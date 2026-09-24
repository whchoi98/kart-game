/**
 * Pooled particle system: two THREE.Points layers (normal-blend + additive) sharing one
 * procedural atlas. No per-frame allocation: all particle state lives in preallocated
 * typed arrays, dead particles are swap-removed so the live range is always [0, count).
 *
 * Atlas (4x2 cells, R = tintable luminance, G = white-hot/highlight, A = alpha):
 *   0 glow   1 puff   2 star   3 streak   4 confetti rect   5 shard   6 ring   7 droplet
 */
import * as THREE from 'three';
import type { ParticleKind, ParticleSystem, RenderQuality } from './contracts.js';
import { ENV_GROUP_NAME } from './renderer.js';

const SH_GLOW = 0, SH_PUFF = 1, SH_STAR = 2, SH_STREAK = 3, SH_RECT = 4, SH_SHARD = 5, SH_RING = 6, SH_DROP = 7;
const F_ALIGN = 1, F_SQUASH = 2, F_RAINBOW = 4, F_FLOOR = 8;
const MAX_TOTAL = 4000;

// ───────────────────────────── Presets ─────────────────────────────

type Mode = 'cone' | 'sphere' | 'ring';
interface Sub {
  layer: 0 | 1;            // 0 normal blend, 1 additive
  shape: number;
  frac?: number;           // share of the kind's count
  fixed?: number;          // absolute count (flashes, rings)
  life: [number, number];
  speed: [number, number];
  mode?: Mode;
  cone?: number;           // half angle (rad) for 'cone'
  gravity?: number;        // m/s² downward (negative rises)
  drag?: number;           // 1/s
  size: [number, number];  // start size (m)
  grow?: number;           // end size multiplier
  colors: string[];
  end?: string;
  alpha?: number;
  hot?: number;            // white-hot / highlight strength
  intensity?: number;      // HDR multiplier on the tint
  spin?: number;           // rad/s (random sign)
  jitter?: number;         // spawn radius (m)
  fadeIn?: number;         // fraction of life
  fadeOut?: number;        // fraction of life where fade-out starts
  align?: boolean;
  squash?: boolean;
  rainbow?: boolean;
  flutter?: number;        // m/s sway
  floor?: number;          // floor offset relative to emit y (bounce / settle)
  tint?: boolean;          // opts.color applies
}
interface KindDef { count: number; dir: [number, number, number]; subs: Sub[] }

const RAINBOW = ['#ff4d6d', '#ff9f1c', '#ffe66d', '#4cd964', '#4cc9f0', '#7b61ff', '#ff6ec7'];

const KINDS: Record<ParticleKind, KindDef> = {
  // Drift sparks double as the mini-turbo charge read-out, so they must read in daylight at the race
  // session's rate (count 1 per wheel per frame): a steady hot glow at the tyre plus flicking streaks.
  driftSpark: { count: 3, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_STREAK, frac: 1, life: [0.16, 0.32], speed: [3, 6.5], mode: 'cone', cone: 0.9, gravity: 14, drag: 1.5,
      size: [0.26, 0.36], grow: 0.4, colors: ['#ffc94d'], hot: 1.2, intensity: 2.6, align: true, jitter: 0.08, fadeOut: 0.4, floor: -0.35, tint: true },
    { layer: 1, shape: SH_GLOW, frac: 0.7, life: [0.06, 0.11], speed: [0.3, 1], mode: 'sphere',
      size: [0.42, 0.58], grow: 0.3, colors: ['#ffe29a'], hot: 1, intensity: 2.2, tint: true },
  ] },
  // Exhaust licks behind a boosting kart. Emitted with emitMoving() (the kart's velocity is inherited),
  // so they hug the nozzles at any speed; plain world-space emission left a dotted trail of separate
  // blobs 1–5 m behind the kart at 30+ m/s. The hot core stays low: with HDR intensity 2 + hot 0.9 the
  // stacked licks tone-mapped to white under night bloom (mini-turbo blue/purple no longer read).
  boostFlame: { count: 3, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_GLOW, frac: 1, life: [0.08, 0.15], speed: [2.5, 5], mode: 'cone', cone: 0.26, gravity: -3, drag: 6,
      size: [0.42, 0.58], grow: 0.4, colors: ['#fff0b8'], end: '#ff6a1f', alpha: 0.85, hot: 0.35, intensity: 1.5, jitter: 0.08, fadeIn: 0.05, fadeOut: 0.3, tint: true },
    { layer: 1, shape: SH_PUFF, frac: 0.34, life: [0.1, 0.18], speed: [1.5, 3], mode: 'cone', cone: 0.4, gravity: -2, drag: 4,
      size: [0.28, 0.36], grow: 1.3, colors: ['#ff8a3d'], end: '#ff2a10', alpha: 0.28, hot: 0.1, intensity: 1.2, spin: 3, jitter: 0.08, fadeOut: 0.25, tint: true },
  ] },
  dust: { count: 3, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_PUFF, frac: 1, life: [0.45, 0.85], speed: [0.8, 2.4], mode: 'cone', cone: 1.1, gravity: -0.6, drag: 2.8,
      size: [0.35, 0.5], grow: 2.8, colors: ['#d9c29a', '#cdb489'], end: '#e8dcc4', alpha: 0.55, spin: 1.2, jitter: 0.15, fadeIn: 0.12, fadeOut: 0.35, tint: true },
  ] },
  grassBits: { count: 4, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_SHARD, frac: 1, life: [0.35, 0.7], speed: [2.5, 5], mode: 'cone', cone: 0.8, gravity: 16, drag: 1.2,
      size: [0.13, 0.2], grow: 0.8, colors: ['#5fbf4a', '#7fd35c', '#3f9a35', '#a3e36a'], hot: 0.15, spin: 14, jitter: 0.12, fadeOut: 0.7, floor: -0.25, tint: true },
    { layer: 0, shape: SH_PUFF, frac: 0.25, life: [0.3, 0.5], speed: [0.5, 1.2], mode: 'cone', cone: 1, gravity: -0.3, drag: 3,
      size: [0.3, 0.4], grow: 2, colors: ['#b7d98f'], alpha: 0.35, spin: 1, jitter: 0.1, fadeIn: 0.1 },
  ] },
  snowPuff: { count: 4, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_PUFF, frac: 1, life: [0.5, 1.0], speed: [1.2, 3.2], mode: 'cone', cone: 1.0, gravity: 1.2, drag: 2.4,
      size: [0.35, 0.55], grow: 2.4, colors: ['#ffffff', '#eef6ff'], alpha: 0.85, spin: 1, jitter: 0.15, fadeIn: 0.05, fadeOut: 0.4, tint: true },
    { layer: 1, shape: SH_GLOW, frac: 0.5, life: [0.4, 0.8], speed: [1.5, 3.5], mode: 'cone', cone: 1, gravity: 3, drag: 1.5,
      size: [0.07, 0.1], colors: ['#dff1ff'], hot: 0.8, intensity: 1.6, floor: -0.2 },
  ] },
  splash: { count: 16, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_DROP, frac: 0.75, life: [0.45, 0.85], speed: [3.5, 7.5], mode: 'cone', cone: 0.7, gravity: 17, drag: 0.6,
      size: [0.16, 0.28], grow: 0.7, colors: ['#bfeaff', '#9ad8f5'], alpha: 0.9, hot: 0.9, jitter: 0.3, fadeOut: 0.7, tint: true },
    { layer: 0, shape: SH_PUFF, frac: 0.25, life: [0.5, 0.9], speed: [1, 2.5], mode: 'cone', cone: 1.2, gravity: -0.3, drag: 2.5,
      size: [0.6, 0.9], grow: 2.2, colors: ['#e9f8ff'], alpha: 0.45, spin: 1, jitter: 0.3, fadeIn: 0.1 },
  ] },
  smoke: { count: 2, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_PUFF, frac: 1, life: [0.9, 1.6], speed: [0.5, 1.4], mode: 'cone', cone: 0.5, gravity: -1.4, drag: 1.2,
      size: [0.5, 0.7], grow: 3.2, colors: ['#77737d', '#6a6670'], end: '#a5a1ab', alpha: 0.5, spin: 0.8, jitter: 0.2, fadeIn: 0.15, fadeOut: 0.3, tint: true },
  ] },
  wallSpark: { count: 16, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_STREAK, frac: 1, life: [0.2, 0.5], speed: [4, 10], mode: 'cone', cone: 1.4, gravity: 14, drag: 1.2,
      size: [0.24, 0.32], grow: 0.35, colors: ['#ffe08a', '#ffd166', '#fff1c1'], hot: 1.2, intensity: 2.6, align: true, floor: -0.4, tint: true },
    { layer: 1, shape: SH_GLOW, fixed: 1, life: [0.07, 0.1], speed: [0, 0], size: [1.4, 1.6], grow: 1.5, colors: ['#fff2c4'], hot: 1, intensity: 2.5 },
  ] },
  explosion: { count: 60, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_GLOW, fixed: 1, life: [0.12, 0.16], speed: [0, 0], size: [5, 5], grow: 1.5, colors: ['#ffe7a8'], hot: 0.6, intensity: 2.1 },
    { layer: 1, shape: SH_PUFF, frac: 0.35, life: [0.35, 0.7], speed: [2.5, 8], mode: 'sphere', gravity: -2, drag: 4,
      size: [1.1, 1.6], grow: 2, colors: ['#ffd36b', '#ffb238'], end: '#e8401c', alpha: 0.9, hot: 0.25, intensity: 1.5, spin: 2, jitter: 0.5, fadeIn: 0.02, fadeOut: 0.3, tint: true },
    { layer: 0, shape: SH_PUFF, frac: 0.25, life: [1.2, 2.2], speed: [1.5, 5], mode: 'cone', cone: 1.3, gravity: -1.6, drag: 2.2,
      size: [1.2, 1.8], grow: 2.6, colors: ['#4b4552', '#5a5361'], end: '#938e9a', alpha: 0.62, spin: 0.8, jitter: 0.6, fadeIn: 0.12, fadeOut: 0.3 },
    { layer: 0, shape: SH_SHARD, frac: 0.18, life: [0.9, 1.4], speed: [6, 13], mode: 'cone', cone: 1.2, gravity: 18, drag: 0.5,
      size: [0.28, 0.45], grow: 0.9, colors: ['#3a3238', '#5b4a44', '#ff7a3d'], hot: 0.2, spin: 12, floor: -0.3 },
    { layer: 1, shape: SH_STREAK, frac: 0.22, life: [0.3, 0.7], speed: [8, 16], mode: 'sphere', gravity: 10, drag: 1.2,
      size: [0.3, 0.4], grow: 0.4, colors: ['#ffd166'], hot: 1.2, intensity: 2.8, align: true },
  ] },
  itemBoxBurst: { count: 30, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_SHARD, frac: 0.6, life: [0.55, 1.0], speed: [4, 8.5], mode: 'cone', cone: 1.5, gravity: 11, drag: 1.4,
      size: [0.3, 0.46], grow: 0.4, colors: RAINBOW, alpha: 0.95, hot: 0.7, spin: 13, jitter: 0.4, fadeOut: 0.55, floor: -0.9 },
    { layer: 1, shape: SH_STAR, frac: 0.3, life: [0.4, 0.75], speed: [2, 5], mode: 'sphere', gravity: 2, drag: 2.5,
      size: [0.35, 0.5], grow: 0.2, colors: ['#ffffff', '#fff6b0', '#bff6ff'], hot: 0.9, intensity: 2.2, spin: 4, jitter: 0.3 },
    { layer: 1, shape: SH_GLOW, fixed: 1, life: [0.12, 0.14], speed: [0, 0], size: [3, 3.2], grow: 1.3, colors: ['#ffffff'], hot: 0.6, intensity: 2 },
    { layer: 1, shape: SH_RING, fixed: 1, life: [0.22, 0.26], speed: [0, 0], size: [1, 1], grow: 3, colors: ['#fff6cf'], alpha: 0.6, hot: 0.3, intensity: 1.3, fadeOut: 0.15 },
  ] },
  coinSparkle: { count: 7, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_STAR, frac: 0.7, life: [0.35, 0.6], speed: [1.2, 3], mode: 'sphere', gravity: -0.5, drag: 3,
      size: [0.32, 0.44], grow: 0.1, colors: ['#ffe066', '#fff3b0'], hot: 1, intensity: 2.2, spin: 5, jitter: 0.2, tint: true },
    { layer: 1, shape: SH_GLOW, fixed: 1, life: [0.18, 0.22], speed: [0, 0], size: [1.3, 1.3], grow: 1.4, colors: ['#ffd23f'], hot: 0.6, intensity: 1.8, tint: true },
    { layer: 1, shape: SH_RING, fixed: 1, life: [0.24, 0.28], speed: [0, 0], size: [0.6, 0.6], grow: 3, colors: ['#ffe066'], alpha: 0.7, hot: 0.3, intensity: 1.5, fadeOut: 0.2, tint: true },
  ] },
  confetti: { count: 44, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_RECT, frac: 1, life: [3.2, 5], speed: [4, 9.5], mode: 'cone', cone: 0.55, gravity: 3.4, drag: 2.4,
      size: [0.2, 0.3], colors: ['#ff4d6d', '#ffd23f', '#3ddc97', '#4cc9f0', '#9b5de5', '#ff8fab', '#ff9f1c'], hot: 0.35, spin: 5,
      squash: true, flutter: 1.3, jitter: 0.5, fadeOut: 0.85, floor: -0.15, tint: true },
    { layer: 1, shape: SH_STAR, frac: 0.12, life: [0.9, 1.6], speed: [3, 7], mode: 'cone', cone: 0.7, gravity: 1.5, drag: 2,
      size: [0.3, 0.4], grow: 0.4, colors: ['#fff6b0'], hot: 0.8, intensity: 2, spin: 3, jitter: 0.4 },
  ] },
  starTrail: { count: 3, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_STAR, frac: 0.67, life: [0.35, 0.65], speed: [0.4, 1.4], mode: 'sphere', gravity: -0.4, drag: 2,
      size: [0.38, 0.52], grow: 0.2, colors: ['#ffffff'], hot: 0.25, intensity: 1.4, spin: 3, jitter: 0.35, rainbow: true },
    { layer: 1, shape: SH_GLOW, frac: 0.34, life: [0.25, 0.45], speed: [0.2, 0.6], mode: 'sphere',
      size: [0.7, 0.9], grow: 0.5, colors: ['#ffffff'], alpha: 0.6, hot: 0.05, intensity: 0.8, jitter: 0.3, rainbow: true },
  ] },
  shrinkPoof: { count: 16, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_PUFF, frac: 0.75, life: [0.45, 0.8], speed: [3, 5], mode: 'ring', gravity: -0.5, drag: 4,
      size: [0.45, 0.6], grow: 2.2, colors: ['#f3ecff', '#e0d4ff'], alpha: 0.8, spin: 2, jitter: 0.2, fadeIn: 0.05, tint: true },
    { layer: 1, shape: SH_RING, fixed: 1, life: [0.33, 0.37], speed: [0, 0], size: [0.6, 0.6], grow: 5, colors: ['#c9b6ff'], alpha: 0.7, hot: 0.3, intensity: 1.1, fadeOut: 0.15 },
    { layer: 1, shape: SH_STAR, frac: 0.25, life: [0.4, 0.7], speed: [2, 4], mode: 'sphere', drag: 2,
      size: [0.28, 0.36], grow: 0.2, colors: ['#e8dcff'], hot: 0.8, intensity: 2, spin: 5 },
  ] },
  inkSplat: { count: 14, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_DROP, frac: 0.8, life: [0.55, 1.0], speed: [3, 6.5], mode: 'cone', cone: 1.2, gravity: 13, drag: 1,
      size: [0.28, 0.5], grow: 0.8, colors: ['#2a1540', '#3a1b5c'], hot: 0.75, jitter: 0.25, fadeOut: 0.7, floor: -0.3, tint: true },
    { layer: 0, shape: SH_PUFF, frac: 0.2, life: [0.5, 0.8], speed: [1, 2], mode: 'cone', cone: 1.2, drag: 3,
      size: [0.6, 0.8], grow: 2, colors: ['#3b2352'], alpha: 0.5, spin: 1, jitter: 0.2, fadeIn: 0.1 },
  ] },
  landingDust: { count: 14, dir: [0, 1, 0], subs: [
    { layer: 0, shape: SH_PUFF, frac: 1, life: [0.45, 0.85], speed: [3, 5.5], mode: 'ring', gravity: -0.4, drag: 4.5,
      size: [0.4, 0.55], grow: 2.4, colors: ['#dccaa6', '#cfbb95'], end: '#ece3d2', alpha: 0.55, spin: 1.5, jitter: 0.3, fadeIn: 0.05, fadeOut: 0.35, tint: true },
  ] },
  lavaEmber: { count: 3, dir: [0, 1, 0], subs: [
    { layer: 1, shape: SH_GLOW, frac: 1, life: [1.1, 2.1], speed: [0.8, 2.4], mode: 'cone', cone: 0.5, gravity: -1, drag: 0.9,
      size: [0.14, 0.22], grow: 0.4, colors: ['#ffb000', '#ff7a00'], end: '#ff2a00', hot: 0.7, intensity: 2.4, flutter: 0.9, jitter: 0.6, fadeIn: 0.1, fadeOut: 0.5, tint: true },
  ] },
};

/** Resolved sub preset: colours converted to linear once. */
interface RSub extends Sub { cols: Float32Array; endCol: Float32Array | null }

const _c = new THREE.Color();
function linear(hex: string, out: Float32Array, o: number): void {
  _c.set(hex);
  out[o] = _c.r; out[o + 1] = _c.g; out[o + 2] = _c.b;
}
function resolveKinds(): Record<ParticleKind, { count: number; dir: [number, number, number]; subs: RSub[] }> {
  const out = {} as Record<ParticleKind, { count: number; dir: [number, number, number]; subs: RSub[] }>;
  for (const k of Object.keys(KINDS) as ParticleKind[]) {
    const def = KINDS[k];
    out[k] = {
      count: def.count, dir: def.dir,
      subs: def.subs.map(s => {
        const cols = new Float32Array(s.colors.length * 3);
        s.colors.forEach((h, i) => linear(h, cols, i * 3));
        let endCol: Float32Array | null = null;
        if (s.end) { endCol = new Float32Array(3); linear(s.end, endCol, 0); }
        return { ...s, cols, endCol };
      }),
    };
  }
  return out;
}

// ───────────────────────────── Atlas ─────────────────────────────

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.3 + vnoise(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.15;
}
const sat = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function shapeSample(shape: number, u: number, v: number, out: number[]): void {
  const r = Math.sqrt(u * u + v * v);
  let R = 1, G = 0, A = 0;
  switch (shape) {
    case SH_GLOW: {
      A = Math.pow(sat(1 - r), 2.2);
      G = Math.pow(sat(1 - r * 2.2), 2);
      break;
    }
    case SH_PUFF: {
      const n = fbm(u * 2.4 + 3.1, v * 2.4 + 1.7);
      const e = r + (n - 0.5) * 0.38;
      A = sstep(0.95, 0.4, e) * (0.78 + 0.22 * fbm(u * 5 + 2, v * 5 + 4));
      R = 0.74 + 0.26 * sat(0.5 + 0.5 * (v * 0.75 - u * 0.35));
      break;
    }
    case SH_STAR: {
      const th = Math.atan2(u, v); // 0 = pointing up
      const m = (th / (Math.PI * 2)) * 5;
      const f = m - Math.floor(m);
      const tri = Math.abs(f - 0.5) * 2;
      const rs = 0.42 + (0.93 - 0.42) * Math.pow(tri, 1.5);
      const star = sstep(rs + 0.05, rs - 0.05, r);
      const halo = 0.32 * Math.pow(sat(1 - r), 3);
      A = Math.max(star, halo);
      G = star * sstep(0.62, 0.0, r) * 0.9;
      break;
    }
    case SH_STREAK: {
      const e = Math.sqrt(u * u + (v / 0.16) * (v / 0.16));
      A = Math.pow(sat(1 - e), 1.3);
      const e2 = Math.sqrt((u / 0.75) * (u / 0.75) + (v / 0.06) * (v / 0.06));
      G = Math.pow(sat(1 - e2), 1.4);
      break;
    }
    case SH_RECT: {
      const hx = 0.78, hy = 0.48, cr = 0.12;
      const qx = Math.abs(u) - hx + cr, qy = Math.abs(v) - hy + cr;
      const sd = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - cr;
      A = sstep(0.03, -0.03, sd);
      R = 0.8 + 0.2 * (v * 0.5 + 0.5);
      G = 0.22 * sstep(0.12, 0.34, v) * A;
      break;
    }
    case SH_SHARD: {
      // triangle (0,0.9) (-0.8,-0.6) (0.78,-0.42)
      const ax = 0, ay = 0.9, bx = -0.8, by = -0.6, cx = 0.78, cy = -0.42;
      const edge = (x0: number, y0: number, x1: number, y1: number) => {
        const ex = x1 - x0, ey = y1 - y0;
        const len = Math.hypot(ex, ey);
        return ((v - y0) * ex - (u - x0) * ey) / len; // signed distance, > 0 outside (clockwise a→c→b)
      };
      const d1 = edge(ax, ay, cx, cy), d2 = edge(cx, cy, bx, by), d3 = edge(bx, by, ax, ay);
      const sd = Math.max(d1, d2, d3);
      A = sstep(0.03, -0.03, sd);
      R = 0.72 + 0.28 * (u * 0.55 + v * 0.45 > 0 ? 1 : 0);
      G = 0.5 * sstep(-0.22, -0.02, sd) * A;
      break;
    }
    case SH_RING: {
      A = Math.exp(-(((r - 0.72) / 0.11) ** 2));
      G = 0.45 * Math.exp(-(((r - 0.72) / 0.05) ** 2));
      break;
    }
    case SH_DROP: {
      A = sstep(0.86, 0.78, r);
      R = 0.95 - 0.35 * sstep(0.3, 0.85, r);
      G = 0.95 * Math.exp(-((u + 0.3) ** 2 + (v - 0.32) ** 2) * 22) + 0.12 * sstep(0.55, 0.8, r) * (v < 0 ? 1 : 0);
      break;
    }
  }
  out[0] = R; out[1] = G; out[2] = A;
}

function createAtlas(): THREE.CanvasTexture {
  const cell = 128, W = cell * 4, H = cell * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = [0, 0, 0];
  for (let s = 0; s < 8; s++) {
    const ox = (s % 4) * cell, oy = Math.floor(s / 4) * cell;
    for (let y = 0; y < cell; y++) {
      const v = ((y + 0.5) / cell) * 2 - 1;
      for (let x = 0; x < cell; x++) {
        const u = ((x + 0.5) / cell) * 2 - 1;
        // keep a transparent margin so mips don't bleed between cells
        if (Math.abs(u) > 0.96 || Math.abs(v) > 0.96) continue;
        shapeSample(s, u / 0.96, v / 0.96, px);
        const o = ((oy + y) * W + ox + x) * 4;
        img.data[o] = Math.round(sat(px[0]!) * 255);
        img.data[o + 1] = Math.round(sat(px[1]!) * 255);
        img.data[o + 2] = 0;
        img.data[o + 3] = Math.round(sat(px[2]!) * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;               // row index == +v (shader treats +y as up)
  tex.colorSpace = THREE.NoColorSpace;
  tex.premultiplyAlpha = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ───────────────────────────── Shaders ─────────────────────────────

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aParams;   // size (m), rotation, shape, squash
attribute vec4 aExtra;    // velocity (align) , hot
uniform vec2 uViewport;   // device px of the current viewport
varying vec4 vColor;
varying vec2 vRot;
varying float vShape;
varying float vHot;
varying float vYScale;
varying float vNear;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mvPosition.z, 0.05);
  // pull the sprite plane toward the camera by ~its radius so puffs aren't sliced flat by the ground
  mvPosition.z += min(aParams.x * 0.45, depth * 0.4);
  gl_Position = projectionMatrix * mvPosition;
  float sizePx = aParams.x * projectionMatrix[1][1] * uViewport.y * 0.5 / depth;
  float rot = aParams.y;
  float yScale = 1.0 / max(aParams.w, 0.08);
  if (dot(aExtra.xyz, aExtra.xyz) > 1e-6) {
    vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(position + aExtra.xyz * 0.035, 1.0));
    vec2 s1 = gl_Position.xy / max(gl_Position.w, 1e-3);
    vec2 s2 = c2.xy / max(c2.w, 1e-3);
    vec2 dpx = (s2 - s1) * uViewport * 0.5;
    float lenPx = length(dpx);
    if (lenPx > 0.01) rot = atan(dpx.y, dpx.x);
    float stretch = clamp(lenPx / max(sizePx * 0.5, 1.0), 1.0, 5.0);
    sizePx *= stretch;
    yScale *= stretch;
  }
  gl_PointSize = clamp(sizePx, 0.0, 420.0);
  vColor = aColor;
  vRot = vec2(cos(rot), sin(rot));
  vShape = aParams.z;
  vHot = aExtra.w;
  vYScale = yScale;
  // fade sprites that get close to the lens (no screen-filling blobs)
  vNear = smoothstep(0.35, 1.2 + aParams.x * 1.4, depth);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;
varying vec4 vColor;
varying vec2 vRot;
varying float vShape;
varying float vHot;
varying float vYScale;
varying float vNear;
#include <fog_pars_fragment>
void main() {
  vec2 q = gl_PointCoord - 0.5;
  q.y = -q.y;
  q = vec2(vRot.x * q.x + vRot.y * q.y, -vRot.y * q.x + vRot.x * q.y);
  q.y *= vYScale;
  if (abs(q.x) > 0.5 || abs(q.y) > 0.5) discard;
  float sh = floor(vShape + 0.5);
  vec2 cell = vec2(mod(sh, 4.0), floor(sh / 4.0));
  vec4 t = texture2D(uAtlas, (cell + q + 0.5) * vec2(0.25, 0.5));
  float a = t.a * vColor.a * vNear;
  if (a < 0.003) discard;
  vec3 col = vColor.rgb * t.r + vec3(t.g * vHot);
  #ifndef ADDITIVE
    col *= uLight;   // normal-blend puffs follow the scene's ambient + sun level (no glowing smoke at night)
  #endif
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    #ifdef ADDITIVE
      col *= 1.0 - fogF;
    #else
      col = mix(col, fogColor, fogF);
    #endif
  #endif
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ───────────────────────────── Layer ─────────────────────────────

const _vp = new THREE.Vector4();

/** Approximate light level for unlit sprites from the pipeline's environment lights (cached per scene). */
const _envCache = new WeakMap<THREE.Object3D, { group: THREE.Object3D; hemi: THREE.HemisphereLight | null; sun: THREE.DirectionalLight | null }>();
function sceneLight(scene: THREE.Object3D, out: THREE.Color): void {
  let c = _envCache.get(scene);
  if (!c || c.group.parent !== scene) {
    let group: THREE.Object3D | undefined;
    for (let i = 0; i < scene.children.length; i++) if (scene.children[i]!.name === ENV_GROUP_NAME) { group = scene.children[i]; break; }
    if (!group) { out.setRGB(1, 1, 1); return; }
    let hemi: THREE.HemisphereLight | null = null, sun: THREE.DirectionalLight | null = null;
    for (const ch of group.children) {
      if ((ch as THREE.HemisphereLight).isHemisphereLight) hemi = ch as THREE.HemisphereLight;
      else if ((ch as THREE.DirectionalLight).isDirectionalLight) sun = ch as THREE.DirectionalLight;
    }
    c = { group, hemi, sun };
    _envCache.set(scene, c);
  }
  let r = 0.1, g = 0.1, b = 0.12;
  if (c.hemi) { const k = c.hemi.intensity * 0.55; r += c.hemi.color.r * k; g += c.hemi.color.g * k; b += c.hemi.color.b * k; }
  if (c.sun) { const k = c.sun.intensity * 0.2; r += c.sun.color.r * k; g += c.sun.color.g * k; b += c.sun.color.b * k; }
  out.setRGB(Math.min(r, 1.1), Math.min(g, 1.1), Math.min(b, 1.1));
}

class Layer {
  readonly max: number;
  count = 0;
  private cursor = 0;
  // simulation state
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  /** Inherited emitter velocity (emitMoving): carried along undamped, no gravity. */
  readonly ux: Float32Array; readonly uy: Float32Array; readonly uz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly s0: Float32Array; readonly s1: Float32Array;
  readonly rot: Float32Array; readonly spin: Float32Array;
  readonly drag: Float32Array; readonly grav: Float32Array;
  readonly flutter: Float32Array; readonly phase: Float32Array;
  readonly alpha0: Float32Array; readonly fadeIn: Float32Array; readonly fadeOut: Float32Array;
  readonly hot: Float32Array; readonly floorY: Float32Array;
  readonly r0: Float32Array; readonly g0: Float32Array; readonly b0: Float32Array;
  readonly r1: Float32Array; readonly g1: Float32Array; readonly b1: Float32Array;
  readonly shape: Uint8Array; readonly flags: Uint8Array;
  private readonly all: Array<Float32Array | Uint8Array>;
  // GPU
  readonly geometry = new THREE.BufferGeometry();
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  private readonly aParams: THREE.BufferAttribute;
  private readonly aExtra: THREE.BufferAttribute;

  constructor(max: number, additive: boolean, atlas: THREE.Texture) {
    this.max = max;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.ux = f(); this.uy = f(); this.uz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.rot = f(); this.spin = f();
    this.drag = f(); this.grav = f(); this.flutter = f(); this.phase = f();
    this.alpha0 = f(); this.fadeIn = f(); this.fadeOut = f(); this.hot = f(); this.floorY = f();
    this.r0 = f(); this.g0 = f(); this.b0 = f(); this.r1 = f(); this.g1 = f(); this.b1 = f();
    this.shape = new Uint8Array(max); this.flags = new Uint8Array(max);
    this.all = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.ux, this.uy, this.uz, this.age, this.life, this.s0, this.s1,
      this.rot, this.spin, this.drag, this.grav, this.flutter, this.phase, this.alpha0, this.fadeIn, this.fadeOut,
      this.hot, this.floorY, this.r0, this.g0, this.b0, this.r1, this.g1, this.b1, this.shape, this.flags];

    const mk = (size: number) => {
      const a = new THREE.BufferAttribute(new Float32Array(max * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      // One persistent update range per attribute (three would otherwise allocate {start,count} every frame).
      a.updateRanges.push({ start: 0, count: 0 });
      a.clearUpdateRanges = function () { return this; };
      return a;
    };
    this.aPos = mk(3); this.aColor = mk(4); this.aParams = mk(4); this.aExtra = mk(4);
    this.geometry.setAttribute('position', this.aPos);
    this.geometry.setAttribute('aColor', this.aColor);
    this.geometry.setAttribute('aParams', this.aParams);
    this.geometry.setAttribute('aExtra', this.aExtra);
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      name: additive ? 'ParticlesAdd' : 'ParticlesNormal',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uAtlas: { value: null }, uViewport: { value: new THREE.Vector2(1280, 720) }, uLight: { value: new THREE.Color(1, 1, 1) } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.material.uniforms['uAtlas']!.value = atlas;
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = additive ? 'particles-add' : 'particles-normal';
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
    this.points.visible = false;
    const uViewport = this.material.uniforms['uViewport']!.value as THREE.Vector2;
    const uLight = this.material.uniforms['uLight']!.value as THREE.Color;
    this.points.onBeforeRender = (renderer, scene) => {
      renderer.getCurrentViewport(_vp);
      uViewport.set(_vp.z, _vp.w);
      if (!additive) sceneLight(scene, uLight);
      this.material.uniformsNeedUpdate = true;
    };
  }

  spawn(): number {
    if (this.count < this.max) return this.count++;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    return i;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      const all = this.all;
      for (let k = 0; k < all.length; k++) all[k]![i] = all[k]![last]!;
    }
  }

  clear(): void { this.count = 0; this.cursor = 0; this.geometry.setDrawRange(0, 0); this.points.visible = false; }

  update(dt: number, time: number): void {
    const P = this.aPos.array as Float32Array, C = this.aColor.array as Float32Array;
    const Q = this.aParams.array as Float32Array, X = this.aExtra.array as Float32Array;
    let i = 0;
    while (i < this.count) {
      const a = this.age[i]! + dt;
      const L = this.life[i]!;
      if (a >= L) { this.kill(i); continue; }
      this.age[i] = a;
      const t = a / L;
      const damp = 1 / (1 + this.drag[i]! * dt);
      let vx = this.vx[i]! * damp, vy = (this.vy[i]! - this.grav[i]! * dt) * damp, vz = this.vz[i]! * damp;
      const ux = this.ux[i]!, uy = this.uy[i]!, uz = this.uz[i]!;
      let x = this.px[i]! + (vx + ux) * dt, y = this.py[i]! + (vy + uy) * dt, z = this.pz[i]! + (vz + uz) * dt;
      const fl = this.flags[i]!;
      const flut = this.flutter[i]!;
      if (flut > 0) {
        const ph = this.phase[i]!;
        x += Math.cos(ph * 1.7 + a * 2.3) * flut * dt;
        z += Math.sin(ph + a * 2.9) * flut * dt;
      }
      if ((fl & F_FLOOR) !== 0 && y < this.floorY[i]!) {
        y = this.floorY[i]!;
        if (vy < 0) vy = -vy * 0.25;
        vx *= 0.55; vz *= 0.55;
        this.spin[i] = this.spin[i]! * 0.6;
        if (flut > 0) this.flutter[i] = 0;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      const rot = this.rot[i]! + this.spin[i]! * dt;
      this.rot[i] = rot;

      const e = 1 - (1 - t) * (1 - t);
      const size = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * e;
      const fi = this.fadeIn[i]!, fo = this.fadeOut[i]!;
      let alpha = this.alpha0[i]!;
      if (fi > 0 && t < fi) alpha *= t / fi;
      if (t > fo) { const k = (t - fo) / (1 - fo); alpha *= 1 - k * k * (3 - 2 * k); }

      let r: number, g: number, b: number;
      if ((fl & F_RAINBOW) !== 0) {
        const h = (time * 0.9 + this.phase[i]! * 0.159) % 1;
        r = sat(Math.abs(h * 6 - 3) - 1); g = sat(2 - Math.abs(h * 6 - 2)); b = sat(2 - Math.abs(h * 6 - 4));
        r = 0.08 + 0.92 * r; g = 0.08 + 0.92 * g; b = 0.08 + 0.92 * b;
        const inten = this.r0[i]!; // rainbow particles store intensity in r0
        r = r * r * inten; g = g * g * inten; b = b * b * inten;
      } else {
        r = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * t;
        g = this.g0[i]! + (this.g1[i]! - this.g0[i]!) * t;
        b = this.b0[i]! + (this.b1[i]! - this.b0[i]!) * t;
      }
      let squash = 1;
      if ((fl & F_SQUASH) !== 0) squash = 0.18 + 0.82 * Math.abs(Math.cos(this.phase[i]! + a * 6.5));

      const o3 = i * 3, o4 = i * 4;
      P[o3] = x; P[o3 + 1] = y; P[o3 + 2] = z;
      C[o4] = r; C[o4 + 1] = g; C[o4 + 2] = b; C[o4 + 3] = alpha;
      Q[o4] = size; Q[o4 + 1] = rot; Q[o4 + 2] = this.shape[i]!; Q[o4 + 3] = squash;
      if ((fl & F_ALIGN) !== 0) { X[o4] = vx + ux; X[o4 + 1] = vy + uy; X[o4 + 2] = vz + uz; }
      else { X[o4] = 0; X[o4 + 1] = 0; X[o4 + 2] = 0; }
      X[o4 + 3] = this.hot[i]!;
      i++;
    }
    const n = this.count;
    this.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n > 0) {
      this.upload(this.aPos, n * 3);
      this.upload(this.aColor, n * 4);
      this.upload(this.aParams, n * 4);
      this.upload(this.aExtra, n * 4);
    }
  }

  private upload(attr: THREE.BufferAttribute, n: number): void {
    const r = attr.updateRanges[0]!;
    r.start = 0;
    r.count = n;
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ───────────────────────────── System ─────────────────────────────

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Non-contract extension used by the race session. */
export interface ParticleSystemExt {
  /** As emit(), but every particle also carries the emitter's velocity (m/s, world): for effects that
   *  must stay with a moving kart (exhaust licks) instead of being left behind as a dotted trail. */
  emitMoving(kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    opts?: Parameters<ParticleSystem['emit']>[4]): void;
}

export function createParticleSystem(quality: RenderQuality): ParticleSystem & ParticleSystemExt {
  const mult = Math.max(0.1, quality.particles);
  const total = Math.round(MAX_TOTAL * mult);
  const atlas = createAtlas();
  const normal = new Layer(Math.round(total * 0.45), false, atlas);
  const additive = new Layer(Math.round(total * 0.55), true, atlas);
  const group = new THREE.Group();
  group.name = 'particles';
  group.add(normal.points, additive.points);
  const kinds = resolveKinds();
  const colorCache = new Map<string, Float32Array>();
  let time = 0;

  const tintOf = (hex: string): Float32Array => {
    let c = colorCache.get(hex);
    if (!c) { c = new Float32Array(3); linear(hex, c, 0); colorCache.set(hex, c); }
    return c;
  };

  function emitSub(s: RSub, n: number, x: number, y: number, z: number,
    ax: number, ay: number, az: number, scale: number, tint: Float32Array | null,
    ivx: number, ivy: number, ivz: number): void {
    const layer = s.layer === 1 ? additive : normal;
    const intensity = s.intensity ?? 1;
    const cone = s.cone ?? 0.6;
    const cosMax = Math.cos(cone);
    // basis around axis
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; }
    let t1x = hy * az - hz * ay, t1y = hz * ax - hx * az, t1z = hx * ay - hy * ax;
    const tl = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= tl; t1y /= tl; t1z /= tl;
    const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x;
    const nCols = s.cols.length / 3;
    const flags = (s.align ? F_ALIGN : 0) | (s.squash ? F_SQUASH : 0) | (s.rainbow ? F_RAINBOW : 0) | (s.floor !== undefined ? F_FLOOR : 0);
    for (let k = 0; k < n; k++) {
      const i = layer.spawn();
      // direction
      let dx: number, dy: number, dz: number;
      const mode = s.mode ?? 'cone';
      if (mode === 'sphere') {
        const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2, sr = Math.sqrt(1 - u * u);
        dx = sr * Math.cos(ph); dy = u; dz = sr * Math.sin(ph);
      } else if (mode === 'ring') {
        const ph = Math.random() * Math.PI * 2;
        dx = Math.cos(ph); dy = rand(0.05, 0.22); dz = Math.sin(ph);
      } else {
        const ct = 1 - Math.random() * (1 - cosMax), st = Math.sqrt(Math.max(0, 1 - ct * ct));
        const ph = Math.random() * Math.PI * 2, cp = Math.cos(ph) * st, sp = Math.sin(ph) * st;
        dx = ax * ct + t1x * cp + t2x * sp; dy = ay * ct + t1y * cp + t2y * sp; dz = az * ct + t1z * cp + t2z * sp;
      }
      const sp = rand(s.speed[0], s.speed[1]) * scale;
      // spawn jitter inside a sphere
      const j = (s.jitter ?? 0) * scale;
      let jx = 0, jy = 0, jz = 0;
      if (j > 0) {
        const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2, sr = Math.sqrt(1 - u * u), rr = j * Math.cbrt(Math.random());
        jx = sr * Math.cos(ph) * rr; jy = u * rr * 0.6; jz = sr * Math.sin(ph) * rr;
      }
      layer.px[i] = x + jx; layer.py[i] = y + jy; layer.pz[i] = z + jz;
      layer.vx[i] = dx * sp; layer.vy[i] = dy * sp; layer.vz[i] = dz * sp;
      layer.ux[i] = ivx; layer.uy[i] = ivy; layer.uz[i] = ivz;
      layer.age[i] = 0;
      layer.life[i] = rand(s.life[0], s.life[1]);
      const size0 = rand(s.size[0], s.size[1]) * scale;
      layer.s0[i] = size0;
      layer.s1[i] = size0 * (s.grow ?? 1);
      layer.rot[i] = Math.random() * Math.PI * 2;
      layer.spin[i] = (s.spin ?? 0) * (Math.random() < 0.5 ? -1 : 1) * rand(0.6, 1.2);
      layer.drag[i] = s.drag ?? 0;
      layer.grav[i] = s.gravity ?? 0;
      layer.flutter[i] = (s.flutter ?? 0) * rand(0.6, 1.3);
      layer.phase[i] = Math.random() * 6.283;
      layer.alpha0[i] = s.alpha ?? 1;
      layer.fadeIn[i] = s.fadeIn ?? 0;
      layer.fadeOut[i] = s.fadeOut ?? 0.5;
      layer.hot[i] = (s.hot ?? 0) * (s.layer === 1 ? intensity : 1);
      layer.floorY[i] = y + (s.floor ?? 0) * scale;
      layer.shape[i] = s.shape;
      layer.flags[i] = flags;
      let cr: number, cg: number, cb: number;
      if (tint && s.tint) { cr = tint[0]!; cg = tint[1]!; cb = tint[2]!; }
      else { const ci = Math.floor(Math.random() * nCols) * 3; cr = s.cols[ci]!; cg = s.cols[ci + 1]!; cb = s.cols[ci + 2]!; }
      let er = cr, eg = cg, eb = cb;
      if (s.endCol) {
        er = s.endCol[0]!; eg = s.endCol[1]!; eb = s.endCol[2]!;
        if (tint && s.tint) { er = cr + (er - cr) * 0.35; eg = cg + (eg - cg) * 0.35; eb = cb + (eb - cb) * 0.35; }
      }
      if (s.rainbow) {
        layer.r0[i] = intensity;
      } else {
        layer.r0[i] = cr * intensity; layer.g0[i] = cg * intensity; layer.b0[i] = cb * intensity;
        layer.r1[i] = er * intensity; layer.g1[i] = eg * intensity; layer.b1[i] = eb * intensity;
      }
    }
  }

  type EmitOpts = Parameters<ParticleSystem['emit']>[4];
  function emitImpl(kind: ParticleKind, x: number, y: number, z: number, opts: EmitOpts, ivx: number, ivy: number, ivz: number): void {
    const def = kinds[kind];
    if (!def) return;
    const base = opts?.count !== undefined ? Math.max(0, opts.count) : def.count;
    if (base <= 0) return;
    const scale = opts?.scale !== undefined && opts.scale > 0 ? opts.scale : 1;
    let ax = def.dir[0], ay = def.dir[1], az = def.dir[2];
    if (opts && (opts.dirX !== undefined || opts.dirY !== undefined || opts.dirZ !== undefined)) {
      const dx = opts.dirX ?? 0, dy = opts.dirY ?? 0, dz = opts.dirZ ?? 0;
      const l = Math.hypot(dx, dy, dz);
      if (l > 1e-6) { ax = dx / l; ay = dy / l; az = dz / l; }
    }
    const tint = opts?.color ? tintOf(opts.color) : null;
    for (let k = 0; k < def.subs.length; k++) {
      const s = def.subs[k]!;
      let n: number;
      if (s.fixed !== undefined) n = s.fixed;
      else {
        const want = base * (s.frac ?? 1) * mult;
        n = Math.floor(want);
        if (Math.random() < want - n) n++;
        if (k === 0 && n === 0) n = 1;
      }
      if (n > 0) emitSub(s, n, x, y, z, ax, ay, az, scale, tint, ivx, ivy, ivz);
    }
  }

  return {
    object: group,
    emit(kind, x, y, z, opts) {
      emitImpl(kind, x, y, z, opts, 0, 0, 0);
    },
    emitMoving(kind, x, y, z, vx, vy, vz, opts) {
      emitImpl(kind, x, y, z, opts,
        Number.isFinite(vx) ? vx : 0, Number.isFinite(vy) ? vy : 0, Number.isFinite(vz) ? vz : 0);
    },
    update(dt, _camera) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      time += dt;
      if (time > 3600) time -= 3600;
      normal.update(dt, time);
      additive.update(dt, time);
    },
    clear() {
      normal.clear();
      additive.clear();
    },
    dispose() {
      group.removeFromParent();
      normal.dispose();
      additive.dispose();
      atlas.dispose();
    },
  };
}

/** Every kind, handy for previews/tests. */
export const PARTICLE_KINDS = Object.keys(KINDS) as ParticleKind[];
