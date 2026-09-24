/** Track outline thumbnails (menus) with a stylised fallback when geometry is unavailable. */
import { hashString } from '../../sim/rng.js';
import { getBuiltTrack } from '../../sim/track-builder.js';
import { getTrackMeta } from '../../sim/tracks/catalog.js';
import type { BuiltTrack } from '../../sim/types.js';
import { THEME_COLORS, drawOutline, fitOutline, outlineFromBuilt, prepareCanvas, type TrackOutline } from './art/track-draw.js';
import { seededRandom } from './grid.js';

const outlines = new Map<string, TrackOutline | null>();

/** Built track or null (never throws). */
export function tryBuiltTrack(id: string, mirror = false): BuiltTrack | null {
  try {
    return getBuiltTrack(id, mirror);
  } catch {
    return null;
  }
}

export function trackOutline(id: string, mirror = false): TrackOutline | null {
  const key = `${id}|${mirror ? 1 : 0}`;
  if (outlines.has(key)) return outlines.get(key) ?? null;
  const t = tryBuiltTrack(id, mirror);
  const o = t ? outlineFromBuilt(t, 360) : null;
  outlines.set(key, o);
  return o;
}

/** Deterministic pseudo circuit used when real geometry is not available. */
function placeholderOutline(id: string): TrackOutline {
  const rand = seededRandom(hashString(id));
  const k = 7;
  const ctrl: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2 + rand() * 0.4;
    const r = 60 + rand() * 45;
    ctrl.push([Math.cos(a) * r * 1.35, Math.sin(a) * r]);
  }
  const n = 210;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const ws = new Float32Array(n).fill(9);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let j = 0; j < n; j++) {
    const u = (j / n) * k;
    const i = Math.floor(u);
    const t = u - i;
    const p0 = ctrl[(i - 1 + k) % k]!; const p1 = ctrl[i % k]!; const p2 = ctrl[(i + 1) % k]!; const p3 = ctrl[(i + 2) % k]!;
    const cr = (a: number, b: number, c: number, d: number) =>
      0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    const x = cr(p0[0], p1[0], p2[0], p3[0]);
    const y = cr(p0[1], p1[1], p2[1], p3[1]);
    xs[j] = x; ys[j] = y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const tx = xs[1]! - xs[0]!;
  const ty = ys[1]! - ys[0]!;
  const tl = Math.hypot(tx, ty) || 1;
  return { xs, ys, ws, n, start: { x: xs[0]!, y: ys[0]!, tx: tx / tl, ty: ty / tl, w: 9 }, minX, maxX, minY, maxY };
}

/** Paint a thumbnail into `canvas` (CSS size read from its box). */
export function paintTrackThumb(canvas: HTMLCanvasElement, trackId: string, mirror = false): void {
  const cssW = canvas.clientWidth || 160;
  const cssH = canvas.clientHeight || 100;
  const ctx = prepareCanvas(canvas, cssW, cssH);
  if (!ctx) return;
  let theme = THEME_COLORS.meadow;
  try { theme = THEME_COLORS[getTrackMeta(trackId).theme]; } catch { /* default */ }
  ctx.clearRect(0, 0, cssW, cssH);
  const real = trackOutline(trackId, mirror);
  const o = real ?? placeholderOutline(trackId);
  const pad = Math.max(8, Math.min(cssW, cssH) * 0.12);
  const fit = fitOutline(o, cssW, cssH, pad);
  drawOutline(ctx, o, fit, {
    edge: theme.edge,
    road: real ? theme.road : 'rgba(255,255,255,0.7)',
    minWidth: Math.max(3, Math.min(cssW, cssH) * 0.045),
    border: Math.max(1.5, Math.min(cssW, cssH) * 0.018),
    glow: 'rgba(0,0,0,0.25)',
    startLine: true,
  });
  canvas.classList.toggle('is-placeholder', !real);
}
