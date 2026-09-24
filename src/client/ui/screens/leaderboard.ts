import { getCharacter } from '../../../sim/characters.js';
import { TRACK_CATALOG, getTrackMeta } from '../../../sim/tracks/catalog.js';
import type { SpeedClass } from '../../../sim/types.js';
import type { LeaderboardEntry, LeaderboardResponse } from '../../../shared/api.js';
import { API_LIMITS } from '../../../shared/api.js';
import { ApiRequestError, browserOffline, errorMessage, fetchLeaderboard, isConnectivityError, leaderboardVersion } from '../../api.js';
import type { MenuAction } from '../../contracts.js';
import type { App } from '../app.js';
import { ICON } from '../art/icons.js';
import { h, svg } from '../dom.js';
import { formatDate, formatTicks, positionTone } from '../format.js';
import { challengeGhost } from '../flows.js';
import { pendingNotice } from '../pwa-ui.js';
import { BaseScreen, frame } from '../screen.js';
import { button, choice, portrait, tabs, type Choice, type Tabs } from '../widgets.js';

const CACHE_MS = 45_000;
const CLASSES: readonly SpeedClass[] = [50, 100, 150, 200];
/** `v` = leaderboardVersion() when fetched: a run accepted since then invalidates the entry. */
const cache = new Map<string, { at: number; v: number; data: LeaderboardResponse }>();

class LeaderboardScreen extends BaseScreen {
  private readonly list: HTMLElement;
  private readonly mine: HTMLElement;
  private readonly trackTabs: Tabs;
  private readonly ccChoice: Choice<SpeedClass>;
  /** Focus is still where the screen put it (the class row): a loaded board's first entry takes it. */
  private defaultFocus = true;
  private trackId: string;
  private cc: SpeedClass;
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(app: App) {
    super(app, 'lb');
    this.music = 'menu';
    this.backdrop = { kind: 'title' };
    this.hints = [{ key: 'tabs', label: '코스' }, { key: 'adjust', label: '클래스' }, { key: 'confirm', label: '고스트 대결' }, { key: 'back', label: '뒤로' }];
    this.trackId = app.memory.lbTrack;
    this.cc = app.memory.lbCc;
    const { body } = frame(this, app, { kicker: '세계 랭킹', title: '랭킹', bodyCls: 'lb__body' });
    this.trackTabs = tabs(app, {
      items: TRACK_CATALOG.map(t => ({ id: t.id, label: t.name })),
      active: this.trackId, cls: 'tabs--tracks',
      onChange: id => { this.trackId = id; app.memory.lbTrack = id; void this.load(); },
    });
    const ccRow = choice<SpeedClass>(app, {
      label: '클래스', icon: 'speed', value: this.cc, cls: 'lb__cc',
      options: ([50, 100, 150, 200] as SpeedClass[]).map(v => ({ value: v, label: `${v}cc` })),
      onChange: v => { this.cc = v; app.memory.lbCc = v; void this.load(); },
    });
    ccRow.el.dataset.autofocus = '';
    this.ccChoice = ccRow;
    this.mine = h('div', 'lb__mine');
    this.list = h('div', 'lb__list');
    this.list.setAttribute('role', 'list');
    // runs recorded offline wait here too (등록 / 삭제 once online)
    const pending = pendingNotice(app, this.nav, { dropped: false }); // the version clean-up note lives on the main menu
    pending.el.classList.add('pwa-notices--inline');
    this.own(pending.dispose);
    body.append(this.trackTabs.el, h('div', 'lb__bar', ccRow.el, this.mine), pending.el, this.list);
    this.el.addEventListener('pointerdown', () => { this.defaultFocus = false; });
    // back online: replace the offline state (or the saved copy) with the live board
    this.own(app.on('net', () => { if (app.online && this.offlineShown) void this.load(true); }));
    // a waiting run was just submitted: the board may have changed
    this.own(app.on('pending', () => { if (app.online && this.lastVersion !== leaderboardVersion()) void this.load(); }));
  }

  /** The list currently shows the offline state or a saved copy fetched earlier. */
  private offlineShown = false;
  private lastVersion = -1;

  override onMenu(action: MenuAction): boolean {
    if (action === 'up' || action === 'down') this.defaultFocus = false;
    // ←/→ switch the class from anywhere, as the hint bar says (on the class row its own picker handles them).
    if ((action === 'left' || action === 'right') && !this.nav.focused?.closest('.lb__cc')) {
      const i = CLASSES.indexOf(this.cc);
      this.app.sound('toggle');
      this.ccChoice.set(CLASSES[(i + (action === 'left' ? -1 : 1) + CLASSES.length) % CLASSES.length]!);
      return true;
    }
    return false;
  }

  override show(first: boolean): void {
    super.show(first);
    if (first) void this.load();
  }

  override onTab(dir: -1 | 1): void {
    this.trackTabs.step(dir);
  }

  override dispose(): void {
    this.abort?.abort();
    super.dispose();
  }

  private renderMine(): void {
    const best = this.app.storage.getBest(this.trackId, this.cc);
    this.mine.replaceChildren(svg(ICON.stopwatch, 'ico'), h('span', null, '내 기록'), h('b', null, best ? formatTicks(best.ticks) : '없음'));
  }

  private async load(force = false): Promise<void> {
    this.renderMine();
    const key = `${this.trackId}|${this.cc}`;
    const seq = ++this.seq;
    const hit = cache.get(key);
    this.lastVersion = leaderboardVersion();
    if (hit && !force && hit.v === leaderboardVersion() && performance.now() - hit.at < CACHE_MS) { this.offlineShown = false; this.render(hit.data); return; }
    this.abort?.abort();
    // Offline: no request (and no spinner) — show the friendly offline state right away.
    if (browserOffline()) { this.abort = null; this.renderOffline(hit?.data ?? null); return; }
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.list.replaceChildren(h('div', 'lb__state', h('div', 'busy__wheel', h('i'), h('i'), h('i')), h('p', null, '랭킹을 불러오는 중…')));
    try {
      const v = leaderboardVersion();
      const data = await fetchLeaderboard(this.trackId, this.cc, { signal: ctrl.signal });
      if (seq !== this.seq) return;
      cache.set(key, { at: performance.now(), v, data });
      this.offlineShown = false;
      this.render(data);
    } catch (err) {
      if (seq !== this.seq || ctrl.signal.aborted) return;
      // No connection (the browser may still claim to be online): the friendly offline state.
      if (browserOffline() || isConnectivityError(err)) {
        this.renderOffline(hit?.data ?? null, browserOffline() || (err instanceof ApiRequestError && err.kind === 'offline') ? 'offline' : 'unreachable');
        return;
      }
      const retry = button(this.app, { label: '다시 시도', icon: 'refresh', variant: 'primary', onClick: () => void this.load(true) });
      this.offlineShown = false;
      this.list.replaceChildren(h('div', 'lb__state lb__state--error', svg(ICON.info, 'ico lb__state-ico'), h('p', null, errorMessage(err)), retry));
      if (this.app.top === this) this.nav.focus(retry, { sound: false });
    }
  }

  /** Friendly offline state; a board fetched earlier this session is still shown, marked as saved. */
  private renderOffline(saved: LeaderboardResponse | null, kind: 'offline' | 'unreachable' = 'offline'): void {
    this.offlineShown = true;
    const head = kind === 'offline' ? '지금은 오프라인이에요.' : '랭킹 서버에 연결할 수 없어요.';
    if (saved) {
      this.render(saved);
      this.list.prepend(h('div', 'lb__offline-note', svg(ICON.offline, 'ico'),
        h('span', null, `${kind === 'offline' ? '오프라인이라' : '서버에 연결할 수 없어'} 마지막으로 받은 순위를 보여 드려요. 고스트 대결은 연결된 뒤에 할 수 있어요.`)));
      return;
    }
    const retry = button(this.app, { label: '다시 시도', icon: 'refresh', variant: 'secondary', onClick: () => void this.load(true) });
    this.list.replaceChildren(h('div', 'lb__state lb__state--offline', svg(ICON.offline, 'ico lb__state-ico'),
      h('p', null, head),
      h('p', 'lb__state-sub', `세계 랭킹은 ${kind === 'offline' ? '인터넷에 연결되면' : '연결이 돌아오면'} 볼 수 있어요. 그랑프리 · VS 레이스 · 타임 어택 · 2인 대전은 오프라인에서도 그대로 즐길 수 있어요!`),
      retry));
    if (this.app.top === this && (!this.nav.focused || this.nav.focused.closest('.lb__list'))) this.nav.focus(retry, { sound: false });
  }

  private render(data: LeaderboardResponse): void {
    // Focus inside the list (a row about to be replaced) or already lost (the retry button was
    // removed by the loading state): move it to something that still exists.
    const focusedWasList = !this.nav.focused || !!this.nav.focused.closest('.lb__list');
    // …or still on the class row the screen opened on: Enter ("고스트 대결") must hit an entry, not cycle the class.
    const onDefault = this.defaultFocus && !!this.nav.focused?.closest('.lb__cc');
    const mayFocus = (focusedWasList || onDefault) && this.app.top === this;
    if (data.entries.length === 0) {
      this.list.replaceChildren(h('div', 'lb__state', svg(ICON.podium, 'ico lb__state-ico'),
        h('p', null, '아직 등록된 기록이 없어요.'), h('p', 'lb__state-sub', '타임 어택에서 첫 번째 주인공이 되어 보세요!')));
      if (mayFocus) this.nav.focusFirst();
      return;
    }
    const rows = data.entries.slice(0, API_LIMITS.leaderboardSize).map(e => this.row(e));
    this.list.replaceChildren(
      h('div', 'lb__head', h('span', null, '순위'), h('span', null, '레이서'), h('span', null, '기록'), h('span', null, '날짜')),
      ...rows);
    if (mayFocus && rows[0]) this.nav.focus(rows[0], { sound: false });
  }

  private row(e: LeaderboardEntry): HTMLButtonElement {
    const ch = getCharacter(e.charId);
    const b = h('button', 'lb-row');
    b.type = 'button';
    b.dataset.nav = '';
    b.setAttribute('role', 'listitem');
    const rank = h('span', 'pos-badge', String(e.rank));
    rank.dataset.tone = positionTone(e.rank);
    const name = h('b', 'lb-row__name');
    name.textContent = e.name; // user-provided: textContent only
    b.append(rank, portrait(e.charId, 'portrait lb-row__portrait'),
      h('span', 'lb-row__who', name, h('small', null, ch.name)),
      h('span', 'lb-row__time', formatTicks(e.ticks)),
      h('span', 'lb-row__date', formatDate(e.createdAt)),
      h('span', 'lb-row__ghost', svg(ICON.ghost, 'ico'), '대결'));
    b.style.setProperty('--c-body', ch.colors.body);
    b.addEventListener('click', () => void this.challenge(e));
    return b;
  }

  private async challenge(e: LeaderboardEntry): Promise<void> {
    this.app.sound('select');
    const track = getTrackMeta(e.trackId);
    const ok = await this.app.confirm({
      title: '이 기록 고스트와 대결',
      message: `${e.name} 님의 ${track.name} ${e.cc}cc 기록 ${formatTicks(e.ticks)}에 도전할까요?`,
      yes: '대결하기', no: '취소',
    });
    if (ok) await challengeGhost(this.app, e);
  }
}

export function createLeaderboardScreen(app: App): BaseScreen {
  return new LeaderboardScreen(app);
}
