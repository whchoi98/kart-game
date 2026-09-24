/**
 * Top-down track outline drawing for menu thumbnails and the HUD minimap.
 * Map projection (seen from above, +Z up the screen): screenX = −x, screenY = −z.
 */
import type { BuiltTrack, ThemeId } from '../../../sim/types.js';

export interface TrackOutline {
  /** Projected centreline points (screen orientation, world metres). */
  xs: Float32Array;
  ys: Float32Array;
  /** Road half width per point. */
  ws: Float32Array;
  n: number;
  /** Index of the start line point + unit tangent there (screen space). */
  start: { x: number; y: number; tx: number; ty: number; w: number };
  minX: number; maxX: number; minY: number; maxY: number;
}

export interface Fit { scale: number; ox: number; oy: number }

export const THEME_COLORS: Record<ThemeId, { a: string; b: string; road: string; edge: string }> = {
  meadow: { a: '#7ee06a', b: '#2f9e5a', road: '#fff7d6', edge: '#1b1036' },
  beach: { a: '#5fe0ff', b: '#ffd98a', road: '#fffdf2', edge: '#1b1036' },
  canyon: { a: '#ff9a55', b: '#b8432f', road: '#ffe9cf', edge: '#1b1036' },
  city: { a: '#7a4dff', b: '#1d1450', road: '#ff5fd2', edge: '#0b0620' },
  snow: { a: '#dff4ff', b: '#7fb8ff', road: '#ffffff', edge: '#1b1036' },
  jungle: { a: '#3fcf6f', b: '#0d5e3c', road: '#ffe8a3', edge: '#0d2418' },
  volcano: { a: '#ff5a3d', b: '#3a0f18', road: '#ffc15e', edge: '#150408' },
  galaxy: { a: '#ff7ae8', b: '#2a0b6b', road: '#b7f3ff', edge: '#0d0327' },
};

/** Decimate a built track to at most ~`maxPoints` outline points. */
export function outlineFromBuilt(t: BuiltTrack, maxPoints = 400): TrackOutline {
  const step = Math.max(1, Math.floor(t.n / maxPoints));
  const n = Math.floor(t.n / step);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const ws = new Float32Array(n);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = k * step;
    const x = -t.px[i]!;
    const y = -t.pz[i]!;
    xs[k] = x; ys[k] = y; ws[k] = t.hw[i]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const si = Math.max(0, Math.min(t.n - 1, Math.round(t.startS / t.spacing))) % t.n;
  const start = { x: -t.px[si]!, y: -t.pz[si]!, tx: -t.tx[si]!, ty: -t.tz[si]!, w: t.hw[si]! };
  const tl = Math.hypot(start.tx, start.ty) || 1;
  start.tx /= tl; start.ty /= tl;
  return { xs, ys, ws, n, start, minX, maxX, minY, maxY };
}

export function fitOutline(o: TrackOutline, w: number, h: number, pad: number): Fit {
  const spanX = Math.max(1, o.maxX - o.minX);
  const spanY = Math.max(1, o.maxY - o.minY);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2 - o.minX * scale;
  const oy = (h - spanY * scale) / 2 - o.minY * scale;
  return { scale, ox, oy };
}

/** World (x, z) → canvas pixel with a fit. */
export function project(fit: Fit, x: number, z: number): [number, number] {
  return [fit.ox + -x * fit.scale, fit.oy + -z * fit.scale];
}

function path(ctx: CanvasRenderingContext2D, o: TrackOutline, fit: Fit): void {
  ctx.beginPath();
  for (let k = 0; k < o.n; k++) {
    const x = fit.ox + o.xs[k]! * fit.scale;
    const y = fit.oy + o.ys[k]! * fit.scale;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export interface OutlineStyle {
  edge: string;
  road: string;
  /** Minimum road width in px so tiny thumbnails stay readable. */
  minWidth: number;
  /** Extra outline thickness around the road in px. */
  border: number;
  glow?: string;
  startLine?: boolean;
}

export function drawOutline(ctx: CanvasRenderingContext2D, o: TrackOutline, fit: Fit, style: OutlineStyle): void {
  let avgW = 0;
  for (let k = 0; k < o.n; k++) avgW += o.ws[k]!;
  avgW /= Math.max(1, o.n);
  const roadW = Math.max(style.minWidth, avgW * 2 * fit.scale);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (style.glow) {
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = roadW * 1.2;
  }
  path(ctx, o, fit);
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = roadW + style.border * 2;
  ctx.stroke();
  ctx.shadowBlur = 0;
  path(ctx, o, fit);
  ctx.strokeStyle = style.road;
  ctx.lineWidth = roadW;
  ctx.stroke();
  if (style.startLine) {
    const [sx, sy] = [fit.ox + o.start.x * fit.scale, fit.oy + o.start.y * fit.scale];
    const nx = -o.start.ty;
    const ny = o.start.tx;
    const half = roadW / 2 + style.border * 0.5;
    ctx.beginPath();
    ctx.moveTo(sx - nx * half, sy - ny * half);
    ctx.lineTo(sx + nx * half, sy + ny * half);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = Math.max(3, roadW * 0.5);
    ctx.stroke();
    ctx.setLineDash([Math.max(2, roadW * 0.25), Math.max(2, roadW * 0.25)]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, roadW * 0.3);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Size a canvas's backing store to its CSS box × devicePixelRatio. Returns the 2D context in CSS px. */
export function prepareCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, maxDpr = 2): CanvasRenderingContext2D | null {
  const dpr = Math.min(maxDpr, Math.max(1, window.devicePixelRatio || 1));
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
