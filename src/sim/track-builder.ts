import { clamp, datan2, dcos, dsin, smoothstep, wrapAngle } from './dmath.js';
import type { BuiltTrack, EdgeKind, TrackDef } from './types.js';
import { getTrackDef } from './tracks/index.js';

const EDGE_INDEX: Record<EdgeKind, number> = { offroad: 0, wall: 1, pit: 2 };
const SUBDIV = 48;          // dense polyline samples per control segment
const TARGET_SPACING = 1.0; // metres between resolved samples

/** Centripetal Catmull–Rom (alpha 0.5) evaluated per segment. */
function catmullRom(
  p0: number[], p1: number[], p2: number[], p3: number[], t: number, out: number[],
): void {
  const d = (a: number[], b: number[]) => {
    const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, dz = b[2]! - a[2]!;
    return Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)) || 1e-4;
  };
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - tt) / (t1 - t0)) * p0[k]! + ((tt - t0) / (t1 - t0)) * p1[k]!;
    const a2 = ((t2 - tt) / (t2 - t1)) * p1[k]! + ((tt - t1) / (t2 - t1)) * p2[k]!;
    const a3 = ((t3 - tt) / (t3 - t2)) * p2[k]! + ((tt - t2) / (t3 - t2)) * p3[k]!;
    const b1 = ((t2 - tt) / (t2 - t0)) * a1 + ((tt - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - tt) / (t3 - t1)) * a2 + ((tt - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - tt) / (t2 - t1)) * b1 + ((tt - t1) / (t2 - t1)) * b2;
  }
}

/** Mirror an authored definition across the X axis (mirror mode). */
export function mirrorDef(def: TrackDef): TrackDef {
  const flipSide = (s: 'left' | 'right' | 'both') => (s === 'left' ? 'right' : s === 'right' ? 'left' : 'both');
  return {
    ...def,
    points: def.points.map(cp => ({ ...cp, p: [-cp.p[0], cp.p[1], cp.p[2]] as [number, number, number], bank: cp.bank ? -cp.bank : cp.bank })),
    edges: def.edges?.map(e => ({ ...e, side: flipSide(e.side) })),
    surfaces: def.surfaces?.map(z => ({
      ...z,
      dFrom: z.dTo !== undefined ? -z.dTo : undefined,
      dTo: z.dFrom !== undefined ? -z.dFrom : undefined,
    })),
    boostPads: def.boostPads?.map(b => ({ ...b, d: -b.d })),
    coins: def.coins?.map(c => ({ ...c, d: -c.d })),
    movers: def.movers?.map(m => ({ ...m, d: -m.d })),
    landmarks: def.landmarks?.map(l => ({ ...l, side: l.side === 'over' ? 'over' : l.side === 'left' ? 'right' : 'left' })),
  };
}

export function buildTrack(sourceDef: TrackDef, opts: { mirror?: boolean } = {}): BuiltTrack {
  const def = opts.mirror ? mirrorDef(sourceDef) : sourceDef;
  const cps = def.points;
  const m = cps.length;
  if (m < 4) throw new Error(`Track ${def.id}: needs at least 4 control points`);

  // 1. Dense polyline with u parameter and cumulative 3D arc length.
  const denseCount = m * SUBDIV;
  const dx = new Float64Array(denseCount + 1);
  const dy = new Float64Array(denseCount + 1);
  const dz = new Float64Array(denseCount + 1);
  const du = new Float64Array(denseCount + 1);
  const ds = new Float64Array(denseCount + 1);
  const tmp = [0, 0, 0];
  for (let k = 0; k < m; k++) {
    const p0 = cps[(k - 1 + m) % m]!.p, p1 = cps[k]!.p, p2 = cps[(k + 1) % m]!.p, p3 = cps[(k + 2) % m]!.p;
    for (let j = 0; j < SUBDIV; j++) {
      const idx = k * SUBDIV + j;
      catmullRom(p0, p1, p2, p3, j / SUBDIV, tmp);
      dx[idx] = tmp[0]!; dy[idx] = tmp[1]!; dz[idx] = tmp[2]!;
      du[idx] = k + j / SUBDIV;
    }
  }
  dx[denseCount] = dx[0]!; dy[denseCount] = dy[0]!; dz[denseCount] = dz[0]!; du[denseCount] = m;
  ds[0] = 0;
  for (let idx = 1; idx <= denseCount; idx++) {
    const ex = dx[idx]! - dx[idx - 1]!, ey = dy[idx]! - dy[idx - 1]!, ez = dz[idx]! - dz[idx - 1]!;
    ds[idx] = ds[idx - 1]! + Math.sqrt(ex * ex + ey * ey + ez * ez);
  }
  const length = ds[denseCount]!;
  const n = Math.max(64, Math.round(length / TARGET_SPACING));
  const spacing = length / n;

  const uToS = (uRaw: number): number => {
    let u = uRaw % m;
    if (u < 0) u += m;
    // dense samples are uniform in u → direct index
    const f = u * SUBDIV;
    const idx = Math.min(denseCount - 1, Math.floor(f));
    const frac = f - idx;
    return ds[idx]! + (ds[idx + 1]! - ds[idx]!) * frac;
  };

  // 2. Uniform resampling.
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
  const uu = new Float64Array(n);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const s = i * spacing;
    while (cursor < denseCount - 1 && ds[cursor + 1]! < s) cursor++;
    const seg = ds[cursor + 1]! - ds[cursor]!;
    const f = seg > 0 ? (s - ds[cursor]!) / seg : 0;
    px[i] = dx[cursor]! + (dx[cursor + 1]! - dx[cursor]!) * f;
    py[i] = dy[cursor]! + (dy[cursor + 1]! - dy[cursor]!) * f;
    pz[i] = dz[cursor]! + (dz[cursor + 1]! - dz[cursor]!) * f;
    uu[i] = du[cursor]! + (du[cursor + 1]! - du[cursor]!) * f;
  }

  // 3. Frames.
  const tx = new Float64Array(n), ty = new Float64Array(n), tz = new Float64Array(n);
  const rx = new Float64Array(n), ry = new Float64Array(n), rz = new Float64Array(n);
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const hw = new Float64Array(n);
  const heading = new Float64Array(n);
  const interpAttr = (u: number, get: (k: number) => number): number => {
    const k = Math.floor(u) % m;
    const f = smoothstep(0, 1, u - Math.floor(u));
    return get(k) + (get((k + 1) % m) - get(k)) * f;
  };
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let ex = px[b]! - px[a]!, ey = py[b]! - py[a]!, ez = pz[b]! - pz[a]!;
    const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
    ex /= el; ey /= el; ez /= el;
    tx[i] = ex; ty[i] = ey; tz[i] = ez;
    // horizontal right r0 = (-tz, 0, tx) normalised; up0 = r0 × t
    const hl = Math.sqrt(ex * ex + ez * ez) || 1;
    const r0x = -ez / hl, r0z = ex / hl;
    const u0x = 0 * ez - 0 * ey; // r0.y = 0 → (r0y*tz - r0z*ty, r0z*tx - r0x*tz, r0x*ty - r0y*tx)
    const upx = u0x - r0z * ey;
    const upy = r0z * ex - r0x * ez;
    const upz = r0x * ey;
    const bank = interpAttr(uu[i]!, k => cps[k]!.bank ?? 0);
    const cb = dcos(bank), sb = dsin(bank);
    // positive bank → right side lower: right = r0 cos - up0 sin ; up = up0 cos + r0 sin
    rx[i] = r0x * cb - upx * sb; ry[i] = -upy * sb; rz[i] = r0z * cb - upz * sb;
    ux[i] = upx * cb + r0x * sb; uy[i] = upy * cb; uz[i] = upz * cb + r0z * sb;
    hw[i] = interpAttr(uu[i]!, k => cps[k]!.w ?? def.halfWidth);
    heading[i] = datan2(ex, ez);
  }

  // 4. Curvature (positive = turning right = heading decreasing), smoothed.
  const rawK = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = heading[(i - 2 + n) % n]!, b = heading[(i + 2) % n]!;
    rawK[i] = -wrapAngle(b - a) / (4 * spacing);
  }
  const curvature = new Float64Array(n);
  const W = 6;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += rawK[(i + k + n) % n]!;
    curvature[i] = sum / (2 * W + 1);
  }

  // 5. Edges and barrier distances.
  const edgeL = new Uint8Array(n), edgeR = new Uint8Array(n);
  const wallL = new Float64Array(n), wallR = new Float64Array(n);
  const shoulderL = new Float64Array(n).fill(def.shoulder);
  const shoulderR = new Float64Array(n).fill(def.shoulder);
  edgeL.fill(EDGE_INDEX[def.defaultEdge]);
  edgeR.fill(EDGE_INDEX[def.defaultEdge]);
  const forRange = (from: number, to: number, fn: (i: number) => void) => {
    const s0 = uToS(from), s1 = uToS(to);
    const len = s1 >= s0 ? s1 - s0 : length - s0 + s1;
    const i0 = Math.floor(s0 / spacing);
    const count = Math.ceil(len / spacing);
    for (let k = 0; k <= count; k++) fn((i0 + k) % n);
  };
  for (const e of def.edges ?? []) {
    forRange(e.from, e.to, i => {
      if (e.side !== 'right') { edgeL[i] = EDGE_INDEX[e.kind]; if (e.shoulder !== undefined) shoulderL[i] = e.shoulder; }
      if (e.side !== 'left') { edgeR[i] = EDGE_INDEX[e.kind]; if (e.shoulder !== undefined) shoulderR[i] = e.shoulder; }
    });
  }
  const barrier = (kind: number, h: number, sh: number) => (kind === 0 ? h + sh : kind === 1 ? h + 0.6 : h);
  for (let i = 0; i < n; i++) {
    wallL[i] = barrier(edgeL[i]!, hw[i]!, shoulderL[i]!);
    wallR[i] = barrier(edgeR[i]!, hw[i]!, shoulderR[i]!);
  }
  // Inner side of tight corners: the offset curve must not fold over itself.
  for (let i = 0; i < n; i++) {
    const k = curvature[i]!;
    if (Math.abs(k) < 1e-5) continue;
    const limit = Math.max(hw[i]! + 0.6, 0.8 / Math.abs(k));
    if (k > 0) wallR[i] = Math.min(wallR[i]!, limit);
    else wallL[i] = Math.min(wallL[i]!, limit);
  }
  // Smooth barrier distances with a running minimum then average (no jagged walls).
  const smoothWall = (arr: Float64Array, road: Float64Array) => {
    const src = Float64Array.from(arr);
    for (let i = 0; i < n; i++) {
      let mn = Infinity;
      for (let k = -4; k <= 4; k++) mn = Math.min(mn, src[(i + k + n) % n]!);
      arr[i] = mn;
    }
    const src2 = Float64Array.from(arr);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -4; k <= 4; k++) sum += src2[(i + k + n) % n]!;
      arr[i] = Math.max(road[i]!, sum / 9);
    }
  };
  smoothWall(wallL, hw);
  smoothWall(wallR, hw);
  for (let i = 0; i < n; i++) {
    if (edgeL[i] === 2) wallL[i] = hw[i]!;
    if (edgeR[i] === 2) wallR[i] = hw[i]!;
  }

  // 6. Ramps.
  const rampH = new Float64Array(n);
  const rampTrick = new Uint8Array(n);
  const ramps: BuiltTrack['ramps'] = [];
  for (const r of def.ramps ?? []) {
    const s0 = uToS(r.at);
    const s1 = s0 + r.length;
    ramps.push({ s0, s1: s1 % length, height: r.height, trick: !!r.trick });
    const i0 = Math.ceil(s0 / spacing);
    const i1 = Math.floor(s1 / spacing);
    for (let k = i0; k <= i1; k++) {
      const i = ((k % n) + n) % n;
      const t = clamp((k * spacing - s0) / r.length, 0, 1);
      rampH[i] = r.height * (0.3 * t + 0.7 * t * t);
      if (r.trick) rampTrick[i] = 1;
    }
  }

  // 7. Surfaces.
  const surfaces: BuiltTrack['surfaces'] = [];
  for (const z of def.surfaces ?? []) {
    surfaces.push({ s0: uToS(z.from), s1: uToS(z.to), d0: z.dFrom ?? -1e9, d1: z.dTo ?? 1e9, kind: z.kind });
  }

  const at = (s: number, d: number) => {
    const ss = ((s % length) + length) % length;
    const f = ss / spacing;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const t = f - Math.floor(f);
    const cx = px[i]! + (px[j]! - px[i]!) * t;
    const cy = py[i]! + (py[j]! - py[i]!) * t;
    const cz = pz[i]! + (pz[j]! - pz[i]!) * t;
    return {
      x: cx + rx[i]! * d, y: cy + ry[i]! * d + rampH[i]!, z: cz + rz[i]! * d,
      yaw: heading[i]!, i, s: ss,
    };
  };

  const startS = uToS(def.startAt);
  const boostPads = (def.boostPads ?? []).map(b => {
    const s = uToS(b.at);
    const p = at(s, b.d);
    return { s, d: b.d, x: p.x, y: p.y, z: p.z, yaw: p.yaw };
  });
  const itemBoxes: BuiltTrack['itemBoxes'] = [];
  for (const row of def.itemRows ?? []) {
    const s = uToS(row.at);
    const i = Math.floor(s / spacing) % n;
    const span = hw[i]! * 1.5;
    const gap = row.count > 1 ? Math.min(3.4, span / (row.count - 1)) : 0;
    for (let k = 0; k < row.count; k++) {
      const d = (k - (row.count - 1) / 2) * gap;
      const p = at(s, d);
      itemBoxes.push({ s, d, x: p.x, y: p.y + 1.05, z: p.z });
    }
  }
  const coins: BuiltTrack['coins'] = [];
  for (const line of def.coins ?? []) {
    const s0 = uToS(line.at);
    for (let k = 0; k < line.count; k++) {
      const s = (s0 + k * (line.spacing ?? 3)) % length;
      const p = at(s, line.d);
      coins.push({ s, d: line.d, x: p.x, y: p.y + 0.8, z: p.z });
    }
  }
  const grid: BuiltTrack['grid'] = [];
  for (let k = 0; k < 8; k++) {
    const s = startS - 7 - k * 4.2;
    const i = Math.floor((((s % length) + length) % length) / spacing) % n;
    const d = (k % 2 === 0 ? -1 : 1) * Math.min(3.4, hw[i]! * 0.4);
    const p = at(s, d);
    grid.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, s: p.s, d, i: p.i });
  }

  const movers = (def.movers ?? []).map(mv => ({ ...mv, s: uToS(mv.at) }));
  const landmarks = (def.landmarks ?? []).map(l => ({ ...l, s: uToS(l.at) }));

  return {
    def, length, n, spacing,
    px, py, pz, tx, ty, tz, rx, ry, rz, ux, uy, uz, hw,
    rampH, rampTrick, curvature, edgeL, edgeR, wallL, wallR,
    surfaces, startS, boostPads, itemBoxes, coins, ramps, movers, landmarks, grid,
    uToS, mirrored: !!opts.mirror,
  };
}

const cache = new Map<string, BuiltTrack>();
/** Cached build by track id (mirror builds are cached separately). */
export function getBuiltTrack(id: string, mirror = false): BuiltTrack {
  const key = `${id}|${mirror ? 1 : 0}`;
  let t = cache.get(key);
  if (!t) {
    t = buildTrack(getTrackDef(id), { mirror });
    cache.set(key, t);
  }
  return t;
}
