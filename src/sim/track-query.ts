import { datan2 } from './dmath.js';
import type { BuiltTrack, SurfaceInfo, SurfaceKind, TrackProjection } from './types.js';

export function wrapS(t: BuiltTrack, s: number): number {
  const L = t.length;
  s = s % L;
  return s < 0 ? s + L : s;
}

export function sampleIndex(t: BuiltTrack, s: number): number {
  return Math.floor(wrapS(t, s) / t.spacing) % t.n;
}

/** Signed shortest difference b - a along the loop, in (-L/2, L/2]. */
export function deltaS(t: BuiltTrack, a: number, b: number): number {
  let d = b - a;
  const L = t.length;
  if (d > L / 2) d -= L;
  else if (d <= -L / 2) d += L;
  return d;
}

const WINDOW = 14;

/**
 * Project a world XZ position onto the track. With a valid hint (previous index)
 * the search is local, so overlapping sections (bridges) resolve by continuity.
 * `y` (optional) breaks ties between vertically stacked sections on a global search.
 */
export function projectToTrack(t: BuiltTrack, x: number, z: number, hint: number, y?: number): TrackProjection {
  const n = t.n;
  let best = -1;
  let bestD = Infinity;
  if (hint >= 0 && hint < n) {
    for (let k = -WINDOW; k <= WINDOW; k++) {
      const i = (hint + k + n) % n;
      const ex = x - t.px[i]!, ez = z - t.pz[i]!;
      const dd = ex * ex + ez * ez;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    // If the kart outran the window (teleport/respawn), fall back to a global search.
    if (best === (hint + WINDOW) % n || best === (hint - WINDOW + n) % n) {
      const again = projectGlobal(t, x, z, y, best);
      if (again !== best) best = again;
    }
  } else {
    best = projectGlobal(t, x, z, y, -1);
  }
  return refine(t, best, x, z);
}

function projectGlobal(t: BuiltTrack, x: number, z: number, y: number | undefined, prefer: number): number {
  let best = prefer >= 0 ? prefer : 0;
  let bestD = Infinity;
  for (let i = 0; i < t.n; i++) {
    const ex = x - t.px[i]!, ez = z - t.pz[i]!;
    let dd = ex * ex + ez * ez;
    if (y !== undefined) {
      const ey = y - t.py[i]!;
      dd += ey * ey * 4;
    }
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return best;
}

function refine(t: BuiltTrack, i: number, x: number, z: number): TrackProjection {
  const n = t.n;
  // horizontal tangent / right
  const thx = t.tx[i]!, thz = t.tz[i]!;
  const hl = Math.sqrt(thx * thx + thz * thz) || 1;
  const fx = thx / hl, fz = thz / hl;
  const ex = x - t.px[i]!, ez = z - t.pz[i]!;
  const along = ex * fx + ez * fz;
  // choose neighbour segment, then locate the point between the two sample normals
  // (a fan on curves) so s stays continuous across sample boundaries in every lane
  const i0 = along >= 0 ? i : (i - 1 + n) % n;
  const i1 = (i0 + 1) % n;
  const hAlong = (k: number) => {
    const tx = t.tx[k]!, tz = t.tz[k]!;
    const l = Math.sqrt(tx * tx + tz * tz) || 1;
    return ((x - t.px[k]!) * tx + (z - t.pz[k]!) * tz) / l;
  };
  const a0 = hAlong(i0), a1 = hAlong(i1);
  const den = a0 - a1;
  let frac = den > 1e-9 ? a0 / den : a0 / t.spacing;
  if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
  const cx = t.px[i0]! + (t.px[i1]! - t.px[i0]!) * frac;
  const cy = t.py[i0]! + (t.py[i1]! - t.py[i0]!) * frac;
  const cz = t.pz[i0]! + (t.pz[i1]! - t.pz[i0]!) * frac;
  const rxv = t.rx[i0]! + (t.rx[i1]! - t.rx[i0]!) * frac;
  const ryv = t.ry[i0]! + (t.ry[i1]! - t.ry[i0]!) * frac;
  const rzv = t.rz[i0]! + (t.rz[i1]! - t.rz[i0]!) * frac;
  const rh = Math.sqrt(rxv * rxv + rzv * rzv) || 1;
  // lateral distance measured along the (banked) right vector
  const dh = ((x - cx) * rxv + (z - cz) * rzv) / rh;
  const d = dh / rh;
  const s = (i0 + frac) * t.spacing;
  const h = cy + ryv * d;
  return { i, s: s >= t.length ? s - t.length : s, d, h };
}

const EDGE_PIT = 2;

/** Ground under a projected point: road (with ramps/zones), off-road shoulder, or pit. */
export function surfaceAt(t: BuiltTrack, p: TrackProjection): SurfaceInfo {
  const i = p.i;
  const hw = t.hw[i]!;
  const ad = p.d < 0 ? -p.d : p.d;
  const edge = p.d < 0 ? t.edgeL[i]! : t.edgeR[i]!;
  const nx = t.ux[i]!, ny = t.uy[i]!, nz = t.uz[i]!;
  if (ad <= hw) {
    let kind: SurfaceKind = 'road';
    for (const z of t.surfaces) {
      const inS = z.s0 <= z.s1 ? p.s >= z.s0 && p.s < z.s1 : p.s >= z.s0 || p.s < z.s1;
      if (inS && p.d >= z.d0 && p.d <= z.d1) { kind = z.kind; break; }
    }
    // interpolate ramp height between samples (no 1 m steps on the kicker)
    const f = p.s / t.spacing;
    const r0 = Math.floor(f) % t.n;
    const r1 = (r0 + 1) % t.n;
    const fr = f - Math.floor(f);
    const ramp = t.rampH[r0]! + (t.rampH[r1]! - t.rampH[r0]!) * fr;
    return { height: p.h + ramp, nx, ny, nz, kind, onRoad: kind === 'road' || kind === 'ice' };
  }
  if (edge === EDGE_PIT && ad > hw + 0.35) {
    return { height: -Infinity, nx, ny, nz, kind: 'pit', onRoad: false };
  }
  // shoulder continues at the road-edge height
  const edgeD = p.d < 0 ? -hw : hw;
  const h = p.h + t.ry[i]! * (edgeD - p.d);
  return { height: h, nx, ny, nz, kind: 'dirt', onRoad: false };
}

/** World position of the road surface at arc length s and lateral offset d. */
export function pointAt(t: BuiltTrack, s: number, d: number): { x: number; y: number; z: number; i: number; yaw: number } {
  const ss = wrapS(t, s);
  const f = ss / t.spacing;
  const i = Math.floor(f) % t.n;
  const j = (i + 1) % t.n;
  const k = f - Math.floor(f);
  const cx = t.px[i]! + (t.px[j]! - t.px[i]!) * k;
  const cy = t.py[i]! + (t.py[j]! - t.py[i]!) * k;
  const cz = t.pz[i]! + (t.pz[j]! - t.pz[i]!) * k;
  const tx = t.tx[i]! + (t.tx[j]! - t.tx[i]!) * k;
  const tz = t.tz[i]! + (t.tz[j]! - t.tz[i]!) * k;
  return {
    x: cx + t.rx[i]! * d,
    y: cy + t.ry[i]! * d + t.rampH[i]!,
    z: cz + t.rz[i]! * d,
    i,
    yaw: datan2(tx, tz),
  };
}

/** Yaw of the track tangent at sample i. */
export function trackYaw(t: BuiltTrack, i: number): number {
  return datan2(t.tx[i]!, t.tz[i]!);
}
