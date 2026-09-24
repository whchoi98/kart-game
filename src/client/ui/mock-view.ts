/**
 * Mock GameView for the UI preview (src/client/ui-preview.html). Paints an animated 2D
 * backdrop and runs a fake race that produces plausible HudSnapshots — intro, countdown,
 * laps, item roulette, position swaps, final lap, finish — then calls onFinish with a
 * plausible RaceSummary. No three.js, no sim stepping.
 */
import { CHARACTERS, getCharacter } from '../../sim/characters.js';
import { COUNTDOWN_TICKS, TICK_HZ } from '../../sim/constants.js';
import { ITEM_IDS, ITEMS } from '../../sim/item-defs.js';
import { getTrackMeta } from '../../sim/tracks/catalog.js';
import type { BuiltTrack, CharacterId, ItemId, ProjectileKind, RaceResult } from '../../sim/types.js';
import type {
  GameView, HudSnapshot, InputManager, RaceStartOptions, RaceSummary, Settings,
} from '../contracts.js';
import { portraitSvg } from './art/portraits.js';
import { THEME_COLORS } from './art/track-draw.js';
import { seededRandom } from './grid.js';
import { tryBuiltTrack } from './thumb.js';

interface MockKart {
  kart: number;
  charId: CharacterId;
  human: number;
  progress: number;     // laps (float)
  pace: number;         // laps per second
  wobble: number;
  lapTicks: number[];
  lastLapTick: number;
  finishTick: number;
  lane: number;
}

interface HumanState {
  item: ItemId | null;
  itemUses: number;
  rouletteUntil: number;
  nextItemAt: number;
  useAt: number;
  coins: number;
  drift: 0 | 1 | 2 | 3;
  driftPhase: number;
  boostUntil: number;
  starUntil: number;
  shrunkUntil: number;
  inkUntil: number;
  wrongUntil: number;
  finalUntil: number;
  toast: HudSnapshot['toast'];
  toastUntil: number;
  lastPos: number;
  finishedAt: number;
}

const INTRO_TICKS = 100;
const LAP_SECONDS = 12;

interface SimTrack { xs: Float64Array; zs: Float64Array; n: number; built: BuiltTrack | null }

function simTrack(id: string, mirror: boolean): SimTrack {
  const t = tryBuiltTrack(id, mirror);
  if (t) return { xs: t.px, zs: t.pz, n: t.n, built: t };
  const n = 360;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xs[i] = Math.cos(a) * 160 + Math.cos(a * 3) * 22;
    zs[i] = Math.sin(a) * 100 + Math.sin(a * 2) * 30;
  }
  return { xs, zs, n, built: null };
}

/** Minimal BuiltTrack stand-in so the minimap works before real geometry exists. */
function fakeBuilt(t: SimTrack, trackId: string): BuiltTrack {
  const n = t.n;
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = t.xs[j]! - t.xs[i]!;
    const dz = t.zs[j]! - t.zs[i]!;
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
  }
  let theme: BuiltTrack['def']['theme'] = 'meadow';
  try { theme = getTrackMeta(trackId).theme; } catch { /* default */ }
  const fake = {
    def: { id: trackId, theme, laps: 3 }, n, length: n, spacing: 1, startS: 0,
    px: t.xs, pz: t.zs, tx, tz, hw: new Float64Array(n).fill(9),
  };
  return fake as unknown as BuiltTrack;
}

export function createMockGameView(opts: { input?: InputManager; speed?: number } = {}): GameView {
  const speed = Math.max(0.25, Math.min(20, opts.speed ?? 1));
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let backdrop: { kind: 'title' | 'garage' | 'podium'; chars: CharacterId[] } = { kind: 'title', chars: [] };
  let settings: Settings | null = null;
  let race: MockRace | null = null;
  let lastOpts: RaceStartOptions | null = null;
  let paused = false;
  let fps = 60;
  let last = performance.now();
  let time = 0;
  const images = new Map<CharacterId, HTMLImageElement>();
  const img = (id: CharacterId) => {
    let im = images.get(id);
    if (!im) {
      im = new Image();
      im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg(id))}`;
      images.set(id, im);
    }
    return im;
  };

  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;
    time += dt;
    if (race && !paused) race.advance(dt * speed);
    draw();
  };

  function resize(): void {
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(): void {
    if (!canvas || !ctx) return;
    resize();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (race) {
      const humans = race.humanCount;
      if (humans > 1) {
        drawRoad(ctx, 0, 0, w, h / 2, race, 0);
        drawRoad(ctx, 0, h / 2, w, h / 2, race, 1);
      } else drawRoad(ctx, 0, 0, w, h, race, 0);
      return;
    }
    drawBackdrop(ctx, w, h);
  }

  function drawBackdrop(c: CanvasRenderingContext2D, w: number, h: number): void {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#5b3bd6');
    g.addColorStop(0.55, '#ff6fb1');
    g.addColorStop(1, '#ffb45e');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // sun
    c.fillStyle = 'rgba(255, 241, 170, 0.9)';
    c.beginPath();
    c.arc(w * 0.72, h * 0.42, Math.min(w, h) * 0.16, 0, Math.PI * 2);
    c.fill();
    // hills (parallax)
    const layers = [['#7b3dff', 0.62, 0.06, 0.2], ['#3b2a9a', 0.72, 0.09, 0.45], ['#1b1036', 0.84, 0.05, 0.9]] as const;
    for (const [col, base, amp, sp] of layers) {
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(0, h);
      for (let x = 0; x <= w; x += 16) c.lineTo(x, h * base + Math.sin(x * 0.006 + time * sp) * h * amp);
      c.lineTo(w, h);
      c.fill();
    }
    if (backdrop.kind === 'garage' && backdrop.chars[0]) {
      const id = backdrop.chars[0];
      const ch = getCharacter(id);
      const cx = w * 0.62;
      const cy = h * 0.58;
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.beginPath();
      c.ellipse(cx, cy + h * 0.2, w * 0.18, h * 0.05, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = ch.colors.body;
      const kartW = Math.min(w, h) * 0.34;
      const bob = Math.sin(time * 3) * 6;
      c.beginPath();
      c.roundRect(cx - kartW / 2, cy + h * 0.08 + bob, kartW, kartW * 0.32, 18);
      c.fill();
      const im = img(id);
      if (im.complete) c.drawImage(im, cx - kartW * 0.33, cy - kartW * 0.42 + bob, kartW * 0.66, kartW * 0.66);
    }
    if (backdrop.kind === 'podium') {
      const order = [1, 0, 2];
      const bw = Math.min(w * 0.12, 180);
      order.forEach((rank, i) => {
        const id = backdrop.chars[rank];
        if (!id) return;
        const x = w / 2 + (i - 1) * bw * 1.1 - bw / 2;
        const ph = [h * 0.28, h * 0.2, h * 0.14][rank]!;
        c.fillStyle = ['#ffcf33', '#d7e1ea', '#e39a5b'][rank]!;
        c.fillRect(x, h - ph - h * 0.08, bw, ph);
        const im = img(id);
        if (im.complete) c.drawImage(im, x + bw * 0.1, h - ph - h * 0.08 - bw * 0.85 + Math.sin(time * 4 + i) * 4, bw * 0.8, bw * 0.8);
      });
    }
  }

  function drawRoad(c: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, r: MockRace, player: number): void {
    const theme = THEME_COLORS[r.theme];
    c.save();
    c.beginPath();
    c.rect(x0, y0, w, h);
    c.clip();
    const horizon = y0 + h * 0.42;
    const sky = c.createLinearGradient(0, y0, 0, horizon);
    sky.addColorStop(0, theme.b);
    sky.addColorStop(1, theme.a);
    c.fillStyle = sky;
    c.fillRect(x0, y0, w, horizon - y0);
    c.fillStyle = theme.b;
    c.fillRect(x0, horizon, w, y0 + h - horizon);
    const k = r.karts.find(kk => kk.human === player);
    const travel = (k?.progress ?? 0) * 60;
    const curve = Math.sin((k?.progress ?? 0) * Math.PI * 4) * w * 0.12;
    for (let i = 0; i < 40; i++) {
      const t0 = i / 40;
      const t1 = (i + 1) / 40;
      const ya = horizon + (y0 + h - horizon) * t0 * t0;
      const yb = horizon + (y0 + h - horizon) * t1 * t1;
      const wa = w * (0.04 + t0 * t0 * 0.9);
      const wb = w * (0.04 + t1 * t1 * 0.9);
      const cxa = x0 + w / 2 + curve * (1 - t0);
      const cxb = x0 + w / 2 + curve * (1 - t1);
      const stripe = Math.floor(i * 0.5 + travel * 3) % 2 === 0;
      c.fillStyle = stripe ? '#6b6780' : '#5d5972';
      c.beginPath();
      c.moveTo(cxa - wa / 2, ya); c.lineTo(cxa + wa / 2, ya); c.lineTo(cxb + wb / 2, yb); c.lineTo(cxb - wb / 2, yb);
      c.fill();
      c.fillStyle = stripe ? '#ffffff' : '#ff3d8b';
      c.fillRect(cxa - wa / 2 - wa * 0.04, ya, wa * 0.04, yb - ya + 1);
      c.fillRect(cxa + wa / 2, ya, wa * 0.04, yb - ya + 1);
    }
    if (k) {
      const ch = getCharacter(k.charId);
      const kw = Math.min(w * 0.16, h * 0.34);
      const kx = x0 + w / 2 - kw / 2 + Math.sin(time * 2) * 6;
      const ky = y0 + h * 0.78;
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.beginPath(); c.ellipse(kx + kw / 2, ky + kw * 0.36, kw * 0.55, kw * 0.1, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = ch.colors.body;
      c.beginPath(); c.roundRect(kx, ky, kw, kw * 0.32, 14); c.fill();
      c.fillStyle = '#1b1036';
      c.fillRect(kx - kw * 0.06, ky + kw * 0.16, kw * 0.14, kw * 0.2);
      c.fillRect(kx + kw * 0.92, ky + kw * 0.16, kw * 0.14, kw * 0.2);
      const im = img(k.charId);
      if (im.complete) c.drawImage(im, kx + kw * 0.25, ky - kw * 0.42, kw * 0.5, kw * 0.5);
    }
    c.restore();
  }

  const view: GameView = {
    mount(container: HTMLElement) {
      if (canvas) return;
      canvas = document.createElement('canvas');
      container.append(canvas);
      ctx = canvas.getContext('2d');
      requestAnimationFrame(loop);
    },
    applySettings(s: Settings) { settings = s; void settings; },
    showBackdrop(kind, charId) {
      backdrop = { kind, chars: charId ? [charId] : CHARACTERS.map(c => c.id) };
    },
    showPodium(top3) {
      race = null;
      backdrop = { kind: 'podium', chars: top3.slice(0, 3) };
    },
    async startRace(o: RaceStartOptions) {
      race = null;
      paused = false;
      lastOpts = o;
      await new Promise(r => setTimeout(r, 450));
      race = new MockRace(o, opts.input ?? null);
    },
    skipIntro() { race?.skipIntro(); },
    pause() { paused = true; },
    resume() { paused = false; },
    get paused() { return paused; },
    get inRace() { return !!race; },
    restartRace() { if (lastOpts) { race = new MockRace(lastOpts, opts.input ?? null); paused = false; } },
    endRace() { race = null; paused = false; },
    hud(player: number) { return race ? race.snapshot(player) : null; },
    get track() { return race ? race.track : null; },
    get fps() { return fps; },
  };
  return view;
}

class MockRace {
  readonly karts: MockKart[];
  readonly laps: number;
  readonly theme: BuiltTrack['def']['theme'];
  readonly track: BuiltTrack;
  readonly humanCount: number;
  private readonly sim: SimTrack;
  private readonly humans: HumanState[] = [];
  private tick = 0; // ticks since countdown start (intro excluded)
  private introLeft = INTRO_TICKS;
  private acc = 0;
  private done = false;
  private doneAt = 0;
  private toastSeq = 1;
  private readonly rand: () => number;
  private finishCalled = false;

  constructor(private readonly o: RaceStartOptions, private readonly input: InputManager | null) {
    const cfg = o.config;
    this.rand = seededRandom(cfg.seed);
    this.sim = simTrack(cfg.trackId, cfg.mirror);
    this.track = this.sim.built ?? fakeBuilt(this.sim, cfg.trackId);
    this.laps = cfg.laps ?? this.sim.built?.def.laps ?? 3;
    let theme: BuiltTrack['def']['theme'] = 'meadow';
    try { theme = getTrackMeta(cfg.trackId).theme; } catch { /* default */ }
    this.theme = theme;
    const n = cfg.racers.length;
    this.karts = cfg.racers.map((r, i) => ({
      kart: i, charId: r.charId, human: r.human,
      progress: -(i + 1) * 0.004,
      pace: (1 / LAP_SECONDS) * (0.93 + this.rand() * 0.1 + (r.human >= 0 ? 0.02 : 0)),
      wobble: this.rand() * 10, lapTicks: [], lastLapTick: 0, finishTick: -1, lane: ((i % 3) - 1) * 4,
    }));
    this.humanCount = cfg.racers.filter(r => r.human >= 0).length;
    for (let p = 0; p < Math.max(1, this.humanCount); p++) {
      this.humans.push({
        item: cfg.mode === 'tt' ? 'nitro3' : null, itemUses: cfg.mode === 'tt' ? 3 : 0, rouletteUntil: 0,
        nextItemAt: COUNTDOWN_TICKS + 150 + p * 40, useAt: 0, coins: 0, drift: 0, driftPhase: this.rand() * 4,
        boostUntil: 0, starUntil: 0, shrunkUntil: 0, inkUntil: 0, wrongUntil: 0, finalUntil: 0,
        toast: null, toastUntil: 0, lastPos: 0, finishedAt: -1,
      });
    }
  }

  skipIntro(): void { this.introLeft = 0; }

  advance(dt: number): void {
    this.acc += dt;
    while (this.acc >= 1 / TICK_HZ) {
      this.acc -= 1 / TICK_HZ;
      this.step();
    }
  }

  private toast(p: number, text: string, tone: 'good' | 'bad' | 'info', ticks = 100): void {
    const h = this.humans[p];
    if (!h) return;
    h.toast = { text, tone, id: this.toastSeq++ };
    h.toastUntil = this.tick + ticks;
  }

  private raceTicks(): number { return Math.max(0, this.tick - COUNTDOWN_TICKS); }

  private step(): void {
    if (this.introLeft > 0) { this.introLeft--; return; }
    this.tick++;
    if (this.tick === COUNTDOWN_TICKS + 1) for (let p = 0; p < this.humans.length; p++) this.toast(p, '완벽한 스타트!', 'good', 90);
    if (this.tick <= COUNTDOWN_TICKS) return;
    const rt = this.raceTicks();
    const cfg = this.o.config;
    for (const k of this.karts) {
      if (k.finishTick >= 0) { k.progress += k.pace / TICK_HZ * 0.4; continue; }
      let pace = k.pace * (1 + Math.sin(rt / 90 + k.wobble) * 0.06);
      if (k.human >= 0) {
        const hs = this.humans[k.human]!;
        const inp = this.input?.poll(k.human, 1 / TICK_HZ);
        if (inp?.throttle) pace *= 1.05;
        if (inp?.brake) pace *= 0.6;
        if (rt < hs.boostUntil) pace *= 1.25;
        if (rt < hs.shrunkUntil) pace *= 0.85;
      }
      const before = Math.floor(k.progress);
      k.progress += pace / TICK_HZ;
      const after = Math.floor(k.progress);
      if (after > before && after >= 1) {
        k.lapTicks.push(rt - k.lastLapTick);
        k.lastLapTick = rt;
        if (k.human >= 0 && after === this.laps - 1) this.humans[k.human]!.finalUntil = rt + 150;
        if (after >= this.laps) {
          k.finishTick = rt;
          if (k.human >= 0) this.humans[k.human]!.finishedAt = rt;
        }
      }
    }
    // Scripted HUD events for humans
    this.humans.forEach((hs, p) => {
      if (hs.toast && this.tick > hs.toastUntil) hs.toast = null;
      if (hs.finishedAt >= 0) return;
      if (cfg.mode !== 'tt' && cfg.items && rt >= hs.nextItemAt && !hs.item && hs.rouletteUntil === 0) {
        hs.rouletteUntil = rt + 114;
      }
      if (hs.rouletteUntil > 0 && rt >= hs.rouletteUntil) {
        hs.rouletteUntil = 0;
        hs.item = ITEM_IDS[Math.floor(this.rand() * ITEM_IDS.length)]!;
        hs.itemUses = ITEMS[hs.item].uses;
        hs.useAt = rt + 180;
      }
      if (hs.item && rt >= hs.useAt && hs.useAt > 0) {
        const it = hs.item;
        hs.itemUses--;
        if (it === 'star') hs.starUntil = rt + 300;
        if (it === 'nitro' || it === 'nitro3') hs.boostUntil = rt + 80;
        if (it === 'coins') hs.coins = Math.min(10, hs.coins + 3);
        if (hs.itemUses <= 0) { hs.item = null; hs.nextItemAt = rt + 240 + Math.floor(this.rand() * 200); hs.useAt = 0; }
        else hs.useAt = rt + 60;
      }
      // drift cycle
      const cyc = ((rt / 60 + hs.driftPhase) % 5);
      const nextDrift = cyc < 1 ? 0 : cyc < 2 ? 1 : cyc < 3 ? 2 : cyc < 3.8 ? 3 : 0;
      if (hs.drift === 3 && nextDrift === 0) hs.boostUntil = rt + 60;
      hs.drift = nextDrift as 0 | 1 | 2 | 3;
      if (rt % 170 === 37) hs.coins = Math.min(10, hs.coins + 1);
      if (rt === 900 && cfg.mode !== 'tt') { hs.inkUntil = rt + 240; this.toast(p, '먹물을 맞았어요!', 'bad'); }
      if (rt === 1300 && p === 0) { hs.wrongUntil = rt + 110; }
      if (rt === 1700 && cfg.mode !== 'tt') { hs.shrunkUntil = rt + 180; this.toast(p, '번개에 맞았어요!', 'bad'); }
    });
    // done?
    const humansDone = this.karts.filter(k => k.human >= 0).every(k => k.finishTick >= 0);
    if (humansDone && !this.done) { this.done = true; this.doneAt = rt; }
    if (this.done && !this.finishCalled && rt - this.doneAt > 180) {
      this.finishCalled = true;
      const summary = this.summary();
      setTimeout(() => this.o.onFinish(summary), 0);
    }
  }

  private order(): MockKart[] {
    return [...this.karts].sort((a, b) => {
      if (a.finishTick >= 0 && b.finishTick >= 0) return a.finishTick - b.finishTick;
      if (a.finishTick >= 0) return -1;
      if (b.finishTick >= 0) return 1;
      return b.progress - a.progress;
    });
  }

  private positionOf(k: MockKart, order = this.order()): number {
    return order.indexOf(k) + 1;
  }

  private worldPos(k: MockKart): { x: number; z: number } {
    const frac = ((k.progress % 1) + 1) % 1;
    const i = Math.floor(frac * this.sim.n) % this.sim.n;
    return { x: this.sim.xs[i]! + k.lane, z: this.sim.zs[i]! + k.lane * 0.5 };
  }

  snapshot(player: number): HudSnapshot | null {
    const k = this.karts.find(kk => kk.human === player);
    const hs = this.humans[player];
    if (!k || !hs) return null;
    const order = this.order();
    const rt = this.raceTicks();
    const position = this.positionOf(k, order);
    const finished = k.finishTick >= 0;
    const countdown = this.introLeft > 0 ? null
      : this.tick < 60 ? 3 : this.tick < 120 ? 2 : this.tick < COUNTDOWN_TICKS ? 1 : this.tick < COUNTDOWN_TICKS + 60 ? 0 : null;
    const lapMs = k.lapTicks.map(t => Math.round((t * 1000) / TICK_HZ));
    const ms = (t: number) => Math.round((t * 1000) / TICK_HZ);
    const projectiles: Array<{ x: number; z: number; kind: ProjectileKind }> = [];
    if (rt > 300) {
      const pk = order[0]!;
      const p = this.worldPos({ ...pk, progress: pk.progress - 0.03 });
      projectiles.push({ x: p.x, z: p.z, kind: 'banana' });
    }
    return {
      player, kart: k.kart, charId: k.charId,
      phase: this.introLeft > 0 ? 'intro' : finished ? 'finished' : this.tick < COUNTDOWN_TICKS ? 'countdown' : 'racing',
      countdown,
      position, racers: this.karts.length,
      lap: Math.max(1, Math.min(this.laps, Math.floor(k.progress) + 1)), laps: this.laps,
      raceMs: ms(finished ? k.finishTick : rt), currentLapMs: ms(rt - k.lastLapTick), lapMs,
      bestLapMs: lapMs.length ? Math.min(...lapMs) : null,
      item: hs.rouletteUntil > 0 ? null : hs.item, itemUses: hs.itemUses, roulette: hs.rouletteUntil > 0,
      coins: hs.coins,
      speedKmh: this.tick < COUNTDOWN_TICKS ? 0 : (rt < hs.boostUntil ? 188 : 148) + Math.sin(rt / 30) * 6,
      driftLevel: hs.drift, boosting: rt < hs.boostUntil,
      starActive: rt < hs.starUntil, shrunk: rt < hs.shrunkUntil, wrongWay: rt < hs.wrongUntil,
      ink: rt < hs.inkUntil ? Math.min(1, (hs.inkUntil - rt) / 120) : 0,
      finalLapBanner: rt < hs.finalUntil && !finished,
      finished, finishPosition: finished ? position : null,
      ghostDeltaMs: this.o.ghost ? Math.round(Math.sin(rt / 200) * 400) : null,
      toast: hs.toast,
      standings: order.map((kk, i) => ({ kart: kk.kart, charId: kk.charId, human: kk.human, position: i + 1, finished: kk.finishTick >= 0 })),
      minimap: {
        karts: this.karts.map(kk => ({ ...this.worldPos(kk), charId: kk.charId, human: kk.human, position: this.positionOf(kk, order), kart: kk.kart })),
        projectiles,
        // time trial: the ghost trails the player by a little (preview of the minimap ghost dot)
        ghost: this.o.ghost ? { ...this.worldPos({ ...k, lane: 0, progress: k.progress - 0.04 - Math.sin(rt / 240) * 0.02 }), charId: this.o.ghost.charId } : null,
      },
    };
  }

  private summary(): RaceSummary {
    const order = this.order();
    const rt = this.raceTicks();
    const results: RaceResult[] = order.map((k, i) => {
      const estimated = k.finishTick < 0;
      const ticks = estimated ? Math.round(rt + ((this.laps - k.progress) / k.pace) * TICK_HZ) : k.finishTick;
      const lapTicks = k.lapTicks.slice(0, this.laps);
      return {
        kart: k.kart, charId: k.charId, human: k.human, position: i + 1, ticks, estimated,
        lapTicks, bestLapTicks: lapTicks.length ? Math.min(...lapTicks) : 0,
      };
    });
    const cfg = this.o.config;
    const me = results.find(r => r.human === 0);
    const bytes = new Uint8Array(96);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(this.rand() * 256);
    const log = btoa(String.fromCharCode(...bytes));
    return {
      config: cfg,
      results,
      timeTrial: cfg.mode === 'tt' && me ? {
        trackId: cfg.trackId, cc: cfg.cc, charId: me.charId, ticks: me.ticks, lapTicks: me.lapTicks, log,
      } : null,
    };
  }
}
