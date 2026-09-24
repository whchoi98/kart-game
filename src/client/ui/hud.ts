/**
 * Race HUD driven by HudSnapshot. One instance per human player (duo = two halves).
 * Performance rules: DOM writes only when a value changes, transforms/opacity only,
 * animations through the Web Animations API (no class-toggle reflows).
 */
import { getCharacter } from '../../sim/characters.js';
import { ITEM_IDS } from '../../sim/item-defs.js';
import type { BuiltTrack, ItemId, RaceMode } from '../../sim/types.js';
import type { HudSnapshot } from '../contracts.js';
import { ICON } from './art/icons.js';
import { COIN_SVG, itemSvg } from './art/item-icons.js';
import { animate, h, prefersReducedMotion, svg } from './dom.js';
import { formatDelta, formatMs, positionTone } from './format.js';
import { Minimap } from './hud-minimap.js';
import { portrait } from './widgets.js';

export interface HudOptions {
  player: number;
  duo: boolean;
  mode: RaceMode;
  showSpeed: boolean;
  showFps: boolean;
  /** Item slot shown (false: VS / duo with items off — an always-empty slot is just noise). */
  items?: boolean;
  /** Pause button (P1 HUD for mouse users). */
  onPause?: () => void;
}

const SPEED_FULL_SCALE = 240;
const ARC_LEN = 188.5; // 270° of r = 40

const INK_BLOBS = `<svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="#1b1036">
    <path d="M180 120c60-40 150-10 170 50 30 10 70 40 50 80 40 30 20 100-40 100-10 50-90 70-130 30-60 20-120-20-110-80-50-20-50-90 0-110-20-40 20-80 60-70z"/>
    <path d="M300 420l20 120c3 20-27 22-28 2l-12-110z"/><circle cx="310" cy="552" r="16"/>
    <path d="M660 90c50-30 120-10 140 40 50 0 90 50 70 100 40 40 10 110-50 105-20 45-100 55-130 15-60 15-110-35-90-90-45-30-30-100 25-110 0-35 15-55 35-60z"/>
    <path d="M760 360l-10 150c-2 22 30 22 30 0l6-140z"/><circle cx="765" cy="520" r="18"/>
    <path d="M420 250c40-20 100 0 110 45 45 5 60 55 30 85 20 45-40 80-80 55-40 30-110 0-100-50-40-15-40-75 5-85 5-30 15-45 35-50z"/>
    <circle cx="120" cy="330" r="26"/><circle cx="880" cy="250" r="22"/><circle cx="560" cy="120" r="18"/><circle cx="600" cy="480" r="24"/>
  </g>
  <g fill="#b7a6ff" opacity=".35">
    <ellipse cx="230" cy="170" rx="30" ry="16"/><ellipse cx="700" cy="140" rx="34" ry="18"/><ellipse cx="455" cy="290" rx="22" ry="12"/>
  </g>
</svg>`;

interface Prev {
  phase: string; position: number; racers: number; lap: number; laps: number; timer: string;
  splits: number; item: ItemId | null; uses: number; roulette: boolean; coins: number; speed: number;
  drift: number; boosting: boolean; star: boolean; shrunk: boolean; wrong: boolean; ink: number;
  finalBanner: boolean; finished: boolean; ghost: string; toastId: number; toastOn: boolean;
  standingsKey: string; standingsOrder: string; countdown: number | null; fps: string;
}

function freshPrev(): Prev {
  return {
    phase: '', position: 0, racers: 0, lap: -1, laps: -1, timer: '', splits: 0, item: null, uses: -1,
    roulette: false, coins: -1, speed: -1, drift: -1, boosting: false, star: false, shrunk: false, wrong: false,
    ink: -1, finalBanner: false, finished: false, ghost: '', toastId: -1, toastOn: false,
    standingsKey: '', standingsOrder: '', countdown: null, fps: '',
  };
}

export class Hud {
  readonly el: HTMLElement;
  private readonly minimap = new Minimap('hud-map');
  private prev: Prev = freshPrev();
  private opts: HudOptions;

  // elements
  private readonly posNum: HTMLElement;
  private readonly posBox: HTMLElement;
  private readonly lapCur: HTMLElement;
  private readonly lapMax: HTMLElement;
  private readonly lapBox: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly splits: HTMLElement;
  private readonly splitFlash: HTMLElement;
  private readonly itemBox: HTMLElement;
  private readonly itemIcons = new Map<ItemId, HTMLElement>();
  private readonly itemUses: HTMLElement;
  private readonly coinNum: HTMLElement;
  private readonly coinBox: HTMLElement;
  private readonly speedBox: HTMLElement;
  private readonly speedNum: HTMLElement;
  private readonly speedArc: SVGPathElement | null;
  private readonly drift: HTMLElement;
  private readonly boostFx: HTMLElement;
  private readonly starFx: HTMLElement;
  private readonly inkFx: HTMLElement;
  private readonly shrunk: HTMLElement;
  private readonly wrong: HTMLElement;
  private readonly finalBanner: HTMLElement;
  private readonly finish: HTMLElement;
  private readonly finishPos: HTMLElement;
  private readonly ghost: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly count: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly fps: HTMLElement;
  private stripSlots = new Map<number, HTMLElement>();
  private rouletteShown: ItemId | null = null;
  private rouletteNext = 0;
  private toastTimer = 0;
  private fpsNext = 0;
  private countTimer = 0;

  constructor(opts: HudOptions) {
    this.opts = opts;
    const el = h('div', `hud hud--p${opts.player + 1} ${opts.duo ? 'hud--duo' : 'hud--single'} hud--${opts.mode}${opts.items === false ? ' hud--noitems' : ''}`);
    el.setAttribute('aria-hidden', 'true');
    this.el = el;

    // Full-screen effects
    this.inkFx = h('div', 'hud-ink');
    this.inkFx.innerHTML = INK_BLOBS;
    this.starFx = h('div', 'hud-star');
    // edge glow only: the renderer draws the radial speed lines (DOM streaks didn't converge on the
    // vanishing point and doubled up with them)
    this.boostFx = h('div', 'hud-boost');
    el.append(h('div', 'hud__fx', this.boostFx, this.starFx, this.inkFx));

    // Standings strip
    this.strip = h('div', 'hud-strip');
    el.append(this.strip);

    // Top-left: item + coins + shrunk
    const reel = h('div', 'hud-item__reel');
    for (const id of ITEM_IDS) {
      const ic = svg(itemSvg(id), 'hud-item__icon');
      ic.hidden = true;
      this.itemIcons.set(id, ic);
      reel.append(ic);
    }
    this.itemBox = h('div', 'hud-item__box', h('span', 'hud-item__empty'), reel);
    this.itemUses = h('div', 'hud-item__uses', h('i'), h('i'), h('i'));
    this.itemUses.hidden = true;
    this.coinNum = h('b', 'hud-coins__num', '0');
    this.coinBox = h('div', 'hud-coins', svg(COIN_SVG, 'hud-coins__ico'), h('span', 'hud-coins__x', '×'), this.coinNum);
    this.shrunk = h('div', 'hud-shrunk', svg(ICON.bolt, 'ico'), h('span', null, '작아졌어요!'));
    this.shrunk.hidden = true;
    el.append(h('div', 'hud-tl', h('div', 'hud-item', this.itemBox, this.itemUses), this.coinBox, this.shrunk));

    // Top-right: lap, timer, splits
    this.lapCur = h('b', 'hud-lap__cur', '1');
    this.lapMax = h('span', 'hud-lap__max', '/3');
    this.lapBox = h('div', 'hud-lap', h('span', 'hud-lap__label', 'LAP'), this.lapCur, this.lapMax);
    this.timer = h('div', 'hud-timer', '00:00.000');
    this.splits = h('ol', 'hud-splits');
    this.splitFlash = h('div', 'hud-splitflash');
    el.append(h('div', 'hud-tr', this.lapBox, this.timer, this.splitFlash, this.splits));

    // Top-centre: ghost delta + toast + pause
    this.ghost = h('div', 'hud-ghost');
    this.ghost.hidden = true;
    this.toast = h('div', 'hud-toast');
    this.toast.hidden = true;
    const tc = h('div', 'hud-tc', this.ghost, this.toast);
    el.append(tc);
    if (opts.onPause) {
      const pause = h('button', 'hud-pause');
      pause.type = 'button';
      pause.tabIndex = -1;
      pause.setAttribute('aria-label', '일시 정지');
      pause.append(svg(ICON.pause, 'ico'));
      pause.addEventListener('click', () => opts.onPause?.());
      el.append(pause);
    }

    // Bottom-left: speedometer + drift
    const gauge = h('span', 'hud-speed__gauge');
    gauge.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
      <path d="M21.7 78.3 A40 40 0 1 1 78.3 78.3" fill="none" stroke="rgba(27,16,54,.55)" stroke-width="12" stroke-linecap="round"/>
      <path class="hud-speed__arc" d="M21.7 78.3 A40 40 0 1 1 78.3 78.3" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${ARC_LEN}"/>
    </svg>`;
    this.speedArc = gauge.querySelector('.hud-speed__arc');
    this.speedNum = h('b', 'hud-speed__num', '0');
    this.speedBox = h('div', 'hud-speed', gauge, h('span', 'hud-speed__read', this.speedNum, h('small', null, 'km/h')));
    this.drift = h('div', 'hud-drift', h('i'), h('i'), h('i'));
    el.append(h('div', 'hud-bl', this.speedBox, this.drift));

    // Bottom-right: minimap + position
    this.posNum = h('b', 'hud-pos__num', '1');
    this.posBox = h('div', 'hud-pos', this.posNum, h('span', 'hud-pos__suffix', '위'));
    el.append(h('div', 'hud-br', this.minimap.canvas, this.posBox));

    // Centre banners
    this.count = h('div', 'hud-count');
    this.count.hidden = true;
    this.intro = h('div', 'hud-intro');
    this.intro.hidden = true;
    this.finalBanner = h('div', 'hud-final', h('span', 'hud-final__ko', '마지막 랩!'), h('span', 'hud-final__en', 'FINAL LAP'));
    this.finalBanner.hidden = true;
    this.wrong = h('div', 'hud-wrong', svg(ICON.restart, 'ico'), h('span', null, '역주행!'));
    this.wrong.hidden = true;
    this.finishPos = h('span', 'hud-finish__pos');
    this.finish = h('div', 'hud-finish', h('span', 'hud-finish__text', 'FINISH!'), this.finishPos);
    this.finish.hidden = true;
    el.append(h('div', 'hud-center', this.intro, this.count, this.finalBanner, this.wrong, this.finish));

    this.fps = h('div', 'hud-fps');
    this.fps.hidden = !opts.showFps;
    el.append(this.fps);
    this.applyOptions();
  }

  setIntro(title: string, sub: string, hint: string): void {
    this.intro.replaceChildren(
      h('span', 'hud-intro__sub', sub),
      h('strong', 'hud-intro__title', title),
      h('span', 'hud-intro__hint', hint),
    );
  }

  setOptions(patch: Partial<HudOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.applyOptions();
  }

  private applyOptions(): void {
    this.speedBox.hidden = !this.opts.showSpeed;
    this.fps.hidden = !this.opts.showFps;
  }

  setTrack(t: BuiltTrack | null): void {
    this.minimap.setTrack(t);
  }

  /** Clear all transient state (restart): every element goes back to its idle look. */
  reset(): void {
    this.prev = freshPrev();
    clearTimeout(this.countTimer);
    this.splits.replaceChildren();
    this.splitFlash.replaceChildren();
    this.finish.hidden = true;
    this.finalBanner.hidden = true;
    this.count.hidden = true;
    this.toast.hidden = true;
    this.wrong.hidden = true;
    this.shrunk.hidden = true;
    this.ghost.hidden = true;
    this.inkFx.hidden = true;
    this.inkFx.style.opacity = '0';
    this.el.classList.remove('is-boosting', 'is-star');
    this.drift.dataset.level = '0';
    this.itemBox.classList.remove('is-rolling', 'has-item');
    this.itemUses.hidden = true;
    for (const ic of this.itemIcons.values()) ic.hidden = true;
    this.rouletteShown = null;
    this.toastTimer = 0;
  }

  update(s: HudSnapshot, fps: number): void {
    const p = this.prev;
    const now = performance.now();

    if (s.phase !== p.phase) {
      this.el.dataset.phase = s.phase;
      this.intro.hidden = s.phase !== 'intro';
      if (s.phase === 'intro') animate(this.intro, [{ transform: 'translateY(30%) scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 500, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      p.phase = s.phase;
    }

    // Position
    if (s.position !== p.position || s.racers !== p.racers) {
      const tone = positionTone(s.position);
      this.posNum.textContent = String(s.position);
      this.posBox.dataset.tone = tone;
      this.posBox.hidden = s.racers <= 1;
      if (p.position !== 0 && s.position !== p.position) {
        const up = s.position < p.position;
        animate(this.posBox, [
          { transform: `scale(${up ? 1.45 : 0.8}) rotate(${up ? -8 : 6}deg)` },
          { transform: 'scale(.94) rotate(2deg)', offset: 0.55 },
          { transform: 'scale(1) rotate(0)' },
        ], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      }
      p.position = s.position;
      p.racers = s.racers;
    }

    // Lap
    if (s.lap !== p.lap || s.laps !== p.laps) {
      this.lapCur.textContent = String(Math.max(1, Math.min(s.lap, s.laps)));
      this.lapMax.textContent = `/${s.laps}`;
      this.lapBox.classList.toggle('is-final', s.lap >= s.laps && s.laps > 1);
      if (p.lap > 0 && s.lap > p.lap) animate(this.lapBox, [{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      p.lap = s.lap;
      p.laps = s.laps;
    }

    // Timer
    const t = formatMs(Math.max(0, s.raceMs));
    if (t !== p.timer) {
      this.timer.textContent = t;
      p.timer = t;
    }

    // Lap splits
    if (s.lapMs.length !== p.splits) {
      if (s.lapMs.length < p.splits) this.splits.replaceChildren();
      for (let i = this.splits.children.length; i < s.lapMs.length; i++) {
        const ms = s.lapMs[i]!;
        const best = s.bestLapMs !== null && ms <= s.bestLapMs;
        this.splits.append(h('li', best ? 'is-best' : '', h('span', null, `L${i + 1}`), h('b', null, formatMs(ms))));
        if (i === s.lapMs.length - 1) this.flashSplit(i + 1, ms, best && s.lapMs.length > 1);
      }
      // Re-mark best
      Array.from(this.splits.children).forEach((li, i) => li.classList.toggle('is-best', s.bestLapMs !== null && s.lapMs[i] === s.bestLapMs && s.lapMs.length > 1));
      while (this.splits.children.length > 3 && this.splits.firstElementChild) this.splits.firstElementChild.remove();
      p.splits = s.lapMs.length;
    }

    // Item slot
    this.updateItem(s, now);

    // Coins
    if (s.coins !== p.coins) {
      this.coinNum.textContent = String(s.coins);
      this.coinBox.classList.toggle('is-max', s.coins >= 10);
      if (p.coins >= 0 && s.coins !== p.coins) {
        animate(this.coinBox, s.coins > p.coins
          ? [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }]
          : [{ transform: 'translateX(-6%)' }, { transform: 'translateX(6%)' }, { transform: 'none' }],
        { duration: 260, easing: 'ease-out' });
      }
      p.coins = s.coins;
    }

    // Speed
    if (this.opts.showSpeed) {
      const kmh = Math.max(0, Math.round(s.speedKmh));
      if (kmh !== p.speed) {
        this.speedNum.textContent = String(kmh);
        const frac = Math.min(1, kmh / SPEED_FULL_SCALE);
        this.speedArc?.setAttribute('stroke-dasharray', `${(frac * ARC_LEN).toFixed(1)} ${ARC_LEN}`);
        p.speed = kmh;
      }
    }

    // Drift + boost
    if (s.driftLevel !== p.drift) {
      this.drift.dataset.level = String(s.driftLevel);
      if (s.driftLevel > p.drift && s.driftLevel > 0) animate(this.drift, [{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
      p.drift = s.driftLevel;
    }
    if (s.boosting !== p.boosting) {
      this.el.classList.toggle('is-boosting', s.boosting);
      if (s.boosting) animate(this.boostFx, [{ opacity: 1 }, { opacity: 0.55 }], { duration: 380, easing: 'ease-out' });
      p.boosting = s.boosting;
    }
    if (s.starActive !== p.star) {
      this.el.classList.toggle('is-star', s.starActive);
      p.star = s.starActive;
    }
    if (s.shrunk !== p.shrunk) {
      this.shrunk.hidden = !s.shrunk;
      if (s.shrunk) animate(this.shrunk, [{ transform: 'scale(1.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      p.shrunk = s.shrunk;
    }
    if (s.wrongWay !== p.wrong) {
      this.wrong.hidden = !s.wrongWay;
      p.wrong = s.wrongWay;
    }
    const ink = Math.round(Math.max(0, Math.min(1, s.ink)) * 50) / 50;
    if (ink !== p.ink) {
      this.inkFx.style.opacity = String(ink);
      this.inkFx.hidden = ink <= 0;
      if (p.ink <= 0 && ink > 0) animate(this.inkFx, [{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
      p.ink = ink;
    }

    // Final lap banner (rising edge)
    if (s.finalLapBanner !== p.finalBanner) {
      if (s.finalLapBanner) this.playFinalLap();
      else this.finalBanner.hidden = true;
      p.finalBanner = s.finalLapBanner;
    }

    // Finish
    if (s.finished !== p.finished) {
      if (s.finished) {
        const pos = s.finishPosition ?? s.position;
        this.finishPos.textContent = this.opts.mode === 'tt' ? formatMs(s.raceMs) : `${pos}위`;
        this.finish.dataset.tone = this.opts.mode === 'tt' ? 'gold' : positionTone(pos);
        this.finish.hidden = false;
        this.wrong.hidden = true;
        animate(this.finish, [
          { transform: 'scale(2.4) rotate(-10deg)', opacity: 0 },
          { transform: 'scale(.92) rotate(2deg)', opacity: 1, offset: 0.6 },
          { transform: 'scale(1) rotate(-3deg)', opacity: 1 },
        ], { duration: 650, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'both' });
      } else {
        this.finish.hidden = true;
      }
      p.finished = s.finished;
    }

    // Ghost delta
    const ghost = s.ghostDeltaMs === null ? '' : formatDelta(s.ghostDeltaMs).text;
    if (ghost !== p.ghost) {
      this.ghost.hidden = ghost === '';
      if (ghost !== '' && s.ghostDeltaMs !== null) {
        const d = formatDelta(s.ghostDeltaMs);
        this.ghost.textContent = d.text;
        this.ghost.dataset.sign = String(d.sign);
        animate(this.ghost, [{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      }
      p.ghost = ghost;
    }

    // Toast
    const toastOn = !!s.toast;
    if (s.toast && s.toast.id !== p.toastId) {
      this.toast.textContent = s.toast.text;
      this.toast.dataset.tone = s.toast.tone;
      this.toast.hidden = false;
      animate(this.toast, [{ transform: 'translateY(-40%) scale(.7)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      p.toastId = s.toast.id;
      this.toastTimer = now + 2600;
    }
    if ((!toastOn && p.toastOn) || (toastOn && now > this.toastTimer && !this.toast.hidden)) this.toast.hidden = true;
    p.toastOn = toastOn;

    // Countdown
    if (s.countdown !== p.countdown) {
      if (s.countdown !== null) {
        const go = s.countdown === 0;
        this.count.textContent = go ? 'GO!' : String(s.countdown);
        this.count.dataset.n = String(s.countdown);
        this.count.hidden = false;
        clearTimeout(this.countTimer);
        animate(this.count, go
          ? [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.35 }, { transform: 'scale(1.05)', opacity: 1, offset: 0.8 }, { transform: 'scale(1.6)', opacity: 0 }]
          : [{ transform: 'scale(2.2)', opacity: 0 }, { transform: 'scale(.9)', opacity: 1, offset: 0.35 }, { transform: 'scale(1)', opacity: 1, offset: 0.8 }, { transform: 'scale(.8)', opacity: 0 }],
        { duration: go ? 1000 : 980, easing: 'ease-out', fill: 'forwards' });
        if (prefersReducedMotion()) this.countTimer = window.setTimeout(() => { this.count.hidden = true; }, 900);
      } else {
        this.count.hidden = true;
      }
      p.countdown = s.countdown;
    }

    // Standings strip
    this.updateStrip(s);

    // Minimap
    this.minimap.draw(s, this.opts.player);

    // FPS (4 Hz)
    if (this.opts.showFps && now >= this.fpsNext) {
      this.fpsNext = now + 250;
      const f = `${Math.round(fps)} FPS`;
      if (f !== p.fps) { this.fps.textContent = f; p.fps = f; }
    }
  }

  private updateItem(s: HudSnapshot, now: number): void {
    const p = this.prev;
    if (s.roulette) {
      if (!p.roulette) {
        this.itemBox.classList.add('is-rolling');
        this.rouletteNext = 0;
      }
      if (now >= this.rouletteNext) {
        this.rouletteNext = now + 75;
        let next = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)]!;
        if (next === this.rouletteShown) next = ITEM_IDS[(ITEM_IDS.indexOf(next) + 1) % ITEM_IDS.length]!;
        this.showItemIcon(next);
      }
      p.roulette = true;
      this.itemUses.hidden = true;
      p.uses = -1; // re-evaluate on landing: a triple landing with the same count as before stayed hidden
      return;
    }
    const landed = p.roulette;
    if (landed) this.itemBox.classList.remove('is-rolling');
    p.roulette = false;
    if (s.item !== p.item || landed) {
      this.showItemIcon(s.item);
      this.itemBox.classList.toggle('has-item', !!s.item);
      if (s.item && (landed || p.item === null)) {
        animate(this.itemBox, [{ transform: 'scale(1.35) rotate(-6deg)' }, { transform: 'scale(.95) rotate(2deg)', offset: 0.6 }, { transform: 'scale(1) rotate(0)' }],
          { duration: 360, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      }
      p.item = s.item;
    }
    const uses = s.item ? s.itemUses : 0;
    if (uses !== p.uses) {
      const multi = !!s.item && /3$/.test(s.item);
      this.itemUses.hidden = !multi;
      Array.from(this.itemUses.children).forEach((d, i) => d.classList.toggle('is-on', i < uses));
      p.uses = uses;
    }
  }

  private showItemIcon(id: ItemId | null): void {
    if (id === this.rouletteShown) return;
    if (this.rouletteShown) {
      const old = this.itemIcons.get(this.rouletteShown);
      if (old) old.hidden = true;
    }
    this.rouletteShown = id;
    if (id) {
      const el = this.itemIcons.get(id);
      if (el) el.hidden = false;
    }
  }

  private flashSplit(lap: number, ms: number, best: boolean): void {
    const el = h('div', `hud-splitflash__item ${best ? 'is-best' : ''}`, h('span', null, `LAP ${lap}`), h('b', null, formatMs(ms)), best ? h('em', null, 'BEST') : null);
    this.splitFlash.replaceChildren(el);
    const a = animate(el, [
      { transform: 'translateX(40%)', opacity: 0 },
      { transform: 'translateX(0)', opacity: 1, offset: 0.1 },
      { opacity: 1, offset: 0.2 }, { opacity: 0.4, offset: 0.3 }, { opacity: 1, offset: 0.4 },
      { opacity: 1, offset: 0.85 },
      { transform: 'translateX(0)', opacity: 0 },
    ], { duration: 3000, easing: 'ease-out', fill: 'forwards' });
    if (a) a.onfinish = () => el.remove();
    else setTimeout(() => el.remove(), 3000);
  }

  private playFinalLap(): void {
    this.finalBanner.hidden = false;
    const a = animate(this.finalBanner, [
      { transform: 'translateX(110%) skewX(-12deg)', opacity: 0 },
      { transform: 'translateX(0) skewX(-12deg)', opacity: 1, offset: 0.18 },
      { transform: 'translateX(-4%) skewX(-12deg)', opacity: 1, offset: 0.82 },
      { transform: 'translateX(-120%) skewX(-12deg)', opacity: 0 },
    ], { duration: 2600, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    if (a) a.onfinish = () => { this.finalBanner.hidden = true; };
    else setTimeout(() => { this.finalBanner.hidden = true; }, 2600);
  }

  private updateStrip(s: HudSnapshot): void {
    const p = this.prev;
    const key = s.standings.map(r => `${r.kart}:${r.charId}:${r.human}`).sort().join('|');
    if (key !== p.standingsKey) {
      this.strip.replaceChildren();
      this.stripSlots.clear();
      this.strip.style.setProperty('--n', String(Math.max(1, s.standings.length)));
      this.strip.hidden = s.standings.length <= 1;
      for (const r of s.standings) {
        const slot = h('div', `hud-strip__slot ${r.human >= 0 ? `is-human is-p${r.human + 1}` : ''}`,
          h('span', 'hud-strip__rank'), portrait(r.charId, 'portrait hud-strip__portrait'));
        slot.style.setProperty('--c-body', getCharacter(r.charId).colors.body);
        this.stripSlots.set(r.kart, slot);
        this.strip.append(slot);
      }
      p.standingsKey = key;
      p.standingsOrder = '';
    }
    const order = s.standings.map(r => `${r.kart}@${r.position}${r.finished ? 'f' : ''}`).join(',');
    if (order !== p.standingsOrder) {
      for (const r of s.standings) {
        const slot = this.stripSlots.get(r.kart);
        if (!slot) continue;
        slot.style.transform = `translateY(${(r.position - 1) * 100}%)`;
        const rank = slot.firstElementChild as HTMLElement;
        if (rank.textContent !== String(r.position)) rank.textContent = String(r.position);
        slot.classList.toggle('is-finished', r.finished);
      }
      p.standingsOrder = order;
    }
  }

  dispose(): void {
    this.minimap.dispose();
    clearTimeout(this.countTimer);
    this.el.remove();
  }
}
