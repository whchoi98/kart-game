/**
 * Shared scenery helpers for the snow / jungle / volcano / galaxy themes.
 *
 *  - GeoBatch: vertex-coloured geometry merged into ONE mesh per material.
 *  - Instancing helpers (per-instance tint on top of vertex colours).
 *  - Track frames for landmarks and track-following builders (bridges, spans).
 *  - Shader materials: animated liquid surfaces (water / ice), lava, falling water.
 *  - Shader-driven particle fields (precipitation, puffs, twinkles) — zero CPU per frame.
 *  - Camera-following sky layer helpers (cloud / nebula cards, star domes).
 *  - Mover animator (rolling / hopping / wobbling looks driven by observed motion).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../../sim/rng.js';
import type { BuiltTrack, LandmarkDef } from '../../../sim/types.js';
import type { Terrain } from '../terrain.js';

export { Rng };

// ───────────────────────────── disposal ─────────────────────────────

/** Collects disposables (geometries, materials, textures) for one scenery build. */
export class Bin {
  private readonly items: Array<{ dispose(): void }> = [];
  add<T extends { dispose(): void }>(x: T): T { this.items.push(x); return x; }
  dispose(): void {
    for (const x of this.items) x.dispose();
    this.items.length = 0;
  }
}

/**
 * Release the per-object GPU state under `root`: InstancedMesh.dispose() frees the instanceMatrix / instanceColor
 * buffers and VAO bindings (geometry.dispose() alone leaves them behind on every rebuild).
 */
export function disposeObjects(root: THREE.Object3D): void {
  root.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
}

// ───────────────────────────── scratch ─────────────────────────────

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _col = new THREE.Color();

/** Compose a TRS matrix into `out` (Euler order YXZ: yaw first, then pitch, then roll). */
export function trsTo(
  out: THREE.Matrix4, x: number, y: number, z: number,
  ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0,
): THREE.Matrix4 {
  _eul.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_eul);
  _v1.set(x, y, z);
  _v2.set(sx, sy, sz);
  return out.compose(_v1, _q, _v2);
}
/** Shared-scratch TRS (consume immediately). */
export function trs(x: number, y: number, z: number, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): THREE.Matrix4 {
  return trsTo(_m4, x, y, z, ry, sx, sy, sz, rx, rz);
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ───────────────────────────── colours ─────────────────────────────

/** Per-vertex colour function, evaluated on LOCAL (pre-transform) positions. */
export type ColorFn = (x: number, y: number, z: number, out: THREE.Color) => void;
export type ColorLike = THREE.ColorRepresentation | ColorFn;

/** Vertical gradient between y0 and y1 (local space). */
export function vGrad(bottom: THREE.ColorRepresentation, top: THREE.ColorRepresentation, y0: number, y1: number): ColorFn {
  const a = new THREE.Color(bottom), b = new THREE.Color(top);
  return (_x, y, _z, out) => { out.copy(a).lerp(b, smoothstep(y0, y1, y)); };
}
/** Solid colour below `yCap`, `cap` colour above it (with a soft band). */
export function capped(base: THREE.ColorRepresentation, cap: THREE.ColorRepresentation, yCap: number, band = 0.05): ColorFn {
  const a = new THREE.Color(base), b = new THREE.Color(cap);
  return (_x, y, _z, out) => { out.copy(a).lerp(b, smoothstep(yCap - band, yCap + band, y)); };
}
/** Mix two colours (sRGB hex in, linear out). */
export function mixHex(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

// ───────────────────────────── geometry prep / batching ─────────────────────────────

/** Copy of `src` with exactly position/normal/uv + an index (so everything merges). */
export function prepGeometry(src: THREE.BufferGeometry, keepColor = false): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  g.setAttribute('position', pos.clone());
  const col = src.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (keepColor && col && col.itemSize === 3) g.setAttribute('color', col.clone());
  const nrm = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nrm) g.setAttribute('normal', nrm.clone());
  const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
  g.setAttribute('uv', uv ? uv.clone() : new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  if (src.index) g.setIndex(src.index.clone());
  else {
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let k = 0; k < count; k++) idx[k] = k;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!nrm) g.computeVertexNormals();
  return g;
}

/** Faceted (flat-shaded) copy — gives chunky low-poly rocks and peaks. */
export function facet(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Displace vertices along their direction from the origin with smooth-ish noise (rocks, asteroids). */
export function lumpy(src: THREE.BufferGeometry, rng: Rng, amount: number, flatBottom = false): THREE.BufferGeometry {
  const g = src.clone();
  if (g.index) {
    // merge duplicated seam vertices first so displacement stays watertight
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
  }
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const ox = rng.range(0, 100), oy = rng.range(0, 100), oz = rng.range(0, 100);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const n = Math.sin(x * 2.1 + ox) * Math.cos(y * 2.3 + oy) + Math.sin(z * 1.9 + oz) * 0.7
      + 0.5 * Math.sin((x + z) * 4.3 + oy) * Math.cos(y * 3.7 + ox);
    const f = 1 + amount * n * 0.5;
    let ny = y * f;
    if (flatBottom && ny < 0) ny *= 0.35;
    pos.setXYZ(k, x * f, ny, z * f);
  }
  const out = facet(g);
  g.dispose();
  return out;
}

function paint(g: THREE.BufferGeometry, color: ColorLike): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  if (typeof color === 'function') {
    for (let k = 0; k < pos.count; k++) {
      color(pos.getX(k), pos.getY(k), pos.getZ(k), _col);
      arr[k * 3] = _col.r; arr[k * 3 + 1] = _col.g; arr[k * 3 + 2] = _col.b;
    }
  } else {
    _col.set(color);
    for (let k = 0; k < pos.count; k++) {
      arr[k * 3] = _col.r; arr[k * 3 + 1] = _col.g; arr[k * 3 + 2] = _col.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Collects vertex-coloured parts and merges them into one mesh / geometry. */
export class GeoBatch {
  private readonly parts: THREE.BufferGeometry[] = [];
  private vertices = 0;
  get count(): number { return this.parts.length; }
  get vertexCount(): number { return this.vertices; }

  /** `color` null keeps the geometry's own vertex colours (e.g. a pre-built template). */
  add(geo: THREE.BufferGeometry, color: ColorLike | null, m?: THREE.Matrix4): this {
    const g = prepGeometry(geo, color === null);
    if (color !== null || !g.getAttribute('color')) paint(g, color ?? '#ffffff');
    if (m) g.applyMatrix4(m);
    this.parts.push(g);
    this.vertices += g.getAttribute('position').count;
    return this;
  }
  /** Convenience: add with an inline TRS. */
  put(geo: THREE.BufferGeometry, color: ColorLike, x: number, y: number, z: number,
    ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): this {
    return this.add(geo, color, trs(x, y, z, ry, sx, sy, sz, rx, rz));
  }
  /** Append all parts of another batch transformed by m (other batch is emptied). */
  absorb(other: GeoBatch, m?: THREE.Matrix4): this {
    for (const g of other.takeParts()) {
      if (m) g.applyMatrix4(m);
      this.parts.push(g);
      this.vertices += g.getAttribute('position').count;
    }
    return this;
  }
  takeParts(): THREE.BufferGeometry[] {
    const p = this.parts.splice(0, this.parts.length);
    this.vertices = 0;
    return p;
  }
  /** Merge into one geometry (parts are disposed). */
  geometry(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    this.vertices = 0;
    if (!merged) return null;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
  /** Merge into a static mesh. */
  mesh(mat: THREE.Material, name: string, bin: Bin, opts: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh | null {
    const geo = this.geometry();
    if (!geo) return null;
    bin.add(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = !!opts.cast;
    mesh.receiveShadow = opts.receive ?? true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

// ───────────────────────────── shapes & materials ─────────────────────────────

/** Cached template primitives for one build (dispose when the build is finished). */
export class Shapes {
  private readonly cache = new Map<string, THREE.BufferGeometry>();
  private get<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    let g = this.cache.get(key);
    if (!g) { g = make(); this.cache.set(key, g); }
    return g as T;
  }
  box(): THREE.BufferGeometry { return this.get('box', () => new THREE.BoxGeometry(1, 1, 1)); }
  /** Unit cylinder (radius 1, height 1) resting on y = 0. */
  cyl(seg = 10, top = 1, open = false): THREE.BufferGeometry {
    return this.get(`cyl${seg}|${top}|${open}`, () => new THREE.CylinderGeometry(top, 1, 1, seg, 1, open).translate(0, 0.5, 0));
  }
  /** Unit cone (radius 1, height 1) resting on y = 0. */
  cone(seg = 10): THREE.BufferGeometry { return this.get(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg, 1).translate(0, 0.5, 0)); }
  sphere(w = 12, h = 8): THREE.BufferGeometry { return this.get(`sph${w}|${h}`, () => new THREE.SphereGeometry(1, w, h)); }
  /** Half sphere dome (radius 1) on y = 0. */
  dome(w = 12, h = 6): THREE.BufferGeometry {
    return this.get(`dome${w}|${h}`, () => new THREE.SphereGeometry(1, w, h, 0, Math.PI * 2, 0, Math.PI / 2));
  }
  ico(detail = 0): THREE.BufferGeometry { return this.get(`ico${detail}`, () => new THREE.IcosahedronGeometry(1, detail)); }
  dodeca(): THREE.BufferGeometry { return this.get('dod', () => new THREE.DodecahedronGeometry(1, 0)); }
  torus(r = 1, tube = 0.2, rs = 8, ts = 24, arc = Math.PI * 2): THREE.BufferGeometry {
    return this.get(`tor${r}|${tube}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(r, tube, rs, ts, arc));
  }
  /** Triangular prism (roof), 1×1×1, ridge along Z at y = 1, base on y = 0. */
  prism(): THREE.BufferGeometry {
    return this.get('prism', () => {
      const shape = new THREE.Shape();
      shape.moveTo(-0.5, 0); shape.lineTo(0.5, 0); shape.lineTo(0, 1); shape.lineTo(-0.5, 0);
      return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    });
  }
  plane(): THREE.BufferGeometry { return this.get('plane', () => new THREE.PlaneGeometry(1, 1)); }
  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
  }
}

export interface BatchMaterials {
  /** Rough painted wood/stone/snow (roughness 0.85). */
  matte: THREE.MeshStandardMaterial;
  /** Toy plastic (roughness 0.5). */
  satin: THREE.MeshStandardMaterial;
  /** Shiny (roughness 0.32, a touch of metal). */
  gloss: THREE.MeshStandardMaterial;
  /** Unlit self-illuminated colour (windows, neon, embers) — output > 1 feeds bloom. */
  glow: THREE.MeshBasicMaterial;
  /** Foliage: double-sided matte. */
  leaf: THREE.MeshStandardMaterial;
}

export function createBatchMaterials(bin: Bin, glowBoost = 1.6): BatchMaterials {
  const matte = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
  const satin = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }));
  const gloss = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15 }));
  const glow = bin.add(new THREE.MeshBasicMaterial({ vertexColors: true }));
  glow.color.setScalar(glowBoost);
  const leaf = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }));
  return { matte, satin, gloss, glow, leaf };
}

// ───────────────────────────── instancing ─────────────────────────────

export interface Placement {
  x: number; y: number; z: number;
  ry?: number;
  s?: number;
  /** Extra vertical stretch multiplier. */
  sy?: number;
  /** Small lean (radians) around X / Z. */
  rx?: number; rz?: number;
  /** Multiplies the vertex colours of this instance. */
  tint?: THREE.Color;
}

/** Instance matrix of a props-b placement (the transform instanced() uses). */
export function placementMatrix(p: Placement, out: THREE.Matrix4): THREE.Matrix4 {
  const s = p.s ?? 1;
  return trsTo(out, p.x, p.y, p.z, p.ry ?? 0, s, s * (p.sy ?? 1), s, p.rx ?? 0, p.rz ?? 0);
}

export function instanced(
  geo: THREE.BufferGeometry, mat: THREE.Material, list: readonly Placement[],
  opts: { cast?: boolean; receive?: boolean; name?: string } = {},
): THREE.InstancedMesh | null {
  // static scenery never stands in the drivable corridor (see CorridorGuard / withCorridorGuard)
  if (activeGuard) list = activeGuard.keep(geo, list, placementMatrix, opts.name);
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  im.name = opts.name ?? 'instanced';
  const m = new THREE.Matrix4();
  let anyTint = false;
  for (let k = 0; k < list.length; k++) {
    const p = list[k]!;
    const s = p.s ?? 1;
    trsTo(m, p.x, p.y, p.z, p.ry ?? 0, s, s * (p.sy ?? 1), s, p.rx ?? 0, p.rz ?? 0);
    im.setMatrixAt(k, m);
    if (p.tint) anyTint = true;
  }
  if (anyTint) {
    const white = new THREE.Color(1, 1, 1);
    for (let k = 0; k < list.length; k++) im.setColorAt(k, list[k]!.tint ?? white);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = !!opts.cast;
  im.receiveShadow = opts.receive ?? true;
  im.computeBoundingSphere();
  im.matrixAutoUpdate = false;
  im.updateMatrix();
  return im;
}

/**
 * Instanced placements, optionally split into a grid×grid set of spatial chunks so the main camera and the shadow
 * camera can frustum-cull whole chunks. Race scenes cull every scattered instance against the view and the sun's
 * shadow box (render/instance-culling.ts, attached by RaceSession), so there chunks only multiply draw calls — one
 * per visible chunk in each pass (jungle at the low tier: ~40 of its 141 grid-view calls). Hence one mesh per prop
 * kind unless a caller that is not per-instance culled asks for `chunked: true`.
 */
export function instancedChunks(
  geo: THREE.BufferGeometry, mat: THREE.Material, list: readonly Placement[],
  opts: { cast?: boolean; receive?: boolean; name?: string; grid?: number; chunked?: boolean } = {},
): THREE.InstancedMesh[] {
  if (!list.length) return [];
  const g = opts.chunked ? Math.max(1, opts.grid ?? 3) : 1;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of list) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const cw = (maxX - minX) / g + 1e-3, ch = (maxZ - minZ) / g + 1e-3;
  const buckets: Placement[][] = Array.from({ length: g * g }, () => []);
  for (const p of list) {
    const cx = Math.min(g - 1, Math.floor((p.x - minX) / cw)), cz = Math.min(g - 1, Math.floor((p.z - minZ) / ch));
    buckets[cz * g + cx]!.push(p);
  }
  const out: THREE.InstancedMesh[] = [];
  buckets.forEach((b, k) => {
    const im = instanced(geo, mat, b, { ...opts, name: `${opts.name ?? 'instanced'}-${k}` });
    if (im) out.push(im);
  });
  return out;
}

/** Slight random brightness/hue tint for natural variation. */
export function jitterTint(rng: Rng, amount = 0.12, hue = 0.02): THREE.Color {
  const c = new THREE.Color(1, 1, 1);
  const b = 1 + rng.range(-amount, amount);
  c.setRGB(b * (1 + rng.range(-hue, hue)), b, b * (1 + rng.range(-hue, hue)));
  return c;
}

// ───────────────────────────── track frames ─────────────────────────────

export interface TrackFrame {
  /** Road surface point at lateral offset d (no ramp height). */
  x: number; y: number; z: number;
  i: number;
  /** Heading yaw (atan2(fx, fz)). */
  yaw: number;
  /** Horizontal unit forward / right. */
  fx: number; fz: number; rx: number; rz: number;
}

export function wrapIndex(track: BuiltTrack, i: number): number {
  const n = track.n;
  return ((i % n) + n) % n;
}
export function indexAtS(track: BuiltTrack, s: number): number {
  const L = track.length;
  const ss = ((s % L) + L) % L;
  return Math.floor(ss / track.spacing) % track.n;
}

export function frameAtIndex(track: BuiltTrack, i: number, d = 0): TrackFrame {
  const tx = track.tx[i]!, tz = track.tz[i]!;
  const hl = Math.sqrt(tx * tx + tz * tz) || 1;
  const fx = tx / hl, fz = tz / hl;
  const rx0 = track.rx[i]!, rz0 = track.rz[i]!;
  const rl = Math.sqrt(rx0 * rx0 + rz0 * rz0) || 1;
  const rx = rx0 / rl, rz = rz0 / rl;
  return {
    x: track.px[i]! + rx * d, y: track.py[i]! + track.ry[i]! * d, z: track.pz[i]! + rz * d,
    i, yaw: Math.atan2(fx, fz), fx, fz, rx, rz,
  };
}
export function frameAt(track: BuiltTrack, s: number, d = 0): TrackFrame {
  return frameAtIndex(track, indexAtS(track, s), d);
}

export interface LandmarkPose {
  frame: TrackFrame;
  /** Signed lateral offset used (0 for 'over'). */
  d: number;
  /** Yaw for a model built facing +Z so that it faces the road (side) or the travel direction (over). */
  yaw: number;
  scale: number;
  over: boolean;
}
export function landmarkPose(track: BuiltTrack, l: LandmarkDef & { s: number }): LandmarkPose {
  const over = l.side === 'over';
  const d = over ? 0 : l.side === 'left' ? -Math.abs(l.dist) : Math.abs(l.dist);
  const frame = frameAt(track, l.s, d);
  // model +Z should point from the prop back toward the road centre
  const yaw = over ? frame.yaw : Math.atan2(-Math.sign(d) * frame.rx, -Math.sign(d) * frame.rz);
  return { frame, d, yaw, scale: l.scale ?? 1, over };
}

/** Half-width of the whole driveable corridor at sample i (to the outer barrier). */
export function corridorHalf(track: BuiltTrack, i: number): number {
  return Math.max(track.wallL[i]!, track.wallR[i]!);
}

/** Matrix that maps a model built facing +Z (X = left, Y = up) onto the road frame at sample i. */
export function roadMatrix(track: BuiltTrack, i: number, d: number, h: number, out: THREE.Matrix4, followSlope = true): THREE.Matrix4 {
  const f = frameAtIndex(track, i, d);
  if (!followSlope) return trsTo(out, f.x, f.y + h, f.z, f.yaw);
  const tx = track.tx[i]!, ty = track.ty[i]!, tz = track.tz[i]!;
  const ux = track.ux[i]!, uy = track.uy[i]!, uz = track.uz[i]!;
  // left = up × forward
  const lx = uy * tz - uz * ty, ly = uz * tx - ux * tz, lz = ux * ty - uy * tx;
  out.set(
    lx, ux, tx, f.x + ux * h,
    ly, uy, ty, f.y + uy * h,
    lz, uz, tz, f.z + uz * h,
    0, 0, 0, 1,
  );
  return out;
}

export interface PitRun { i0: number; i1: number; len: number; left: boolean; right: boolean; minY: number; maxY: number }

/** Contiguous runs of samples with a 'pit' edge on either side (handles wrap-around). */
export function findPitRuns(track: BuiltTrack): PitRun[] {
  const n = track.n;
  const isPit = (i: number) => track.edgeL[i] === 2 || track.edgeR[i] === 2;
  let start = -1;
  for (let i = 0; i < n; i++) if (!isPit(i)) { start = i; break; }
  if (start < 0) {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, track.py[i]!); maxY = Math.max(maxY, track.py[i]!); }
    return [{ i0: 0, i1: n - 1, len: n, left: true, right: true, minY, maxY }];
  }
  const runs: PitRun[] = [];
  let cur: PitRun | null = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (isPit(i)) {
      if (!cur) cur = { i0: i, i1: i, len: 0, left: false, right: false, minY: Infinity, maxY: -Infinity };
      cur.i1 = i; cur.len++;
      if (track.edgeL[i] === 2) cur.left = true;
      if (track.edgeR[i] === 2) cur.right = true;
      cur.minY = Math.min(cur.minY, track.py[i]!); cur.maxY = Math.max(cur.maxY, track.py[i]!);
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs;
}

/** Track height statistics. */
export function trackStats(track: BuiltTrack): { minY: number; maxY: number; cx: number; cz: number; radius: number; minX: number; maxX: number; minZ: number; maxZ: number } {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minY = Math.min(minY, track.py[i]!); maxY = Math.max(maxY, track.py[i]!);
    minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!);
    minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const radius = Math.sqrt((maxX - minX) ** 2 + (maxZ - minZ) ** 2) / 2;
  return { minY, maxY, cx, cz, radius, minX, maxX, minZ, maxZ };
}

/** Pit depth that guarantees the terrain under every pit run sinks below `level` by `margin`. */
export function pitDepthFor(track: BuiltTrack, level: number, margin = 8): number {
  let maxPy = -Infinity;
  for (let i = 0; i < track.n; i++) if (track.edgeL[i] === 2 || track.edgeR[i] === 2) maxPy = Math.max(maxPy, track.py[i]!);
  if (maxPy === -Infinity) return 30;
  return Math.max(18, maxPy - level + margin);
}

/** Minimum distance (m) from XZ to any track sample — brute force, for build-time checks only. */
export function nearTrackBrute(track: BuiltTrack, x: number, z: number, step = 3): number {
  let best = Infinity;
  for (let i = 0; i < track.n; i += step) {
    const d = (x - track.px[i]!) ** 2 + (z - track.pz[i]!) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Is a disc of radius r around XZ clear of every track corridor? (terrain-backed) */
export function clearOfRoad(terrain: Terrain, x: number, z: number, r: number): boolean {
  if (terrain.inCorridor(x, z, r + 2)) return false;
  if (r < 3) return true;
  const k = r * 0.8;
  return !terrain.inCorridor(x + k, z, 2) && !terrain.inCorridor(x - k, z, 2)
    && !terrain.inCorridor(x, z + k, 2) && !terrain.inCorridor(x, z - k, 2);
}

// ───────────────────────────── drivable-corridor guard ─────────────────────────────

const CG_CELL = 2;
const cgKey = (cx: number, cz: number) => (cx + 16384) * 32768 + (cz + 16384);

export interface CorridorGuardReport { checked: number; dropped: Record<string, number>; /** time spent guarding (ms) */ ms: number }

/**
 * Keeps solid scenery out of the DRIVABLE CORRIDOR — road + off-road verge up to just inside the barrier
 * (wall − 0.35 m; at a pit edge the road edge), from `lo` to `hi` above the road / verge surface. The sim has no
 * colliders for scenery, so anything standing there would be driven straight through (leaves at kart height on the
 * verge, lift chairs over the road...). Points are judged the way the sim judges a kart: against the NEAREST
 * centreline sample of every section whose cross-section covers them (stacked sections resolve by height), with the
 * barrier line interpolated between samples. Templates are tested by their real geometry (vertices plus a ≤ 0.6 m
 * point grid on large triangles), so a canopy overhanging the road above `hi` stays while a leaf at 1 m goes.
 */
export class CorridorGuard {
  readonly lo: number;
  readonly hi: number;
  /** Extra lateral margin (m) added to the corridor edge. */
  readonly pad: number;
  readonly report: CorridorGuardReport = { checked: 0, dropped: {}, ms: 0 };
  private readonly t: BuiltTrack;
  private readonly hx: Float32Array; private readonly hz: Float32Array;
  private readonly fx: Float32Array; private readonly fz: Float32Array;
  private readonly hl: Float32Array;
  private readonly dL: Float32Array; private readonly dR: Float32Array;
  private readonly cells = new Map<number, number[]>();
  private readonly clouds = new WeakMap<THREE.BufferGeometry, Map<number, { pts: Float32Array; c: THREE.Vector3; r: number }>>();
  private readonly heads: number[] = [];
  private readonly headD: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();

  constructor(track: BuiltTrack, opts: { lo?: number; hi?: number; pad?: number } = {}) {
    const t0 = performance.now();
    this.t = track;
    this.lo = opts.lo ?? 0.3;
    this.hi = opts.hi ?? 4.7;
    this.pad = opts.pad ?? 0.25;
    const n = track.n;
    this.hx = new Float32Array(n); this.hz = new Float32Array(n); this.fx = new Float32Array(n); this.fz = new Float32Array(n);
    this.hl = new Float32Array(n); this.dL = new Float32Array(n); this.dR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(track.rx[i]!, track.rz[i]!) || 1;
      this.hx[i] = track.rx[i]! / l; this.hz[i] = track.rz[i]! / l; this.hl[i] = l;
      const fl = Math.hypot(track.tx[i]!, track.tz[i]!) || 1;
      this.fx[i] = track.tx[i]! / fl; this.fz[i] = track.tz[i]! / fl;
      const hw = track.hw[i]!;
      this.dL[i] = (track.edgeL[i] === 2 ? hw - 0.1 : Math.max(hw, track.wallL[i]! - 0.35)) + this.pad;
      this.dR[i] = (track.edgeR[i] === 2 ? hw - 0.1 : Math.max(hw, track.wallR[i]! - 0.35)) + this.pad;
    }
    // 2 m cells → samples whose corridor slab touches the cell
    for (let i = 0; i < n; i++) {
      const tol = track.spacing * 0.5 * (1 + Math.abs(track.curvature[i]!) * Math.max(this.dL[i]!, this.dR[i]!)) + 0.3;
      for (let d = -this.dL[i]! - 0.4; d <= this.dR[i]! + 0.4; d += 0.8) {
        for (const a of [-tol, 0, tol]) {
          const x = track.px[i]! + this.hx[i]! * d + this.fx[i]! * a, z = track.pz[i]! + this.hz[i]! * d + this.fz[i]! * a;
          const k = cgKey(Math.floor(x / CG_CELL), Math.floor(z / CG_CELL));
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          if (arr[arr.length - 1] !== i) arr.push(i);
        }
      }
    }
    this.report.ms += performance.now() - t0;
  }

  /** How far (m) a world point lies inside the guarded corridor volume (> 0 = inside). */
  depth(x: number, y: number, z: number): number {
    const arr = this.cells.get(cgKey(Math.floor(x / CG_CELL), Math.floor(z / CG_CELL)));
    if (!arr) return -1;
    const t = this.t, n = t.n;
    const heads = this.heads, headD = this.headD;
    heads.length = 0; headD.length = 0;
    for (const i of arr) {
      const dd = (x - t.px[i]!) ** 2 + (z - t.pz[i]!) ** 2;
      let merged = false;
      for (let h = 0; h < heads.length; h++) {
        const di = Math.abs(heads[h]! - i);
        if (Math.min(di, n - di) < 25) { if (dd < headD[h]!) { heads[h] = i; headD[h] = dd; } merged = true; break; }
      }
      if (!merged) { heads.push(i); headD.push(dd); }
    }
    let best = -1;
    for (let q = 0; q < heads.length; q++) {
      // hill-climb to the true nearest centreline sample (as the sim projects a kart): a cell lists only samples whose
      // slab reaches it, and at a barrier transition the nearest sample's (narrower) slab may stop short of the point
      let i = heads[q]!, di = headD[q]!;
      for (let g = 0; g < 40; g++) {
        const a = (i + 1) % n, b = (i - 1 + n) % n;
        const da = (x - t.px[a]!) ** 2 + (z - t.pz[a]!) ** 2, db = (x - t.px[b]!) ** 2 + (z - t.pz[b]!) ** 2;
        if (da < di && da <= db) { i = a; di = da; } else if (db < di) { i = b; di = db; } else break;
      }
      const ex = x - t.px[i]!, ez = z - t.pz[i]!;
      const d = (ex * this.hx[i]! + ez * this.hz[i]!) / this.hl[i]!;
      const along = ex * this.fx[i]! + ez * this.fz[i]!;
      const gap = t.spacing * Math.max(0.2, 1 - t.curvature[i]! * d);
      const j = (along >= 0 ? i + 1 : i - 1 + n) % n, f = Math.min(1, Math.abs(along) / gap);
      const dmax = d < 0 ? this.dL[i]! + (this.dL[j]! - this.dL[i]!) * f : this.dR[i]! + (this.dR[j]! - this.dR[i]!) * f;
      const ad = Math.abs(d);
      if (ad >= dmax) continue;
      const hw = t.hw[i]! + (t.hw[j]! - t.hw[i]!) * f;
      const ys = t.py[i]! + (t.py[j]! - t.py[i]!) * f + (t.ry[i]! + (t.ry[j]! - t.ry[i]!) * f) * Math.max(-hw, Math.min(hw, d));
      const h = y - ys;
      if (h < this.lo || h > this.hi) continue;
      best = Math.max(best, dmax - ad);
    }
    return best;
  }

  /**
   * Highest road / verge surface (world y) of any section whose corridor covers (x, z), or −Infinity. Unlike the
   * terrain (pulled down by lower switchbacks, falling away beside pits) this is where karts actually drive.
   */
  surfaceAt(x: number, z: number): number {
    const arr = this.cells.get(cgKey(Math.floor(x / CG_CELL), Math.floor(z / CG_CELL)));
    if (!arr) return -Infinity;
    const t = this.t;
    let top = -Infinity;
    for (const i of arr) {
      const ex = x - t.px[i]!, ez = z - t.pz[i]!;
      const along = ex * this.fx[i]! + ez * this.fz[i]!;
      if (Math.abs(along) > t.spacing * 0.75 + 0.3) continue;
      const d = (ex * this.hx[i]! + ez * this.hz[i]!) / this.hl[i]!;
      if (Math.abs(d) >= (d < 0 ? this.dL[i]! : this.dR[i]!)) continue;
      const hw = t.hw[i]!;
      top = Math.max(top, t.py[i]! + t.ry[i]! * Math.max(-hw, Math.min(hw, d)) + t.rampH[i]!);
    }
    return top;
  }

  /** Cheap pre-test: could anything within horizontal radius r of (x, z) reach the corridor footprint? */
  near(x: number, z: number, r: number): boolean {
    const x0 = Math.floor((x - r) / CG_CELL), x1 = Math.floor((x + r) / CG_CELL);
    const z0 = Math.floor((z - r) / CG_CELL), z1 = Math.floor((z + r) / CG_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) if (this.cells.has(cgKey(cx, cz))) return true;
    return false;
  }

  /** True when a world-space point cloud (x, y, z triplets) has any point inside the corridor volume. */
  pointsIntrude(pts: ArrayLike<number>): boolean {
    for (let k = 0; k + 2 < pts.length; k += 3) if (this.depth(pts[k]!, pts[k + 1]!, pts[k + 2]!) > 0) return true;
    return false;
  }

  /** True when `geo` (template space) placed by matrix `m` would put a solid part inside the corridor. */
  intrudes(geo: THREE.BufferGeometry, m: THREE.Matrix4): boolean {
    const scale = m.getMaxScaleOnAxis();
    const cl = this.cloudOf(geo, scale);
    this.v.copy(cl.c).applyMatrix4(m);
    if (!this.near(this.v.x, this.v.z, cl.r * scale + 0.5)) return false;
    const e = m.elements, P = cl.pts;
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k]!, y = P[k + 1]!, z = P[k + 2]!;
      if (this.depth(e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) > 0) return true;
    }
    return false;
  }

  /** Placements whose template stays out of the corridor (the rest are counted in `report.dropped`). */
  keep<T>(geo: THREE.BufferGeometry, list: readonly T[], toMatrix: (p: T, out: THREE.Matrix4) => THREE.Matrix4, name = 'instanced'): T[] {
    const t0 = performance.now();
    const out: T[] = [];
    let dropped = 0;
    for (const p of list) {
      if (this.intrudes(geo, toMatrix(p, this.m))) dropped++;
      else out.push(p);
    }
    this.report.checked += list.length;
    this.report.ms += performance.now() - t0;
    if (dropped) {
      const key = name.replace(/-\d+$/, '');
      this.report.dropped[key] = (this.report.dropped[key] ?? 0) + dropped;
    }
    return out;
  }

  /** Test points of a template: every vertex plus a ≤ 0.6 m (world, at this scale) grid on triangles with long edges. */
  private cloudOf(geo: THREE.BufferGeometry, scale: number): { pts: Float32Array; c: THREE.Vector3; r: number } {
    const bucket = Math.max(1, Math.ceil(scale));
    let byScale = this.clouds.get(geo);
    if (!byScale) { byScale = new Map(); this.clouds.set(geo, byScale); }
    let cl = byScale.get(bucket);
    if (cl) return cl;
    const step = 0.6 / bucket;
    const P = geo.getAttribute('position') as THREE.BufferAttribute;
    const I = geo.index;
    const pts: number[] = [];
    for (let k = 0; k < P.count; k++) pts.push(P.getX(k), P.getY(k), P.getZ(k));
    const nT = I ? I.count / 3 : P.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let f = 0; f < nT; f++) {
      a.fromBufferAttribute(P, I ? I.getX(f * 3) : f * 3);
      b.fromBufferAttribute(P, I ? I.getX(f * 3 + 1) : f * 3 + 1);
      c.fromBufferAttribute(P, I ? I.getX(f * 3 + 2) : f * 3 + 2);
      const L = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      if (L <= step * 1.5) continue;
      const q = Math.min(40, Math.ceil(L / step));
      for (let u = 0; u <= q; u++) for (let w = 0; w <= q - u; w++) {
        if ((u === 0 && w === 0) || (u === q && w === 0) || (u === 0 && w === q)) continue;
        const bu = u / q, bw = w / q, ba = 1 - bu - bw;
        pts.push(a.x * ba + b.x * bu + c.x * bw, a.y * ba + b.y * bu + c.y * bw, a.z * ba + b.z * bu + c.z * bw);
      }
    }
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    cl = { pts: new Float32Array(pts), c: bs.center.clone(), r: bs.radius };
    byScale.set(bucket, cl);
    return cl;
  }
}

let activeGuard: CorridorGuard | null = null;
/** Guard of the scenery build in progress (instanced() here and addInstanced() in props-a consult it), or null. */
export function activeCorridorGuard(): CorridorGuard | null { return activeGuard; }

/**
 * Run a theme's scenery build with a CorridorGuard active: every static instanced placement made through
 * instanced()/instancedChunks() (props-b) or addInstanced() (props-a) whose template would stand in the drivable
 * corridor is dropped. Movers, animated rigs and anything created after the build are unaffected. The guard's
 * report is left on `scene.userData.corridorGuard` (debug / QA).
 */
export function withCorridorGuard<T>(ctx: { track: BuiltTrack; scene: THREE.Scene }, build: (guard: CorridorGuard) => T): T {
  const prev = activeGuard;
  const guard = new CorridorGuard(ctx.track);
  activeGuard = guard;
  try {
    return build(guard);
  } finally {
    activeGuard = prev;
    ctx.scene.userData.corridorGuard = guard.report;
  }
}

// ───────────────────────────── canvas textures ─────────────────────────────

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void, bin: Bin): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return bin.add(tex);
}

/** Fluffy cloud/smoke puff (white, alpha). */
export function puffTexture(bin: Bin, seed = 7, size = 128): THREE.CanvasTexture {
  const rng = new Rng(seed);
  return canvasTexture(size, (g, S) => {
    g.clearRect(0, 0, S, S);
    for (let k = 0; k < 14; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0, S * 0.2);
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r * 0.8;
      const rad = rng.range(S * 0.16, S * 0.3);
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.25)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    }
  }, bin);
}

/** Cloud bank card: several puffs along a flat base (for sky layers). */
export function cloudTexture(bin: Bin, seed = 11, size = 256): THREE.CanvasTexture {
  const rng = new Rng(seed);
  return canvasTexture(size, (g, S) => {
    g.clearRect(0, 0, S, S);
    for (let k = 0; k < 26; k++) {
      const x = rng.range(S * 0.18, S * 0.82);
      const baseY = S * 0.68;
      const hump = Math.sin(((x / S) - 0.18) / 0.64 * Math.PI);
      const y = baseY - hump * rng.range(S * 0.05, S * 0.26);
      const rad = rng.range(S * 0.08, S * 0.16) * (0.6 + hump * 0.6);
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.7, 'rgba(255,255,255,0.75)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    // soft shaded underside
    const sh = g.createLinearGradient(0, S * 0.45, 0, S * 0.75);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(60,80,120,0.35)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = sh;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
  }, bin);
}

/** Radial glow (white centre → transparent). */
export function glowTexture(bin: Bin, size = 128, core = 0.12): THREE.CanvasTexture {
  return canvasTexture(size, (g, S) => {
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(core, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.25)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
  }, bin);
}

/** Nebula blotch (white, wispy alpha). */
export function nebulaTexture(bin: Bin, seed = 5, size = 256): THREE.CanvasTexture {
  const rng = new Rng(seed);
  return canvasTexture(size, (g, S) => {
    g.clearRect(0, 0, S, S);
    for (let k = 0; k < 40; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0, S * 0.28) * (0.3 + 0.7 * rng.next());
      const x = S / 2 + Math.cos(a) * r * 1.3, y = S / 2 + Math.sin(a) * r * 0.7;
      const rad = rng.range(S * 0.06, S * 0.22);
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const al = rng.range(0.05, 0.22);
      grd.addColorStop(0, `rgba(255,255,255,${al})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    }
    // radial falloff mask so card edges never show
    g.globalCompositeOperation = 'destination-in';
    const m = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
  }, bin);
}

// ───────────────────────────── GLSL snippets ─────────────────────────────

const NOISE_GLSL = /* glsl */`
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 3; k++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.875;
}
`;

const SURFACE_VERT = /* glsl */`
varying vec3 vWP;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG_TAIL = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`;

function fogUniforms(): Record<string, THREE.IUniform> {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
}

export interface LiquidOptions {
  deep: THREE.ColorRepresentation;
  shallow: THREE.ColorRepresentation;
  /** Colour reflected at grazing angles. */
  sky: THREE.ColorRepresentation;
  sunColor?: THREE.ColorRepresentation;
  sunDir?: [number, number, number];
  /** Noise frequency (1/m). */
  scale?: number;
  /** Flow speed (noise units / s); 0 = frozen. */
  flow?: number;
  flowDir?: [number, number];
  bump?: number;
  glint?: number;
  /** Twinkling sparkles (ice / sunlit water). */
  sparkle?: number;
  opacity?: number;
}

/** Animated liquid / ice surface. uniforms.uTime must be driven by the owner. */
export function liquidMaterial(bin: Bin, o: LiquidOptions): THREE.ShaderMaterial {
  const sd = new THREE.Vector3(...(o.sunDir ?? [0.4, 0.8, 0.3])).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(o.deep) },
      uShallow: { value: new THREE.Color(o.shallow) },
      uSky: { value: new THREE.Color(o.sky) },
      uSunCol: { value: new THREE.Color(o.sunColor ?? '#fff6e0') },
      uSunDir: { value: sd },
      uScale: { value: o.scale ?? 0.06 },
      uFlow: { value: o.flow ?? 0.25 },
      uDir: { value: new THREE.Vector2(...(o.flowDir ?? [1, 0.3])).normalize() },
      uBump: { value: o.bump ?? 1.4 },
      uGlint: { value: o.glint ?? 1.2 },
      uSparkle: { value: o.sparkle ?? 0 },
      uOpacity: { value: o.opacity ?? 1 },
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: /* glsl */`
uniform float uTime, uScale, uFlow, uBump, uGlint, uSparkle, uOpacity;
uniform vec3 uDeep, uShallow, uSky, uSunCol, uSunDir;
uniform vec2 uDir;
varying vec3 vWP;
varying vec2 vUv;
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  vec2 p = vWP.xz * uScale;
  float t = uTime * uFlow;
  vec2 o1 = uDir * t, o2 = vec2(-uDir.y, uDir.x) * t * 0.7;
  float n1 = fbm3(p + o1);
  float n2 = fbm3(p * 1.7 - o2 + 3.1);
  float e = 0.12;
  float hx = fbm3(p + vec2(e, 0.0) + o1) - n1;
  float hz = fbm3(p + vec2(0.0, e) + o1) - n1;
  vec3 N = normalize(vec3(-hx * uBump * 8.0, 1.0, -hz * uBump * 8.0));
  vec3 V = normalize(cameraPosition - vWP);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 col = mix(uDeep, uShallow, smoothstep(0.25, 0.8, n2));
  col = mix(col, uSky, clamp(0.15 + fres * 0.8, 0.0, 1.0));
  vec3 R = reflect(-V, N);
  float spec = pow(max(dot(R, uSunDir), 0.0), 80.0) * uGlint;
  col += uSunCol * spec;
  float ridge = 1.0 - smoothstep(0.0, 0.035, abs(n1 - 0.52));
  col += mix(uShallow, vec3(1.0), 0.5) * ridge * 0.22;
  if (uSparkle > 0.0) {
    // round glints at a random spot in ~0.6 m cells (never whole square cells), faded out with distance (aliasing)
    vec2 gp = vWP.xz * 1.6;
    vec2 cell = floor(gp);
    float r = h21(cell);
    vec2 c = vec2(h21(cell + 17.3), h21(cell + 5.9)) * 0.6 + 0.2;
    float dotMask = 1.0 - smoothstep(0.03, 0.13, length(fract(gp) - c));
    float tw = sin(uTime * (2.0 + r * 5.0) + r * 60.0);
    float nearF = 1.0 - smoothstep(25.0, 70.0, length(cameraPosition - vWP));
    col += vec3(1.0) * step(0.93, r) * smoothstep(0.8, 1.0, tw) * dotMask * nearF * uSparkle * 1.6;
  }
  gl_FragColor = vec4(col, uOpacity);
${FRAG_TAIL}
}
`,
    fog: true,
    transparent: (o.opacity ?? 1) < 1,
    depthWrite: (o.opacity ?? 1) >= 1,
  });
  return bin.add(mat);
}

export interface LavaOptions {
  crust?: THREE.ColorRepresentation;
  mid?: THREE.ColorRepresentation;
  hot?: THREE.ColorRepresentation;
  /** Overall emissive multiplier (> 1 blooms). */
  intensity?: number;
  scale?: number;
  flow?: number;
  flowDir?: [number, number];
  /** Use mesh UVs (x along, y across) instead of world XZ — for lava falls / streams. */
  useUv?: boolean;
  /** Noise level where the white-hot magma starts (higher = more crust, less glare). Default 0.45. */
  heat?: number;
  uvScale?: [number, number];
}

/** Molten lava: dark crust plates drifting over bright glowing magma. Drive uniforms.uTime. */
export function lavaMaterial(bin: Bin, o: LavaOptions = {}): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 },
      uCrust: { value: new THREE.Color(o.crust ?? '#2a0c06') },
      uMid: { value: new THREE.Color(o.mid ?? '#ff4a00') },
      uHot: { value: new THREE.Color(o.hot ?? '#ffd35a') },
      uIntensity: { value: o.intensity ?? 1.6 },
      uScale: { value: o.scale ?? 0.08 },
      uFlow: { value: o.flow ?? 0.12 },
      uDir: { value: new THREE.Vector2(...(o.flowDir ?? [1, 0.4])).normalize() },
      uUseUv: { value: o.useUv ? 1 : 0 },
      uUvScale: { value: new THREE.Vector2(...(o.uvScale ?? [1, 1])) },
      uHeat: { value: o.heat ?? 0.45 },
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: /* glsl */`
uniform float uTime, uIntensity, uScale, uFlow, uUseUv, uHeat;
uniform vec3 uCrust, uMid, uHot;
uniform vec2 uDir, uUvScale;
varying vec3 vWP;
varying vec2 vUv;
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  vec2 p = uUseUv > 0.5 ? vUv * uUvScale : vWP.xz * uScale;
  float t = uTime * uFlow;
  vec2 q = vec2(fbm3(p + uDir * t * 0.5), fbm3(p + vec2(5.2, 1.3) - uDir * t * 0.3));
  float n = fbm3(p * 1.6 + q * 2.4 + uDir * t);
  float cracks = 1.0 - smoothstep(0.015, 0.09, abs(n - 0.5));
  float heat = smoothstep(uHeat, uHeat + 0.4, n);
  vec3 col = mix(uCrust, uMid, smoothstep(0.32, 0.6, n));
  col = mix(col, uHot, heat * heat);
  col += uHot * cracks * 0.9;
  float pulse = 0.88 + 0.12 * sin(uTime * 1.9 + n * 7.0);
  gl_FragColor = vec4(col * uIntensity * pulse, 1.0);
${FRAG_TAIL}
}
`,
    fog: true,
  });
  return bin.add(mat);
}

/** Falling water sheet (UV y = 0 bottom → 1 top). Drive uniforms.uTime. */
export function fallMaterial(bin: Bin, o: { water: THREE.ColorRepresentation; foam: THREE.ColorRepresentation; speed?: number; opacity?: number; glow?: number }): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 },
      uWater: { value: new THREE.Color(o.water) },
      uFoam: { value: new THREE.Color(o.foam) },
      uSpeed: { value: o.speed ?? 1.2 },
      uOpacity: { value: o.opacity ?? 0.92 },
      uGlow: { value: o.glow ?? 1 },
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: /* glsl */`
uniform float uTime, uSpeed, uOpacity, uGlow;
uniform vec3 uWater, uFoam;
varying vec3 vWP;
varying vec2 vUv;
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  float s1 = fbm3(vec2(vUv.x * 9.0, vUv.y * 2.0 + uTime * uSpeed));
  float s2 = fbm3(vec2(vUv.x * 23.0 + 4.0, vUv.y * 1.2 + uTime * uSpeed * 1.6));
  float streak = smoothstep(0.5, 0.8, s2);
  float foam = smoothstep(0.22, 0.0, vUv.y) + smoothstep(0.93, 1.0, vUv.y) * 0.6;
  vec3 col = mix(uWater, uFoam, clamp(streak * 0.75 + s1 * 0.25 + foam, 0.0, 1.0));
  float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  gl_FragColor = vec4(col * uGlow, uOpacity * edge);
${FRAG_TAIL}
}
`,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return bin.add(mat);
}

/** Aurora / energy curtain ribbon (UV x along, y up). Additive. */
export function auroraMaterial(bin: Bin, o: { a: THREE.ColorRepresentation; b: THREE.ColorRepresentation; intensity?: number; speed?: number }): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uA: { value: new THREE.Color(o.a) },
      uB: { value: new THREE.Color(o.b) },
      uIntensity: { value: o.intensity ?? 1.2 },
      uSpeed: { value: o.speed ?? 1 },
    },
    vertexShader: /* glsl */`
uniform float uTime, uSpeed;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.x += sin(uv.x * 18.0 + uTime * 0.5 * uSpeed) * 6.0 * uv.y;
  p.z += cos(uv.x * 11.0 + uTime * 0.37 * uSpeed) * 9.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`,
    fragmentShader: /* glsl */`
uniform float uTime, uIntensity, uSpeed;
uniform vec3 uA, uB;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float c = fbm3(vec2(vUv.x * 40.0 + uTime * 0.25 * uSpeed, uTime * 0.08));
  float rays = 0.45 + 0.55 * smoothstep(0.35, 0.75, c);
  float a = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.3, 1.0, vUv.y));
  a *= smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
  vec3 col = mix(uA, uB, smoothstep(0.1, 0.9, vUv.y));
  gl_FragColor = vec4(col * a * rays * uIntensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  return bin.add(mat);
}

// ───────────────────────────── particle fields ─────────────────────────────

const POINT_FRAG_SOFT = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying vec3 vCol;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.0) * (1.0 - smoothstep(0.7, 1.0, d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * vCol, a * vAlpha * uOpacity);
${FRAG_TAIL}
}
`;

export interface PrecipOptions {
  count: number;
  /** Size of the wrap box around the camera (m). */
  box: [number, number, number];
  /** Fall speed (m/s, negative rises). */
  fall: number;
  sway?: number;
  drift?: [number, number];
  /** Point size (m). */
  size: number;
  color: THREE.ColorRepresentation;
  opacity?: number;
  additive?: boolean;
}

export interface PointField {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  update(time: number, camera: THREE.Camera, viewH: number): void;
}

/** Camera-following wrapped particles (snowfall, embers, space dust). */
export function createPrecip(bin: Bin, rng: Rng, o: PrecipOptions): PointField {
  const n = Math.max(1, Math.floor(o.count));
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    pos[k * 3] = rng.range(0, o.box[0]); pos[k * 3 + 1] = rng.range(0, o.box[1]); pos[k * 3 + 2] = rng.range(0, o.box[2]);
    seed[k] = rng.next();
  }
  const geo = bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = bin.add(new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(...o.box) },
      uFall: { value: o.fall }, uSway: { value: o.sway ?? 0.6 }, uDrift: { value: new THREE.Vector2(...(o.drift ?? [0, 0])) },
      uSize: { value: o.size }, uViewH: { value: 720 }, uColor: { value: new THREE.Color(o.color) }, uOpacity: { value: o.opacity ?? 0.9 },
    },
    vertexShader: /* glsl */`
uniform float uTime, uFall, uSway, uSize, uViewH;
uniform vec3 uCam, uBox;
uniform vec2 uDrift;
attribute float aSeed;
varying float vAlpha;
varying vec3 vCol;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  p.y -= uTime * uFall * (0.7 + 0.6 * aSeed);
  p.x += sin(uTime * 0.9 + aSeed * 20.0) * uSway + uDrift.x * uTime;
  p.z += cos(uTime * 0.7 + aSeed * 13.0) * uSway + uDrift.y * uTime;
  vec3 rel = mod(p - uCam, uBox) - 0.5 * uBox;
  vec4 mvPosition = viewMatrix * vec4(uCam + rel, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 0.3);
  gl_PointSize = uSize * (0.6 + 0.8 * aSeed) * projectionMatrix[1][1] * uViewH * 0.5 / dist;
  vec3 e = abs(rel) / (0.5 * uBox);
  float edge = max(max(e.x, e.y), e.z);
  vAlpha = (1.0 - smoothstep(0.7, 1.0, edge)) * smoothstep(0.4, 2.0, dist);
  vCol = vec3(1.0);
  #include <fog_vertex>
}
`,
    fragmentShader: POINT_FRAG_SOFT,
    transparent: true,
    depthWrite: false,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: true,
  }));
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = 'precip';
  points.renderOrder = 5;
  const u = mat.uniforms;
  // wrap box centred on the camera of the view being drawn (split-screen: each player gets their own snowfall)
  points.onBeforeRender = (renderer, _scene, camera) => {
    const e = camera.matrixWorld.elements;
    (u.uCam!.value as THREE.Vector3).set(e[12]!, e[13]!, e[14]!);
    u.uViewH!.value = viewportHeight(renderer);
  };
  return {
    points, material: mat,
    update(time, camera, viewH) {
      const e = camera.matrixWorld.elements;
      (u.uCam!.value as THREE.Vector3).set(e[12]!, e[13]!, e[14]!);
      u.uTime!.value = time;
      u.uViewH!.value = viewH;
    },
  };
}

export interface PuffOptions {
  /** Seconds per particle cycle. */
  life: number;
  /** Initial vertical speed (m/s). */
  rise: number;
  /** Initial horizontal speed (m/s). */
  spread: number;
  /** Constant acceleration (wind x, gravity y (negative = down), wind z). */
  acc?: [number, number, number];
  size0: number; size1: number;
  color0: THREE.ColorRepresentation; color1: THREE.ColorRepresentation;
  opacity?: number;
  additive?: boolean;
  /** Use the fluffy puff texture (smoke) instead of a soft disc (sparks). */
  texture?: THREE.Texture | null;
  fog?: boolean;
  /** Fade-in / fade-out fractions of life. */
  fadeIn?: number; fadeOut?: number;
}

/** Emitter-driven puffs (smoke, mist, embers, lava bombs) — all motion is in the vertex shader. */
export function createPuffs(bin: Bin, rng: Rng, emitters: ReadonlyArray<{ x: number; y: number; z: number; r?: number }>, perEmitter: number, o: PuffOptions): PointField | null {
  const count = emitters.length * Math.max(1, Math.floor(perEmitter));
  if (!emitters.length || count <= 0) return null;
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 4);
  let k = 0;
  for (const em of emitters) {
    for (let j = 0; j < perEmitter; j++, k++) {
      const a = rng.range(0, Math.PI * 2), rr = (em.r ?? 0) * Math.sqrt(rng.next());
      pos[k * 3] = em.x + Math.cos(a) * rr; pos[k * 3 + 1] = em.y; pos[k * 3 + 2] = em.z + Math.sin(a) * rr;
      const b = rng.range(0, Math.PI * 2);
      rnd[k * 4] = Math.cos(b); rnd[k * 4 + 1] = Math.sin(b); rnd[k * 4 + 2] = rng.range(0.6, 1.3);
      rnd[k * 4 + 3] = (j + rng.range(0, 0.8)) / perEmitter;
    }
  }
  const geo = bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += o.rise * o.life + o.spread * o.life + o.size1 + 20;
  const tex = o.texture ?? null;
  const mat = bin.add(new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 }, uLife: { value: o.life }, uRise: { value: o.rise }, uSpread: { value: o.spread },
      uAcc: { value: new THREE.Vector3(...(o.acc ?? [0, 0, 0])) },
      uSize0: { value: o.size0 }, uSize1: { value: o.size1 }, uViewH: { value: 720 },
      uC0: { value: new THREE.Color(o.color0) }, uC1: { value: new THREE.Color(o.color1) },
      uOpacity: { value: o.opacity ?? 0.8 }, uMap: { value: tex },
      uFadeIn: { value: o.fadeIn ?? 0.12 }, uFadeOut: { value: o.fadeOut ?? 0.45 },
    },
    defines: tex ? { USE_PUFF_MAP: '' } : {},
    vertexShader: /* glsl */`
uniform float uTime, uLife, uRise, uSpread, uSize0, uSize1, uViewH, uFadeIn, uFadeOut;
uniform vec3 uAcc, uC0, uC1;
attribute vec4 aRnd;
varying float vAlpha;
varying vec3 vCol;
varying float vRot;
#include <fog_pars_vertex>
void main() {
  float t = fract(uTime / uLife + aRnd.w);
  float age = t * uLife;
  vec3 v = vec3(aRnd.x * uSpread, uRise, aRnd.y * uSpread) * aRnd.z;
  vec3 p = position + v * age + 0.5 * uAcc * age * age;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 0.3);
  gl_PointSize = mix(uSize0, uSize1, t) * aRnd.z * projectionMatrix[1][1] * uViewH * 0.5 / dist;
  vAlpha = smoothstep(0.0, uFadeIn, t) * (1.0 - smoothstep(1.0 - uFadeOut, 1.0, t));
  vCol = mix(uC0, uC1, t);
  vRot = aRnd.w * 6.2831 + t * aRnd.x * 2.0;
  #include <fog_vertex>
}
`,
    fragmentShader: /* glsl */`
uniform float uOpacity;
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vCol;
varying float vRot;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
#ifdef USE_PUFF_MAP
  float cs = cos(vRot), sn = sin(vRot);
  vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) + 0.5;
  float a = texture2D(uMap, r).a;
#else
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.5) * (1.0 - smoothstep(0.7, 1.0, d));
#endif
  a *= vAlpha * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol, a);
${FRAG_TAIL}
}
`,
    transparent: true,
    depthWrite: false,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: o.fog ?? true,
  }));
  const points = new THREE.Points(geo, mat);
  points.name = 'puffs';
  points.renderOrder = 4;
  const u = mat.uniforms;
  points.onBeforeRender = (renderer) => { u.uViewH!.value = viewportHeight(renderer); };
  return {
    points, material: mat,
    update(time, _camera, viewH) { u.uTime!.value = time; u.uViewH!.value = viewH; },
  };
}

export interface TwinkleOptions {
  /** Point size: metres when attenuate, else pixels (at 720p). */
  size: number;
  attenuate: boolean;
  twinkle?: number;
  speed?: number;
  /** Wander amplitude (m) for fireflies. */
  wander?: number;
  opacity?: number;
  additive?: boolean;
  fog?: boolean;
}

/** Static twinkling points with per-point colour and size (stars, sparkles, fireflies). */
export function createTwinkles(bin: Bin, rng: Rng, pts: ArrayLike<number>, colors: ArrayLike<number>, sizes: ArrayLike<number> | null, o: TwinkleOptions): PointField | null {
  const n = Math.floor(pts.length / 3);
  if (n <= 0) return null;
  const seed = new Float32Array(n);
  const size = new Float32Array(n);
  for (let k = 0; k < n; k++) { seed[k] = rng.next(); size[k] = sizes ? sizes[k]! : 1; }
  const geo = bin.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pts), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(colors), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += (o.wander ?? 0) + 2;
  const mat = bin.add(new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: { value: 0 }, uViewH: { value: 720 }, uSize: { value: o.size }, uTwinkle: { value: o.twinkle ?? 0.5 },
      uSpeed: { value: o.speed ?? 2 }, uWander: { value: o.wander ?? 0 }, uAtt: { value: o.attenuate ? 1 : 0 },
      uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: o.opacity ?? 1 },
    },
    vertexShader: /* glsl */`
uniform float uTime, uViewH, uSize, uTwinkle, uSpeed, uWander, uAtt;
attribute float aSeed, aSize;
attribute vec3 color;
varying float vAlpha;
varying vec3 vCol;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  if (uWander > 0.0) {
    float t = uTime * 0.6;
    p += uWander * vec3(sin(t * (0.7 + aSeed) + aSeed * 40.0), 0.5 * sin(t * (0.9 + aSeed * 0.5) + aSeed * 17.0), cos(t * (0.6 + aSeed * 0.7) + aSeed * 29.0));
  }
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 0.3);
  float px = uAtt > 0.5 ? uSize * aSize * projectionMatrix[1][1] * uViewH * 0.5 / dist : uSize * aSize * uViewH / 720.0;
  gl_PointSize = max(px, 1.0);
  float tw = 0.5 + 0.5 * sin(uTime * uSpeed * (0.4 + aSeed * 1.2) + aSeed * 91.0);
  vAlpha = 1.0 - uTwinkle * tw;
  vCol = color;
  #include <fog_vertex>
}
`,
    fragmentShader: POINT_FRAG_SOFT,
    transparent: true,
    depthWrite: false,
    blending: o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    fog: o.fog ?? false,
  }));
  const points = new THREE.Points(geo, mat);
  points.name = 'twinkles';
  const u = mat.uniforms;
  points.onBeforeRender = (renderer) => { u.uViewH!.value = viewportHeight(renderer); };
  return {
    points, material: mat,
    update(time, _camera, viewH) { u.uTime!.value = time; u.uViewH!.value = viewH; },
  };
}

// ───────────────────────────── sky layer ─────────────────────────────

const _vp = new THREE.Vector4();
/** Height (px) of the viewport currently being drawn — half the canvas per player in split-screen. */
export function viewportHeight(renderer: THREE.WebGLRenderer): number {
  return renderer.getCurrentViewport(_vp).w || renderer.domElement.height || 720;
}

const PINNED = Symbol('pinned-to-camera');
/**
 * Pin a renderable "at infinity": every time it is drawn its world matrix is re-centred on THAT view's camera
 * (world = T(camera) · local). Correct for split-screen (each view has its own camera) and never a frame behind.
 * The object's parents must sit at the world origin.
 */
export function pinToCamera(o: THREE.Object3D): void {
  const tagged = o as THREE.Object3D & { [PINNED]?: boolean };
  if (tagged[PINNED]) return;
  tagged[PINNED] = true;
  o.frustumCulled = false;
  const prev = o.onBeforeRender;   // keep any hook the object already had (e.g. point fields' viewport height)
  o.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    prev.call(this, renderer, scene, camera, geometry, material, group);
    const c = camera.matrixWorld.elements, w = o.matrixWorld;
    w.copy(o.matrix);
    w.elements[12]! += c[12]!; w.elements[13]! += c[13]!; w.elements[14]! += c[14]!;
  };
}

/**
 * Things "at infinity" (clouds, stars, nebulae, aurora, sky comets). The group stays at the origin; each renderable
 * child is pinned to the camera of the view being drawn (see pinToCamera). follow() only pins newly added children.
 */
export class SkyLayer {
  readonly group = new THREE.Group();
  constructor() { this.group.name = 'sky-layer'; }
  follow(_camera?: THREE.Camera): void {
    const kids = this.group.children;
    for (let k = 0; k < kids.length; k++) pinToCamera(kids[k]!);
  }
}

export interface CardSpec {
  /** Direction from the layer centre (normalised internally). */
  dir: [number, number, number];
  dist: number;
  w: number; h: number;
  /** Colour at the card's bottom / top (vertical gradient). */
  bottom: THREE.ColorRepresentation;
  top: THREE.ColorRepresentation;
  roll?: number;
}

/** Merged camera-facing cards (textured quads looking at the layer centre). */
export function buildCards(bin: Bin, specs: readonly CardSpec[], map: THREE.Texture, o: { additive?: boolean; opacity?: number; name?: string } = {}): THREE.Mesh | null {
  if (!specs.length) return null;
  const batch = new GeoBatch();
  const plane = new THREE.PlaneGeometry(1, 1);
  const m = new THREE.Matrix4(), r = new THREE.Matrix4(), s = new THREE.Matrix4();
  const z = new THREE.Vector3(), x = new THREE.Vector3(), y = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const c of specs) {
    z.set(-c.dir[0], -c.dir[1], -c.dir[2]).normalize();
    x.crossVectors(up, z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    y.crossVectors(z, x);
    m.makeBasis(x, y, z);
    m.setPosition(-z.x * c.dist, -z.y * c.dist, -z.z * c.dist);
    r.makeRotationZ(c.roll ?? 0);
    s.makeScale(c.w, c.h, 1);
    m.multiply(r).multiply(s);
    batch.add(plane, vGrad(c.bottom, c.top, -0.5, 0.5), m);
  }
  plane.dispose();
  const mat = bin.add(new THREE.MeshBasicMaterial({
    map, vertexColors: true, transparent: true, depthWrite: false, fog: false,
    opacity: o.opacity ?? 1,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
  const mesh = batch.mesh(mat, o.name ?? 'cards', bin, { receive: false });
  if (mesh) { mesh.frustumCulled = false; mesh.renderOrder = -5; }
  return mesh;
}

/** Random directions for sky cards within an elevation band (degrees). */
export function skyDir(rng: Rng, elevMin: number, elevMax: number, azimuth?: number): [number, number, number] {
  const az = azimuth ?? rng.range(0, Math.PI * 2);
  const el = THREE.MathUtils.degToRad(rng.range(elevMin, elevMax));
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

// ───────────────────────────── curves / tubes ─────────────────────────────

/** Tube along points (rope, chain, vine, cable). */
export function tubeAlong(points: THREE.Vector3[], radius: number, radial = 5, perSeg = 2): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(2, points.length * perSeg), radius, radial, false);
}

/** Straight beam between two points (unit cylinder template stretched). */
export function beamMatrix(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, out: THREE.Matrix4): THREE.Matrix4 {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
  _v1.set(dx / len, dy / len, dz / len);
  _q.setFromUnitVectors(_v2.set(0, 1, 0), _v1);
  return out.compose(_v1.set(ax, ay, az), _q, _v2.set(radius, len, radius));
}

// ───────────────────────────── suspension bridges ─────────────────────────────

export interface BridgeStyle {
  tower: THREE.ColorRepresentation;
  towerTrim: THREE.ColorRepresentation;
  cable: THREE.ColorRepresentation;
  towerHeight: number;
  cableRadius: number;
  /** Chain look (bead links) instead of rope. */
  chain?: boolean;
  /** Pillars from under the deck down into the pit. */
  pylons?: boolean;
  pylonColor?: THREE.ColorRepresentation;
  /** Emitter points returned for torch flames on tower tops. */
  torches?: boolean;
  /** Dangling vines/ropes under the deck. */
  danglers?: THREE.ColorRepresentation;
  /** Depth the towers/pylons extend below the deck. */
  depth: number;
}

export interface BridgeOut {
  torches: Array<{ x: number; y: number; z: number }>;
}

/**
 * Decorates a pit run [i0..i1] as a suspension bridge: towers at the span ends (outside the deck edge, standing in the
 * pit), sagging main cables and suspender ropes. Long runs are split into spans of ≤ maxSpan metres.
 */
export function buildSuspensionBridge(
  track: BuiltTrack, run: { i0: number; i1: number; len: number }, style: BridgeStyle,
  solid: GeoBatch, rope: GeoBatch, sh: Shapes, rng: Rng, maxSpan = 90,
): BridgeOut {
  const out: BridgeOut = { torches: [] };
  const n = track.n;
  const len = run.len;
  if (len < 12) return out;
  const spans = Math.max(1, Math.ceil((len * track.spacing) / maxSpan));
  const m = new THREE.Matrix4();
  const sideOff = (i: number, side: -1 | 1) => {
    const edge = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
    const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
    return edge === 2 ? track.hw[i]! + 1.3 : wall + 1.4;
  };
  const towerAt = (i: number, side: -1 | 1) => {
    const f = frameAtIndex(track, i, side * sideOff(i, side));
    const H = style.towerHeight;
    const w = 1.1;
    // tall post from deep in the pit to above the deck
    solid.add(sh.box(), style.tower, trs(f.x, f.y - style.depth / 2 + H / 2, f.z, f.yaw, w, style.depth + H, w));
    // trims and cap
    solid.add(sh.box(), style.towerTrim, trs(f.x, f.y + H * 0.35, f.z, f.yaw, w * 1.35, 0.35, w * 1.35));
    solid.add(sh.box(), style.towerTrim, trs(f.x, f.y + H, f.z, f.yaw, w * 1.5, 0.4, w * 1.5));
    solid.add(sh.cone(4), style.towerTrim, trs(f.x, f.y + H + 0.2, f.z, f.yaw + Math.PI / 4, w * 1.05, 1.3, w * 1.05));
    if (style.torches) out.torches.push({ x: f.x, y: f.y + H + 1.7, z: f.z });
  };
  for (let sp = 0; sp < spans; sp++) {
    const a = run.i0 + Math.floor((len * sp) / spans);
    const b = run.i0 + Math.floor((len * (sp + 1)) / spans) - 1;
    const ia = wrapIndex(track, a + 1), ib = wrapIndex(track, b - 1);
    for (const side of [-1, 1] as const) {
      towerAt(ia, side);
      if (sp === spans - 1) towerAt(ib, side);
      // main cable
      const pts: THREE.Vector3[] = [];
      const count = b - a - 2;
      const step = Math.max(2, Math.round(3 / track.spacing));
      const sus: Array<[number, number, number, number]> = [];
      for (let k = 0; k <= count; k += step) {
        const i = wrapIndex(track, a + 1 + k);
        const t = count > 0 ? k / count : 0;
        const off = sideOff(i, side) - 0.55;
        const f = frameAtIndex(track, i, side * off);
        const h = 1.0 + (style.towerHeight - 1.3) * (2 * t - 1) * (2 * t - 1);
        pts.push(new THREE.Vector3(f.x, f.y + h, f.z));
        if (k > 0 && k < count) sus.push([f.x, f.y - 0.4, f.z, h + 0.4]);
      }
      if (pts.length >= 2) {
        const last = frameAtIndex(track, ib, side * (sideOff(ib, side) - 0.55));
        const lp = pts[pts.length - 1]!;
        if (Math.hypot(lp.x - last.x, lp.z - last.z) > 0.5) pts.push(new THREE.Vector3(last.x, last.y + style.towerHeight - 0.3, last.z));
        const tube = tubeAlong(pts, style.cableRadius, style.chain ? 6 : 5, style.chain ? 3 : 2);
        rope.add(tube, style.cable);
        tube.dispose();
      }
      for (const [x, y, z, h] of sus) {
        rope.add(sh.cyl(4), style.cable, trs(x, y, z, 0, style.cableRadius * 0.55, h, style.cableRadius * 0.55));
        if (style.chain && rng.chance(0.5)) {
          rope.add(sh.torus(1, 0.3, 4, 8), style.cable, trs(x, y + h * 0.5, z, rng.range(0, 3), style.cableRadius * 1.6));
        }
      }
    }
    // pylons under long spans
    if (style.pylons) {
      const spanLen = (b - a) * track.spacing;
      const mid = wrapIndex(track, Math.floor((a + b) / 2));
      if (spanLen > 40) {
        const f = frameAtIndex(track, mid, 0);
        const w = Math.min(track.hw[mid]! * 1.1, 8);
        solid.add(sh.box(), style.pylonColor ?? style.tower, trs(f.x, f.y - 1.3 - style.depth / 2, f.z, f.yaw, w, style.depth, 3.2));
        solid.add(sh.box(), style.towerTrim, trs(f.x, f.y - 1.5, f.z, f.yaw, w * 1.2 + 1, 0.7, 4));
      }
    }
    // dangling vines / loose ropes below the deck edges
    if (style.danglers) {
      for (let k = a + 3; k < b - 3; k += Math.max(3, Math.round(5 / track.spacing))) {
        const i = wrapIndex(track, k);
        if (!rng.chance(0.6)) continue;
        const side = rng.chance(0.5) ? -1 : 1;
        const f = frameAtIndex(track, i, side * (track.hw[i]! - 0.3));
        const L = rng.range(1.5, 5);
        rope.add(sh.cyl(4), style.danglers, trs(f.x, f.y - 0.6 - L, f.z, 0, 0.07, L, 0.07));
        rope.add(sh.sphere(5, 4), style.danglers, trs(f.x, f.y - 0.6 - L, f.z, 0, 0.22, 0.3, 0.22));
      }
    }
  }
  void m; void n;
  return out;
}

// ───────────────────────────── movers ─────────────────────────────

export type MoverStyle = 'roll' | 'rollLog' | 'hop' | 'wobble' | 'tumble';

interface MoverRec {
  root: THREE.Object3D;
  heading: THREE.Object3D;
  body: THREE.Object3D;
  style: MoverStyle;
  radius: number;
  /** Last observed WORLD position. */
  px: number; pz: number;
  init: boolean;
  roll: number;
  phase: number;
  speed: number;
  /** Smoothed world-space heading of the model (rad). */
  yaw: number;
  extra: ((dt: number, time: number, speed: number) => void) | null;
  /** Optional: world yaw the model should keep facing (e.g. toward oncoming karts), re-sampled every 0.5 s. */
  face: ((x: number, z: number) => number) | null;
  faceYaw: number;
  faceT: number;
  side: number;
}

export interface MoverOptions {
  /** Height of the root above the glue's ground point (default: radius for rollers, else 0). */
  pivot?: number;
  /** Keep facing this world yaw (sampled at the mover's position) instead of the travel direction. */
  face?: (x: number, z: number) => number;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Animates mover visuals from their observed WORLD motion.
 *
 * The race glue (game/race-session.ts) wraps the returned root in its own group, sets THAT group's position and yaw
 * (the travel direction, which snaps by π whenever a sweep mover reverses) and, for its "hard" looks (boulder,
 * snowball, log, meteor, rock, lava), adds its own roll to `root.rotation.x` — about the wrapper's ground point, which
 * would swing a ball through the road. Every update() therefore cancels that roll and the yaw snap, then:
 *  - heading turns smoothly toward the observed motion (rollers never turn around: they roll backwards),
 *  - rollers spin the body about its own centre (the root is lifted to the pivot height, default = radius),
 *  - hoppers hop, blobs wobble, tumblers tumble.
 * scenery.update() runs after the glue places the movers each frame, so this always has the final word before render.
 */
export class MoverAnimator {
  private readonly list: MoverRec[] = [];
  /**
   * root (lifted to `pivot`) ← heading (yaw toward motion) ← body (spin / hop). Rollers: build the mesh centred on the
   * body origin. Others: build it standing on the body origin (pivot 0).
   */
  make(style: MoverStyle, radius: number, extra?: (dt: number, time: number, speed: number) => void, opts: MoverOptions = {}): { root: THREE.Group; heading: THREE.Group; body: THREE.Group } {
    const root = new THREE.Group();
    const heading = new THREE.Group();
    const body = new THREE.Group();
    root.add(heading); heading.add(body);
    root.name = `mover-${style}`;
    root.position.y = opts.pivot ?? (style === 'roll' || style === 'rollLog' ? radius : 0);
    this.list.push({
      root, heading, body, style, radius, px: 0, pz: 0, init: false, roll: 0, phase: Math.random() * 6.28, speed: 0, yaw: 0,
      extra: extra ?? null, face: opts.face ?? null, faceYaw: 0, faceT: 0, side: 0,
    });
    return { root, heading, body };
  }
  update(dt: number, time: number): void {
    for (const r of this.list) {
      const root = r.root;
      // cancel any roll/tilt the glue applied to the returned object (we roll the body about the right pivot)
      root.rotation.x = 0; root.rotation.z = 0;
      root.updateWorldMatrix(true, false);
      const e = root.matrixWorld.elements;
      const wx = e[12]!, wz = e[14]!;
      const rootYaw = Math.atan2(e[8]!, e[10]!);
      if (!r.init) {
        r.init = true; r.px = wx; r.pz = wz; r.yaw = rootYaw;
        if (r.face) { r.faceYaw = r.face(wx, wz); r.yaw = r.faceYaw; r.faceT = 0.5; }
      }
      const dx = wx - r.px, dz = wz - r.pz;
      r.px = wx; r.pz = wz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const roller = r.style === 'roll' || r.style === 'rollLog';
      if (r.face) {
        // stare at the drivers, turning the head a little toward the side it is hopping to
        r.faceT -= dt;
        if (r.faceT <= 0) { r.faceYaw = r.face(wx, wz); r.faceT = 0.5; }
        if (dt > 0) {
          const moving = dist > 1e-4 && dist <= 25;
          const side = moving ? (-dx * Math.cos(r.faceYaw) + dz * Math.sin(r.faceYaw)) / dist : 0;
          r.side += (side - r.side) * (1 - Math.exp(-dt * 5));
          if (moving) r.speed += (dist / dt - r.speed) * (1 - Math.exp(-dt * 6));
          r.yaw = wrapAngle(r.yaw + wrapAngle(r.faceYaw - 0.35 * r.side - r.yaw) * (1 - Math.exp(-dt * 8)));
        }
      } else if (dt > 0 && dist > 1e-4 && dist <= 25) {
        r.speed += (dist / dt - r.speed) * (1 - Math.exp(-dt * 6));
        let diff = wrapAngle(Math.atan2(dx, dz) - r.yaw);
        // a ball / log may roll either way: pick the closer of heading and heading + π
        if (roller && Math.abs(diff) > Math.PI / 2) diff -= Math.sign(diff) * Math.PI;
        const rate = r.style === 'rollLog' ? 4 : r.style === 'hop' ? 7 : 10;
        r.yaw = wrapAngle(r.yaw + diff * (1 - Math.exp(-dt * rate)));
        if (roller) r.roll += (dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw)) / r.radius;
      } else if (dt > 0) {
        r.speed *= Math.exp(-dt * 6);
      }
      r.heading.rotation.y = r.yaw - rootYaw;
      const b = r.body;
      switch (r.style) {
        case 'roll':
        case 'rollLog':
          b.rotation.x = r.roll;
          break;
        case 'hop': {
          const ph = time * 3.2 + r.phase;
          const s = Math.abs(Math.sin(ph));
          b.position.y = s * r.radius * 0.9;
          const squash = s < 0.18 ? 1 - (0.18 - s) * 1.6 : 1 + s * 0.06;
          b.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
          b.rotation.x = Math.cos(ph) * 0.12;
          break;
        }
        case 'wobble': {
          const w = time * 4 + r.phase;
          b.scale.set(1 + Math.sin(w) * 0.07, 1 + Math.sin(w + 1.7) * 0.1, 1 + Math.sin(w + 3.1) * 0.07);
          b.position.y = Math.abs(Math.sin(w * 0.5)) * 0.25;
          break;
        }
        case 'tumble':
          b.rotation.x += dt * 1.4;
          b.rotation.z += dt * 0.9;
          break;
      }
      if (r.extra) r.extra(dt, time, r.speed);
    }
  }
  clear(): void { this.list.length = 0; }
}

/** Visible viewport height in pixels for point-size scaling. */
export function viewHeight(renderer: THREE.WebGLRenderer): number {
  return renderer.domElement.height || 720;
}

// ───────────────────────────── terrain / mountains ─────────────────────────────

/** Re-tint the terrain's vertex colours in place (slope / height aware). `c` holds the current colour. */
export function recolorTerrain(mesh: THREE.Mesh, fn: (x: number, y: number, z: number, ny: number, c: THREE.Color) => void): void {
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) return;
  for (let k = 0; k < pos.count; k++) {
    _col.setRGB(col.getX(k), col.getY(k), col.getZ(k));
    fn(pos.getX(k), pos.getY(k), pos.getZ(k), nrm.getY(k), _col);
    col.setXYZ(k, _col.r, _col.g, _col.b);
  }
  col.needsUpdate = true;
}

/**
 * Ridged mountain (unit radius at the base, unit height), faceted. Ridges radiate from the summit.
 * Colour with a ColorFn using local y (0..1) and the angle atan2(z, x).
 */
export function mountainGeometry(rng: Rng, seg = 22, rings = 7, ridgeAmt = 0.3, round = false): THREE.BufferGeometry {
  const ph = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
  const fr = [rng.int(3, 5), rng.int(6, 9), rng.int(11, 15)];
  const twist = rng.range(-0.8, 0.8);
  const skew = rng.range(0.7, 1.3);
  const hAt = (r: number, a: number) => {
    let ridge = 0;
    for (let o = 0; o < 3; o++) ridge += (1 - Math.abs(Math.sin(a * fr[o]! * 0.5 + ph[o]! + r * twist * (o + 1)))) / (o + 1.3);
    const prof = round ? Math.pow(1 - r * r, 1.7) * (1 - 0.15 * r) : Math.pow(1 - r, 1.15 + 0.35 * Math.cos(a - ph[0]!) * (skew - 1));
    return prof * (1 + ridgeAmt * (ridge - 0.9) * Math.min(1, r * 3));
  };
  const pos: number[] = [];
  const P = (r: number, a: number) => {
    const rr = r * (1 + 0.12 * Math.sin(a * 3 + ph[1]!) * r);
    return [Math.cos(a) * rr, r >= 1 ? -0.05 : hAt(r, a), Math.sin(a) * rr] as const;
  };
  for (let i = 0; i < rings; i++) {
    const r0 = i / rings, r1 = (i + 1) / rings;
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2, a1 = ((j + 1) / seg) * Math.PI * 2;
      const A = P(r0, a0), B = P(r0, a1), Cc = P(r1, a0), D = P(r1, a1);
      if (i === 0) pos.push(...A, ...D, ...Cc);
      else pos.push(...A, ...D, ...Cc, ...A, ...B, ...D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
