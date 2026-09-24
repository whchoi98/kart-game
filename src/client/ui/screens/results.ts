import { getCharacter } from '../../../sim/characters.js';
import { getTrackMeta } from '../../../sim/tracks/catalog.js';
import type { CupId, RaceResult, SpeedClass } from '../../../sim/types.js';
import { API_LIMITS, type SubmitRunRequest } from '../../../shared/api.js';
import { ApiRequestError, describeRejection, errorMessage, isConnectivityError, submitRun } from '../../api.js';
import type { MenuAction, RaceSummary, TimeTrialRecord } from '../../contracts.js';
import { pendingRunId, type PersonalBest, type UnlockId } from '../../storage.js';
import type { App } from '../app.js';
import { trophySvg } from '../art/icons.js';
import { animate, countUp, h, svg } from '../dom.js';
import { formatDelta, formatLapTicks, formatTicks, positionTone, validatePlayerName } from '../format.js';
import { TROPHY_LABEL, type GpAward, type GpEntry, type TrophyTier } from '../gp.js';
import { InputHold } from '../input-hold.js';
import { clientBuild } from '../pwa-ui.js';
import { BaseScreen, type MenuSource } from '../screen.js';
import { button, icon, portrait, textRow } from '../widgets.js';
import { APP_VERSION } from './title.js';

function humanLabel(app: App, human: number, duo: boolean): string {
  if (human < 0) return 'CPU';
  if (duo) return `P${human + 1}`;
  return app.settings.playerName || '나';
}

function posBadge(pos: number): HTMLElement {
  const el = h('span', 'pos-badge', String(pos));
  el.dataset.tone = positionTone(pos);
  return el;
}

function stagger(rows: HTMLElement[], base = 60): void {
  rows.forEach((r, i) => animate(r, [{ transform: 'translateX(-12%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 320, delay: i * base, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'backwards' }));
}

/** Confirm / back are ignored this long after a results screen appears (mashing, Space = drift = confirm). */
const RESULTS_HOLD_MS = 500;
/** The podium ceremony: the trophy lands before a press can leave it. */
const PODIUM_HOLD_MS = 1500;

function bestLap(r: RaceResult): number {
  if (r.bestLapTicks > 0) return r.bestLapTicks;
  return r.lapTicks.length ? Math.min(...r.lapTicks) : 0;
}

// ───────────────────────── VS / Duo ─────────────────────────

export function createVersusResults(app: App, o: {
  summary: RaceSummary; duo: boolean; onRetry(): void; onOtherTrack(): void; onMenu(): void;
}): BaseScreen {
  const s = new BaseScreen(app, 'results results--vs');
  s.music = 'results';
  s.inputMode = o.duo ? 'duo' : 'single';
  const results = [...o.summary.results].sort((a, b) => a.position - b.position);
  const meta = getTrackMeta(o.summary.config.trackId);
  const fastest = Math.min(...results.map(bestLap).filter(t => t > 0));
  const rows = results.map(r => {
    const ch = getCharacter(r.charId);
    const row = h('li', `res-row ${r.human >= 0 ? `is-human is-p${r.human + 1}` : ''}`,
      posBadge(r.position),
      portrait(r.charId, 'portrait res-row__portrait'),
      // CPUs read by character (as in the GP tables), not seven rows of "CPU".
      h('span', 'res-row__name', h('b', null, r.human >= 0 ? humanLabel(app, r.human, o.duo) : ch.name), h('small', null, r.human >= 0 ? ch.name : 'CPU')),
      h('span', `res-row__time ${r.estimated ? 'is-estimated' : ''}`, formatTicks(r.ticks), r.estimated ? h('small', null, '예상') : null),
      // No completed lap (e.g. a CPU still on lap 1 when the race closed): show the placeholder, not 00:00.000.
      h('span', `res-row__lap ${bestLap(r) > 0 && bestLap(r) === fastest ? 'is-fastest' : ''}`, h('small', null, '베스트 랩'), formatLapTicks(bestLap(r))));
    row.style.setProperty('--c-body', ch.colors.body);
    return row;
  });
  const humans = results.filter(r => r.human >= 0);
  const headline = o.duo
    ? (humans.length === 2 ? `${humans[0]!.position < humans[1]!.position ? `P${humans[0]!.human + 1}` : `P${humans[1]!.human + 1}`} 승리!` : '레이스 종료')
    : !humans[0] ? '레이스 종료'
      : results.length === 1 ? '완주!' // solo run (VS with no CPUs): nobody to beat
        : humans[0].position === 1 ? '우승!' : `${humans[0].position}위 완주!`;
  const panel = h('div', 'res-panel',
    h('div', 'res-panel__head', h('span', 'res-panel__kicker', `${o.duo ? '2인 대전' : 'VS 레이스'} · ${o.summary.config.cc}cc`),
      h('h1', 'res-panel__title', headline), h('span', 'res-panel__track', meta.name)),
    h('ol', 'res-table', ...rows),
    h('div', 'res-actions',
      button(app, { label: '다시 하기', icon: 'restart', variant: 'primary', autofocus: true, onClick: o.onRetry }),
      button(app, { label: '다른 트랙', icon: 'flag', onClick: o.onOtherTrack }),
      button(app, { label: '메뉴', icon: 'home', variant: 'ghost', onClick: o.onMenu })),
  );
  s.el.append(panel);
  const hold = new InputHold();
  const baseShow = s.show.bind(s);
  s.show = first => { baseShow(first); if (first) { hold.arm(RESULTS_HOLD_MS); stagger(rows); } };
  s.onMenu = action => hold.blocks(action);
  s.onBack = () => { app.sound('back'); o.onMenu(); };
  return s;
}

// ───────────────────────── Grand Prix ─────────────────────────

class GrandPrixResults extends BaseScreen {
  private phase: 'race' | 'standings' = 'race';
  private readonly raceView: HTMLElement;
  private readonly standingsView: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private timer = 0;
  /** Standings re-order animation (starts 750 ms after the switch). */
  private sortTimer = 0;
  private disposed = false;
  private readonly hold = new InputHold();

  constructor(app: App, private readonly o: {
    raceIndex: number; totalRaces: number; cupName: string; summary: RaceSummary;
    awards: GpAward[]; before: GpEntry[]; after: GpEntry[]; final: boolean; onNext(): void;
  }) {
    super(app, 'results results--gp');
    this.music = 'results';
    this.hints = [{ key: 'confirm', label: '계속' }];
    const results = [...o.summary.results].sort((a, b) => a.position - b.position);
    const byChar = new Map(results.map(r => [r.charId, r] as const));
    const raceRows = o.awards.map(a => {
      const r = byChar.get(a.charId);
      const ch = getCharacter(a.charId);
      const row = h('li', `res-row ${a.human >= 0 ? 'is-human is-p1' : ''}`,
        posBadge(a.position), portrait(a.charId, 'portrait res-row__portrait'),
        h('span', 'res-row__name', h('b', null, a.human >= 0 ? humanLabel(app, a.human, false) : ch.name), a.human >= 0 ? h('small', null, ch.name) : null),
        h('span', `res-row__time ${r?.estimated ? 'is-estimated' : ''}`, r ? formatTicks(r.ticks) : ''),
        h('span', 'res-row__pts', `+${a.points}`));
      row.style.setProperty('--c-body', ch.colors.body);
      return row;
    });
    this.raceView = h('ol', 'res-table', ...raceRows);

    // Standings: rows positioned by transform so they can slide into the new order.
    const n = o.after.length;
    this.standingsView = h('div', 'standings');
    this.standingsView.style.setProperty('--rows', String(n));
    this.standingsView.hidden = true;
    const beforeIdx = new Map(o.before.map((e, i) => [e.charId, i] as const));
    const gained = new Map(o.awards.map(a => [a.charId, a.points] as const));
    for (const e of o.after) {
      const ch = getCharacter(e.charId);
      const pts = h('b', 'standings__pts', String(e.points - (gained.get(e.charId) ?? 0)));
      const rank = h('span', 'pos-badge', '');
      const row = h('div', `standings__row ${e.human >= 0 ? 'is-human is-p1' : ''}`,
        rank, portrait(e.charId, 'portrait res-row__portrait'),
        h('span', 'res-row__name', h('b', null, e.human >= 0 ? humanLabel(app, e.human, false) : ch.name), e.human >= 0 ? h('small', null, ch.name) : null),
        h('span', 'standings__gain', `+${gained.get(e.charId) ?? 0}`), pts);
      row.style.setProperty('--c-body', ch.colors.body);
      const bi = beforeIdx.get(e.charId) ?? 0;
      row.style.transform = `translateY(calc(${bi} * (100% + 0.3rem)))`;
      rank.textContent = String(bi + 1);
      rank.dataset.tone = positionTone(bi + 1);
      row.dataset.char = e.charId;
      row.dataset.to = String(e.points);
      this.standingsView.append(row);
    }

    const title = h('h1', 'res-panel__title', `레이스 ${o.raceIndex + 1} 결과`);
    this.nextBtn = button(app, {
      label: o.final ? '최종 결과' : '다음 레이스', sub: o.final ? undefined : `${o.raceIndex + 2} / ${o.totalRaces}`,
      icon: o.final ? 'trophy' : 'next', variant: 'go', autofocus: true,
      onClick: () => this.advance(),
    });
    const head = h('div', 'res-panel__head', h('span', 'res-panel__kicker', `${o.cupName} · ${o.summary.config.cc}cc`), title,
      h('span', 'res-panel__track', getTrackMeta(o.summary.config.trackId).name));
    const dots = h('div', 'gp-dots', ...Array.from({ length: o.totalRaces }, (_, i) => h('i', i < o.raceIndex ? 'is-done' : i === o.raceIndex ? 'is-now' : '')));
    this.el.append(h('div', 'res-panel', head, dots, this.raceView, this.standingsView, h('div', 'res-actions', this.nextBtn)));
    this.titleEl = title;
  }

  private titleEl: HTMLElement;

  override show(first: boolean): void {
    super.show(first);
    if (first) {
      this.hold.arm(RESULTS_HOLD_MS);
      stagger(Array.from(this.raceView.children) as HTMLElement[]);
      this.timer = window.setTimeout(() => this.toStandings(), 2600);
    }
  }

  override dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.sortTimer);
    super.dispose();
  }

  override onMenu(action: MenuAction, _s: MenuSource): boolean {
    if (this.hold.blocks(action)) return true;
    if (action === 'confirm' || action === 'back') {
      this.app.sound('select');
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): void {
    if (this.phase === 'race') { this.toStandings(); return; }
    this.o.onNext();
  }

  private toStandings(): void {
    if (this.phase === 'standings' || this.disposed) return;
    clearTimeout(this.timer);
    this.phase = 'standings';
    this.titleEl.textContent = '종합 순위';
    this.raceView.hidden = true;
    this.standingsView.hidden = false;
    const rows = Array.from(this.standingsView.children) as HTMLElement[];
    rows.forEach(r => {
      const pts = r.querySelector('.standings__pts')!;
      const from = Number(pts.textContent);
      countUp(pts, from, Number(r.dataset.to), 700);
      const gain = r.querySelector<HTMLElement>('.standings__gain');
      if (gain) animate(gain, [{ transform: 'translateY(40%)', opacity: 0 }, { opacity: 1, transform: 'none', offset: 0.3 }, { opacity: 1 }, { opacity: 0 }],
        { duration: 1400, easing: 'ease-out', fill: 'forwards' });
    });
    clearTimeout(this.sortTimer);
    this.sortTimer = window.setTimeout(() => {
      if (this.disposed) return;
      rows.forEach((r, i) => {
        r.classList.add('is-moving');
        r.style.transform = `translateY(calc(${i} * (100% + 0.3rem)))`;
        const rank = r.querySelector<HTMLElement>('.pos-badge');
        if (rank) { rank.textContent = String(i + 1); rank.dataset.tone = positionTone(i + 1); }
      });
    }, 750);
  }
}

export function createGrandPrixResults(app: App, o: ConstructorParameters<typeof GrandPrixResults>[1]): BaseScreen {
  return new GrandPrixResults(app, o);
}

const UNLOCK_TEXT: Record<UnlockId, string> = {
  cc200: '200cc 클래스가 열렸어요!',
  mirror: '미러 모드가 열렸어요!',
};

export function createPodium(app: App, o: {
  cup: CupId; cupName: string; cc: SpeedClass; standings: GpEntry[]; trophy: TrophyTier | null; improved: boolean;
  newUnlocks: UnlockId[]; onRetry(): void; onMenu(): void;
}): BaseScreen {
  const s = new BaseScreen(app, 'results results--podium');
  s.music = 'podium';
  const human = o.standings.find(e => e.human >= 0);
  const rank = human ? o.standings.indexOf(human) + 1 : 0;
  const headline = rank === 1 ? '그랑프리 우승!' : rank === 2 ? '준우승!' : rank === 3 ? '3위 입상!' : `최종 ${rank}위`;
  // Unlocks are announced inside the trophy card (a global toast would sit on top of the
  // '최종 순위' panel for seconds on small screens).
  const unlockEls = o.newUnlocks.map(u => {
    const el = h('span', 'trophy-card__unlock', icon('sparkle', 'ico'), UNLOCK_TEXT[u]);
    el.setAttribute('role', 'status');
    el.hidden = true;
    return el;
  });
  const newChip = o.improved && o.trophy ? h('span', 'chip chip--gold trophy-card__new', 'NEW 트로피!') : null;
  const trophyCard = h('div', `trophy-card ${o.trophy ? `is-${o.trophy}` : 'is-none'}`,
    svg(trophySvg(o.trophy), 'trophy-card__ico'),
    h('div', 'trophy-card__text',
      h('strong', 'trophy-card__title', headline),
      h('span', 'trophy-card__sub', o.trophy ? `${o.cupName} ${o.cc}cc ${TROPHY_LABEL[o.trophy]}` : '3위 안에 들면 트로피를 받아요'),
      newChip || unlockEls.length ? h('div', 'trophy-card__chips', newChip, ...unlockEls) : null));
  // Final standings as a compact 4 × 2 (portrait: 2 × 4) strip along the bottom: the 3D podium
  // in the middle of the screen stays clear, so all three drivers remain visible.
  const table = h('ol', 'podium-table', ...o.standings.map((e, i) => {
    const ch = getCharacter(e.charId);
    const row = h('li', `res-row podium-row ${e.human >= 0 ? 'is-human is-p1' : ''}`, posBadge(i + 1), portrait(e.charId, 'portrait res-row__portrait'),
      h('span', 'res-row__name', h('b', null, e.human >= 0 ? humanLabel(app, e.human, false) : ch.name)),
      h('span', 'res-row__pts', `${e.points}점`));
    row.style.setProperty('--c-body', ch.colors.body);
    return row;
  }));
  s.hints = []; // the hint bar would sit on the standings strip; the two buttons speak for themselves
  s.el.append(
    h('div', 'podium-top',
      h('div', 'podium-left', trophyCard),
      h('div', 'podium-actions',
        button(app, { label: '메뉴로', icon: 'home', variant: 'primary', autofocus: true, onClick: o.onMenu }),
        button(app, { label: '다시 도전', icon: 'restart', onClick: o.onRetry }))),
    h('div', 'podium-stage'),
    h('div', 'res-panel podium-standings',
      h('div', 'res-panel__head', h('h1', 'res-panel__title', '최종 순위'), h('span', 'res-panel__kicker', `${o.cupName} · ${o.cc}cc`)),
      table),
  );
  const hold = new InputHold();
  s.onMenu = action => hold.blocks(action);
  const timers: number[] = [];
  s.own(() => { for (const t of timers.splice(0)) clearTimeout(t); });
  const baseShow = s.show.bind(s);
  s.show = first => {
    baseShow(first);
    if (!first) return;
    hold.arm(PODIUM_HOLD_MS);
    animate(trophyCard, [{ transform: 'scale(.4) rotate(-20deg)', opacity: 0 }, { transform: 'scale(1.1) rotate(4deg)', opacity: 1, offset: 0.7 }, { transform: 'scale(1) rotate(0)', opacity: 1 }],
      { duration: 900, delay: 400, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
    unlockEls.forEach((el, i) => timers.push(window.setTimeout(() => {
      el.hidden = false;
      app.sound('unlock');
      animate(el, [{ transform: 'scale(.3) rotate(-8deg)', opacity: 0 }, { transform: 'scale(1.12) rotate(2deg)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }],
        { duration: 520, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }, 1600 + i * 1400)));
  };
  s.onBack = () => { app.sound('back'); o.onMenu(); };
  return s;
}

// ───────────────────────── Time trial ─────────────────────────

class TimeTrialResults extends BaseScreen {
  private submitted = false;
  private submitting = false;
  /** This run waits in storage (recorded / failed offline) for a later submission. */
  private queued = false;
  private readonly status: HTMLElement;
  private readonly submitBtn: HTMLButtonElement | null = null;
  private readonly nameRow: ReturnType<typeof textRow> | null = null;

  constructor(app: App, private readonly o: {
    record: TimeTrialRecord; previous: PersonalBest | null; newRecord: boolean; ghostLabel: string | null;
    /** Bot-assisted run (RaceSummary.timeTrial === null): never saved as a best, never submitted. */
    assisted?: boolean;
    onRetry(): void; onGhostRetry(): void; onMenu(): void; onOtherTrack: (() => void) | null;
  }) {
    super(app, 'results results--tt');
    this.music = 'results';
    const r = o.record;
    // The ranking screen opens on the course / class just driven.
    app.memory.lbTrack = r.trackId;
    app.memory.lbCc = r.cc;
    const meta = getTrackMeta(r.trackId);
    const best = Math.min(...r.lapTicks);
    const delta = o.previous ? formatDelta(((r.ticks - o.previous.ticks) * 1000) / 60) : null;
    const total = h('div', 'tt-total', h('span', 'tt-total__label', o.assisted ? '총 기록 (자동 주행)' : '총 기록'), h('strong', 'tt-total__time', formatTicks(r.ticks)),
      delta ? h('span', `tt-total__delta sign-${delta.sign}`, `${delta.text} (이전 최고 ${formatTicks(o.previous!.ticks)})`)
        : h('span', 'tt-total__delta', o.assisted ? '기록 저장 안 됨' : '첫 기록!'));
    const ribbon = o.newRecord && !o.assisted ? h('div', 'new-record', h('span', null, 'NEW RECORD'), h('b', null, '신기록!')) : null;
    const laps = h('ol', 'tt-laps', ...r.lapTicks.map((t, i) => h('li', t === best && r.lapTicks.length > 1 ? 'is-best' : '',
      h('span', null, `LAP ${i + 1}`), h('b', null, formatTicks(t)), t === best && r.lapTicks.length > 1 ? h('em', null, 'BEST') : null)));
    const racer = h('div', 'tt-racer', portrait(r.charId, 'portrait portrait--md'), h('span', null, getCharacter(r.charId).name));

    this.status = h('p', 'submit__status');
    let submitCard: HTMLElement;
    if (o.assisted) {
      submitCard = h('div', 'submit submit--assisted',
        h('h2', 'submit__title', icon('cpu', 'ico'), '자동 주행 기록'),
        h('p', 'submit__note', '자동 주행이 도와준 주행이라 내 최고 기록으로 저장하거나 세계 랭킹에 등록할 수 없어요. 직접 달려서 기록에 도전해 보세요!'));
    } else {
      const nameRow = textRow(app, {
        label: '닉네임', icon: 'star', value: app.settings.playerName, placeholder: '1~12자', maxLength: API_LIMITS.nameMax,
        onInput: v => { const c = validatePlayerName(v); nameRow.setError(v && !c.ok ? c.message : null); },
      });
      this.nameRow = nameRow;
      this.submitBtn = button(app, { label: '랭킹 등록', icon: 'upload', variant: 'primary', sound: null, onClick: () => void this.submit() });
      if (!r.log) {
        this.submitBtn.classList.add('is-locked');
        this.status.textContent = '주행 기록 데이터가 없어 등록할 수 없어요.';
      }
      submitCard = h('div', 'submit', h('h2', 'submit__title', icon('podium', 'ico'), `세계 랭킹 · ${r.cc}cc`), nameRow.el, this.submitBtn, this.status);
      this.own(app.on('net', () => this.onNet()));
    }

    const actions = h('div', 'res-actions',
      button(app, { label: '다시 도전', icon: 'restart', variant: 'primary', autofocus: true, onClick: o.onRetry }),
      button(app, { label: '고스트와 다시', icon: 'ghost', onClick: o.onGhostRetry }),
      o.onOtherTrack ? button(app, { label: '다른 트랙', icon: 'flag', onClick: o.onOtherTrack }) : null,
      button(app, { label: '메뉴', icon: 'home', variant: 'ghost', onClick: o.onMenu }));

    this.el.append(h('div', 'res-panel res-panel--tt',
      h('div', 'res-panel__head', h('span', 'res-panel__kicker', `타임 어택 · ${r.cc}cc`), h('h1', 'res-panel__title', meta.name),
        o.ghostLabel ? h('span', 'res-panel__track', `고스트: ${o.ghostLabel}`) : null),
      h('div', 'tt-grid', h('div', 'tt-col', ribbon, total, racer, laps), submitCard),
      actions));
    this.ribbon = ribbon;
  }

  private ribbon: HTMLElement | null;
  private readonly hold = new InputHold();

  override show(first: boolean): void {
    super.show(first);
    if (first) this.hold.arm(RESULTS_HOLD_MS);
    if (first && this.ribbon) {
      this.app.sound('unlock');
      animate(this.ribbon, [{ transform: 'scale(2) rotate(-12deg)', opacity: 0 }, { transform: 'scale(.95) rotate(-4deg)', opacity: 1, offset: 0.7 }, { transform: 'scale(1) rotate(-4deg)', opacity: 1 }],
        { duration: 700, delay: 250, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
    }
    // Finished offline: keep the run so it can be submitted once the connection is back.
    if (first && this.canSubmit && !this.app.online) {
      const c = validatePlayerName(this.nameRow!.get());
      this.queue(c.ok ? c.name : '', 'offline');
    }
  }

  override onMenu(action: MenuAction): boolean {
    return this.hold.blocks(action);
  }

  override onBack(): void {
    this.app.sound('back');
    this.o.onMenu();
  }

  private get canSubmit(): boolean {
    return !this.o.assisted && !!this.o.record.log && !!this.submitBtn && !!this.nameRow;
  }

  private setStatus(text: string, tone: 'info' | 'good' | 'bad'): void {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
  }

  private setLabel(text: string): void {
    const label = this.submitBtn?.querySelector('.btn__label');
    if (label) label.textContent = text;
  }

  private request(name: string): SubmitRunRequest {
    const r = this.o.record;
    return {
      trackId: r.trackId, cc: r.cc, charId: r.charId, name,
      playerId: this.app.storage.playerId(), ticks: r.ticks, lapTicks: [...r.lapTicks], log: r.log, version: APP_VERSION,
    };
  }

  /** Store this run for later (offline, or the server could not be reached). */
  private queue(name: string, why: 'offline' | 'network', detail = ''): void {
    const res = this.app.storage.queuePendingRun(this.request(name), clientBuild());
    const later = '온라인이 되면 등록할 수 있어요.';
    if (res.stored) {
      this.queued = true;
      this.app.pendingChanged();
      this.setLabel('등록 대기 중');
      this.submitBtn?.classList.add('is-queued');
      this.setStatus(why === 'offline'
        ? `오프라인이라 지금은 등록할 수 없어요. 기록을 보관해 뒀으니 ${later}`
        : `${detail || '서버에 연결하지 못했어요.'} 기록을 보관해 뒀으니 ${later}`, 'info');
    } else if (res.reason === 'slower' && res.existing) {
      this.setStatus(`이 코스·클래스에는 더 빠른 대기 기록(${formatTicks(res.existing.request.ticks)})이 보관돼 있어요. ${later}`, 'info');
    } else if (res.reason === 'quota') {
      this.setStatus('저장 공간이 부족해 기록을 보관하지 못했어요. 온라인이 되면 이 화면에서 다시 등록해 주세요.', 'bad');
    } else {
      this.setStatus(why === 'offline' ? `오프라인이에요. ${later}` : (detail || '기록을 등록하지 못했어요.'), 'bad');
    }
  }

  private onNet(): void {
    if (!this.canSubmit || this.submitted || this.submitting) return;
    if (this.app.online && this.queued) {
      this.setLabel('지금 등록');
      this.submitBtn!.classList.remove('is-queued');
      this.setStatus('다시 온라인이에요! 보관한 기록을 지금 등록할 수 있어요.', 'good');
    } else if (!this.app.online && !this.queued) {
      this.setStatus('오프라인이에요. 등록 버튼을 누르면 기록을 보관해 두고, 온라인이 되면 등록할 수 있어요.', 'info');
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.nameRow || !this.submitBtn) return;
    if (this.submitted) { this.app.sound('error'); this.app.notify('이미 등록한 기록이에요.', 'info'); return; }
    if (!this.o.record.log) { this.app.sound('error'); return; }
    const check = validatePlayerName(this.nameRow.get());
    if (!check.ok) {
      this.app.sound('error');
      this.nameRow.setError(check.message);
      this.nav.focus(this.nameRow.el, { sound: false });
      this.nameRow.input.focus();
      return;
    }
    this.app.sound('select');
    this.nameRow.set(check.name);
    this.nameRow.setError(null);
    if (check.name !== this.app.settings.playerName) this.app.updateSettings({ playerName: check.name });
    if (!this.app.online) { this.queue(check.name, 'offline'); return; }
    this.submitting = true;
    this.submitBtn.classList.add('is-busy');
    this.setStatus('서버에서 기록을 검증하는 중…', 'info');
    try {
      const res = await submitRun(this.request(check.name));
      // answered: the waiting copy (if any) is settled either way
      this.settlePending();
      if (!res.accepted) {
        this.setStatus(describeRejection(res.reason), 'bad');
        this.app.sound('error');
      } else {
        this.submitted = true;
        this.setLabel('등록 완료');
        this.submitBtn.classList.remove('is-queued');
        this.submitBtn.classList.add('is-done');
        if (!res.personalBest) this.setStatus('이전에 등록한 기록이 더 빨라요. 순위는 그대로예요.', 'info');
        else if (res.rank !== null) this.setStatus(`세계 ${res.rank}위로 등록됐어요!`, 'good');
        else this.setStatus(`등록 완료! 아직 TOP ${API_LIMITS.leaderboardSize} 밖이에요.`, 'good');
        this.app.sound(res.rank !== null && res.rank <= 3 ? 'unlock' : 'select');
      }
    } catch (err) {
      if (isConnectivityError(err)) {
        this.queue(check.name, 'network', errorMessage(err));
      } else {
        if (err instanceof ApiRequestError && err.kind === 'invalid') this.settlePending();
        this.setStatus(errorMessage(err), 'bad');
      }
      this.app.sound('error');
    } finally {
      this.submitting = false;
      this.submitBtn.classList.remove('is-busy');
    }
  }

  /** The server answered for this course / class: drop a waiting run that cannot do better. */
  private settlePending(): void {
    const r = this.o.record;
    const id = pendingRunId(r.trackId, r.cc);
    const waiting = this.app.storage.pendingRuns().find(p => p.id === id);
    if (waiting && (waiting.request.log === r.log || waiting.request.ticks >= r.ticks)) {
      this.app.storage.removePendingRun(id);
      this.app.pendingChanged();
    }
    this.queued = false;
  }
}

export function createTimeTrialResults(app: App, o: ConstructorParameters<typeof TimeTrialResults>[1]): BaseScreen {
  return new TimeTrialResults(app, o);
}
