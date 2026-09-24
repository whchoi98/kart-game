import { getCharacter } from '../../../sim/characters.js';
import { getTrackMeta } from '../../../sim/tracks/catalog.js';
import type { CharacterId, CpuLevel, SpeedClass } from '../../../sim/types.js';
import type { LeaderboardEntry } from '../../../shared/api.js';
import { ApiRequestError, browserOffline, errorMessage, fetchLeaderboard } from '../../api.js';
import type { App } from '../app.js';
import { h } from '../dom.js';
import { formatTicks } from '../format.js';
import { BaseScreen, frame } from '../screen.js';
import { paintTrackThumb } from '../thumb.js';
import { button, choice, portrait, stepper, toggle, type Choice } from '../widgets.js';
import { CPU_LABEL, MODE_LABEL } from './class-select.js';
import { trackLaps } from './course-select.js';

function summaryCard(o: { trackId: string; cc: SpeedClass; chars: CharacterId[]; cpuLevel?: CpuLevel; mirror?: boolean }): { el: HTMLElement; paint(): void } {
  const meta = getTrackMeta(o.trackId);
  const canvas = h('canvas', 'summary__map');
  const el = h('div', `summary theme--${meta.theme}`,
    canvas,
    h('div', 'summary__info',
      h('strong', 'summary__track', meta.name),
      h('div', 'summary__chips',
        h('span', 'chip', `${o.cc}cc`),
        h('span', 'chip', `${trackLaps(o.trackId)}랩`),
        o.cpuLevel ? h('span', 'chip', `CPU ${CPU_LABEL[o.cpuLevel]}`) : null,
        o.mirror ? h('span', 'chip chip--on', '미러') : null),
      h('div', 'summary__racers', ...o.chars.map((c, i) => h('span', 'summary__racer',
        portrait(c, 'portrait portrait--sm'), h('span', null, o.chars.length > 1 ? `P${i + 1} ${getCharacter(c).name}` : getCharacter(c).name))))),
  );
  return { el, paint: () => paintTrackThumb(canvas, o.trackId, !!o.mirror) };
}

// ───────────────────────── VS / Duo rules ─────────────────────────

export interface VersusRules { items: boolean; cpuCount: number }

export function createVersusOptions(app: App, o: {
  duo: boolean; trackId: string; cc: SpeedClass; cpuLevel: CpuLevel; mirror: boolean; chars: CharacterId[];
  steps: string[]; step: number; onStart(r: VersusRules): void;
}): BaseScreen {
  const s = new BaseScreen(app, 'setup setup--options');
  s.music = 'menu';
  s.inputMode = o.duo ? 'duo' : 'single';
  const { body } = frame(s, app, { kicker: MODE_LABEL[o.duo ? 'duo' : 'vs'], title: '레이스 규칙', steps: o.steps, step: o.step });
  const maxCpu = 8 - o.chars.length;
  let items = app.memory.items;
  let cpuCount = Math.min(maxCpu, o.duo ? app.memory.duoCpuCount : app.memory.cpuCount);
  const sum = summaryCard({ trackId: o.trackId, cc: o.cc, chars: o.chars, cpuLevel: o.cpuLevel, mirror: o.mirror });
  const rows = h('div', 'setup__rows',
    toggle(app, { label: '아이템', icon: 'box', value: items, on: '사용', off: '없음', onChange: v => { items = v; } }).el,
    stepper(app, {
      label: 'CPU 레이서', icon: 'cpu', min: 0, max: maxCpu, value: cpuCount,
      format: v => (v === 0 ? '없음' : `${v}명`),
      onChange: v => { cpuCount = v; },
    }).el,
  );
  const go = button(app, {
    label: '레이스 시작!', icon: 'play', variant: 'go', cls: 'setup__start', autofocus: true, sound: 'start',
    onClick: () => {
      app.memory.items = items;
      if (o.duo) app.memory.duoCpuCount = cpuCount; else app.memory.cpuCount = cpuCount;
      o.onStart({ items, cpuCount });
    },
  });
  body.append(h('div', 'options-layout', sum.el, h('div', 'options-col', rows, go)));
  const baseShow = s.show.bind(s);
  let painted = false;
  s.show = (first: boolean) => {
    baseShow(first);
    if (!painted) { painted = true; requestAnimationFrame(() => sum.paint()); }
  };
  return s;
}

// ───────────────────────── Time trial ghost ─────────────────────────

export type GhostChoice = 'none' | 'best' | 'world';

class TimeTrialOptions extends BaseScreen {
  private readonly worldText: HTMLElement;
  private worldEntry: LeaderboardEntry | null = null;
  private worldState: 'loading' | 'ready' | 'empty' | 'error' | 'offline' = 'loading';
  private abort: AbortController | null = null;
  private readonly ghostChoice: Choice<GhostChoice>;
  private readonly sum: { el: HTMLElement; paint(): void };
  private painted = false;

  constructor(app: App, private readonly o: {
    trackId: string; cc: SpeedClass; charId: CharacterId; steps: string[]; step: number;
    onStart(choice: GhostChoice, world: LeaderboardEntry | null): void;
  }) {
    super(app, 'setup setup--options setup--tt');
    this.music = 'menu';
    const { body } = frame(this, app, { kicker: '타임 어택', title: '고스트 선택', steps: o.steps, step: o.step });
    const best = app.storage.getBest(o.trackId, o.cc);
    let initial: GhostChoice = app.memory.ttGhost;
    if (initial === 'best' && !(best && best.log)) initial = 'none';
    this.ghostChoice = choice<GhostChoice>(app, {
      label: '고스트', icon: 'ghost', value: initial,
      options: this.ghostOptions(),
      onChange: v => { app.memory.ttGhost = v; },
    });
    this.worldText = h('span', 'tt-rec__value', '불러오는 중…');
    const recs = h('div', 'tt-recs',
      h('div', 'tt-rec', h('span', 'tt-rec__label', '내 최고 기록'),
        h('span', 'tt-rec__value', best ? formatTicks(best.ticks) : '기록 없음'),
        best ? h('span', 'tt-rec__sub', `${getCharacter(best.charId).name}`) : null),
      h('div', 'tt-rec tt-rec--world', h('span', 'tt-rec__label', `세계 1위 · ${o.cc}cc`), this.worldText),
    );
    this.sum = summaryCard({ trackId: o.trackId, cc: o.cc, chars: [o.charId] });
    const go = button(app, {
      label: '출발!', icon: 'play', variant: 'go', cls: 'setup__start', autofocus: true, sound: 'start',
      onClick: () => this.start(),
    });
    body.append(h('div', 'options-layout', this.sum.el, h('div', 'options-col', recs, h('div', 'setup__rows', this.ghostChoice.el), go)));
  }

  private ghostOptions(): Array<{ value: GhostChoice; label: string; locked?: string | null }> {
    const best = this.app.storage.getBest(this.o.trackId, this.o.cc);
    const worldLocked = this.worldState === 'ready' ? null
      : this.worldState === 'loading' ? '세계 기록을 불러오는 중이에요.'
        : this.worldState === 'empty' ? '아직 등록된 세계 기록이 없어요.'
          : this.worldState === 'offline' ? '오프라인에서는 세계 1위 고스트를 받을 수 없어요. 온라인이 되면 고를 수 있어요.'
            : '세계 기록을 불러오지 못했어요.';
    return [
      { value: 'none', label: '없음' },
      { value: 'best', label: '내 최고 기록', locked: best && best.log ? null : '이 코스와 클래스의 기록이 아직 없어요.' },
      { value: 'world', label: '세계 1위', locked: worldLocked },
    ];
  }

  override show(first: boolean): void {
    super.show(first);
    if (!this.painted) { this.painted = true; requestAnimationFrame(() => this.sum.paint()); }
    if (first) {
      void this.loadWorld();
      // connection came back: the world record (and its ghost) become available
      this.own(this.app.on('net', () => { if (this.app.online && this.worldState === 'offline') void this.loadWorld(); }));
    }
  }

  override dispose(): void {
    this.abort?.abort();
    super.dispose();
  }

  private async loadWorld(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    if (browserOffline()) {
      this.setWorld('offline', '오프라인', '인터넷에 연결되면 세계 기록을 볼 수 있어요.');
    } else {
      const ctrl = new AbortController();
      this.abort = ctrl;
      this.setWorld('loading', '불러오는 중…');
      try {
        const lb = await fetchLeaderboard(this.o.trackId, this.o.cc, { signal: ctrl.signal });
        const top = lb.entries[0] ?? null;
        this.worldEntry = top;
        this.setWorld(top ? 'ready' : 'empty', top ? `${formatTicks(top.ticks)} · ${top.name}` : '아직 기록 없음');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const offline = browserOffline() || (err instanceof ApiRequestError && err.kind === 'offline');
        this.setWorld(offline ? 'offline' : 'error', offline ? '오프라인' : '불러오지 못했어요', errorMessage(err));
      }
    }
    if (this.ghostChoice.get() === 'world' && this.worldState !== 'ready') this.ghostChoice.set('none', true);
    this.ghostChoice.refresh(this.ghostOptions());
    if (this.app.memory.ttGhost === 'world' && this.worldState === 'ready') this.ghostChoice.set('world', true);
  }

  private setWorld(state: TimeTrialOptions['worldState'], text: string, title = ''): void {
    this.worldState = state;
    this.worldText.textContent = text;
    this.worldText.title = title;
  }

  private start(): void {
    this.o.onStart(this.ghostChoice.get(), this.worldEntry);
  }
}

export function createTimeTrialOptions(app: App, o: {
  trackId: string; cc: SpeedClass; charId: CharacterId; steps: string[]; step: number;
  onStart(choice: GhostChoice, world: LeaderboardEntry | null): void;
}): BaseScreen {
  return new TimeTrialOptions(app, o);
}
