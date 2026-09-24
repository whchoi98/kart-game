import { CUPS, TRACK_CATALOG, getTrackMeta, tracksOfCup, type CupMeta } from '../../../sim/tracks/catalog.js';
import type { CupId, RaceMode, SpeedClass } from '../../../sim/types.js';
import type { App } from '../app.js';
import { ICON, trophySvg } from '../art/icons.js';
import { THEME_COLORS } from '../art/track-draw.js';
import { h, svg } from '../dom.js';
import { formatTicks } from '../format.js';
import { TROPHY_LABEL } from '../gp.js';
import { BaseScreen, frame } from '../screen.js';
import { paintTrackThumb, tryBuiltTrack } from '../thumb.js';
import { MODE_LABEL } from './class-select.js';

export function cupEmblem(cup: CupMeta, cls = 'cup-emblem'): HTMLElement {
  const el = h('span', `${cls} ${cls}--${cup.id}`, svg(cup.emblem === 'sprout' ? ICON.sprout : ICON.bolt, 'ico'));
  el.style.setProperty('--cup', cup.color);
  return el;
}

export function trackLaps(id: string): number {
  return tryBuiltTrack(id)?.def.laps ?? 3;
}

// ───────────────────────── cups ─────────────────────────

export function createCupSelect(app: App, o: { cc: SpeedClass; steps: string[]; step: number; onNext(cup: CupId): void }): BaseScreen {
  const s = new BaseScreen(app, 'setup setup--cup');
  s.music = 'menu';
  s.backdrop = { kind: 'title' };
  const { body } = frame(s, app, { kicker: '그랑프리', title: '컵 선택', steps: o.steps, step: o.step });
  const row = h('div', 'cup-cards');
  for (const cup of CUPS) {
    const trophy = app.storage.getTrophy(cup.id, o.cc);
    const b = h('button', `cup-card cup-card--${cup.id}`);
    b.type = 'button';
    b.dataset.nav = '';
    if (cup.id === app.memory.cup) b.dataset.autofocus = '';
    b.style.setProperty('--cup', cup.color);
    const list = h('ol', 'cup-card__tracks', ...tracksOfCup(cup.id).map(t => h('li', null, h('b', null, String(t.order)), h('span', null, t.name))));
    b.append(
      h('div', 'cup-card__head', cupEmblem(cup), h('div', 'cup-card__names', h('strong', null, cup.name), h('span', null, cup.nameEn))),
      list,
      h('div', `cup-card__trophy ${trophy ? `is-${trophy}` : ''}`, svg(trophySvg(trophy), 'ico'),
        h('span', null, trophy ? `${o.cc}cc ${TROPHY_LABEL[trophy]}` : `${o.cc}cc 트로피 없음`)),
    );
    b.addEventListener('click', () => {
      app.sound('select');
      app.memory.cup = cup.id;
      o.onNext(cup.id);
    });
    row.append(b);
  }
  body.append(row);
  return s;
}

// ───────────────────────── tracks ─────────────────────────

class TrackSelect extends BaseScreen {
  private readonly info: HTMLElement;
  private painted = false;

  constructor(app: App, private readonly o: {
    mode: RaceMode; cc: SpeedClass; mirror: boolean; steps: string[]; step: number; onNext(trackId: string): void;
  }) {
    super(app, 'setup setup--track', {
      onFocus: el => { const id = el.dataset.track; if (id) this.describe(id); },
    });
    this.music = 'menu';
    this.inputMode = o.mode === 'duo' ? 'duo' : 'single';
    this.backdrop = { kind: 'title' };
    const { body } = frame(this, app, { kicker: MODE_LABEL[o.mode], title: '코스 선택', steps: o.steps, step: o.step });
    const groups = h('div', 'track-groups');
    for (const cup of CUPS) {
      const grid = h('div', 'track-grid');
      for (const t of tracksOfCup(cup.id)) grid.append(this.card(t.id));
      groups.append(h('section', `track-group track-group--${cup.id}`,
        h('h2', 'track-group__title', cupEmblem(cup, 'cup-emblem cup-emblem--sm'), h('span', null, cup.name)), grid));
    }
    this.info = h('div', 'track-info');
    body.append(groups, this.info);
    this.describe(app.memory.trackId);
  }

  private card(id: string): HTMLButtonElement {
    const meta = getTrackMeta(id);
    const theme = THEME_COLORS[meta.theme];
    const b = h('button', `track-card theme--${meta.theme}`);
    b.type = 'button';
    b.dataset.nav = '';
    b.dataset.track = id;
    if (id === this.app.memory.trackId) b.dataset.autofocus = '';
    b.style.setProperty('--t-a', theme.a);
    b.style.setProperty('--t-b', theme.b);
    const canvas = h('canvas', 'track-card__map');
    canvas.setAttribute('aria-hidden', 'true');
    b.append(h('span', 'track-card__order', String(meta.order)), canvas, h('span', 'track-card__name', meta.name));
    this.bestBadge(b, id);
    b.addEventListener('click', () => {
      this.app.sound('select');
      this.app.memory.trackId = id;
      this.o.onNext(id);
    });
    return b;
  }

  /** Time trial: personal-best badge on the card (re-run when coming back from a run). */
  private bestBadge(card: HTMLElement, id: string): void {
    const best = this.o.mode === 'tt' ? this.app.storage.getBest(id, this.o.cc) : null;
    card.querySelector('.track-card__best')?.remove();
    if (best) card.append(h('span', 'track-card__best', svg(ICON.stopwatch, 'ico'), formatTicks(best.ticks)));
  }

  private describe(id: string): void {
    const meta = TRACK_CATALOG.find(t => t.id === id);
    if (!meta) return;
    const cup = CUPS.find(c => c.id === meta.cup)!;
    const best = this.app.storage.getBest(id, this.o.cc);
    this.info.replaceChildren(
      h('div', 'track-info__head', h('strong', 'track-info__name', meta.name), h('span', 'track-info__en', meta.nameEn)),
      h('p', 'track-info__blurb', meta.blurb),
      h('div', 'track-info__chips',
        h('span', 'chip', `${cup.name} · ${meta.order}번째`),
        h('span', 'chip', `${trackLaps(id)}랩`),
        this.o.mirror ? h('span', 'chip chip--on', '미러') : null,
        best ? h('span', 'chip chip--gold', `내 기록 ${formatTicks(best.ticks)}`) : null),
    );
  }

  override show(first: boolean): void {
    super.show(first);
    if (!first) {
      // Back from a race ('다른 트랙'): a new personal best must show on the cards and the info panel.
      for (const c of this.el.querySelectorAll<HTMLElement>('.track-card[data-track]')) this.bestBadge(c, c.dataset.track!);
      this.describe(this.nav.focused?.dataset.track ?? this.app.memory.trackId);
    }
    if (!this.painted) {
      this.painted = true;
      // Paint after layout so canvases have their CSS size; spread over frames to keep input snappy.
      const canvases = Array.from(this.el.querySelectorAll<HTMLCanvasElement>('.track-card__map'));
      let i = 0;
      const step = () => {
        const c = canvases[i++];
        if (!c) return;
        const id = c.closest<HTMLElement>('[data-track]')?.dataset.track;
        if (id) paintTrackThumb(c, id, this.o.mirror);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
}

export function createTrackSelect(app: App, o: {
  mode: RaceMode; cc: SpeedClass; mirror: boolean; steps: string[]; step: number; onNext(trackId: string): void;
}): BaseScreen {
  return new TrackSelect(app, o);
}
