/**
 * Track mesh: road ribbon, shoulders, curbs, barriers, pit/bridge visuals, ramps,
 * boost pads, surface zones, start/finish gantry, grid slots and track furniture
 * (grandstands, inflatable arches, sponsor banners).
 *
 * Everything static is merged per material; repeats are InstancedMeshes. Animated
 * bits (pad arrows, neon pulses, crowd, flags) run on texture offsets and shader
 * uniforms, so update() allocates nothing.
 *
 * Frame conventions (see sim/types.ts): road point = p + r·d (py excludes ramps),
 * d > 0 is right of travel. Local model frames use rotation.y = yaw semantics:
 * local +Z = forward, local +X = LEFT of travel, +Y = up.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuiltTrack, ThemeId } from '../../sim/types.js';
import { pointAt } from '../../sim/track-query.js';
import type { RenderQuality, TrackMeshHandle } from './contracts.js';
import { THEME_PALETTES, type ThemePalette } from './theme-palette.js';
import * as TX from './textures.js';

export type StartLightState = 3 | 2 | 1 | 0 | null;

export interface TrackMeshStats {
  drawCalls: number; triangles: number; instances: number;
  /** Total build time (ms) and per-phase breakdown, for debug overlays / load-time budgets. */
  buildMs?: number;
  timings?: Record<string, number>;
}

export interface TrackMesh extends TrackMeshHandle {
  /** Countdown light bar: 3/2/1 = one/two/three red lamps lit, 0 = all green, null = off. */
  setStartLights(n: StartLightState): void;
  /** Build statistics (draw calls = meshes in the group, triangles incl. instances). */
  readonly stats: TrackMeshStats;
}

// ───────────────────────────── geometry builder ─────────────────────────────

interface Vtx { x: number; y: number; z: number; u: number; v: number; r: number; g: number; b: number; a: number }

class Geo {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  get count(): number { return this.pos.length / 3; }
  add(x: number, y: number, z: number, u: number, v: number, r = 1, g = 1, b = 1, a = 1): number {
    this.pos.push(x, y, z); this.uv.push(u, v); this.col.push(r, g, b, a);
    return this.pos.length / 3 - 1;
  }
  /** a=(row,c) b=(row,c+1) c=(row+1,c+1) d=(row+1,c). */
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, d, b, c, d); }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  get empty(): boolean { return this.idx.length === 0; }
  toGeometry(alpha = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (alpha) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    else {
      const c3 = new Float32Array((this.col.length / 4) * 3);
      for (let i = 0, j = 0; i < this.col.length; i += 4, j += 3) { c3[j] = this.col[i]!; c3[j + 1] = this.col[i + 1]!; c3[j + 2] = this.col[i + 2]!; }
      g.setAttribute('color', new THREE.BufferAttribute(c3, 3));
    }
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const VT: Vtx = { x: 0, y: 0, z: 0, u: 0, v: 0, r: 1, g: 1, b: 1, a: 1 };

/** Grid of rows × cols vertices; quads face cross(colDir, rowDir) (CW profile ⇒ outward). */
function strip(g: Geo, rows: number, cols: number, emit: (r: number, c: number, o: Vtx) => void): void {
  if (rows < 2 || cols < 2) return;
  const base = g.count;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      VT.r = VT.g = VT.b = VT.a = 1;
      emit(r, c, VT);
      g.add(VT.x, VT.y, VT.z, VT.u, VT.v, VT.r, VT.g, VT.b, VT.a);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = base + r * cols + c;
      g.quad(a, a + 1, a + 1 + cols, a + cols);
    }
  }
}

/** Prepare a primitive geometry for merging: color attribute, indexed, no extra attributes. */
function prep(geo: THREE.BufferGeometry, color?: THREE.ColorRepresentation, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo;
  if (!g.index) {
    const idx: number[] = [];
    for (let i = 0; i < g.attributes.position!.count; i++) idx.push(i);
    g.setIndex(idx);
  }
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) {
    const c = new THREE.Color(color ?? 0xffffff);
    const n = g.attributes.position!.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  if (m) g.applyMatrix4(m);
  return g;
}

/** Per-material geometry buckets merged at the end (one draw call each). */
class Buckets {
  private readonly map = new Map<string, THREE.BufferGeometry[]>();
  add(key: string, g: THREE.BufferGeometry | Geo | null | undefined): void {
    if (!g) return;
    const geo = g instanceof Geo ? (g.empty ? null : g.toGeometry()) : g;
    if (!geo) return;
    let arr = this.map.get(key);
    if (!arr) { arr = []; this.map.set(key, arr); }
    arr.push(geo);
  }
  take(key: string): THREE.BufferGeometry | null {
    const arr = this.map.get(key);
    if (!arr || arr.length === 0) return null;
    this.map.delete(key);
    if (arr.length === 1) return arr[0]!;
    const merged = mergeGeometries(arr, false);
    for (const g of arr) g.dispose();
    return merged;
  }
  keys(): string[] { return [...this.map.keys()]; }
  /** Triangles currently held (before merging). */
  triangles(): number {
    let t = 0;
    for (const arr of this.map.values()) for (const g of arr) t += (g.index ? g.index.count : g.attributes.position!.count) / 3;
    return t;
  }
}

interface Run { start: number; len: number; closed: boolean }

/** Contiguous circular runs of samples satisfying pred. */
function runsOf(n: number, pred: (i: number) => boolean): Run[] {
  let all = true, any = false;
  for (let i = 0; i < n; i++) { const p = pred(i); all = all && p; any = any || p; }
  if (all) return [{ start: 0, len: n, closed: true }];
  if (!any) return [];
  let f = 0;
  while (pred(f)) f++;
  const out: Run[] = [];
  let k = 0;
  while (k < n) {
    const i = (f + k) % n;
    if (pred(i)) {
      let len = 0;
      while (k + len < n && pred((f + k + len) % n)) len++;
      out.push({ start: i, len, closed: false });
      k += len;
    } else k++;
  }
  return out;
}
/** Rows for a run: closed loops repeat the first sample; open runs reach into the next sample. */
function runRows(r: Run): number { return r.closed ? r.len + 1 : Math.max(2, r.len + 1); }

const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ───────────────────────────── track sampling context ─────────────────────────────

class Ctx {
  readonly t: BuiltTrack;
  readonly n: number;
  readonly sp: number;
  /** Horizontal unit right. */
  readonly hx: Float32Array; readonly hz: Float32Array;
  /** Overpass / elevated section: another section far below within hw+6, or terrain pulled well below the shoulders. */
  readonly over: Uint8Array;
  /** Estimated drop (m, ≥ 0) from the road edge to the terrain just outside the barrier, [left, right]. */
  readonly drop: [Float32Array, Float32Array];
  private readonly grid = new Map<number, number[]>();
  private readonly cell = 20;
  /** Themes whose elevated sections become viaducts (deck + pillars) instead of earth embankments. */
  readonly viaduct: boolean;
  constructor(t: BuiltTrack, viaduct = false) {
    this.viaduct = viaduct;
    this.t = t; this.n = t.n; this.sp = t.spacing;
    this.hx = new Float32Array(t.n); this.hz = new Float32Array(t.n);
    this.drop = [new Float32Array(t.n), new Float32Array(t.n)];
    for (let i = 0; i < t.n; i++) {
      const l = Math.hypot(t.rx[i]!, t.rz[i]!) || 1;
      this.hx[i] = t.rx[i]! / l; this.hz[i] = t.rz[i]! / l;
      const key = this.key(Math.floor(t.px[i]! / this.cell), Math.floor(t.pz[i]! / this.cell));
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(i);
    }
    this.over = this.detectOverpasses();
  }
  private key(cx: number, cz: number): number { return (cx + 4096) * 8192 + (cz + 4096); }
  /**
   * Estimate of the scenery terrain height next to the corridor. Mirrors render/terrain.ts: close to a road
   * the ground hugs the LOWEST road (its banked surface at that lateral offset − 0.35) whose corridor reaches
   * (x, z) and falls away near 'pit' edges.
   * `low` excludes the pit term (terrain pulled down by another, lower section); `pit` is the pit falloff 0..1.
   */
  groundInfo(x: number, z: number, out: GroundInfo, from = -1): GroundInfo {
    const t = this.t;
    let low = Infinity, lowOther = Infinity, pit = 0;
    this.near(x, z, 80, j => {
      const dx = x - t.px[j]!, dz = z - t.pz[j]!;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const side = dx * this.hx[j]! + dz * this.hz[j]!;
      const wall = side >= 0 ? t.wallR[j]! : t.wallL[j]!;
      if (dist >= wall + 55) return;
      if ((side >= 0 ? t.edgeR[j]! : t.edgeL[j]!) === 2) pit = Math.max(pit, 1 - smooth01(t.hw[j]! + 1, t.hw[j]! + 40, dist));
      // road surface at this lateral offset (banking), − 0.35 — same as terrain.ts
      const h = t.py[j]! + t.ry[j]! * Math.max(-t.hw[j]!, Math.min(t.hw[j]!, side)) - 0.35;
      if (h < low) low = h;
      if (h < lowOther && (from < 0 || this.loopDist(from, j) > 80)) lowOther = h;
    });
    out.low = low; out.lowOther = lowOther; out.pit = pit;
    return out;
  }
  /** Visit samples within radius of (x, z). Return true from fn to stop. */
  near(x: number, z: number, radius: number, fn: (j: number) => boolean | void): boolean {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const arr = this.grid.get(this.key(cx + dx, cz + dz));
      if (!arr) continue;
      for (const j of arr) if (fn(j)) return true;
    }
    return false;
  }
  loopDist(i: number, j: number): number { const d = Math.abs(i - j); return Math.min(d, this.n - d) * this.sp; }
  private detectOverpasses(): Uint8Array {
    const t = this.t, n = this.n;
    const raw = new Uint8Array(n);
    const gi: GroundInfo = { low: 0, lowOther: 0, pit: 0 };
    for (let i = 0; i < n; i++) {
      const lim = t.hw[i]! + 6;
      const x = t.px[i]!, z = t.pz[i]!, y = t.py[i]!;
      raw[i] = this.near(x, z, lim, j => {
        if (this.loopDist(i, j) < 40) return false;
        if (t.py[j]! > y - 5) return false;
        return (t.px[j]! - x) ** 2 + (t.pz[j]! - z) ** 2 < lim * lim;
      }) ? 1 : 0;
      // Elevated: the terrain hugs a lower section nearby, so this section's shoulders would float.
      for (const side of [-1, 1]) {
        const d = Math.max(this.wall(i, side), t.hw[i]! + 0.3) + 1.6;
        const px = t.px[i]! + t.rx[i]! * side * d, pz = t.pz[i]! + t.rz[i]! * side * d;
        this.groundInfo(px, pz, gi, i);
        const ye = this.yEdge(i, side);
        this.drop[side < 0 ? 0 : 1][i] = Math.max(0, ye - (gi.low - 30 * gi.pit));
        // another section drags the terrain far below this one: carry it on a viaduct (viaduct themes)
        if (this.viaduct && this.edge(i, side) !== 2 && ye - gi.lowOther > 3.5) raw[i] = 1;
      }
    }
    const out = new Uint8Array(n);
    const W = 10;
    for (let i = 0; i < n; i++) {
      if (!raw[i]) continue;
      for (let k = -W; k <= W; k++) out[(i + k + n) % n] = 1;
    }
    return out;
  }
  /** True when (x,z) at height y is above/inside another (lower) section's corridor. */
  blockedBelow(x: number, z: number, y: number, pad: number): boolean {
    const t = this.t;
    return this.near(x, z, 40, j => {
      if (t.py[j]! > y - 3) return false;
      const w = Math.max(t.wallL[j]!, t.wallR[j]!) + pad;
      return (t.px[j]! - x) ** 2 + (t.pz[j]! - z) ** 2 < w * w;
    });
  }
  /** True when (x,z) lies inside any corridor (between barriers) of a section at similar height. */
  inCorridor(x: number, z: number, y: number, pad: number): boolean {
    const t = this.t;
    return this.near(x, z, 45, j => {
      if (Math.abs(t.py[j]! - y) > 6) return false;
      const ex = x - t.px[j]!, ez = z - t.pz[j]!;
      const along = Math.abs(ex * t.tx[j]! + ez * t.tz[j]!);
      if (along > 1.5) return false;
      const side = ex * this.hx[j]! + ez * this.hz[j]!;
      const wall = side >= 0 ? t.wallR[j]! : t.wallL[j]!;
      return Math.abs(side) < wall + pad;
    });
  }
  /** Road-edge height on a side (-1 left, +1 right). */
  yEdge(i: number, side: number): number { return this.t.py[i]! + this.t.ry[i]! * side * this.t.hw[i]!; }
  wall(i: number, side: number): number { return side < 0 ? this.t.wallL[i]! : this.t.wallR[i]!; }
  edge(i: number, side: number): number { return side < 0 ? this.t.edgeL[i]! : this.t.edgeR[i]!; }
  /** Interpolated centreline frame at arc length s (no ramps). */
  frameAt(s: number, out: Frame): Frame {
    const t = this.t;
    let ss = s % t.length; if (ss < 0) ss += t.length;
    const f = ss / this.sp;
    const i = Math.floor(f) % this.n, j = (i + 1) % this.n, k = f - Math.floor(f);
    const L = (a: ArrayLike<number>) => a[i]! + (a[j]! - a[i]!) * k;
    out.i = i;
    out.px = L(t.px); out.py = L(t.py); out.pz = L(t.pz);
    out.rx = L(t.rx); out.ry = L(t.ry); out.rz = L(t.rz);
    out.ux = L(t.ux); out.uy = L(t.uy); out.uz = L(t.uz);
    out.hw = L(t.hw);
    const fx = L(t.tx), fz = L(t.tz), fl = Math.hypot(fx, fz) || 1;
    out.fx = fx / fl; out.fz = fz / fl;
    out.yaw = Math.atan2(out.fx, out.fz);
    out.ramp = t.rampH[i]! + (t.rampH[j]! - t.rampH[i]!) * k;
    return out;
  }
}

interface GroundInfo { low: number; lowOther: number; pit: number }

interface Frame {
  i: number;
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fz: number; yaw: number; hw: number; ramp: number;
}
const newFrame = (): Frame => ({ i: 0, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fz: 1, yaw: 0, hw: 9, ramp: 0 });

/** Local model frame at a world point with a yaw (rotation.y semantics). */
function yawMatrix(x: number, y: number, z: number, yaw: number, scale = 1): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(yaw);
  if (scale !== 1) m.scale(new THREE.Vector3(scale, scale, scale));
  m.setPosition(x, y, z);
  return m;
}

/** A local box (min/max corners) as a prepared geometry. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: THREE.ColorRepresentation, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return prep(g, color, m);
}
function roundedBox(w: number, h: number, d: number, r: number, cx: number, cy: number, cz: number, color?: THREE.ColorRepresentation, m?: THREE.Matrix4, seg = 2): THREE.BufferGeometry {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const sub = new THREE.BoxGeometry(w, h, d, seg * 2 + 1, seg * 2 + 1, seg * 2 + 1);
  const p = sub.attributes.position as THREE.BufferAttribute;
  const nrm = sub.attributes.normal as THREE.BufferAttribute;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  const N = seg * 2 + 1;
  const remap = (x: number, size: number, inner: number) => {
    const k = Math.round((x + size / 2) / (size / N));
    if (k <= seg) return -size / 2 + (k / seg) * r;
    if (k >= N - seg) return inner + ((k - (N - seg)) / seg) * r;
    return x < 0 ? -inner : inner;
  };
  for (let i = 0; i < p.count; i++) {
    const x = remap(p.getX(i), w, hx), y = remap(p.getY(i), h, hy), z = remap(p.getZ(i), d, hz);
    // project the outer band onto the rounded shape
    const cxv = Math.max(-hx, Math.min(hx, x)), cyv = Math.max(-hy, Math.min(hy, y)), czv = Math.max(-hz, Math.min(hz, z));
    const dx = x - cxv, dy = y - cyv, dz = z - czv;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) {
      p.setXYZ(i, cxv + (dx / l) * r, cyv + (dy / l) * r, czv + (dz / l) * r);
      nrm.setXYZ(i, dx / l, dy / l, dz / l);
    }
  }
  sub.translate(cx, cy, cz);
  return prep(sub, color, m);
}

function cyl(rTop: number, rBot: number, h: number, seg: number, cx: number, cy: number, cz: number, color?: THREE.ColorRepresentation, m?: THREE.Matrix4, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  g.translate(cx, cy + h / 2, cz);
  return prep(g, color, m);
}
function sphere(r: number, ws: number, hs: number, cx: number, cy: number, cz: number, color?: THREE.ColorRepresentation, m?: THREE.Matrix4, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, ws, hs);
  g.scale(sx, sy, sz);
  g.translate(cx, cy, cz);
  return prep(g, color, m);
}

/** Double-sided textured quad in local coords (for banners): centre, width (local X), height, facing +Z and -Z. */
function bannerQuads(rect: [number, number, number, number], w: number, h: number, cx: number, cy: number, cz: number, depth: number, m: THREE.Matrix4, both = true): THREE.BufferGeometry {
  const g = new Geo();
  const [u0, v0, u1, v1] = rect;
  // front (+Z): viewer looks toward -Z, their right is -X ... local +X = viewer's left
  const zf = cz + depth / 2, zb = cz - depth / 2;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  // front face: text reads left→right for a viewer at +Z looking -Z: viewer's right = +X
  let a = g.add(x0, y0, zf, u0, v0), b = g.add(x1, y0, zf, u1, v0), c = g.add(x1, y1, zf, u1, v1), d = g.add(x0, y1, zf, u0, v1);
  g.idx.push(a, b, c, a, c, d);
  if (both) {
    a = g.add(x1, y0, zb, u0, v0); b = g.add(x0, y0, zb, u1, v0); c = g.add(x0, y1, zb, u1, v1); d = g.add(x1, y1, zb, u0, v1);
    g.idx.push(a, b, c, a, c, d);
  }
  const geo = g.toGeometry();
  geo.applyMatrix4(m);
  return geo;
}

// ───────────────────────────── theme styling ─────────────────────────────

const col = (hex: string) => new THREE.Color(hex);
const dark = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

interface Style {
  pal: ThemePalette;
  theme: ThemeId;
  night: boolean;
  /** Emissive strength for signage & glow at night / day. */
  glow: number;
}

// ───────────────────────────── builder ─────────────────────────────

type BarrierStyle = ThemePalette['barrier'];

const BRANDS: TX.BannerSpec[] = [
  { text: 'TURBO PALS GRAND PRIX', bg: '#1d2360', fg: '#ffd23f', outline: '#0b0f33', ends: 'checker' },
  { text: 'TURBO', bg: '#e63946', fg: '#ffffff', ends: 'stripes' },
  { text: 'PALS FUEL', bg: '#1f6feb', fg: '#ffd23f', ends: 'stripes' },
  { text: 'ZOOM COLA', bg: '#d62828', fg: '#ffffff', sub: 'FIZZY · FAST · FUN' },
  { text: 'SPROUT TYRES', bg: '#2a9d8f', fg: '#ffffff', ends: 'stripes' },
  { text: 'BOLT BATTERY', bg: '#ffc300', fg: '#2b2b2b', outline: 'rgba(255,255,255,0.6)' },
  { text: 'MOCHI MOTORS', bg: '#ff5fa2', fg: '#ffffff', ends: 'stripes' },
  { text: 'STAR SNACKS', bg: '#6a4cff', fg: '#ffe600', sub: 'CRUNCHY COSMIC BITES' },
];

class TrackMeshBuilder {
  readonly c: Ctx;
  readonly t: BuiltTrack;
  readonly st: Style;
  readonly q: RenderQuality;
  readonly group = new THREE.Group();
  readonly buckets = new Buckets();
  readonly materials = new Map<string, THREE.Material>();
  readonly textures: THREE.Texture[] = [];
  readonly geometries: THREE.BufferGeometry[] = [];
  readonly instanced: THREE.InstancedMesh[] = [];
  /** Animated texture offsets: [texture, speedU, speedV]. */
  readonly scrollers: Array<[THREE.Texture, number, number]> = [];
  readonly pulses: Array<{ mat: THREE.Material & { opacity: number }; base: number; amp: number; freq: number }> = [];
  readonly timeUniform = { value: 0 };
  lamps: THREE.InstancedMesh | null = null;
  lampHalos: THREE.InstancedMesh | null = null;
  lampCols = 3;
  banner!: TX.BannerAtlas;
  private brandCursor = 1;
  private readonly fr = newFrame();
  /** Per side [left, right], per sample: verge/embankment profile points 4 and 5 (d4, y4, d5, y5) from buildShoulders. */
  private bankProf: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];

  constructor(track: BuiltTrack, theme: ThemeId, quality: RenderQuality) {
    this.t = track;
    this.c = new Ctx(track, theme === 'city' || theme === 'volcano');
    this.q = quality;
    const pal = THEME_PALETTES[theme];
    this.st = { pal, theme, night: pal.night, glow: pal.night ? 1 : 0.35 };
    // Starlight roads float in open space: every section gets a deck underside and lipped verges.
    if (theme === 'galaxy') this.c.over.fill(1);
    this.group.name = 'track-mesh';
  }

  tex<T extends THREE.Texture>(t: T): T { this.textures.push(t); return t; }
  mat<M extends THREE.Material>(key: string, make: () => M): M {
    let m = this.materials.get(key) as M | undefined;
    if (!m) { m = make(); m.name = `track:${key}`; this.materials.set(key, m); }
    return m;
  }
  nextBrand(): number {
    const b = this.brandCursor;
    this.brandCursor = this.brandCursor >= BRANDS.length - 1 ? 1 : this.brandCursor + 1;
    return b;
  }

  // ───────────── road ─────────────

  buildRoad(): void {
    const { t, c, st } = this;
    const rt = TX.createRoadTextures(st.theme);
    this.tex(rt.map); if (rt.emissiveMap) this.tex(rt.emissiveMap); if (rt.roughnessMap) this.tex(rt.roughnessMap);
    const rep = t.length / Math.max(1, Math.round(t.length / rt.repeatLength));
    const galaxy = st.theme === 'galaxy';
    this.mat('road', () => new THREE.MeshStandardMaterial({
      map: rt.map, vertexColors: true,
      roughness: galaxy ? 0.25 : st.theme === 'city' ? 0.5 : 0.9,
      roughnessMap: rt.roughnessMap,
      metalness: galaxy ? 0.2 : 0,
      emissive: rt.emissiveMap ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      emissiveMap: rt.emissiveMap,
      emissiveIntensity: galaxy ? 1.0 : st.theme === 'city' ? 0.75 : st.theme === 'volcano' ? 0.9 : 0,
      transparent: galaxy,
      opacity: galaxy ? 0.86 : 1,
      depthWrite: true,
    }));
    const L = this.q.level === 'low' ? 4 : 6;
    const g = new Geo();
    const rows = t.n + 1;
    strip(g, rows, L + 1, (r, k, o) => {
      const i = r % t.n;
      const hw = t.hw[i]!;
      const d = -hw + (2 * hw * k) / L;
      o.x = t.px[i]! + t.rx[i]! * d; o.y = t.py[i]! + t.ry[i]! * d; o.z = t.pz[i]! + t.rz[i]! * d;
      o.u = k / L; o.v = (r * c.sp) / rep;
      // low-frequency tone variation breaks up texture tiling
      const sv = r * c.sp;
      const tone = 0.94 + 0.035 * Math.sin(sv * 0.043 + d * 0.21) + 0.03 * Math.sin(sv * 0.117 - d * 0.47 + 1.7) + 0.02 * Math.sin(sv * 0.29 + 2.3);
      o.r = o.g = o.b = galaxy ? 1 : tone;
    });
    this.buckets.add('road', g);
  }

  // ───────────── shoulders ─────────────

  buildShoulders(): void {
    const { t, c, st } = this;
    const gt = this.tex(TX.createGroundTexture(st.theme));
    const pitDeck = (i: number) => c.over[i] === 1;
    this.bankProf = [new Float32Array(t.n * 4).fill(NaN), new Float32Array(t.n * 4).fill(NaN)];
    this.mat('shoulder', () => new THREE.MeshStandardMaterial({ map: gt, vertexColors: true, roughness: st.theme === 'city' ? 0.8 : 0.95 }));
    const g = new Geo();
    const COLS = 6;
    const prof = new Float32Array(COLS * 3); // d, y, shade per profile point (outward order)
    const profile = (i: number, side: number): Float32Array => {
      const hw = t.hw[i]!, wall = Math.max(c.wall(i, side), hw + 0.3);
      const ye = c.yEdge(i, side);
      const d1 = hw + Math.min(0.8, (wall - hw) * 0.5);
      // low-frequency tone so the verge never reads as one flat tint
      const tone = 0.93 + 0.07 * Math.sin(i * c.sp * 0.051 + side * 1.7) * Math.sin(i * c.sp * 0.013 + 0.6);
      const set = (k: number, d: number, y: number, sh: number) => { prof[k * 3] = d; prof[k * 3 + 1] = y; prof[k * 3 + 2] = sh * tone; };
      set(0, hw - 0.03, ye - 0.012, 0.62);
      set(1, d1, ye, 0.9);
      set(2, (d1 + wall) / 2, ye, 1);
      set(3, wall + 0.25, ye, 1);
      set(4, wall + 1.6, ye - 0.42, 0.92);
      if (pitDeck(i)) set(5, wall + 1.8, ye - 0.5, 0.72);
      else {
        // embankment down to (below) the terrain: a steep bank/cliff where the ground falls far away,
        // pulled in to a retaining face when its toe would land in a lower section's corridor
        const drop = Math.max(5.5, c.drop[side < 0 ? 0 : 1][i]! + 1.5);
        let run = Math.max(3.4, Math.min(10, drop * 0.45));
        const hx = t.rx[i]! * side, hz = t.rz[i]! * side;
        for (let k = 0; k < 3; k++) {
          const dd = wall + 1.6 + run;
          if (!c.inCorridor(t.px[i]! + hx * dd, t.pz[i]! + hz * dd, ye - drop, 1.5)) break;
          run *= 0.35;
        }
        set(5, wall + 1.6 + run, ye - drop, drop > 9 ? 0.58 : 0.66);
      }
      // remembered for the feet of road-spanning structures standing beyond the barrier (see groundBeyond)
      this.bankProf[side < 0 ? 0 : 1].set([prof[12]!, prof[13]!, prof[15]!, prof[16]!], i * 4);
      return prof;
    };
    const cliffTex = this.tex(TX.createCliffTexture(st.theme));
    this.mat('cliff', () => new THREE.MeshStandardMaterial({ map: cliffTex, vertexColors: true, roughness: st.theme === 'city' ? 0.8 : 0.93 }));
    const cliff = new Geo();
    for (const side of [-1, 1]) {
      for (const run of runsOf(t.n, i => c.edge(i, side) !== 2)) {
        const rows = runRows(run);
        const P = new Float32Array(rows * COLS * 3);
        for (let r = 0; r < rows; r++) P.set(profile((run.start + r) % t.n, side), r * COLS * 3);
        const at = (r: number, k: number, q: number) => P[(r * COLS + k) * 3 + q]!;
        const place = (r: number, k: number, o: Vtx) => {
          const i = (run.start + r) % t.n;
          const d = at(r, k, 0);
          o.x = t.px[i]! + t.rx[i]! * side * d; o.z = t.pz[i]! + t.rz[i]! * side * d; o.y = at(r, k, 1);
        };
        // verge: road edge → barrier → top of the bank (profile points 0..4); outward order, left side reversed
        const VC = COLS - 1;
        strip(g, rows, VC, (r, k0, o) => {
          const k = side > 0 ? k0 : VC - 1 - k0;
          place(r, k, o);
          let u = 0;
          for (let q = 1; q <= k; q++) u += Math.hypot(at(r, q, 0) - at(r, q - 1, 0), at(r, q, 1) - at(r, q - 1, 1));
          o.u = (u / 6) * side; o.v = ((run.start + r) * c.sp) / 6;
          o.r = o.g = o.b = at(r, k, 2);
        });
        // bank / cliff face (points 4..5) in the themed rock material; strata follow world height
        strip(cliff, rows, 2, (r, k0, o) => {
          const k = side > 0 ? VC - 1 + k0 : COLS - 1 - k0;
          place(r, k, o);
          o.u = ((run.start + r) * c.sp) / 8; o.v = o.y / 6;
          o.r = o.g = o.b = k === VC - 1 ? 1 : 0.72;
        });
        if (!run.closed) {
          // close the cross-section where the verge ends (next to a pit edge): a rock face seen from the chasm
          for (const end of [0, rows - 1]) {
            const i = (run.start + end) % t.n;
            const hw = t.hw[i]!;
            const botY = Math.min(at(end, COLS - 1, 1), c.yEdge(i, side) - 1.2);
            const V = (d: number, y: number, sh: number) => cliff.add(t.px[i]! + t.rx[i]! * side * d, y, t.pz[i]! + t.rz[i]! * side * d, (d * side) / 8, y / 6, sh, sh, sh);
            // both windings on separate vertices (seen from either side; normals stay valid)
            for (const flip of [false, true]) {
              const base = cliff.count;
              for (let k = 0; k < COLS; k++) V(at(end, k, 0), at(end, k, 1), 0.85);
              const anchor = V(hw - 0.03, botY, 0.7);
              for (let k = 0; k < COLS - 1; k++) {
                if (flip) cliff.tri(anchor, base + k + 1, base + k); else cliff.tri(anchor, base + k, base + k + 1);
              }
            }
          }
        }
      }
    }
    this.buckets.add('cliff', cliff);
    this.buckets.add('shoulder', g);
  }

  // ───────────── curbs ─────────────

  curbWeights(side: number): Float32Array {
    const { t, c } = this;
    const n = t.n;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(t.curvature[i]!);
      raw[i] = c.edge(i, side) === 2 ? 0 : smooth01(1 / 115, 1 / 88, k);
    }
    const dil = new Float32Array(n);
    const W = 7;
    for (let i = 0; i < n; i++) { let m = 0; for (let k = -W; k <= W; k++) m = Math.max(m, raw[(i + k + n) % n]!); dil[i] = m; }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; for (let k = -W; k <= W; k++) s += dil[(i + k + n) % n]!;
      out[i] = c.edge(i, side) === 2 ? 0 : s / (2 * W + 1);
    }
    return out;
  }

  buildCurbs(): void {
    const { t, c, st } = this;
    const ct = this.tex(TX.createCurbTexture(st.pal.curbA, st.pal.curbB));
    const neonCurb = st.theme === 'city' || st.theme === 'galaxy';
    this.mat('curb', () => new THREE.MeshStandardMaterial({
      map: ct, roughness: 0.55,
      emissive: neonCurb ? new THREE.Color(0xffffff) : new THREE.Color(0),
      emissiveMap: neonCurb ? ct : null, emissiveIntensity: neonCurb ? 0.35 : 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    const g = new Geo();
    for (const side of [-1, 1]) {
      const w = this.curbWeights(side);
      for (const run of runsOf(t.n, i => w[i]! > 0.02)) {
        const rows = runRows(run);
        const COLS = 5;
        strip(g, rows, COLS, (r, k0, o) => {
          const i = (run.start + r) % t.n;
          const k = side > 0 ? k0 : COLS - 1 - k0;
          const ww = w[i]!;
          const hw = t.hw[i]!;
          const width = 0.95 * ww;
          const H = 0.06 * ww;
          // inner (on road) → outer (over the road edge)
          const prof: Array<[number, number, number]> = [
            [hw - width, 0.004, 0],
            [hw - width + 0.14 * ww, H, 0.15],
            [hw - 0.1, H, 0.85],
            [hw + 0.08, H * 0.6, 0.95],
            [hw + 0.2, -0.03, 1],
          ];
          const [d, h, u] = prof[k]!;
          const dd = d * side;
          o.x = t.px[i]! + t.rx[i]! * dd + t.ux[i]! * h;
          o.y = t.py[i]! + t.ry[i]! * dd + t.uy[i]! * h;
          o.z = t.pz[i]! + t.rz[i]! * dd + t.uz[i]! * h;
          if (k >= 3) o.y = Math.max(o.y, c.yEdge(i, side) + h);
          o.u = u; o.v = ((run.start + r) * c.sp) / 3;
        });
      }
    }
    this.buckets.add('curb', g);
  }

  // ───────────── barriers ─────────────

  barrierPath(run: Run, side: number, offset = 0): BPath {
    const { t, c } = this;
    const rows = runRows(run);
    const P: BPath = {
      n: rows, x: new Float32Array(rows), y: new Float32Array(rows), z: new Float32Array(rows),
      nx: new Float32Array(rows), nz: new Float32Array(rows), a: new Float32Array(rows), i: new Int32Array(rows),
      open: !run.closed,
    };
    for (let r = 0; r < rows; r++) {
      const i = (run.start + r) % t.n;
      const w = Math.max(c.wall(i, side), t.hw[i]! + 0.3) + offset;
      P.i[r] = i;
      P.x[r] = t.px[i]! + t.rx[i]! * side * w;
      P.z[r] = t.pz[i]! + t.rz[i]! * side * w;
      P.y[r] = c.yEdge(i, side);
      P.nx[r] = c.hx[i]! * side; P.nz[r] = c.hz[i]! * side;
      P.a[r] = r === 0 ? 0 : P.a[r - 1]! + Math.hypot(P.x[r]! - P.x[r - 1]!, P.z[r]! - P.z[r - 1]!);
    }
    return P;
  }

  /**
   * Sweep profile lines (o = outward offset from the path, h = height, v = texture v) along a path.
   * Lines are given for the RIGHT side in clockwise order (outward-facing); mirrored for the left.
   */
  sweepPath(g: Geo, P: BPath, side: number, lines: ProfileLine[], uLen: number,
    opts: { swapUV?: boolean; color?: (r: number, line: number, k: number) => number; colorRGB?: [number, number, number][];
      scaleH?: (r: number) => number; cap?: boolean } = {}): void {
    lines.forEach((line, li) => {
      const cols = line.length;
      strip(g, P.n, cols, (r, k0, o) => {
        const k = side > 0 ? k0 : cols - 1 - k0;
        const [off, h0, v] = line[k]!;
        const h = opts.scaleH ? h0 * (h0 > 0 ? opts.scaleH(r) : 1) : h0;
        o.x = P.x[r]! + P.nx[r]! * off; o.y = P.y[r]! + h; o.z = P.z[r]! + P.nz[r]! * off;
        if (opts.swapUV) { o.u = v; o.v = P.a[r]! / uLen; } else { o.u = P.a[r]! / uLen; o.v = v; }
        const rgb = opts.colorRGB?.[li];
        if (rgb) { o.r = rgb[0]; o.g = rgb[1]; o.b = rgb[2]; }
        if (opts.color) { const s = opts.color(r, li, k); o.r *= s; o.g *= s; o.b *= s; }
      });
    });
    if (opts.cap && P.open && P.n >= 2) {
      // flat end caps from the concatenated outline
      const outline: Array<[number, number]> = [];
      for (const line of lines) for (const [o, h] of line) outline.push([o, h]);
      for (const end of [0, P.n - 1]) {
        const r = end;
        const fx = end === 0 ? -1 : 1;
        const dirx = P.x[Math.min(P.n - 1, r + 1)]! - P.x[Math.max(0, r - 1)]!;
        const dirz = P.z[Math.min(P.n - 1, r + 1)]! - P.z[Math.max(0, r - 1)]!;
        let cx = 0, cy = 0;
        for (const [o, h] of outline) { cx += o; cy += h; }
        cx /= outline.length; cy /= outline.length;
        const pt = (o: number, h: number) => g.add(P.x[r]! + P.nx[r]! * o, P.y[r]! + h, P.z[r]! + P.nz[r]! * o, 0.5, 0.5);
        const cI = pt(cx, cy);
        for (let k = 0; k < outline.length - 1; k++) {
          const a = pt(outline[k]![0], outline[k]![1]), b = pt(outline[k + 1]![0], outline[k + 1]![1]);
          // orient by the along direction
          const ax = g.pos[a * 3]! - g.pos[cI * 3]!, ay = g.pos[a * 3 + 1]! - g.pos[cI * 3 + 1]!, az = g.pos[a * 3 + 2]! - g.pos[cI * 3 + 2]!;
          const bx = g.pos[b * 3]! - g.pos[cI * 3]!, by = g.pos[b * 3 + 1]! - g.pos[cI * 3 + 1]!, bz = g.pos[b * 3 + 2]! - g.pos[cI * 3 + 2]!;
          const nx = ay * bz - az * by, nz = ax * by - ay * bx;
          if ((nx * dirx + nz * dirz) * fx >= 0) g.tri(cI, a, b); else g.tri(cI, b, a);
        }
      }
    }
  }

  /** Walk a path by arc length and call fn at each placement. */
  alongPath(P: BPath, spacing: number, fn: (x: number, y: number, z: number, nx: number, nz: number, k: number, r: number) => void, startOffset = 0): void {
    const total = P.a[P.n - 1]!;
    let r = 0, k = 0;
    for (let s = startOffset; s <= total; s += spacing, k++) {
      while (r < P.n - 2 && P.a[r + 1]! < s) r++;
      const seg = P.a[r + 1]! - P.a[r]!;
      const f = seg > 1e-6 ? Math.min(1, Math.max(0, (s - P.a[r]!) / seg)) : 0;
      const L = (arr: Float32Array) => arr[r]! + (arr[r + 1]! - arr[r]!) * f;
      const nx = L(P.nx), nz = L(P.nz), nl = Math.hypot(nx, nz) || 1;
      fn(L(P.x), L(P.y), L(P.z), nx / nl, nz / nl, k, r);
    }
  }

  barrierRuns(): Array<{ run: Run; side: number }> {
    const out: Array<{ run: Run; side: number }> = [];
    for (const side of [-1, 1]) for (const run of runsOf(this.t.n, i => this.c.edge(i, side) !== 2)) out.push({ run, side });
    return out;
  }

  buildBarriers(): void {
    const style = this.st.pal.barrier;
    const runs = this.barrierRuns();
    if (runs.length === 0) return;
    switch (style) {
      case 'tires': this.barrierTires(runs); break;
      case 'fence': this.barrierFence(runs); break;
      case 'stone': this.barrierStone(runs); break;
      case 'rail': this.barrierRail(runs); break;
      case 'snowbank': this.barrierSnow(runs); break;
      case 'wood': this.barrierWood(runs); break;
      case 'neon': this.barrierNeon(runs); break;
      case 'hedge': this.barrierHedge(runs); break;
    }
  }

  /** Posts (or any small repeated prop) as an instanced mesh along barrier paths. */
  postsAlong(name: string, geo: THREE.BufferGeometry, material: THREE.Material, runs: Array<{ run: Run; side: number }>,
    spacing: number, offset: number, opts: { color?: (k: number) => THREE.Color | null; shadow?: boolean; jitter?: number; start?: number } = {}): THREE.InstancedMesh | null {
    const { mats, colors } = this.placeAlong(runs, spacing, offset, opts);
    if (mats.length === 0) { geo.dispose(); return null; }
    return this.instancedFrom(name, geo, material, mats, colors.length === mats.length ? colors : null, opts.shadow ?? true);
  }

  /** Instance transforms (and optional colours) for a small prop repeated along the barrier paths. */
  placeAlong(runs: Array<{ run: Run; side: number }>, spacing: number, offset: number,
    opts: { color?: (k: number) => THREE.Color | null; jitter?: number; start?: number } = {}): { mats: THREE.Matrix4[]; colors: THREE.Color[] } {
    const mats: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.alongPath(P, spacing, (x, y, z, nx, nz, k) => {
        const yaw = Math.atan2(-nx, -nz);
        const j = opts.jitter ?? 0;
        const m = yawMatrix(x + nx * offset, y, z + nz * offset, yaw + (rnd() - 0.5) * j * 0.5, 1 + (rnd() - 0.5) * j * 0.1);
        mats.push(m);
        const cc = opts.color?.(k);
        if (cc) colors.push(cc);
      }, opts.start ?? spacing * 0.5);
    }
    return { mats, colors };
  }

  instancedFrom(name: string, geo: THREE.BufferGeometry, material: THREE.Material, mats: THREE.Matrix4[], colors: THREE.Color[] | null, shadow: boolean): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, material, mats.length);
    im.name = `track:${name}`;
    mats.forEach((m, k) => im.setMatrixAt(k, m));
    if (colors) colors.forEach((cc, k) => im.setColorAt(k, cc));
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadow; im.receiveShadow = true;
    im.computeBoundingSphere();
    this.group.add(im);
    this.instanced.push(im);
    this.geometries.push(geo);
    return im;
  }

  /** Tyre-wall placements, instanced in buildTyres() once the rest of the triangle budget is known. */
  tyrePending: { mats: THREE.Matrix4[]; colors: THREE.Color[] } | null = null;

  barrierTires(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    const cA = col(pal.barrierA), cB = col(pal.barrierB);
    const cW = new THREE.Color('#f4f4f4');
    this.tyrePending = this.placeAlong(runs, 0.94, 0.47, {
      jitter: 0.6,
      color: k => (k % 4 === 1 ? cB : k % 4 === 3 ? (pal.barrierB.toLowerCase() === '#f1f1f1' ? cA : cW) : cA),
    });
    // A low base strip keeps the stacks visually grounded.
    const g = new Geo();
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.sweepPath(g, P, side, [[[-0.04, 0.0, 0], [-0.04, 0.08, 0.1], [0.98, 0.08, 0.9], [0.98, -0.25, 1]]], 4, { color: () => 0.55 });
    }
    this.buckets.add('shoulderPlain', g);
  }

  barrierFence(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    const plank = this.tex(TX.createPlankTexture('#ead7b8'));
    this.mat('wood', () => new THREE.MeshStandardMaterial({ map: plank, vertexColors: true, roughness: 0.85 }));
    const g = new Geo();
    const railA = col(pal.barrierA), railB = col(pal.barrierB);
    const board = (hc: number, hh: number): ProfileLine[] => [
      [[-0.06, hc - hh, 0], [-0.06, hc + hh, 1]],
      [[-0.06, hc + hh, 0], [0.04, hc + hh, 0.2]],
      [[0.04, hc + hh, 0], [0.04, hc - hh, 1]],
      [[0.04, hc - hh, 0], [-0.06, hc - hh, 0.2]],
    ];
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      for (const [hc, hh, colr] of [[0.32, 0.1, railA], [0.66, 0.1, railA], [0.98, 0.11, railB]] as const) {
        this.sweepPath(g, P, side, board(hc, hh), 4, { colorRGB: [0, 1, 2, 3].map(() => [colr.r, colr.g, colr.b] as [number, number, number]), cap: true });
      }
    }
    this.buckets.add('wood', g);
    const post = box(-0.12, -0.1, -0.12, 0.12, 1.12, 0.12, dark(pal.barrierA, 0.85));
    const cap = cyl(0.0, 0.17, 0.16, 4, 0, 1.12, 0, pal.barrierB);
    cap.rotateY(Math.PI / 4);
    const pg = mergeGeometries([post, cap])!; post.dispose(); cap.dispose();
    const pm = this.mat('post', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    this.postsAlong('fencePosts', pg, pm, runs, 2.6, 0.12);
  }

  barrierStone(runs: Array<{ run: Run; side: number }>): void {
    const { pal, theme } = this.st;
    const glowM = theme === 'volcano';
    const st = TX.createStoneTexture(pal.barrierA, pal.barrierB, glowM);
    this.tex(st.map); if (st.emissiveMap) this.tex(st.emissiveMap);
    this.mat('stone', () => new THREE.MeshStandardMaterial({
      map: st.map, vertexColors: true, roughness: 0.9,
      emissive: glowM ? col(pal.barrierB) : new THREE.Color(0), emissiveMap: st.emissiveMap, emissiveIntensity: glowM ? 1.1 : 0,
    }));
    const g = new Geo();
    const Hh = 0.95, W = 0.7;
    const lines: ProfileLine[] = [
      [[0, -0.5, 0], [0, Hh, (Hh + 0.5) / 1.2]],
      [[0, Hh, 0], [0.1, Hh + 0.14, 0.12], [W - 0.1, Hh + 0.14, 0.5], [W, Hh, 0.62]],
      [[W, Hh, 0], [W, -0.5, (Hh + 0.5) / 1.2]],
    ];
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.sweepPath(g, P, side, lines, 4, { cap: true, color: (r) => 0.9 + 0.1 * Math.sin(P.a[r]! * 0.37) });
      // pier blocks / crenellations
      const every = theme === 'volcano' ? 3.2 : 11;
      this.alongPath(P, every, (x, y, z, nx, nz, k, r) => {
        // square the pier block to the WALL, not to the centreline: where the barrier angles in (wall-distance
        // transitions) a block squared to the track frame poked a corner 0.5–0.7 m into the drivable verge
        let tx = P.x[Math.min(P.n - 1, r + 1)]! - P.x[r]!, tz = P.z[Math.min(P.n - 1, r + 1)]! - P.z[r]!;
        const tl = Math.hypot(tx, tz);
        let ox = nx, oz = nz;
        if (tl > 1e-6) {
          tx /= tl; tz /= tl;
          ox = tz; oz = -tx;
          if (ox * nx + oz * nz < 0) { ox = -ox; oz = -oz; }
        }
        const cosA = Math.max(0.5, ox * nx + oz * nz);
        const off = 0.6 - 0.25 * cosA;   // 0.35 on straight walls, a little further out on angled ones
        const yaw = Math.atan2(-ox, -oz);
        const m = yawMatrix(x + ox * off, y, z + oz * off, yaw);
        if (theme === 'volcano') {
          if (k % 2 === 0) this.buckets.add('stoneProps', uvScale(box(-0.55, Hh + 0.1, -0.42, 0.55, Hh + 0.55, 0.42, 0xffffff, m), 0.28, 0.3));
        } else {
          this.buckets.add('stoneProps', uvScale(box(-0.62, -0.4, -0.5, 0.62, Hh + 0.55, 0.5, 0xdcdcd0, m), 0.3, 1.1));
          this.buckets.add('stoneProps', uvScale(box(-0.72, Hh + 0.55, -0.6, 0.72, Hh + 0.72, 0.6, 0xf0f0e6, m), 0.35, 0.15));
        }
      }, 2);
    }
    this.buckets.add('stone', g);
  }

  barrierRail(runs: Array<{ run: Run; side: number }>): void {
    const metal = this.tex(TX.createMetalTexture());
    this.mat('metal', () => new THREE.MeshStandardMaterial({ map: metal, vertexColors: true, roughness: 0.38, metalness: 0.55 }));
    const g = new Geo();
    const front: Array<[number, number, number]> = [[-0.02, 0.5, 0], [-0.13, 0.58, 0.25], [-0.05, 0.68, 0.5], [-0.13, 0.78, 0.75], [-0.02, 0.86, 1]];
    const lines: ProfileLine[] = [front, [[-0.02, 0.86, 0], [0.02, 0.86, 0.1]], [[0.02, 0.86, 0], [0.02, 0.5, 1]], [[0.02, 0.5, 0], [-0.02, 0.5, 0.1]]];
    const tint = col(this.st.pal.barrierA);
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.sweepPath(g, P, side, lines, 4, { cap: true, colorRGB: lines.map(() => [tint.r, tint.g, tint.b] as [number, number, number]) });
    }
    this.buckets.add('metal', g);
    const post = box(-0.07, -0.3, -0.06, 0.07, 0.92, 0.06, 0x8d959c);
    const pm = this.mat('post', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 }));
    this.postsAlong('railPosts', post, pm, runs, 2.0, 0.08);
    // reflectors
    const refl = box(-0.06, 0.62, -0.075, 0.06, 0.74, -0.06, this.st.pal.barrierB);
    this.postsAlong('railReflectors', refl, this.glowMat('reflector', this.st.pal.barrierB, 1.2), runs, 8.0, 0.08, { shadow: false });
  }

  barrierSnow(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    const snow = this.tex(TX.createSnowTexture(pal.barrierB));
    this.mat('snowbank', () => new THREE.MeshStandardMaterial({ map: snow, vertexColors: true, roughness: 0.72 }));
    const g = new Geo();
    const prof: Array<[number, number, number]> = [
      [-0.2, -0.45, 0], [-0.12, 0.3, 0.12], [0.1, 0.78, 0.25], [0.45, 1.05, 0.38], [0.95, 1.14, 0.5],
      [1.5, 1.02, 0.62], [1.95, 0.66, 0.75], [2.3, 0.2, 0.88], [2.6, -0.5, 1],
    ];
    const blue = col(pal.barrierB);
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      const lump = (r: number) => {
        const a = P.a[r]! + side * 17.3;
        return 0.84 + 0.12 * Math.sin(a * 0.41) * Math.sin(a * 0.13 + 1.3) + 0.07 * Math.sin(a * 1.37 + 0.4);
      };
      this.sweepPath(g, P, side, [prof], 5, {
        scaleH: lump, cap: true,
        color: (_r, _l, k) => (k <= 1 || k >= 7 ? 0.82 : 1),
      });
      void blue;
    }
    this.buckets.add('snowbank', g);
    // red/white marker poles on top of the bank
    const parts: THREE.BufferGeometry[] = [];
    for (let s = 0; s < 6; s++) parts.push(cyl(0.05, 0.05, 0.36, 6, 0, 0.6 + s * 0.36, 0, s % 2 ? 0xffffff : col(pal.accent), undefined, true));
    parts.push(sphere(0.07, 6, 4, 0, 0.6 + 6 * 0.36, 0, col(pal.accent)));
    const pole = mergeGeometries(parts)!; parts.forEach(p => p.dispose());
    const pm = this.mat('post', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    this.postsAlong('snowPoles', pole, pm, runs, 16, 0.55, { jitter: 0.3 });
  }

  barrierWood(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    const plank = this.tex(TX.createPlankTexture(pal.barrierA));
    this.mat('wood', () => new THREE.MeshStandardMaterial({ map: plank, vertexColors: true, roughness: 0.85 }));
    this.mat('painted', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
    const g = new Geo(), cap = new Geo();
    const Hh = 0.86;
    const lines: ProfileLine[] = [
      [[0, -0.4, 0], [0, Hh, 1]],
      [[0.14, Hh, 0], [0.14, -0.4, 1]],
    ];
    const capLine: ProfileLine = [[-0.05, Hh - 0.04, 0], [-0.05, Hh + 0.08, 0], [0.0, Hh + 0.14, 0], [0.14, Hh + 0.14, 0], [0.19, Hh + 0.08, 0], [0.19, Hh - 0.04, 0], [-0.05, Hh - 0.04, 0]];
    const w = col(pal.barrierB);
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.sweepPath(g, P, side, lines, 3, { cap: true });
      this.sweepPath(cap, P, side, [capLine], 3, { colorRGB: [[w.r, w.g, w.b]], cap: true });
    }
    this.buckets.add('wood', g);
    this.buckets.add('painted', cap);
    const post = box(-0.13, -0.1, -0.13, 0.13, 1.08, 0.13, pal.barrierB);
    const knob = sphere(0.16, 6, 4, 0, 1.12, 0, pal.barrierB);
    const pg = mergeGeometries([post, knob])!; post.dispose(); knob.dispose();
    this.postsAlong('woodPosts', pg, this.materials.get('painted')!, runs, 3.2, 0.07);
    // rope swag between posts (thin dark tube at mid height) – cheap: part of cap bucket
  }

  barrierNeon(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    this.mat('neonBase', () => new THREE.MeshStandardMaterial({ color: col(pal.barrierA), vertexColors: true, roughness: 0.35, metalness: 0.4 }));
    const pulse = this.tex(TX.createNeonPulseTexture());
    this.scrollers.push([pulse, 0, -0.55]);
    const tube = this.mat('neonTube', () => new THREE.MeshStandardMaterial({
      color: col(pal.barrierB).multiplyScalar(0.6), emissive: col(pal.barrierB), emissiveMap: pulse,
      // galaxy (bloom 1.1, nothing else lit around it): at 2.6 the walled sections became a solid white glare band
      // that swallowed the barrier base; 1.5 still reads as a hot neon rail
      emissiveIntensity: this.st.theme === 'galaxy' ? 1.5 : 2.6, roughness: 0.3, metalness: 0,
    }));
    void tube;
    const base = new Geo(), glow = new Geo();
    const Hh = 0.5;
    const lines: ProfileLine[] = [
      [[0, -0.5, 0], [0, Hh, 1]],
      [[0, Hh, 0], [0.08, Hh + 0.09, 0.2], [0.36, Hh + 0.09, 0.8], [0.44, Hh, 1]],
      [[0.44, Hh, 0], [0.44, -0.5, 1]],
    ];
    const circle = (cx: number, cy: number, r: number, segs: number): ProfileLine => {
      const out: ProfileLine = [];
      for (let k = 0; k <= segs; k++) {
        const a = Math.PI / 2 - (k / segs) * Math.PI * 2; // clockwise
        out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, k / segs]);
      }
      return out;
    };
    // thin rails swept along whole barrier runs (~1 row per metre): fewer sides at the lower tiers
    const railSegs = this.q.level === 'high' ? 8 : this.q.level === 'medium' ? 6 : 5;
    const stripSegs = this.q.level === 'high' ? 6 : 4;
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      this.sweepPath(base, P, side, lines, 4, { cap: true, color: (_r, l) => (l === 1 ? 1.25 : 1) });
      this.sweepPath(glow, P, side, [circle(0.12, 1.02, 0.085, railSegs)], 14, { swapUV: true });
      this.sweepPath(glow, P, side, [circle(-0.015, Hh - 0.08, 0.04, stripSegs)], 9, { swapUV: true });
    }
    this.buckets.add('neonBase', base);
    this.buckets.add('neonTube', glow);
    const post = box(-0.04, Hh, -0.04, 0.04, 1.0, 0.04, 0x9aa0b5);
    this.postsAlong('neonPosts', post, this.materials.get('neonBase')!, runs, 3.5, 0.12, { shadow: false });
  }

  barrierHedge(runs: Array<{ run: Run; side: number }>): void {
    const { pal } = this.st;
    const leaf = this.tex(TX.createLeafTexture(pal.barrierA, pal.barrierB));
    this.mat('hedge', () => new THREE.MeshStandardMaterial({ map: leaf, vertexColors: true, roughness: 0.9 }));
    const g = new Geo();
    const prof: Array<[number, number, number]> = [
      [0, -0.45, 0], [-0.06, 0.45, 0.15], [0.0, 0.95, 0.3], [0.18, 1.12, 0.42], [0.55, 1.18, 0.5],
      [0.92, 1.12, 0.58], [1.1, 0.95, 0.7], [1.16, 0.45, 0.85], [1.1, -0.45, 1],
    ];
    for (const { run, side } of runs) {
      const P = this.barrierPath(run, side);
      const lump = (r: number) => { const a = P.a[r]!; return 0.93 + 0.05 * Math.sin(a * 1.9) + 0.04 * Math.sin(a * 0.7 + 2); };
      this.sweepPath(g, P, side, [prof], 2.5, { scaleH: lump, cap: true, color: (_r, _l, k) => (k === 0 || k === 8 ? 0.6 : k >= 3 && k <= 5 ? 1.1 : 0.95) });
    }
    this.buckets.add('hedge', g);
  }

  /**
   * Tyre walls are by far the heaviest element (thousands of stacks), so they are tessellated from whatever the
   * triangle budget leaves after everything else (6..12 sides) and split into ~200 m spatial chunks: each chunk
   * has its own bounding sphere, so stretches behind the camera / outside the shadow frustum are culled.
   */
  buildTyres(): void {
    const p = this.tyrePending;
    this.tyrePending = null;
    if (!p || p.mats.length === 0) return;
    const coarse = this.q.level === 'low';
    const bands = coarse ? 4 : 7;
    const cap = this.q.level === 'high' ? 396_000 : this.q.level === 'medium' ? 300_000 : 200_000;
    let others = this.buckets.triangles();
    for (const im of this.instanced) others += ((im.geometry.index ? im.geometry.index.count : im.geometry.attributes.position!.count) / 3) * im.count;
    const perSeg = bands * 2 * p.mats.length;
    const segs = Math.max(6, Math.min(12, Math.floor((cap - others) / perSeg)));
    const geo = tyreStackGeometry(segs, coarse);
    const material = this.mat('tyre', () => new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0 }));
    this.instancedChunks('tyres', geo, material, p.mats, p.colors.length === p.mats.length ? p.colors : null, true, 210);
  }

  /** Like instancedFrom, but consecutive instances (placed along a path) are split into spatially coherent chunks. */
  instancedChunks(name: string, geo: THREE.BufferGeometry, material: THREE.Material, mats: THREE.Matrix4[], colors: THREE.Color[] | null,
    shadow: boolean, chunk: number): void {
    const n = Math.max(1, Math.round(mats.length / chunk));
    const per = Math.ceil(mats.length / n);
    for (let c0 = 0, k = 0; c0 < mats.length; c0 += per, k++) {
      const c1 = Math.min(mats.length, c0 + per);
      const im = new THREE.InstancedMesh(geo, material, c1 - c0);
      im.name = `track:${name}`;
      for (let j = c0; j < c1; j++) {
        im.setMatrixAt(j - c0, mats[j]!);
        if (colors) im.setColorAt(j - c0, colors[j]!);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = shadow; im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
      this.instanced.push(im);
    }
    this.geometries.push(geo);
  }

  glowMat(key: string, color: string, intensity: number): THREE.MeshStandardMaterial {
    return this.mat(`glow:${key}`, () => new THREE.MeshStandardMaterial({
      color: col(color).multiplyScalar(0.5), emissive: col(color), emissiveIntensity: intensity, roughness: 0.4,
    }));
  }

  // ───────────── pits, bridges, overpasses ─────────────

  edgePath(run: Run, side: number): BPath {
    const { t, c } = this;
    const rows = runRows(run);
    const P: BPath = {
      n: rows, x: new Float32Array(rows), y: new Float32Array(rows), z: new Float32Array(rows),
      nx: new Float32Array(rows), nz: new Float32Array(rows), a: new Float32Array(rows), i: new Int32Array(rows), open: !run.closed,
    };
    for (let r = 0; r < rows; r++) {
      const i = (run.start + r) % t.n;
      const hw = t.hw[i]!;
      P.i[r] = i;
      P.x[r] = t.px[i]! + t.rx[i]! * side * hw; P.z[r] = t.pz[i]! + t.rz[i]! * side * hw;
      P.y[r] = c.yEdge(i, side);
      P.nx[r] = c.hx[i]! * side; P.nz[r] = c.hz[i]! * side;
      P.a[r] = r === 0 ? 0 : P.a[r - 1]! + Math.hypot(P.x[r]! - P.x[r - 1]!, P.z[r]! - P.z[r - 1]!);
    }
    return P;
  }

  pitStyle(): 'glow' | 'rainbow' | 'stone' | 'planks' {
    const { pal, theme } = this.st;
    if (pal.pit === 'void') return theme === 'galaxy' ? 'rainbow' : 'glow';
    if (pal.pit === 'water') return 'planks';
    if (pal.pit === 'chasm' && theme === 'canyon') return 'planks';
    return 'stone';
  }

  pitStoneMaterial(): THREE.MeshStandardMaterial {
    const { pal, theme } = this.st;
    return this.mat('pitStone', () => {
      const lava = pal.pit === 'lava';
      const a = theme === 'snow' ? '#8d99a8' : theme === 'canyon' ? '#b86b42' : pal.barrierA;
      const b = lava ? pal.pitColor : theme === 'snow' ? '#6f7c8c' : shade2(a);
      const st = TX.createStoneTexture(a, b, lava, theme === 'jungle' || theme === 'meadow');
      this.tex(st.map); if (st.emissiveMap) this.tex(st.emissiveMap);
      return new THREE.MeshStandardMaterial({
        map: st.map, vertexColors: true, roughness: 0.9,
        emissive: lava ? col(pal.pitColor) : new THREE.Color(0), emissiveMap: st.emissiveMap, emissiveIntensity: lava ? 1.1 : 0,
      });
    });
  }

  /** Deck undersides and pillars: plain stone, faintly lit from below over lava. */
  deckStoneMaterial(): THREE.MeshStandardMaterial {
    const { pal, theme } = this.st;
    return this.mat('deckStone', () => {
      const lava = pal.pit === 'lava';
      const a = theme === 'snow' ? '#a3aebb' : theme === 'canyon' ? '#c47a4e' : lava ? '#6d5a52' : shade2(pal.barrierA);
      const st = TX.createStoneTexture(a, shade2(a), false, theme === 'jungle' || theme === 'meadow');
      this.tex(st.map);
      return new THREE.MeshStandardMaterial({
        map: st.map, vertexColors: true, roughness: 0.92,
        emissive: lava ? col(pal.pitColor) : new THREE.Color(0), emissiveMap: lava ? st.map : null, emissiveIntensity: lava ? 0.3 : 0,
      });
    });
  }

  pitWoodMaterial(): THREE.MeshStandardMaterial {
    return this.mat('pitWood', () => {
      const tx = this.tex(TX.createPlankTexture(this.st.theme === 'canyon' ? '#a8744c' : '#b98552'));
      // faint bounce light from the water / chasm floor: deck undersides and trestles only see the
      // (dark) hemisphere ground colour and otherwise render as black slabs
      const bounce = col(this.st.pal.pitColor).lerp(new THREE.Color(0xffffff), 0.45);
      return new THREE.MeshStandardMaterial({
        map: tx, vertexColors: true, roughness: 0.85,
        emissive: bounce, emissiveMap: tx, emissiveIntensity: 0.2,
      });
    });
  }

  buildPits(): void {
    const { t, c, st } = this;
    const style = this.pitStyle();
    const trim = new Geo();
    let trimKey = '';
    if (style === 'glow' || style === 'rainbow') {
      trimKey = 'pitGlow';
      if (style === 'rainbow') {
        const rb = this.tex(TX.createRainbowTexture());
        this.scrollers.push([rb, 0, 0.04]);
        this.mat(trimKey, () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: rb, emissive: 0xffffff, emissiveMap: rb, emissiveIntensity: 0.55, roughness: 0.3 }));
      } else {
        this.mat(trimKey, () => new THREE.MeshStandardMaterial({ color: col(st.pal.curbB).multiplyScalar(0.5), emissive: col(st.pal.curbB), emissiveIntensity: 0.9, roughness: 0.3 }));
      }
    } else if (style === 'stone') { trimKey = 'pitStone'; this.pitStoneMaterial(); }
    else { trimKey = 'pitWood'; this.pitWoodMaterial(); }

    for (const side of [-1, 1]) {
      for (const run of runsOf(t.n, i => c.edge(i, side) === 2)) {
        const P = this.edgePath(run, side);
        let lines: ProfileLine[];
        let uLen = 4;
        if (style === 'glow' || style === 'rainbow') {
          lines = [[[-0.22, 0.006, 0], [-0.18, 0.07, 0.3], [0.06, 0.07, 0.7], [0.1, 0.0, 0.8], [0.1, -0.35, 1]]];
          uLen = style === 'rainbow' ? 36 : 4;
        } else if (style === 'stone') {
          lines = [
            [[-0.4, 0.0, 0.8], [-0.4, 0.14, 0.86]],
            [[-0.4, 0.14, 0.86], [-0.33, 0.21, 0.9], [0.33, 0.21, 0.97], [0.4, 0.14, 1.0]],
            [[0.4, 0.14, 1.0], [0.4, -1.1, 0.0]],
          ];
        } else {
          lines = [
            [[-0.34, 0.005, 0], [-0.3, 0.07, 0.05], [0.3, 0.07, 0.5]],
            [[0.3, 0.07, 0], [0.3, -0.7, 0.62]],
          ];
          uLen = 3;
        }
        this.sweepPath(trim, P, side, lines, uLen, { swapUV: style === 'rainbow', cap: true });
      }
    }
    this.buckets.add(trimKey, trim);
    this.buildLedgeFaces();
    this.buildDeck();
  }

  /**
   * One-sided pit ledges (a cliff road with the chasm / sea on one side only, no pillars): a rock face from just under
   * the pit trim down past the valley floor, in the themed cliff material. From the valley (intro flyover) the road
   * then reads as cut into the mountainside instead of a thin slab floating over the drop. Bridges (pit on both sides)
   * keep their deck + pillars; void themes keep their floating decks.
   */
  buildLedgeFaces(): void {
    const { t, c, st } = this;
    if (st.pal.pit === 'void' || !this.materials.has('cliff')) return;
    const g = new Geo();
    const DEPTHS = [1.05, 2.4, 4.2, 6.6, 9.6, 13.5, 18.5, 25, 33, 42];
    const K = DEPTHS.length;
    for (const side of [-1, 1]) {
      const ledge = (i: number) => c.edge(i, side) === 2 && c.edge(i, -side) !== 2 && !c.over[i];
      for (const run of runsOf(t.n, ledge)) {
        if (run.closed) continue;
        // run on 2 samples past each end: the face tucks under the verge / bank where the pit ends
        const start = (run.start - 2 + t.n) % t.n, rows = run.len + 4;
        const hwAt = (i: number) => (c.edge(i, side) === 2 ? t.hw[i]! : Math.min(t.hw[i]! + 0.3, c.wall(i, side)));
        strip(g, rows, K, (r, k0, o) => {
          const i = (start + r) % t.n;
          const k = side > 0 ? k0 : K - 1 - k0;   // top → down on the right, reversed on the left (faces the chasm)
          const ye = c.yEdge(i, side);
          const bottom = Math.max(16, c.drop[side < 0 ? 0 : 1][i]! + 14);
          const depth = Math.min(DEPTHS[k]!, bottom);
          // strata: a few decimetres of relief, never proud of the trim over the first 10 m (a kart that drives off
          // falls clear of it before it respawns); lower down the face spreads into a battered cliff foot
          const a = i * c.sp;
          const relief = k === 0 ? 0 : 0.22 * Math.sin(a * 0.37 + depth * 0.9) + 0.16 * Math.sin(a * 1.13 - depth * 2.1) - 0.12;
          const deep = Math.max(0, depth - 10);
          const batter = deep * (0.3 + 0.12 * Math.sin(a * 0.071 + 1.3)) + (deep > 0 ? 0.9 * Math.sin(a * 0.19 + depth * 0.33) : 0);
          const d = hwAt(i) + 0.36 + Math.min(0.05, relief) + Math.max(0, batter);
          o.x = t.px[i]! + t.rx[i]! * side * d; o.z = t.pz[i]! + t.rz[i]! * side * d;
          o.y = ye - (k === K - 1 ? bottom : depth);
          o.u = a / 8; o.v = o.y / 6;
          o.r = o.g = o.b = (k === 0 ? 0.78 : 0.64 + 0.1 * Math.sin(depth * 1.7 + a * 0.2));
        });
      }
    }
    this.buckets.add('cliff', g);
  }

  deckMaterial(): THREE.Material {
    const { pal, theme } = this.st;
    const style = this.pitStyle();
    if (style === 'planks') return this.pitWoodMaterial();
    if (style === 'stone') return this.deckStoneMaterial();
    if (theme === 'galaxy') {
      return this.mat('deckGlass', () => new THREE.MeshStandardMaterial({
        color: col(pal.roadAlt), emissive: col(pal.roadAlt), emissiveIntensity: 0.5, vertexColors: true,
        roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.78,
      }));
    }
    return this.mat('deckConcrete', () => new THREE.MeshStandardMaterial({ color: 0x9aa0b4, vertexColors: true, roughness: 0.85 }));
  }

  deckKey(): string { return this.deckMaterial().name.replace('track:', ''); }

  /** Small deck platform sticking out over a pit edge (local frame: +x = left of travel). */
  outrigger(m: THREE.Matrix4, sx: number, hw: number, reach: number, halfLen: number, yTop: number): void {
    const x0 = sx * (hw - 0.4), x1 = sx * reach;
    this.buckets.add(this.deckKey(), box(Math.min(x0, x1), yTop - 1.0, -halfLen, Math.max(x0, x1), yTop - 0.015, halfLen, 0xd0d0d0, m));
    const style = this.pitStyle();
    const trimKey = style === 'glow' || style === 'rainbow' ? 'pitGlow' : style === 'stone' ? 'pitStone' : 'pitWood';
    if (!this.materials.has(trimKey)) return;
    const xe = sx * reach;
    this.buckets.add(trimKey, box(xe - sx * 0.25, yTop - 0.3, -halfLen - 0.05, xe + sx * 0.05, yTop + 0.08, halfLen + 0.05, 0xffffff, m));
  }

  buildDeck(): void {
    const { t, c } = this;
    const isDeck = (i: number) => t.edgeL[i] === 2 || t.edgeR[i] === 2 || c.over[i] === 1;
    const runs = runsOf(t.n, isDeck);
    if (runs.length === 0) return;
    const mat = this.deckMaterial();
    const key = mat.name.replace('track:', '');
    const g = new Geo();
    const extent = (i: number, side: number) => {
      const hw = t.hw[i]!;
      if (c.edge(i, side) === 2) return hw;
      return c.over[i] ? Math.max(c.wall(i, side), hw + 0.3) + 1.6 : hw;
    };
    const posAt = (i: number, d: number, h: number, o: Vtx) => {
      const hw = t.hw[i]!;
      const side = d < 0 ? -1 : 1;
      o.x = t.px[i]! + t.rx[i]! * d; o.z = t.pz[i]! + t.rz[i]! * d;
      o.y = (Math.abs(d) <= hw ? t.py[i]! + t.ry[i]! * d : c.yEdge(i, side)) + h;
    };
    for (const run of runs) {
      const rows = runRows(run);
      const T = (i: number) => (c.over[i] ? 1.25 : 1.0);
      // right face, bottom, left face (clockwise). The underside only gets hemisphere light, so it is not
      // darkened further (0.55 read as a black slab from the water/lava).
      const faces: Array<(i: number, k: number, o: Vtx) => void> = [
        (i, k, o) => { const d = extent(i, 1); posAt(i, d, k === 0 ? -0.02 : -T(i), o); o.v = k * 0.3; o.r = o.g = o.b = k === 0 ? 1 : 0.82; },
        (i, k, o) => { const d = k === 0 ? extent(i, 1) : -extent(i, -1); posAt(i, d, -T(i), o); o.v = k * 5; o.r = o.g = o.b = 0.9; },
        (i, k, o) => { const d = -extent(i, -1); posAt(i, d, k === 0 ? -T(i) : -0.02, o); o.v = k * 0.3; o.r = o.g = o.b = k === 0 ? 0.82 : 1; },
      ];
      for (const f of faces) {
        strip(g, rows, 2, (r, k, o) => {
          const i = (run.start + r) % t.n;
          f(i, k, o);
          o.u = ((run.start + r) * c.sp) / 4;
        });
      }
    }
    this.buckets.add(key, g);
    // night viaducts (concrete decks): rows of warm fixtures under the deck — seen from the road passing beneath,
    // the unlit underside otherwise reads as a flat black slab across the sky
    if (this.st.night && key === 'deckConcrete') {
      const lampKey = 'glow:deckLamp';
      this.glowMat('deckLamp', '#ffe2b0', 1.6);
      for (const run of runs) {
        for (let r = 3; r < run.len - 2; r += Math.max(1, Math.round(7 / c.sp))) {
          const i = (run.start + r) % t.n;
          if (!c.over[i] || (t.edgeL[i] === 2 && t.edgeR[i] === 2)) continue;
          const yaw = Math.atan2(t.tx[i]!, t.tz[i]!);
          for (const d of [-0.55 * t.hw[i]!, 0, 0.55 * t.hw[i]!]) {
            const mm = yawMatrix(t.px[i]! + t.rx[i]! * d, t.py[i]! + t.ry[i]! * d - 1.25, t.pz[i]! + t.rz[i]! * d, yaw);
            this.buckets.add(lampKey, box(-0.7, -0.07, -0.4, 0.7, 0.0, 0.4, '#ffffff', mm));
          }
        }
      }
    }
    this.buildPillars(runs);
  }

  buildPillars(deckRuns: Run[]): void {
    const { t, c, st } = this;
    const mats: THREE.Matrix4[] = [];
    const every = st.theme === 'galaxy' ? 40 : 24;
    for (const run of deckRuns) {
      const rows = run.closed ? run.len : run.len;
      for (let r = 6; r < rows - 4; r += Math.max(1, Math.round(every / c.sp))) {
        const i = (run.start + r) % t.n;
        const bridge = t.edgeL[i] === 2 && t.edgeR[i] === 2;
        const over = c.over[i] === 1;
        if (!bridge && !over) continue;
        const T = over ? 1.25 : 1.0;
        const hw = t.hw[i]!;
        const place = (d: number) => {
          const x = t.px[i]! + t.rx[i]! * d, z = t.pz[i]! + t.rz[i]! * d;
          const y = t.py[i]! + t.ry[i]! * d - T;
          if (c.blockedBelow(x, z, y, 2.5)) return false;
          mats.push(yawMatrix(x, y, z, Math.atan2(t.tx[i]!, t.tz[i]!)));
          return true;
        };
        if (!place(0)) { place(-(hw - 2)); place(hw - 2); }
      }
    }
    if (mats.length === 0) return;
    const style = this.pitStyle();
    let geo: THREE.BufferGeometry;
    let mat: THREE.Material;
    if (st.theme === 'galaxy') {
      // tractor-beam tether: a thin bright core inside a soft wider sheath, fading into the void
      const core = new THREE.CylinderGeometry(0.16, 0.16, 26, 8, 1, true);
      const sheath = new THREE.CylinderGeometry(0.75, 0.45, 26, 12, 1, true);
      for (const g of [core, sheath]) g.translate(0, -13, 0);
      geo = mergeGeometries([prep(core), prep(sheath, 0x5a5a5a)])!;
      core.dispose(); sheath.dispose();
      const grad = this.tex(verticalFadeTexture());
      mat = this.mat('beam', () => new THREE.MeshBasicMaterial({
        color: col(st.pal.curbB), vertexColors: true, alphaMap: grad, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
      }));
    } else if (style === 'planks') {
      // timber trestle: two chunky posts, cap beam, cross bracing every 6 m
      const parts: THREE.BufferGeometry[] = [];
      const W = 2.6;
      for (const sx of [-1, 1]) parts.push(uvScale(box(sx * W / 2 - 0.3, -42, -0.3, sx * W / 2 + 0.3, -0.2, 0.3, 0xc49a6c), 0.3, 8));
      parts.push(uvScale(box(-W / 2 - 0.7, -0.75, -0.42, W / 2 + 0.7, -0.05, 0.42, 0xb08058), 1, 0.3));
      for (let y = -2; y > -40; y -= 6) {
        for (const dir of [-1, 1]) {
          const len = Math.hypot(W, 5.2);
          const b = box(-0.12, -len / 2, -0.12, 0.12, len / 2, 0.12, 0xa87850);
          b.rotateZ(dir * Math.atan2(W, 5.2));
          b.translate(0, y - 2.6, dir * 0.18);
          parts.push(uvScale(b, 0.2, 2));
        }
      }
      geo = mergeGeometries(parts)!; parts.forEach(p => p.dispose());
      mat = this.pitWoodMaterial();
    } else if (style === 'stone') {
      const parts = [
        uvScale(cyl(1.25, 1.45, 42, 8, 0, -42, 0, 0xd8d0c8), 2, 11),
        uvScale(cyl(1.7, 1.25, 1.2, 8, 0, -1.2, 0, 0xffffff), 2, 0.4),
      ];
      geo = mergeGeometries(parts)!; parts.forEach(p => p.dispose());
      mat = this.deckStoneMaterial();
    } else {
      const parts = [
        roundedBox(1.8, 42, 1.8, 0.35, 0, -21, 0, 0xb8bccb),
        roundedBox(4.2, 1.1, 2.2, 0.3, 0, -0.55, 0, 0xc8ccd8),
      ];
      geo = mergeGeometries(parts)!; parts.forEach(p => p.dispose());
      mat = this.mat('deckConcrete', () => new THREE.MeshStandardMaterial({ color: 0x9aa0b4, vertexColors: true, roughness: 0.85 }));
    }
    const pil = this.instancedFrom('pillars', geo, mat, mats, null, st.theme !== 'galaxy');
    if (st.theme === 'galaxy') pil.renderOrder = 4;
  }

  // ───────────── ramps ─────────────

  buildRamps(): void {
    const { t, c, st } = this;
    if (t.ramps.length === 0) return;
    const chev = this.tex(TX.createChevronTexture('#2e3140', st.pal.accent, { count: 2 }));
    chev.flipY = false;
    this.mat('rampTop', () => new THREE.MeshStandardMaterial({ map: chev, roughness: 0.8, metalness: 0 }));
    const boost = TX.createBoostRampTextures(st.pal.boostPad);
    for (const tx of [boost.map, boost.emissiveMap]) { this.tex(tx); tx.flipY = false; this.scrollers.push([tx, 0, -1.2]); }
    this.mat('rampTrick', () => new THREE.MeshStandardMaterial({
      // volcano / galaxy (yellow pads, bloom 1.0–1.1 under a dark sky): at the night glow the panel flared into a white
      // slab whose halo filled half the screen and hid the chevrons; ~half keeps it the brightest thing on the road.
      // The lit albedo alone (#ffd000 / #ffe600 panel) still crossed the 0.62 night bloom threshold, so from the chase
      // camera the whole ramp bloomed (galaxy s≈412: mean luma 172/255): a darker amber panel leaves the glow to the chevrons
      color: st.theme === 'volcano' || st.theme === 'galaxy' ? 0xa0a0a0 : 0xffffff,
      map: boost.map, emissive: 0xffffff, emissiveMap: boost.emissiveMap,
      emissiveIntensity: st.theme === 'volcano' ? 0.55 : st.theme === 'galaxy' ? 0.5 : st.night ? 1.2 : 0.5,
      roughness: 0.82, metalness: 0,
    }));
    this.mat('rampSide', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
    const fr = this.fr;
    for (const rp of t.ramps) {
      const len = rp.s1 >= rp.s0 ? rp.s1 - rp.s0 : rp.s1 + t.length - rp.s0;
      const s0 = rp.s0;
      const i0 = Math.ceil(s0 / c.sp), i1 = Math.floor((s0 + len) / c.sp);
      const rowsS: number[] = [s0];
      for (let k = i0; k <= i1; k++) if (k * c.sp > s0 + 1e-3) rowsS.push(k * c.sp);
      const rows = rowsS.length;
      if (rows < 2) continue;
      const hAt = (r: number) => (r === 0 ? 0.012 : t.rampH[((i0 + r - (rowsS[1] === i0 * c.sp ? 1 : 0)) % t.n + t.n) % t.n]!);
      const hRow = rowsS.map((s, r) => {
        if (r === 0) return 0.012;
        const k = Math.round(s / c.sp);
        return Math.max(0.012, t.rampH[((k % t.n) + t.n) % t.n]!);
      });
      void hAt;
      const COLS = 6;
      const top = new Geo(), side = new Geo();
      const P = (r: number, d: number, h: number, o: Vtx) => {
        c.frameAt(rowsS[r]!, fr);
        o.x = fr.px + fr.rx * d; o.y = fr.py + fr.ry * d + h; o.z = fr.pz + fr.rz * d;
      };
      strip(top, rows, COLS, (r, k, o) => {
        c.frameAt(rowsS[r]!, fr);
        const hw = fr.hw;
        const d = -hw + (2 * hw * k) / (COLS - 1);
        P(r, d, hRow[r]!, o);
        const across = Math.max(2, Math.round((2 * hw) / (rp.trick ? 5 : 6.5)));
        o.u = ((d + hw) / (2 * hw)) * across; o.v = (rowsS[r]! - s0) / 4;
      });
      const sideCol = col(rp.trick ? st.pal.boostPad : st.pal.accent);
      const darkCol = dark(rp.trick ? st.pal.boostPad : st.pal.accent, 0.45);
      // side walls (right: top→bottom, left: bottom→top)
      for (const sd of [-1, 1]) {
        strip(side, rows, 2, (r, k, o) => {
          c.frameAt(rowsS[r]!, fr);
          const d = sd * fr.hw;
          const up = sd > 0 ? k === 0 : k === 1;
          P(r, d, up ? hRow[r]! : -0.05, o);
          const cc = up ? sideCol : darkCol;
          o.r = cc.r; o.g = cc.g; o.b = cc.b;
          o.u = 0; o.v = 0;
        });
      }
      // lip face at the end (faces forward)
      const rL = rows - 1;
      const hL = hRow[rL]!;
      const base = side.count;
      for (let k = 0; k < COLS; k++) {
        c.frameAt(rowsS[rL]!, fr);
        const d = -fr.hw + (2 * fr.hw * k) / (COLS - 1);
        const o = VT;
        P(rL, d, hL, o); side.add(o.x, o.y, o.z, 0, 0, sideCol.r, sideCol.g, sideCol.b);
        P(rL, d, -0.05, o); side.add(o.x, o.y, o.z, 0, 0, darkCol.r, darkCol.g, darkCol.b);
      }
      for (let k = 0; k < COLS - 1; k++) {
        const T0 = base + k * 2, B0 = T0 + 1, T1 = T0 + 2, B1 = T0 + 3;
        side.tri(T0, T1, B0); side.tri(T1, B1, B0);
      }
      // glowing lip edge strip for trick ramps / hazard edge otherwise
      this.buckets.add(rp.trick ? 'rampTrick' : 'rampTop', top);
      this.buckets.add('rampSide', side);
      const edge = new Geo();
      strip(edge, COLS, 2, (k, j, o) => {
        c.frameAt(rowsS[rL]!, fr);
        const d = -fr.hw + (2 * fr.hw * k) / (COLS - 1);
        c.frameAt(rowsS[rL]! - (j === 0 ? 0.0 : 0.45), fr);
        const hh = j === 0 ? hL + 0.03 : hL - 0.02;
        o.x = fr.px + fr.rx * d; o.y = fr.py + fr.ry * d + hh; o.z = fr.pz + fr.rz * d;
      });
      flipIfDown(edge, 0);
      this.buckets.add(rp.trick ? 'glow:lip' : 'glow:lipHazard', edge);
    }
    // volcano / galaxy: the chase camera crosses the lip ~4 m behind the kart, where the full-width strip at 1.4 bloomed
    // over the whole frame for a few frames every lap (galaxy s≈413: mean luma 165 → 56 with the track mesh hidden)
    this.glowMat('lip', st.pal.boostPad, st.theme === 'volcano' || st.theme === 'galaxy' ? 0.6 : st.night ? 1.4 : 1.1);
    this.glowMat('lipHazard', st.pal.accent, st.night ? 1.4 : 0.6);
  }

  // ───────────── boost pads ─────────────

  surfPoint(s: number, d: number, lift: number, o: Vtx): void {
    const fr = this.c.frameAt(s, this.fr);
    o.x = fr.px + fr.rx * d + fr.ux * lift;
    o.y = fr.py + fr.ry * d + fr.ramp + fr.uy * lift;
    o.z = fr.pz + fr.rz * d + fr.uz * lift;
  }

  buildBoostPads(): void {
    const { t, st } = this;
    if (t.boostPads.length === 0) return;
    const arrows = this.tex(TX.createBoostArrowTexture(st.pal.boostPad));
    arrows.flipY = false;
    this.scrollers.push([arrows, 0, -2.2]);
    this.mat('pad', () => new THREE.MeshStandardMaterial({
      map: arrows, emissive: 0xffffff, emissiveMap: arrows, emissiveIntensity: st.night ? 1.3 : 0.9, roughness: 0.3,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    const glowTex = this.tex(TX.createPanelGlowTexture());
    const glowMat = this.mat('padGlow', () => new THREE.MeshBasicMaterial({
      color: col(st.pal.boostPad), map: glowTex, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    }));
    this.pulses.push({ mat: glowMat, base: 0.55, amp: 0.25, freq: 5 });
    this.mat('padRim', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.4 }));
    const pad = new Geo(), glow = new Geo(), rim = new Geo();
    const LEN = 4.2, WID = 5;
    const rimCol = new THREE.Color('#2b2e3a'), rimHi = col(st.pal.boostPad);
    for (const bp of t.boostPads) {
      strip(pad, 7, 3, (r, k, o) => {
        const a = -LEN / 2 + (LEN * r) / 6, b = -WID / 2 + (WID * k) / 2;
        this.surfPoint(bp.s + a, bp.d + b, 0.04, o);
        o.u = k / 2; o.v = (a + LEN / 2) / LEN * 1.5;
      });
      strip(glow, 7, 3, (r, k, o) => {
        const a = (-LEN / 2 + (LEN * r) / 6) * 1.25, b = (-WID / 2 + (WID * k) / 2) * 1.2;
        this.surfPoint(bp.s + a, bp.d + b, 0.09, o);
        o.u = k / 2; o.v = r / 6;
      });
      // rim: ring around the pad (inner edge, top inner, top outer, outer foot)
      const per: Array<[number, number]> = [];
      const ha = LEN / 2 + 0.02, hb = WID / 2 + 0.02;
      const addEdge = (a0: number, b0: number, a1: number, b1: number, steps: number) => {
        for (let k = 0; k < steps; k++) per.push([a0 + (a1 - a0) * (k / steps), b0 + (b1 - b0) * (k / steps)]);
      };
      addEdge(-ha, -hb, ha, -hb, 6); addEdge(ha, -hb, ha, hb, 4); addEdge(ha, hb, -ha, hb, 6); addEdge(-ha, hb, -ha, -hb, 4);
      per.push(per[0]!);
      const prof: Array<[number, number]> = [[0, 0.03], [0.04, 0.09], [0.24, 0.09], [0.3, 0.0]];
      const start = rim.idx.length;
      strip(rim, per.length, prof.length, (r, k, o) => {
        const [a, b] = per[r]!;
        const [off, h] = prof[k]!;
        // outward direction from the rectangle
        const na = Math.abs(a) >= ha - 1e-3 ? Math.sign(a) : 0, nb = Math.abs(b) >= hb - 1e-3 ? Math.sign(b) : 0;
        const nl = Math.hypot(na, nb) || 1;
        this.surfPoint(bp.s + a + (na / nl) * off, bp.d + b + (nb / nl) * off, h, o);
        const cc = k === 1 ? rimHi : rimCol;
        o.r = cc.r; o.g = cc.g; o.b = cc.b;
      });
      flipIfDown(rim, start);
    }
    this.buckets.add('pad', pad);
    this.buckets.add('padGlow', glow);
    this.buckets.add('padRim', rim);
  }

  // ───────────── surface zones ─────────────

  buildSurfaces(): void {
    const { t, c } = this;
    if (t.surfaces.length === 0) return;
    const zones = { ice: new Geo(), mud: new Geo(), dirt: new Geo() };
    for (const z of t.surfaces) {
      if (z.kind === 'road') continue;
      const len = z.s1 >= z.s0 ? z.s1 - z.s0 : z.s1 + t.length - z.s0;
      if (len < 0.5) continue;
      const g = zones[z.kind];
      const rows = Math.max(2, Math.ceil(len / c.sp) + 1);
      const lift = z.kind === 'ice' ? 0.03 : z.kind === 'mud' ? 0.026 : 0.022;
      const fadeS = Math.min(3, len / 3);
      strip(g, rows, 8, (r, k, o) => {
        const a = (len * r) / (rows - 1);
        const s = z.s0 + a;
        const fr = c.frameAt(s, this.fr);
        const hw = fr.hw;
        const d0 = Math.max(-hw, z.d0), d1 = Math.min(hw, z.d1);
        const w = Math.max(0.1, d1 - d0);
        const e = Math.min(0.8, w / 4);
        const dList = [d0, d0 + e, d0 + e + (w - 2 * e) * 0.2, d0 + e + (w - 2 * e) * 0.4, d0 + e + (w - 2 * e) * 0.6, d0 + e + (w - 2 * e) * 0.8, d1 - e, d1];
        const d = dList[k]!;
        o.x = fr.px + fr.rx * d + fr.ux * lift; o.y = fr.py + fr.ry * d + fr.uy * lift + fr.ramp; o.z = fr.pz + fr.rz * d + fr.uz * lift;
        o.u = d / 7; o.v = s / 7;
        const edgeSoft = (z.d0 <= -hw + 0.01 && k === 0) || (z.d1 >= hw - 0.01 && k === 7) ? 0.85 : 0;
        const fd = k === 0 || k === 7 ? edgeSoft : 1;
        o.a = fd * smooth01(0, fadeS, a) * smooth01(0, fadeS, len - a);
      });
    }
    const common = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, vertexColors: true };
    if (!zones.ice.empty) {
      const tx = this.tex(TX.createIceTexture());
      this.mat('ice', () => new THREE.MeshStandardMaterial({ ...common, map: tx, color: 0xf6fcff, roughness: 0.06, metalness: 0.15, opacity: 0.95, emissive: 0x6fb4e0, emissiveIntensity: 0.22 }));
      this.buckets.add('ice', zones.ice.toGeometry(true));
    }
    if (!zones.mud.empty) {
      const tx = this.tex(TX.createMudTexture());
      this.mat('mud', () => new THREE.MeshStandardMaterial({ ...common, map: tx, color: 0xd8c8b8, roughness: 0.22, metalness: 0.08 }));
      this.buckets.add('mud', zones.mud.toGeometry(true));
    }
    if (!zones.dirt.empty) {
      const tx = this.tex(TX.createDirtTexture());
      this.mat('dirt', () => new THREE.MeshStandardMaterial({ ...common, map: tx, color: 0xffffff, roughness: 1 }));
      this.buckets.add('dirt', zones.dirt.toGeometry(true));
    }
  }

  // ───────────── start / finish ─────────────

  /** How far the barrier model reaches outward from its path (m). */
  barrierDepth(): number {
    switch (this.st.pal.barrier) {
      case 'tires': return 0.94;
      case 'stone': return 0.97;
      case 'hedge': return 1.16;
      case 'snowbank': return 2.6;
      case 'neon': return 0.44;
      case 'fence': case 'wood': return 0.25;
      default: return 0.15;
    }
  }

  /**
   * Lateral distance (m) from the centreline to the centre of a foot of a structure spanning the road (start
   * gantry, inflatable arch, over-road banner) on one side (-1 left, +1 right). Beside a pit the foot stands on an
   * outrigger just past the road edge; everywhere else it stands OUTSIDE the barrier — past the barrier model plus
   * at least 1 m of clearance — never on the drivable off-road verge, where it would have no collider.
   */
  spanFoot(i: number, side: number, pitLeg: number, footHalf: number): number {
    const { t, c } = this;
    const hw = t.hw[i]!;
    if (c.edge(i, side) === 2) return hw + pitLeg;
    let wall = 0;
    for (let k = -3; k <= 3; k++) {
      const j = (i + k + t.n) % t.n;
      if (c.edge(j, side) !== 2) wall = Math.max(wall, c.wall(j, side));
    }
    return Math.max(hw + pitLeg, wall + Math.max(1, this.barrierDepth() + 0.3) + footHalf);
  }

  /**
   * Estimated ground height (world y) at lateral distance d on a side beyond the barrier: the verge / embankment
   * profile laid by buildShoulders (flat top to wall + 1.6, then the bank down to its toe), or the terrain where
   * that covers the bank (Ctx.drop). Without a profile (never built) it assumes 0.35 m below the road edge.
   */
  groundBeyond(i: number, side: number, d: number): number {
    const { t, c } = this;
    const ye = c.yEdge(i, side);
    const terrain = ye - c.drop[side < 0 ? 0 : 1][i]!;
    const bp = this.bankProf[side < 0 ? 0 : 1];
    const d4 = bp[i * 4], y4 = bp[i * 4 + 1], d5 = bp[i * 4 + 2], y5 = bp[i * 4 + 3];
    if (d4 === undefined || y4 === undefined || d5 === undefined || y5 === undefined || Number.isNaN(d4)) return ye - 0.35;
    const w3 = Math.max(c.wall(i, side), t.hw[i]! + 0.3) + 0.25;
    let yb: number;
    if (d <= w3) yb = ye;
    else if (d <= d4) yb = ye + ((y4 - ye) * (d - w3)) / Math.max(1e-3, d4 - w3);
    else if (d <= d5) yb = y4 + ((y5 - y4) * (d - d4)) / Math.max(1e-3, d5 - d4);
    else yb = -Infinity;
    return Math.max(yb, terrain);
  }

  /**
   * Footing under a span foot (local lateral centre x, local +x = LEFT; underside yBottom; half footprint `half`)
   * whose ground falls away: beyond the barrier of an embankment the verge top is only ~1.6 m wide, so a foot
   * standing outside the barrier hung over the bank face. A concrete block reaches from the foot down into the
   * lowest ground under its footprint (buried on flat ground, where nothing is added).
   */
  footing(m: THREE.Matrix4, fr: Frame, sx: number, x: number, yBottom: number, half: number): void {
    const { t, c } = this;
    const side = -sx;
    let low = Infinity;
    for (const k of [-1, 0, 1]) {
      const j = (fr.i + k + t.n) % t.n;
      if (c.edge(j, side) === 2) return;
      for (const dd of [Math.abs(x) - half, Math.abs(x), Math.abs(x) + half + 0.12]) low = Math.min(low, this.groundBeyond(j, side, dd) - fr.py);
    }
    if (!(yBottom - low > 0.25)) return;
    const h = half + 0.12;
    this.buckets.add('painted', box(x - h, low - 0.35, -h, x + h, yBottom + 0.04, h, '#8b8680', m));
  }

  buildStart(): void {
    const { t, c, st } = this;
    const s0 = t.startS;
    // checkered strip
    const chk = this.tex(TX.createCheckerTexture());
    this.mat('checker', () => new THREE.MeshStandardMaterial({ map: chk, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    const g = new Geo();
    const LEN = 3;
    strip(g, 5, 9, (r, k, o) => {
      const a = -LEN / 2 + (LEN * r) / 4;
      const fr = c.frameAt(s0 + a, this.fr);
      const d = -fr.hw + (2 * fr.hw * k) / 8;
      this.surfPoint(s0 + a, d, 0.02, o);
      o.u = (d + fr.hw) / 1.5; o.v = (a + LEN / 2) / 1.5;
    });
    this.buckets.add('checker', g);

    // gantry
    const fr = c.frameAt(s0, newFrame());
    const hw = fr.hw;
    const m = yawMatrix(fr.px, fr.py, fr.pz, fr.yaw);
    // legs stand outside the barriers (never on the drivable off-road verge, which has no collider for them);
    // local +x = LEFT of travel, so the left leg sits at +legL and the right one at −legR
    const legL = this.spanFoot(fr.i, -1, 1.7, 1.0), legR = this.spanFoot(fr.i, 1, 1.7, 1.0);
    const H = 8.6;
    const accent = st.pal.accent;
    const paint = (key: string) => this.mat(key, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05 }));
    paint('painted');
    // night: the gantry paint is floodlit (self-lit ∝ its own colour) so legs and beam read against the dark sky
    // instead of a black silhouette; by day it is the plain painted material
    const gk = st.night ? 'gantryLit' : 'painted';
    if (st.night) {
      this.mat('gantryLit', () => {
        const mm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, emissive: new THREE.Color(0.3, 0.3, 0.34) });
        mm.onBeforeCompile = sh => {
          sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;');
        };
        mm.customProgramCacheKey = () => 'track-floodlit';
        return mm;
      });
    }
    for (const sx of [-1, 1]) {
      const legX = sx > 0 ? legL : legR;
      const x = sx * legX;
      const yb = -fr.ry * sx * hw; // local x = LEFT → road edge height on that side
      const pit = c.edge(fr.i, -sx) === 2;
      if (pit) this.outrigger(m, sx, hw, legX + 1.4, 1.8, yb);
      // beyond the barrier the ground sits ~0.35 m below the road edge: sink the foot plate into it
      const yf = pit ? yb : yb - 0.3;
      this.buckets.add('painted', roundedBox(2.0, 0.7, 2.0, 0.15, x, yf + 0.2, 0, '#2b2e3a', m));
      if (!pit) this.footing(m, fr, sx, x, yf - 0.15, 1.0);
      this.buckets.add(gk, roundedBox(1.3, H + 2, 1.3, 0.3, x, yb + H / 2 - 1, 0, accent, m));
      for (const hy of [1.6, 3.4, 5.2]) this.buckets.add(st.night ? 'glow:ring' : 'painted', roundedBox(1.42, 0.35, 1.42, 0.12, x, yb + hy, 0, '#ffffff', m, 1));
      this.buckets.add(gk, sphere(0.62, 14, 10, x, H + 1.35, 0, st.pal.curbA, m));
      this.flagSpots.push({ m: m.clone().multiply(new THREE.Matrix4().makeTranslation(x, H + 1.9, 0)), color: st.pal.curbA, tall: 1.8 });
    }
    // cross beam + banner
    const beamW = legL + legR + 0.6, beamX = (legL - legR) / 2;
    const beamY = H - 0.6;
    this.buckets.add(gk, roundedBox(beamW, 2.5, 1.1, 0.35, beamX, beamY, 0, st.night ? '#34409c' : '#1d2360', m));
    // light strips along the beam edges (glow at night, bright paint by day)
    for (const yy of [beamY - 1.05, beamY + 1.05]) for (const fz of [-1, 1]) {
      this.buckets.add('glow:ring', box(beamX - beamW / 2 + 0.5, yy - 0.05, fz * 0.56 - 0.03, beamX + beamW / 2 - 0.5, yy + 0.05, fz * 0.56 + 0.03, '#ffffff', m));
    }
    this.glowMat('ring', st.theme === 'city' ? st.pal.curbB : st.theme === 'galaxy' ? st.pal.curbB : st.night ? st.pal.boostPad : '#ffffff', st.night ? 0.8 : 0.25);
    const bw = Math.min(beamW - 3, 20);
    this.buckets.add('banner', bannerQuads(this.banner.rects[0]!, bw, bw / 8, 0, beamY, 0, 1.16, m));
    // a wide beam (legs outside broad verges) carries sponsor boards either side of the title banner
    for (const sx of [-1, 1]) {
      const free = (sx > 0 ? beamX + beamW / 2 : beamW / 2 - beamX) - bw / 2 - 1.4;
      if (free < 5) continue;
      const sw = Math.min(9, free - 0.6);
      this.buckets.add('banner', bannerQuads(this.banner.rects[this.nextBrand()]!, sw, sw / 8, sx * (bw / 2 + 0.7 + sw / 2), beamY, 0, 1.16, m));
    }
    // light bar housing hanging under the beam
    const hy = beamY - 2.35;
    this.buckets.add('painted', roundedBox(0.18, 1.1, 0.18, 0.05, -1.4, hy + 1.0, 0, '#2b2e3a', m));
    this.buckets.add('painted', roundedBox(0.18, 1.1, 0.18, 0.05, 1.4, hy + 1.0, 0, '#2b2e3a', m));
    // Thunder Cup night themes (volcano, galaxy): under a dark sky the near-black housing had no lit face from below and
    // read as a black curved blob when the chase camera passed under the gantry — slate body + an LED strip beneath it
    const nightThunder = st.theme === 'volcano' || st.theme === 'galaxy';
    this.buckets.add('painted', roundedBox(4.6, 1.5, 0.8, 0.3, 0, hy, 0, nightThunder ? '#3a3e52' : '#20222c', m));
    if (nightThunder) this.buckets.add('glow:ring', box(-1.9, hy - 0.78, -0.2, 1.9, hy - 0.72, 0.2, '#ffffff', m));
    const lampPos: Array<[number, number]> = [];
    for (let k = 0; k < 3; k++) for (let row = 0; row < 2; row++) lampPos.push([(1 - k) * 1.35, hy + 0.34 - row * 0.68]);
    this.lampCols = 3;
    // hoods above each lamp column (both faces)
    for (let k = 0; k < 3; k++) for (const fz of [-1, 1]) this.buckets.add('painted', box((1 - k) * 1.35 - 0.45, hy + 0.7, fz * 0.4, (1 - k) * 1.35 + 0.45, hy + 0.78, fz * 0.62, '#15161d', m));
    const lampGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.1, 18);
    lampGeo.rotateX(Math.PI / 2);
    const lampMat = this.mat('lamp', () => new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const haloGeo = new THREE.PlaneGeometry(1.35, 1.35);
    const haloTex = this.tex(TX.createGlowTexture());
    const haloMat = this.mat('lampHalo', () => new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const lm: THREE.Matrix4[] = [], hm: THREE.Matrix4[] = [];
    for (const fz of [-1, 1]) {
      for (const [x, y] of lampPos) {
        lm.push(m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, fz * 0.42)));
        hm.push(m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, fz * 0.5)));
      }
    }
    this.lamps = this.instancedFrom('startLamps', lampGeo, lampMat, lm, lm.map(() => new THREE.Color(0.05, 0.05, 0.06)), false);
    this.lampHalos = this.instancedFrom('startHalos', haloGeo, haloMat, hm, hm.map(() => new THREE.Color(0, 0, 0)), false);
    this.lampPositions = lampPos.length;

    // grid slots
    const slotTex = this.tex(TX.createGridSlotAtlas('#ffffff'));
    this.mat('gridSlot', () => new THREE.MeshStandardMaterial({ map: slotTex, transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    const sg = new Geo();
    t.grid.forEach((slot, k) => {
      const cu = (k % 4) / 4, cv = Math.floor(k / 4) === 0 ? 0.5 : 0;
      strip(sg, 4, 3, (r, j, o) => {
        const a = -2.3 + (3.9 * r) / 3, b = -1.35 + (2.7 * j) / 2;
        this.surfPoint(slot.s + a, slot.d + b, 0.018, o);
        o.u = cu + (j / 2) * 0.25; o.v = cv + (r / 3) * 0.5;
      });
    });
    this.buckets.add('gridSlot', sg);
  }
  lampPositions = 0;
  /** Last applied light state (undefined = never applied), so repeated calls do no work. */
  private lightState: StartLightState | undefined = undefined;
  flagSpots: Array<{ m: THREE.Matrix4; color: string; tall: number }> = [];

  setStartLights(n: StartLightState): void {
    if (!this.lamps || !this.lampHalos) return;
    if (n === this.lightState) return;
    this.lightState = n;
    const off = LAMP_OFF, red = LAMP_RED, green = LAMP_GREEN, hRed = HALO_RED, hGreen = HALO_GREEN, hOff = HALO_OFF;
    const per = this.lampPositions;
    for (let idx = 0; idx < per * 2; idx++) {
      const k = idx % per;
      const colIdx = Math.floor(k / 2); // column 0 = leftmost from the grid's view
      let lamp = off, halo = hOff;
      if (n === 0) { lamp = green; halo = hGreen; }
      else if (n !== null) {
        const lit = 4 - n; // 3 → 1 column, 2 → 2, 1 → 3
        if (colIdx < lit) { lamp = red; halo = hRed; }
      }
      this.lamps.setColorAt(idx, lamp);
      this.lampHalos.setColorAt(idx, halo);
    }
    this.lamps.instanceColor!.needsUpdate = true;
    this.lampHalos.instanceColor!.needsUpdate = true;
  }

  // ───────────── track furniture (landmarks: grandstand / arch / banner) ─────────────

  crowdMats: THREE.Matrix4[] = [];
  crowdColors: THREE.Color[] = [];

  sidePlace(s: number, side: number, dist: number, clearance: number): { x: number; y: number; z: number; yaw: number; d: number; i: number } {
    const { c } = this;
    const fr = c.frameAt(s, this.fr);
    const i = fr.i;
    const dd = Math.max(dist, c.wall(i, side) + clearance);
    const d = side * dd;
    const x = fr.px + fr.rx * d, z = fr.pz + fr.rz * d;
    const hx = c.hx[i]!, hz = c.hz[i]!;
    return { x, y: fr.py - 0.3, z, yaw: Math.atan2(-side * hx, -side * hz), d, i };
  }

  buildLandmarks(): void {
    const lms = this.t.landmarks.filter(l => l.kind === 'grandstand' || l.kind === 'arch' || l.kind === 'banner');
    const nearStart = (s: number, m: number) => {
      let d = Math.abs(s - this.t.startS) % this.t.length;
      d = Math.min(d, this.t.length - d);
      return d < m;
    };
    for (const l of lms) {
      const side = l.side === 'left' ? -1 : l.side === 'right' ? 1 : 0;
      // the start gantry already spans the road there
      if (side === 0 && nearStart(l.s, l.kind === 'banner' ? 12 : 20)) continue;
      const scale = l.scale ?? 1;
      if (l.kind === 'grandstand') {
        if (side === 0) this.buildArch(l.s, scale); else this.buildGrandstand(l.s, side, l.dist, scale);
      } else if (l.kind === 'arch') {
        this.buildArch(l.s, scale);
      } else {
        if (side === 0) this.buildOverBanner(l.s); else this.buildSideBanner(l.s, side, l.dist);
      }
    }
    this.buildStraightBoards();
  }

  buildGrandstand(s: number, side: number, dist: number, scale: number): void {
    const { c, st } = this;
    const tiers = 6, stepD = 1.05, stepH = 0.62;
    const depth = tiers * stepD;
    // shrink (then push outward) until the stand's footprint clears every corridor; give up rather than
    // build a stand across another section of road
    const test = new THREE.Vector3();
    const fits = (p: ReturnType<TrackMeshBuilder['sidePlace']>, len: number) => {
      const mm = yawMatrix(p.x, p.y, p.z, p.yaw);
      for (const [lx, lz] of [[-len / 2, 0.4], [len / 2, 0.4], [-len / 2, -depth], [len / 2, -depth], [0, 0.4], [0, -depth]] as const) {
        test.set(lx, 0, lz).applyMatrix4(mm);
        if (c.inCorridor(test.x, test.z, p.y, 0.8)) return false;
      }
      return true;
    };
    let pl = this.sidePlace(s, side, dist, 3.2);
    let L = 30 * scale;
    let found = false;
    for (const push of [0, 6, 12]) {
      pl = this.sidePlace(s, side, dist + push, 3.2);
      for (L = 30 * scale; L >= 10; L -= 2) if (fits(pl, L)) { found = true; break; }
      if (found) break;
    }
    if (!found) return;
    this.standSpans.push({ s, side, half: L / 2 });
    // Raised on a 1.2 m plinth so the front row and parapet boards clear the ~1.1 m barrier from kart-eye height.
    const LIFT = 1.2;
    const m = yawMatrix(pl.x, pl.y + LIFT, pl.z, pl.yaw);
    const concrete = '#e7e1d6';
    const seatCols = [st.pal.curbA, st.pal.accent, '#1f6feb', st.pal.boostPad, '#2a9d8f', '#ffffff'];
    const B = (key: string, g: THREE.BufferGeometry) => this.buckets.add(key, g);
    // plinth with an accent band along the top; beside a pit it is a stepped floating island built from the
    // theme's deck material (glass / planks / stone) instead of grey concrete
    if (c.edge(pl.i, side) === 2) {
      const dk = this.deckKey();
      const y0 = -1.2 - LIFT;
      B(dk, uvScale(box(-L / 2 - 0.6, y0, -depth - 0.6, L / 2 + 0.6, 0.25, 0.9, 0xe0e0e0, m), L / 4, 1));
      B(dk, uvScale(box(-L / 2 + 0.8, y0 - 3, -depth + 0.8, L / 2 - 0.8, y0, -0.5, 0xc8c8c8, m), L / 4, 1));
      B(dk, uvScale(box(-L / 2 + 3, y0 - 6.3, -depth + 2.2, L / 2 - 3, y0 - 3, -1.9, 0xb0b0b0, m), L / 5, 1));
    } else {
      B('painted', box(-L / 2 - 0.6, -2.5 - LIFT, -depth - 0.6, L / 2 + 0.6, 0.25, 0.9, '#b9b2a6', m));
    }
    B('painted', box(-L / 2 - 0.62, -0.12, 0.88, L / 2 + 0.62, 0.26, 0.96, st.pal.accent, m));
    for (let k = 0; k < tiers; k++) {
      const top = 0.25 + (k + 1) * stepH;
      const z0 = -k * stepD, z1 = -(k + 1) * stepD;
      B('painted', box(-L / 2, 0.2, z1, L / 2, top, z0, k % 2 ? concrete : '#ddd6ca', m));
      B('painted', box(-L / 2 + 0.2, top, z1 + 0.12, L / 2 - 0.2, top + 0.26, z1 + 0.45, seatCols[k % seatCols.length], m));
      // crowd on this step
      const density = this.q.scenery;
      for (let x = -L / 2 + 0.7; x < L / 2 - 0.6; x += 0.82) {
        const h = hash01(x * 13.1 + k * 7.7 + s);
        if (h > 0.18 + 0.72 * density) continue;
        const jx = x + (hash01(x * 3.3 + k) - 0.5) * 0.3;
        const pm = m.clone().multiply(yawMatrix(jx, top, z0 - 0.42, (hash01(x + k * 3.1) - 0.5) * 0.6, 0.9 + hash01(x * 7 + k) * 0.25));
        this.crowdMats.push(pm);
        this.crowdColors.push(col(CROWD_COLORS[Math.floor(hash01(x * 5.7 + k * 1.3 + s) * CROWD_COLORS.length)]!));
      }
    }
    const topY = 0.25 + tiers * stepH;
    // side walls, back wall
    for (const sx of [-1, 1]) {
      const sh = new THREE.Shape();
      sh.moveTo(0.55, 0.2); sh.lineTo(0.55, 1.7); sh.lineTo(-depth - 0.35, topY + 1.0); sh.lineTo(-depth - 0.35, 0.2); sh.closePath();
      const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 });
      eg.rotateY(-Math.PI / 2); // shape X → local z, extrusion → local -x
      eg.translate(sx > 0 ? L / 2 + 0.45 : -L / 2, 0, 0);
      B('painted', prep(eg, st.pal.accent, m));
    }
    B('painted', box(-L / 2 - 0.45, 0.2, -depth - 0.4, L / 2 + 0.45, topY + 4.6, -depth, '#cfc8bb', m));
    B('painted', box(-L / 2 - 0.5, topY - 0.2, -depth - 0.5, L / 2 + 0.5, topY + 0.35, -depth - 0.3, st.pal.accent, m));
    // sponsor boards along the top of the back wall (seen above the crowd from the road)
    {
      const nb = Math.max(1, Math.floor(L / 8.5));
      const bw = Math.min(8, L / nb - 0.5);
      B('painted', box(-L / 2 - 0.1, topY + 1.35, -depth + 0.02, L / 2 + 0.1, topY + 2.75, -depth + 0.1, '#2b2e3a', m));
      for (let b = 0; b < nb; b++) {
        const bx = -L / 2 + (L / nb) * (b + 0.5);
        B('banner', bannerQuads(this.banner.rects[this.nextBrand()]!, bw, bw / 8, bx, topY + 2.05, -depth + 0.11, 0.02, m, false));
      }
    }
    const ribs = Math.max(2, Math.round(L / 5));
    for (let k = 0; k <= ribs; k++) {
      const x = -L / 2 + (L * k) / ribs;
      B('painted', box(x - 0.25, 0.2, -depth - 0.7, x + 0.25, topY + 4.4, -depth - 0.35, '#b7afa2', m));
    }
    // front parapet with sponsor boards
    B('painted', box(-L / 2, 0.2, 0.05, L / 2, 1.35, 0.4, '#2b2e3a', m));
    const boards = Math.max(1, Math.floor(L / 9));
    for (let b = 0; b < boards; b++) {
      const bx = -L / 2 + (L / boards) * (b + 0.5);
      const bw = Math.min(8, L / boards - 0.6);
      B('banner', bannerQuads(this.banner.rects[this.nextBrand()]!, bw, bw / 8, bx, 0.8, 0.41, 0.02, m, false));
    }
    // roof: slanted canopy in stripes + posts
    const roofBackY = topY + 4.6, roofFrontY = topY + 3.4;
    const roofZ0 = -depth - 0.4, roofZ1 = 1.2;
    const slope = Math.atan2(roofBackY - roofFrontY, roofZ1 - roofZ0);
    const stripes = Math.max(4, Math.round(L / 2.6));
    for (let k = 0; k < stripes; k++) {
      const x0 = -L / 2 - 0.6 + ((L + 1.2) * k) / stripes, x1 = -L / 2 - 0.6 + ((L + 1.2) * (k + 1)) / stripes;
      const rm = m.clone().multiply(new THREE.Matrix4().makeTranslation(0, (roofBackY + roofFrontY) / 2, (roofZ0 + roofZ1) / 2))
        .multiply(new THREE.Matrix4().makeRotationX(slope));
      const len = Math.hypot(roofZ1 - roofZ0, roofBackY - roofFrontY);
      B('painted', box(x0, -0.14, -len / 2, x1, 0.14, len / 2, k % 2 ? '#ffffff' : st.pal.curbA, rm));
    }
    const posts = Math.max(2, Math.round(L / 9) + 1);
    for (let k = 0; k < posts; k++) {
      const x = -L / 2 + (L * k) / (posts - 1);
      B('painted', cyl(0.14, 0.14, roofFrontY + 0.1, 8, x, 0.2, 0.95, '#f4f4f4', m));
    }
    // roof fascia with sponsor boards facing the track + a light strip under the eave
    {
      const fy0 = roofFrontY - 0.95, fy1 = roofFrontY + 0.1;
      B('painted', box(-L / 2 - 0.6, fy0, roofZ1 - 0.12, L / 2 + 0.6, fy1, roofZ1 + 0.1, '#23252f', m));
      const nb = Math.max(1, Math.floor((L + 1.2) / 7.4));
      const bw = Math.min(6.8, (L + 1.2) / nb - 0.4);
      for (let b = 0; b < nb; b++) {
        const bx = -L / 2 - 0.6 + ((L + 1.2) / nb) * (b + 0.5);
        B('banner', bannerQuads(this.banner.rects[this.nextBrand()]!, bw, bw / 8, bx, (fy0 + fy1) / 2, roofZ1 + 0.11, 0.02, m, false));
      }
      B(st.night ? 'glow:ring' : 'painted', box(-L / 2, fy0 - 0.12, roofZ1 - 0.5, L / 2, fy0, roofZ1 - 0.2, st.night ? '#ffffff' : '#f4f4f4', m));
    }
    // bunting along the roof edge
    const bunt = new Geo();
    const edgeY = roofFrontY - 1.02, edgeZ = roofZ1 + 0.04;
    const nP = Math.floor(L / 0.9);
    for (let k = 0; k < nP; k++) {
      const x0 = -L / 2 + k * 0.9 + 0.05, x1 = x0 + 0.8;
      const cc = col(seatCols[k % seatCols.length]!);
      const v = new THREE.Vector3();
      const add = (lx: number, ly: number) => { v.set(lx, ly, edgeZ).applyMatrix4(m); return bunt.add(v.x, v.y, v.z, 0, 0, cc.r, cc.g, cc.b); };
      const a = add(x0, edgeY), b = add(x1, edgeY), cI = add((x0 + x1) / 2, edgeY - 0.75);
      bunt.tri(a, cI, b);
    }
    this.buckets.add('pennant', bunt);
    // flags on the roof
    const nF = Math.max(2, Math.round(L / 6));
    for (let k = 0; k < nF; k++) {
      const x = -L / 2 + (L * (k + 0.5)) / nF;
      const fm = m.clone().multiply(new THREE.Matrix4().makeTranslation(x, roofBackY + 0.1, -depth - 0.2));
      this.flagSpots.push({ m: fm, color: seatCols[k % seatCols.length]!, tall: 2.6 });
    }
  }

  buildArch(s: number, scale: number): void {
    const { c, st } = this;
    const fr = c.frameAt(s, newFrame());
    const i = fr.i;
    const hw = fr.hw;
    // feet outside the barriers on each side (local +x = LEFT of travel): the arch spans −legR … +legL
    const legL = this.spanFoot(i, -1, 1.7, 1.2), legR = this.spanFoot(i, 1, 1.7, 1.2);
    const legX = (legL + legR) / 2, cx = (legL - legR) / 2;
    const m = yawMatrix(fr.px, fr.py, fr.pz, fr.yaw);
    for (const sx of [-1, 1]) if (c.edge(i, -sx) === 2) this.outrigger(m, sx, hw, (sx > 0 ? legL : legR) + 1.5, 1.6, -fr.ry * sx * hw);
    // wide spans (feet beyond wide verges) get a proportionally taller arch so it never reads as a flat hoop
    let Hh = 8.2 * Math.min(1.3, Math.max(0.8, scale)) * Math.sqrt(Math.max(1, legX / 13));
    const R = 1.0;
    {
      // headroom: the tube stays ≥ 4.9 m above the road / verge over the whole drivable width (to just inside the
      // barriers) — near the feet a low ellipse dipped to ~3.5 m over the verge lanes, and the sim has no collider there
      let dmL = 0, dmR = 0;
      for (let k = -3; k <= 3; k++) {
        const j = (i + k + this.t.n) % this.t.n, hj = this.t.hw[j]!;
        dmL = Math.max(dmL, c.edge(j, -1) === 2 ? hj - 0.1 : Math.max(hj, c.wall(j, -1) - 0.35));
        dmR = Math.max(dmR, c.edge(j, 1) === 2 ? hj - 0.1 : Math.max(hj, c.wall(j, 1) - 0.35));
      }
      const tilt0 = -fr.ry * hw / legX, tA0 = fr.ry * hw * cx / legX;
      const headroom = (H: number): number => {
        let worst = Infinity;
        for (let th = 0.01; th < Math.PI; th += 0.01) {
          const x = cx + legX * Math.cos(th), y = H * Math.sin(th) - 0.4 + tA0 + tilt0 * x;
          const reach = x >= 0 ? x - R - dmL : -x - R - dmR;   // tube's inner side vs the corridor edge (local +x = left)
          if (reach >= 0) continue;
          const surf = fr.ry * Math.max(-hw, Math.min(hw, -x));
          worst = Math.min(worst, y - R - surf);
        }
        return worst;
      };
      for (let g = 0; g < 40 && headroom(Hh) < 4.9; g++) Hh *= 1.03;
    }
    const brand = this.nextBrand();
    const spec = BRANDS[brand]!;
    const cA = col(spec.bg), cB = new THREE.Color('#ffffff');
    const g = new Geo();
    const K = 13, per = 6, rows = K * per + 1, cols = 13;
    const pos = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), Bv = new THREE.Vector3();
    const v = new THREE.Vector3();
    // tilt the arch with the banking so both feet meet their road edge height (local x → lateral d = −x):
    // y += tA + tilt·x with −ry·hw at x = +legL and +ry·hw at x = −legR
    const tilt = -fr.ry * hw / legX, tA = fr.ry * hw * cx / legX;
    strip(g, rows, cols, (r, k, o) => {
      const tt = r / (rows - 1);
      const th = Math.PI * (1 - tt); // from the foot at local −x (right of travel) over to local +x
      pos.set(cx + legX * Math.cos(th), Hh * Math.sin(th) - 0.4, 0);
      pos.y += tA + tilt * pos.x;
      T.set(legX * Math.sin(th), -Hh * Math.cos(th), 0);
      T.y += tilt * T.x;
      T.normalize(); // d/dt direction
      N.set(-T.y, T.x, 0); // in-plane normal, pointing away from the arch centre
      if (N.x * (pos.x - cx) + N.y * (pos.y + 0.4 - tA - tilt * cx) < 0) N.negate();
      Bv.crossVectors(T, N);
      const seg = (tt * K) % 1;
      const rr = R * (0.8 + 0.2 * Math.sqrt(Math.max(0, Math.sin(Math.PI * seg))));
      const ph = (k / (cols - 1)) * Math.PI * 2;
      v.copy(pos).addScaledVector(N, Math.cos(ph) * rr).addScaledVector(Bv, Math.sin(ph) * rr);
      v.applyMatrix4(m);
      o.x = v.x; o.y = v.y; o.z = v.z;
      const cc = Math.floor(tt * K) % 2 ? cB : cA;
      o.r = cc.r; o.g = cc.g; o.b = cc.b;
    });
    this.buckets.add('inflatable', g);
    this.mat('inflatable', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 }));
    // feet weights (beyond the barrier the ground sits a little below the road edge; pit feet stand on the outrigger)
    for (const sx of [-1, 1]) {
      const fx = sx > 0 ? legL : -legR;
      const sink = c.edge(i, -sx) === 2 ? 0 : 0.2;
      this.buckets.add('painted', roundedBox(2.4, 0.6, 2.4, 0.2, fx, -0.1 - sink + tA + tilt * fx, 0, '#2b2e3a', m));
      if (sink) this.footing(m, fr, sx, fx, -0.4 - sink + tA + tilt * fx, 1.2);
    }
    // sponsor panel under the apex (both faces)
    const bw = Math.min(legX * 1.25, 14);
    const apexY = Hh - 0.4 + tA + tilt * cx;
    this.buckets.add('banner', bannerQuads(this.banner.rects[brand]!, bw, bw / 8, cx, apexY - R - bw / 16 - 0.1, 0, 0.3, m));
    this.buckets.add('painted', box(cx - bw / 2, apexY - R - 0.12, -0.16, cx + bw / 2, apexY - R + 0.05, 0.16, '#2b2e3a', m));
    // small flags on top
    this.flagSpots.push({ m: m.clone().multiply(new THREE.Matrix4().makeTranslation(cx, apexY + R * 0.7, 0)), color: spec.bg, tall: 1.6 });
  }

  buildSideBanner(s: number, side: number, dist: number): void {
    const { c } = this;
    const fr = c.frameAt(s, this.fr);
    const pit = c.edge(fr.i, side) === 2;
    // beside a pit the banner stands on a small outrigger at the deck edge instead of floating over the void
    const pl = this.sidePlace(s, side, pit ? 0 : dist, pit ? 1.9 : 1.4);
    // the whole 8.6 m board must stay clear of every corridor (figure-8 crossings, hairpins)
    const probe = new THREE.Vector3();
    const test = yawMatrix(pl.x, pl.y, pl.z, pl.yaw);
    for (const lx of [-4.3, 0, 4.3]) {
      probe.set(lx, 0, 0).applyMatrix4(test);
      if (c.inCorridor(probe.x, probe.z, pl.y, 0.6)) return;
    }
    if (pit) {
      const road = c.frameAt(s, newFrame());
      const mr = yawMatrix(road.px, road.py, road.pz, road.yaw);
      // local +x = left of travel ⇒ sx = -side; top of the deck at the road-edge height on that side
      this.outrigger(mr, -side, road.hw, road.hw + 3.1, 4.7, road.ry * side * road.hw);
    }
    const m = yawMatrix(pl.x, pl.y, pl.z, pl.yaw);
    const brand = this.nextBrand();
    for (const sx of [-1, 1]) this.buckets.add('painted', cyl(0.1, 0.1, 3.0, 8, sx * 3.9, -0.4, -0.12, '#e8e8e8', m));
    this.buckets.add('painted', box(-4.1, 1.28, -0.2, 4.1, 2.52, -0.04, '#2b2e3a', m));
    this.buckets.add('banner', bannerQuads(this.banner.rects[brand]!, 8, 1, 0, 1.9, -0.12, 0.2, m));
    this.flagSpots.push({ m: m.clone().multiply(new THREE.Matrix4().makeTranslation(4.3, 0, -0.12)), color: BRANDS[brand]!.bg, tall: 3.4 });
  }

  buildOverBanner(s: number): void {
    const { c } = this;
    const fr = c.frameAt(s, newFrame());
    const hw = fr.hw;
    const m = yawMatrix(fr.px, fr.py, fr.pz, fr.yaw);
    const brand = this.nextBrand();
    // poles outside the barriers (local +x = left of travel): the beam spans −legR … +legL
    const legL = this.spanFoot(fr.i, -1, 1.4, 0.5), legR = this.spanFoot(fr.i, 1, 1.4, 0.5);
    for (const sx of [-1, 1]) {
      const legX = sx > 0 ? legL : legR;
      // road-edge height on that side (banking) so the foot never floats; off the deck it sinks into the ground
      const yb = -fr.ry * sx * hw;
      const pit = c.edge(fr.i, -sx) === 2;
      if (pit) this.outrigger(m, sx, hw, legX + 1.3, 1.3, yb);
      const yf = pit ? yb : yb - 0.3;
      this.buckets.add('painted', cyl(0.22, 0.26, 7.9 - (yf - 0.3), 10, sx * legX, yf - 0.3, 0, '#f0f0f0', m));
      this.buckets.add('painted', roundedBox(1.0, 0.5, 1.0, 0.12, sx * legX, yf, 0, '#2b2e3a', m));
      if (!pit) this.footing(m, fr, sx, sx * legX, yf - 0.25, 0.5);
    }
    const bw = Math.min(2 * hw, 20);
    this.buckets.add('painted', box(-legR, 7.35, -0.1, legL, 7.6, 0.1, '#2b2e3a', m));
    this.buckets.add('banner', bannerQuads(this.banner.rects[brand]!, bw, bw / 8, 0, 7.3 - bw / 16, 0, 0.12, m));
  }

  /** Sponsor boards behind the barriers along the start straight. */
  /** Grandstands built so far: arc length, side and half length (m). */
  readonly standSpans: Array<{ s: number; side: number; half: number }> = [];
  /** Signed shortest loop distance b − a (m). */
  loopDelta(a: number, b: number): number {
    const L = this.t.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
    return d;
  }

  buildStraightBoards(): void {
    const { t, c } = this;
    const offsets = [-70, -40, 35, 65];
    for (const off of offsets) {
      for (const side of [-1, 1]) {
        const s = t.startS + off + (side > 0 ? 9 : 0);
        const fr = c.frameAt(s, this.fr);
        if (c.edge(fr.i, side) === 2) continue;
        if (Math.abs(t.curvature[fr.i]!) > 1 / 120) continue;
        // never in front of a grandstand on the same side (it hid the stand's own parapet boards)
        if (this.standSpans.some(sp => sp.side === side && Math.abs(this.loopDelta(sp.s, s)) < sp.half + 7)) continue;
        this.buildSideBanner(s, side, 0);
      }
    }
  }

  // ───────────── finalize ─────────────

  buildFlagsAndCrowd(): void {
    const { st } = this;
    const time = this.timeUniform;
    const painted = this.materials.get('painted')!;
    void painted;
    if (this.flagSpots.length) {
      const fm: THREE.Matrix4[] = [], fc: THREE.Color[] = [];
      for (const f of this.flagSpots) {
        this.buckets.add('painted', cyl(0.05, 0.06, f.tall + 0.1, 6, 0, 0, 0, '#f2f2f2', f.m));
        this.buckets.add('painted', sphere(0.09, 6, 4, 0, f.tall + 0.12, 0, st.pal.accent, f.m));
        fm.push(f.m.clone().multiply(new THREE.Matrix4().makeTranslation(0.05, f.tall, 0)));
        fc.push(col(f.color));
      }
      const geo = new THREE.PlaneGeometry(1.5, 0.95, 8, 1);
      geo.translate(0.75, -0.475, 0);
      const mat = this.mat('flag', () => {
        const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, side: THREE.DoubleSide });
        m.onBeforeCompile = sh => {
          sh.uniforms.uTime = time;
          sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            float fHash = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
            float fw = clamp(position.x / 1.5, 0.0, 1.0);
            transformed.z += sin(uTime * 7.0 - position.x * 3.2 + fHash * 6.2831) * 0.22 * fw;
            transformed.y += sin(uTime * 4.3 - position.x * 2.0 + fHash * 3.1) * 0.06 * fw;`);
        };
        return m;
      });
      this.instancedFrom('flags', geo, mat, fm, fc, true);
    }
    if (this.crowdMats.length) {
      const parts: THREE.BufferGeometry[] = [];
      const body = new THREE.CylinderGeometry(0.17, 0.24, 0.64, 7, 1, false); body.translate(0, 0.32, 0);
      parts.push(prep(body, 0xffffff));
      parts.push(sphere(0.21, 7, 5, 0, 0.9, 0, 0x000000));
      for (const sx of [-1, 1]) {
        const arm = new THREE.CylinderGeometry(0.055, 0.06, 0.5, 5, 1, true);
        arm.translate(0, 0.25, 0); arm.rotateZ(-sx * 0.55); arm.translate(sx * 0.2, 0.62, 0);
        parts.push(prep(arm, 0xffffff));
      }
      const geo = mergeGeometries(parts)!; parts.forEach(p => p.dispose());
      const mat = this.mat('crowd', () => {
        const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
        m.onBeforeCompile = sh => {
          sh.uniforms.uTime = time;
          sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader
            .replace('#include <color_vertex>', `#include <color_vertex>
              #if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )
                float cHash = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
                vec3 skin = cHash < 0.55 ? vec3(1.0, 0.66, 0.46) : (cHash < 0.82 ? vec3(0.7, 0.4, 0.22) : vec3(0.3, 0.15, 0.07));
                vColor.rgb = mix(skin, instanceColor.rgb, color.r);
              #endif`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              float bHash = fract(sin(dot(instanceMatrix[3].xz, vec2(39.3468, 11.135))) * 24634.6345);
              float jump = max(0.0, sin(uTime * (5.5 + bHash * 4.0) + bHash * 31.0));
              transformed.y += jump * jump * 0.22 * step(0.45, bHash);
              float wave = sin(uTime * (2.5 + bHash * 2.0) + bHash * 20.0);
              transformed.x += wave * 0.05 * position.y;
              if (position.y > 0.75) transformed.x += wave * 0.35 * (position.y - 0.75);`);
        };
        return m;
      });
      this.instancedFrom('crowd', geo, mat, this.crowdMats, this.crowdColors, false);
    }
  }

  materialFor(key: string): THREE.Material {
    const existing = this.materials.get(key);
    if (existing) return existing;
    const { st } = this;
    switch (key) {
      case 'stoneProps': return this.materials.get('stone')!;
      case 'shoulderPlain': return this.mat('painted', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
      case 'banner': return this.mat('banner', () => new THREE.MeshStandardMaterial({
        map: this.banner.texture, roughness: 0.45,
        emissive: 0xffffff, emissiveMap: this.banner.texture, emissiveIntensity: st.night ? 0.42 : 0.12,
      }));
      case 'pennant': return this.mat('pennant', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
      case 'painted': return this.mat('painted', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
      default: return this.mat(key, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    }
  }

  finalize(): TrackMeshStats {
    const NO_SHADOW = new Set(['road', 'shoulder', 'cliff', 'curb', 'checker', 'gridSlot', 'pad', 'padGlow', 'padRim', 'ice', 'mud', 'dirt', 'pitGlow', 'neonTube', 'glow:lip', 'glow:lipHazard', 'beam', 'deckGlass']);
    const ORDER: Record<string, number> = { road: 1, ice: 2, mud: 2, dirt: 2, gridSlot: 2, checker: 2, pad: 2, padGlow: 3, deckGlass: 1, beam: 4 };
    for (const key of this.buckets.keys()) {
      const geo = this.buckets.take(key);
      if (!geo) continue;
      geo.clearGroups();
      geo.computeBoundingSphere();
      const mat = this.materialFor(key);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `track:${key}`;
      mesh.castShadow = !NO_SHADOW.has(key);
      mesh.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial);
      mesh.renderOrder = ORDER[key] ?? 0;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.geometries.push(geo);
    }
    for (const im of this.instanced) im.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    let drawCalls = 0, triangles = 0, instances = 0;
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      drawCalls++;
      const g = m.geometry;
      const tri = (g.index ? g.index.count : g.attributes.position!.count) / 3;
      const cnt = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      triangles += tri * cnt;
      if (cnt > 1) instances += cnt;
    });
    return { drawCalls, triangles: Math.round(triangles), instances };
  }

  update(_dt: number, time: number): void {
    // indexed loops: no iterator / destructuring allocations in the frame loop
    const sc = this.scrollers;
    for (let k = 0; k < sc.length; k++) {
      const e = sc[k]!;
      e[0].offset.x = (time * e[1]) % 1;
      e[0].offset.y = (time * e[2]) % 1;
    }
    const ps = this.pulses;
    for (let k = 0; k < ps.length; k++) { const p = ps[k]!; p.mat.opacity = p.base + p.amp * Math.sin(time * p.freq); }
    this.timeUniform.value = time;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const im of this.instanced) im.dispose();
    this.geometries.length = 0;
    this.textures.length = 0;
    this.materials.clear();
  }
}

// ───────────────────────────── module helpers ─────────────────────────────

interface BPath {
  n: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  /** Outward horizontal normal (away from the road). */
  nx: Float32Array; nz: Float32Array;
  /** Cumulative horizontal arc length. */
  a: Float32Array;
  i: Int32Array;
  open: boolean;
}
/** Profile points [outward offset, height, texture v]. */
type ProfileLine = Array<[number, number, number]>;

// Countdown lamp colours (HDR instance colours so lit lamps bloom; halos are additive).
const LAMP_OFF = new THREE.Color(0.05, 0.05, 0.06);
const LAMP_RED = new THREE.Color(4.0, 0.28, 0.16);
const LAMP_GREEN = new THREE.Color(0.3, 3.0, 0.5);
const HALO_OFF = new THREE.Color(0, 0, 0);
const HALO_RED = new THREE.Color(1.0, 0.12, 0.05);
const HALO_GREEN = new THREE.Color(0.12, 0.8, 0.2);

const CROWD_COLORS = ['#e63946', '#ffd23f', '#1f6feb', '#2a9d8f', '#ff7eb6', '#ff9f1c', '#6a4cff', '#ffffff', '#5ce1ff', '#7ed957', '#f15bb5', '#00bbf9'];

function hash01(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function shade2(hex: string): string {
  return '#' + new THREE.Color(hex).multiplyScalar(0.7).getHexString();
}

function uvScale(g: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Flip triangle winding from index offset `start` if the first triangle faces down. */
function flipIfDown(g: Geo, start: number): void {
  if (g.idx.length < start + 3) return;
  const [a, b, c] = [g.idx[start]!, g.idx[start + 1]!, g.idx[start + 2]!];
  const P = (k: number) => [g.pos[k * 3]!, g.pos[k * 3 + 1]!, g.pos[k * 3 + 2]!] as const;
  const A = P(a), B = P(b), C = P(c);
  const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
  if (ny >= 0) return;
  for (let k = start; k + 2 < g.idx.length; k += 3) { const t = g.idx[k + 1]!; g.idx[k + 1] = g.idx[k + 2]!; g.idx[k + 2] = t; }
}

/** Stack of three tyres (lathe with `segs` sides). Vertex colour darkens the hole. */
function tyreStackGeometry(segs: number, coarse = false): THREE.BufferGeometry {
  const prof: Array<[number, number, number]> = coarse
    ? [[0.4, 0.0, 1], [0.47, 0.35, 1], [0.42, 0.7, 0.85], [0.44, 1.03, 1], [0.0, 0.98, 0.1]]
    : [
      [0.36, 0.0, 1], [0.47, 0.17, 1], [0.385, 0.35, 0.8], [0.47, 0.52, 1], [0.385, 0.7, 0.8],
      [0.47, 0.87, 1], [0.4, 1.03, 1], [0.0, 0.98, 0.1],
    ];
  const angles: number[] = [];
  // descending order → outward faces; the UV/normal seam sits at the back (local −Z, away from the road)
  for (let k = 0; k <= segs; k++) angles.push(Math.PI - (2 * Math.PI * k) / segs);
  const g = new Geo();
  strip(g, angles.length, prof.length, (r, k, o) => {
    const ph = angles[r]!;
    const [rad, y, shadeK] = prof[k]!;
    o.x = Math.sin(ph) * rad; o.z = Math.cos(ph) * rad; o.y = y;
    o.u = r / (angles.length - 1); o.v = y;
    o.r = o.g = o.b = shadeK;
  });
  const geo = g.toGeometry();
  // weld the seam normals (first and last ring are the same angle)
  return geo;
}

function verticalFadeTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = TX.makeCanvas(4, 128);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#777777'); g.addColorStop(1, '#000000');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 128);
  return TX.toTexture(canvas, { repeat: false, srgb: false });
}

// ───────────────────────────── entry point ─────────────────────────────

export function buildTrackMesh(track: BuiltTrack, theme: ThemeId, quality: RenderQuality): TrackMesh {
  const timings: Record<string, number> = {};
  let tPrev = performance.now();
  const t0 = tPrev;
  const lap = (name: string) => { const now = performance.now(); timings[name] = Math.round(now - tPrev); tPrev = now; };
  const b = new TrackMeshBuilder(track, theme, quality);
  lap('analyse');
  b.banner = TX.createBannerAtlas(BRANDS);
  b.tex(b.banner.texture);
  lap('banners');
  b.buildRoad(); lap('road');
  b.buildShoulders(); lap('shoulders');
  b.buildCurbs(); lap('curbs');
  b.buildBarriers(); lap('barriers');
  b.buildPits(); lap('pits');
  b.buildRamps(); lap('ramps');
  b.buildBoostPads(); lap('pads');
  b.buildSurfaces(); lap('surfaces');
  b.buildStart(); lap('start');
  b.buildLandmarks(); lap('landmarks');
  b.buildFlagsAndCrowd(); lap('crowd');
  b.buildTyres(); lap('tyres');
  const stats = b.finalize();
  lap('merge');
  stats.buildMs = Math.round(performance.now() - t0);
  stats.timings = timings;
  b.setStartLights(null);
  return {
    group: b.group,
    stats,
    update: (dt, time) => b.update(dt, time),
    setStartLights: n => b.setStartLights(n),
    dispose: () => b.dispose(),
  };
}
