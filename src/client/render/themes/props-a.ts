/**
 * Shared prop / material helpers for the meadow, beach, canyon and city scenery.
 *
 * Everything is procedural. Static props carry their colours in a vertex
 * `color` attribute so whole categories merge into one mesh per material
 * (optionally split into spatial chunks for frustum culling); repeated props
 * use InstancedMesh. `Bag` tracks everything a theme adds so dispose() is a
 * single call.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../../sim/rng.js';
import type { BuiltTrack, LandmarkDef } from '../../../sim/types.js';
import type { Terrain } from '../terrain.js';
import { activeCorridorGuard } from './props-b.js';

export { Rng };
export { CorridorGuard, activeCorridorGuard, withCorridorGuard } from './props-b.js';

// ───────────────────────────── Disposal bag ─────────────────────────────

/** Remembers objects added to the scene and GPU resources; dispose() cleans everything once. */
export class Bag {
  private readonly disposables = new Set<{ dispose(): void }>();
  private readonly objects: THREE.Object3D[] = [];
  track<T extends { dispose(): void }>(d: T): T { this.disposables.add(d); return d; }
  add<T extends THREE.Object3D>(parent: THREE.Object3D, o: T): T { parent.add(o); this.objects.push(o); return o; }
  dispose(): void {
    const seen = new Set<{ dispose(): void }>(this.disposables);
    for (const o of this.objects) {
      o.removeFromParent();
      o.traverse(c => {
        const m = c as THREE.Mesh;
        if (m.geometry) seen.add(m.geometry);
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(x => seen.add(x)); else if (mat) seen.add(mat);
        if ((c as THREE.InstancedMesh).isInstancedMesh) seen.add(c as THREE.InstancedMesh);
      });
    }
    for (const d of seen) d.dispose();
    this.objects.length = 0;
    this.disposables.clear();
  }
}

// ───────────────────────────── Geometry utils ─────────────────────────────

/** Strip a geometry to position/normal/color(/uv), make it indexed and colour-complete (in place). */
export function normalize(g: THREE.BufferGeometry, withUv = false): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color' && !(withUv && name === 'uv')) g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  const count = g.attributes.position!.count;
  if (!g.index) {
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) {
    const c = new Float32Array(count * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (withUv && !g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  return g;
}

/** Fill the vertex colour of `g` with one colour (in place). */
export function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  normalize(g, !!g.attributes.uv);
  const c = new THREE.Color(color);
  const a = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXYZ(i, c.r, c.g, c.b);
  a.needsUpdate = true;
  return g;
}

/** Multiply vertex colours by `tint` (in place). */
export function tintGeo(g: THREE.BufferGeometry, tint: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(tint);
  const a = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXYZ(i, a.getX(i) * c.r, a.getY(i) * c.g, a.getZ(i) * c.b);
  return g;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a TRS matrix (Euler XYZ… with Y applied as world yaw last: order 'YXZ'). */
export function trs(
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, out = new THREE.Matrix4(),
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/**
 * Paint + transform a freshly created geometry (modified in place) — the building block for
 * multi-coloured templates: combine([part(new BoxGeometry(..), '#f00', 0, 1, 0), ...]).
 */
export function part(
  g: THREE.BufferGeometry, color: THREE.ColorRepresentation,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx,
): THREE.BufferGeometry {
  paint(g, color);
  g.applyMatrix4(trs(x, y, z, rx, ry, rz, sx, sy, sz, _m4));
  return g;
}

/** Merge parts into one geometry (sources are disposed). */
export function combine(parts: THREE.BufferGeometry[], withUv = false): THREE.BufferGeometry {
  for (const p of parts) normalize(p, withUv);
  const merged = parts.length === 1 ? parts[0]!.clone() : mergeGeometries(parts, false);
  if (!merged) throw new Error('combine: incompatible geometries');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(Math.round(x * 100) | 0, 374761393) ^ Math.imul(Math.round(y * 100) | 0, 668265263)
    ^ Math.imul(Math.round(z * 100) | 0, 1442695041) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Displace vertices by a position-hash (crack-free for indexed and split geometry). */
export function jitter(g: THREE.BufferGeometry, amount: number, seed = 1): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i,
      x + (hash3(x, y, z, seed) - 0.5) * 2 * amount,
      y + (hash3(x, y, z, seed + 17) - 0.5) * 2 * amount,
      z + (hash3(x, y, z, seed + 41) - 0.5) * 2 * amount);
  }
  g.computeVertexNormals();
  return g;
}

/** Faceted low-poly look: split vertices and recompute normals. */
export function faceted(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  if (ng !== g) g.dispose();
  return ng;
}

/** Vertical colour gradient over the geometry's own Y range (in place, overrides colour). */
export function gradientY(g: THREE.BufferGeometry, bottom: THREE.ColorRepresentation, top: THREE.ColorRepresentation, y0?: number, y1?: number): THREE.BufferGeometry {
  normalize(g, !!g.attributes.uv);
  g.computeBoundingBox();
  const lo = y0 ?? g.boundingBox!.min.y, hi = y1 ?? g.boundingBox!.max.y;
  const a = new THREE.Color(bottom), b = new THREE.Color(top), c = new THREE.Color();
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - lo) / (hi - lo || 1)));
    c.copy(a).lerp(b, t);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  return g;
}

/** Sphere blob squashed flat underneath (clouds, bushes, foliage). */
export function blob(radius: number, wSeg = 12, hSeg = 9, flatBottom = 0.35): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, wSeg, hSeg);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < -radius * flatBottom) p.setY(i, -radius * flatBottom + (y + radius * flatBottom) * 0.25);
  }
  g.computeVertexNormals();
  return g;
}

// ───────────────────────────── Materials ─────────────────────────────

/** Per-theme cache of vertex-coloured standard materials. */
export class Materials {
  private readonly cache = new Map<string, THREE.Material>();
  constructor(private readonly bag: Bag) {}
  /** Vertex-coloured MeshStandardMaterial. */
  vc(roughness = 0.8, opts: { metalness?: number; emissive?: THREE.ColorRepresentation; emissiveIntensity?: number; fog?: boolean; flat?: boolean; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
    const key = `vc|${roughness}|${opts.metalness ?? 0}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? 0}|${opts.fog ?? true}|${opts.flat ?? false}|${opts.side ?? 0}`;
    let m = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness, metalness: opts.metalness ?? 0,
        emissive: new THREE.Color(opts.emissive ?? 0x000000), emissiveIntensity: opts.emissiveIntensity ?? 1,
        fog: opts.fog ?? true, flatShading: opts.flat ?? false, side: opts.side ?? THREE.FrontSide,
      });
      this.cache.set(key, m);
      this.bag.track(m);
    }
    return m;
  }
  /** Unlit vertex-coloured material (glowing windows, neon, bulbs). */
  glow(opts: { fog?: boolean; transparent?: boolean; opacity?: number; additive?: boolean } = {}): THREE.MeshBasicMaterial {
    const key = `glow|${opts.fog ?? true}|${opts.transparent ?? false}|${opts.opacity ?? 1}|${opts.additive ?? false}`;
    let m = this.cache.get(key) as THREE.MeshBasicMaterial | undefined;
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        vertexColors: true, fog: opts.fog ?? true, transparent: opts.transparent ?? false, opacity: opts.opacity ?? 1,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !(opts.transparent || opts.additive),
      });
      this.cache.set(key, m);
      this.bag.track(m);
    }
    return m;
  }
}

// ───────────────────────────── Static batches ─────────────────────────────

/** Collects transformed copies of templates and merges them per spatial chunk. */
export class Batch {
  private readonly buckets = new Map<string, THREE.BufferGeometry[]>();
  private tris = 0;
  constructor(
    readonly material: THREE.Material,
    readonly opts: { chunk?: number; castShadow?: boolean; receiveShadow?: boolean; uv?: boolean; name?: string; renderOrder?: number } = {},
  ) {}
  get triangles(): number { return this.tris; }
  /** Add a copy of `template` (untouched) transformed by `m`, optionally tinted. */
  add(template: THREE.BufferGeometry, m: THREE.Matrix4, tint?: THREE.ColorRepresentation): void {
    const g = template.clone().applyMatrix4(m);
    normalize(g, this.opts.uv);
    if (tint !== undefined) tintGeo(g, tint);
    const ch = this.opts.chunk ?? 0;
    const key = ch > 0 ? `${Math.floor(m.elements[12]! / ch)},${Math.floor(m.elements[14]! / ch)}` : '0';
    let arr = this.buckets.get(key);
    if (!arr) { arr = []; this.buckets.set(key, arr); }
    arr.push(g);
    this.tris += (g.index ? g.index.count : g.attributes.position!.count) / 3;
  }
  addAt(template: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, s = 1, tint?: THREE.ColorRepresentation): void {
    this.add(template, trs(x, y, z, 0, ry, 0, s, s, s, _m4), tint);
  }
  /** Add an already-positioned geometry (consumed). */
  addRaw(g: THREE.BufferGeometry): void {
    normalize(g, this.opts.uv);
    g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(_v);
    const ch = this.opts.chunk ?? 0;
    const key = ch > 0 ? `${Math.floor(c.x / ch)},${Math.floor(c.z / ch)}` : '0';
    let arr = this.buckets.get(key);
    if (!arr) { arr = []; this.buckets.set(key, arr); }
    arr.push(g);
    this.tris += (g.index ? g.index.count : g.attributes.position!.count) / 3;
  }
  build(parent: THREE.Object3D, bag: Bag): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const arr of this.buckets.values()) {
      if (!arr.length) continue;
      const merged = arr.length === 1 ? arr[0]! : mergeGeometries(arr, false);
      if (!merged) continue;
      if (arr.length > 1) for (const g of arr) g.dispose();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.material);
      mesh.castShadow = this.opts.castShadow ?? false;
      mesh.receiveShadow = this.opts.receiveShadow ?? false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (this.opts.renderOrder !== undefined) mesh.renderOrder = this.opts.renderOrder;
      if (this.opts.name) mesh.name = this.opts.name;
      bag.add(parent, mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

// ───────────────────────────── Instancing ─────────────────────────────

export interface Xf { x: number; y: number; z: number; ry?: number; rx?: number; rz?: number; s?: number; sx?: number; sy?: number; sz?: number }

/** Instance matrix of an Xf (the transform addInstanced() uses). */
export function xfMatrix(f: Xf, out: THREE.Matrix4): THREE.Matrix4 {
  const s = f.s ?? 1;
  return trs(f.x, f.y, f.z, f.rx ?? 0, f.ry ?? 0, f.rz ?? 0, (f.sx ?? 1) * s, (f.sy ?? 1) * s, (f.sz ?? 1) * s, out);
}

/** Build (and add) an InstancedMesh; returns null when there is nothing to draw. */
export function addInstanced(
  parent: THREE.Object3D, bag: Bag, geo: THREE.BufferGeometry, mat: THREE.Material, xfs: readonly Xf[],
  opts: { colors?: ReadonlyArray<THREE.ColorRepresentation>; castShadow?: boolean; receiveShadow?: boolean; name?: string; dynamic?: boolean } = {},
): THREE.InstancedMesh | null {
  bag.track(geo);
  // static scenery never stands in the drivable corridor (props-b CorridorGuard, active during a scenery build)
  const guard = opts.dynamic ? null : activeCorridorGuard();
  if (guard) xfs = guard.keep(geo, xfs, xfMatrix, opts.name);
  if (!xfs.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, xfs.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < xfs.length; i++) {
    const f = xfs[i]!;
    const s = f.s ?? 1;
    trs(f.x, f.y, f.z, f.rx ?? 0, f.ry ?? 0, f.rz ?? 0, (f.sx ?? 1) * s, (f.sy ?? 1) * s, (f.sz ?? 1) * s, m);
    mesh.setMatrixAt(i, m);
    if (opts.colors) mesh.setColorAt(i, c.set(opts.colors[i % opts.colors.length]!));
  }
  if (opts.dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = opts.castShadow ?? false;
  mesh.receiveShadow = opts.receiveShadow ?? false;
  if (opts.name) mesh.name = opts.name;
  bag.add(parent, mesh);
  return mesh;
}

// ───────────────────────────── Track placement ─────────────────────────────

export interface TrackFrame {
  x: number; y: number; z: number;
  /** Track heading (yaw 0 = +Z). */
  yaw: number;
  /** Horizontal unit right vector. */
  rx: number; rz: number;
  i: number;
}

export function frameAt(track: BuiltTrack, s: number): TrackFrame {
  const L = track.length;
  const ss = ((s % L) + L) % L;
  const f = ss / track.spacing;
  const i = Math.floor(f) % track.n;
  const j = (i + 1) % track.n;
  const k = f - Math.floor(f);
  const tx = track.tx[i]! + (track.tx[j]! - track.tx[i]!) * k;
  const tz = track.tz[i]! + (track.tz[j]! - track.tz[i]!) * k;
  const hl = Math.hypot(tx, tz) || 1;
  return {
    x: track.px[i]! + (track.px[j]! - track.px[i]!) * k,
    y: track.py[i]! + (track.py[j]! - track.py[i]!) * k,
    z: track.pz[i]! + (track.pz[j]! - track.pz[i]!) * k,
    yaw: Math.atan2(tx, tz),
    rx: -tz / hl, rz: tx / hl,
    i,
  };
}

/** Yaw that makes a +Z-facing model at (x,z) look at (tx,tz). */
export function yawToward(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(tx - x, tz - z);
}

export interface LandmarkPlace {
  x: number; y: number; z: number;
  /** Yaw facing the track (side) or along the track (over). */
  yaw: number;
  trackYaw: number;
  frame: TrackFrame;
  scale: number;
  side: LandmarkDef['side'];
}

export function landmarkPlace(track: BuiltTrack, l: LandmarkDef & { s: number }, heightAt: (x: number, z: number) => number): LandmarkPlace {
  const f = frameAt(track, l.s);
  const d = l.side === 'left' ? -l.dist : l.side === 'right' ? l.dist : 0;
  const x = f.x + f.rx * d, z = f.z + f.rz * d;
  const y = l.side === 'over' ? f.y : heightAt(x, z);
  const yaw = l.side === 'over' ? f.yaw : yawToward(x, z, f.x, f.z);
  return { x, y, z, yaw, trackYaw: f.yaw, frame: f, scale: l.scale ?? 1, side: l.side };
}

/** 'Rock-Arch' → 'rockarch'. */
export function normKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Landmark kinds drawn by the track-mesh module. */
export function isTrackMeshKind(kind: string): boolean {
  const k = normKind(kind);
  return k === 'grandstand' || k === 'grandstands' || k === 'arch' || k === 'banner' || k === 'banners';
}

/** True when a disc of `radius` around (x,z) keeps clear of every track corridor. */
export function clearOf(terrain: Terrain, x: number, z: number, radius: number, pad = 3): boolean {
  if (terrain.inCorridor(x, z, pad + radius)) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (terrain.inCorridor(x + Math.cos(a) * radius, z + Math.sin(a) * radius, pad)) return false;
  }
  return terrain.nearestTrack(x, z).dist > radius + 6;
}

/** Centre and radius of the track's XZ bounding box. */
export function trackExtent(track: BuiltTrack): { cx: number; cz: number; r: number; minY: number; maxY: number; minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!);
    minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!);
    minY = Math.min(minY, track.py[i]!); maxY = Math.max(maxY, track.py[i]!);
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, r: Math.hypot(maxX - minX, maxZ - minZ) / 2, minY, maxY, minX, maxX, minZ, maxZ };
}

/** Scale an instance count by the quality multiplier (never below 1 when base > 0). */
export function qcount(base: number, scenery: number): number {
  return base <= 0 ? 0 : Math.max(1, Math.round(base * scenery));
}

// ───────────────────────────── Canvas textures ─────────────────────────────

export function canvasTex(
  w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { repeat?: boolean; srgb?: boolean; anisotropy?: number; mipmaps?: boolean } = {},
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = Math.min(1024, w); cv.height = Math.min(1024, h);
  const g = cv.getContext('2d')!;
  draw(g, cv.width, cv.height);
  const t = new THREE.CanvasTexture(cv);
  if (opts.srgb ?? true) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = opts.anisotropy ?? 4;
  t.generateMipmaps = opts.mipmaps ?? true;
  if (!t.generateMipmaps) t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Soft radial white glow with alpha (for billboards). */
export function radialTexture(size = 128, hard = 0.15): THREE.CanvasTexture {
  return canvasTex(size, size, (g, w) => {
    const r = w / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(hard, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, w);
  }, { srgb: false });
}

// ───────────────────────────── Glow billboards ─────────────────────────────

/**
 * Camera-facing additive glow quads in ONE draw call (street lamp halos, aviation
 * lights, sun disc, lighthouse lantern). Per-instance position, size, colour and
 * intensity; intensity can be animated each frame without allocations.
 */
export class Glows {
  readonly mesh: THREE.Mesh;
  private readonly offset: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly base: Float32Array;
  readonly count: number;
  private n = 0;
  constructor(capacity: number, tex: THREE.Texture, opts: { fog?: boolean; depthTest?: boolean; renderOrder?: number } = {}) {
    this.count = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position!);
    geo.setAttribute('uv', quad.attributes.uv!);
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.offset.setUsage(THREE.DynamicDrawUsage);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.base = new Float32Array(capacity * 3);
    geo.setAttribute('iOffset', this.offset);
    geo.setAttribute('iSize', this.size);
    geo.setAttribute('iColor', this.color);
    geo.instanceCount = 0;
    const fog = opts.fog ?? true;
    const mat = new THREE.ShaderMaterial({
      // `map` is attached after the merge: UniformsUtils.merge() deep-clones textures, and that clone (never
      // disposed by the caller, who owns `tex`) kept one GPU texture alive per race start/end cycle
      uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), map: { value: tex } },
      vertexShader: /* glsl */`
        attribute vec3 iOffset; attribute float iSize; attribute vec3 iColor;
        varying vec2 vUv; varying vec3 vColor; varying float vDepth;
        void main() {
          vUv = uv; vColor = iColor;
          vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
          mv.xy += position.xy * iSize;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        uniform float fogNear; uniform float fogFar; uniform float fogDensity;
        varying vec2 vUv; varying vec3 vColor; varying float vDepth;
        void main() {
          // the glow textures (radialTexture) are white with the falloff in ALPHA: sampling .r gave a flat disc
          // with a hard rim (lamp halos, lighthouse lantern, campfires read as solid beige/cyan balls)
          float a = texture2D(map, vUv).a;
          vec3 c = vColor * a;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              c *= exp(-fogDensity * fogDensity * vDepth * vDepth);
            #else
              c *= 1.0 - smoothstep(fogNear, fogFar * 1.15, vDepth);
            #endif
          #endif
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: opts.depthTest ?? true,
      blending: THREE.AdditiveBlending, fog,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 2;
    this.mesh.name = 'glows';
  }
  /** Append a glow; returns its index (or -1 when full). */
  push(x: number, y: number, z: number, size: number, color: THREE.ColorRepresentation, intensity = 1): number {
    if (this.n >= this.count) return -1;
    const i = this.n++;
    const c = new THREE.Color(color);
    this.offset.setXYZ(i, x, y, z);
    this.size.setX(i, size);
    this.base[i * 3] = c.r * intensity; this.base[i * 3 + 1] = c.g * intensity; this.base[i * 3 + 2] = c.b * intensity;
    this.color.setXYZ(i, this.base[i * 3]!, this.base[i * 3 + 1]!, this.base[i * 3 + 2]!);
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.n;
    this.offset.needsUpdate = true; this.size.needsUpdate = true; this.color.needsUpdate = true;
    return i;
  }
  get length(): number { return this.n; }
  setPos(i: number, x: number, y: number, z: number): void { this.offset.setXYZ(i, x, y, z); this.offset.needsUpdate = true; }
  /** Scale the i-th glow's base colour (0 = off). */
  setLevel(i: number, k: number): void {
    this.color.setXYZ(i, this.base[i * 3]! * k, this.base[i * 3 + 1]! * k, this.base[i * 3 + 2]! * k);
    this.color.needsUpdate = true;
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ───────────────────────────── Shader patches ─────────────────────────────

/**
 * Wind sway in the vertex shader: displacement grows with local height² and
 * the phase comes from the instance position, so every tree moves differently.
 */
export function applySway(mat: THREE.MeshStandardMaterial, time: { value: number }, amp: number, freq = 1.3): void {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uSwayTime = time;
    sh.vertexShader = 'uniform float uSwayTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec3 ip = vec3(0.0);
        #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
        #endif
        float h = max(0.0, transformed.y);
        float ph = ip.x * 0.071 + ip.z * 0.053;
        float w = sin(uSwayTime * ${freq.toFixed(3)} + ph) + 0.35 * sin(uSwayTime * ${(freq * 2.3).toFixed(3)} + ph * 1.7);
        transformed.x += w * ${amp.toFixed(5)} * h * h;
        transformed.z += cos(uSwayTime * ${(freq * 0.8).toFixed(3)} + ph) * ${(amp * 0.6).toFixed(5)} * h * h;
      }`);
  };
  mat.customProgramCacheKey = () => `sway-${amp}-${freq}`;
}

/** Wing flap for instanced birds/butterflies: |x| drives vertical wing motion. */
export function applyFlap(mat: THREE.Material, time: { value: number }, amp: number, speed: number): void {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uFlapTime = time;
    sh.vertexShader = 'uniform float uFlapTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.y += abs(transformed.x) * ${amp.toFixed(3)} * sin(uFlapTime * ${speed.toFixed(3)} + float(gl_InstanceID) * 1.7);`);
  };
  mat.customProgramCacheKey = () => `flap-${amp}-${speed}`;
}

// ───────────────────────────── Water ─────────────────────────────

export interface WaterOptions {
  deep: THREE.ColorRepresentation;
  shallow: THREE.ColorRepresentation;
  foam: THREE.ColorRepresentation;
  sky: THREE.ColorRepresentation;
  sunDir: [number, number, number];
  sunColor: THREE.ColorRepresentation;
  /** Wave amplitude multiplier (1 = ocean swell). */
  waves?: number;
  /** Depth (m) at which the colour reaches `deep`. */
  depthRange?: number;
  foamWidth?: number;
}

/**
 * Stylised water: shallow→deep colour from a per-vertex `aDepth` attribute, animated swell,
 * sun glints, fresnel sky tint and a breaking foam line where the depth approaches zero.
 */
export function createWaterMaterial(o: WaterOptions): THREE.ShaderMaterial & { uniforms: { uTime: { value: number } } } {
  const sd = new THREE.Vector3(...o.sunDir).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(o.deep) },
      uShallow: { value: new THREE.Color(o.shallow) },
      uFoam: { value: new THREE.Color(o.foam) },
      uSky: { value: new THREE.Color(o.sky) },
      uSunDir: { value: sd },
      uSunColor: { value: new THREE.Color(o.sunColor) },
      uWaves: { value: o.waves ?? 1 },
      uDepthRange: { value: o.depthRange ?? 9 },
      uFoamWidth: { value: o.foamWidth ?? 1.4 },
    }]),
    vertexShader: /* glsl */`
      uniform float uTime; uniform float uWaves;
      attribute float aDepth;
      varying float vDepth; varying vec3 vWorld; varying vec3 vN;
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position;
        float amp = clamp(aDepth * 0.12, 0.0, 1.0) * uWaves;
        float a1 = p.x * 0.045 + uTime * 0.9, b1 = p.z * 0.038 - uTime * 0.7;
        float a2 = (p.x + p.z) * 0.11 + uTime * 1.6;
        p.y += (sin(a1) * cos(b1) * 0.35 + sin(a2) * 0.12) * amp;
        float dx = (0.045 * cos(a1) * cos(b1) * 0.35 + 0.11 * cos(a2) * 0.12) * amp;
        float dz = (-0.038 * sin(a1) * sin(b1) * 0.35 + 0.11 * cos(a2) * 0.12) * amp;
        vN = normalize(vec3(-dx, 1.0, -dz));
        vDepth = aDepth;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam; uniform vec3 uSky;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uDepthRange; uniform float uFoamWidth;
      varying float vDepth; varying vec3 vWorld; varying vec3 vN;
      #include <common>
      #include <fog_pars_fragment>
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec2 q = vWorld.xz;
        float n1 = vnoise(q * 0.35 + vec2(uTime * 0.35, uTime * 0.2));
        float n2 = vnoise(q * 0.9 - vec2(uTime * 0.5, -uTime * 0.3));
        vec3 N = normalize(vN + vec3((n1 - 0.5) * 0.22, 0.0, (n2 - 0.5) * 0.22));
        vec3 V = normalize(cameraPosition - vWorld);
        float dt = smoothstep(0.0, 1.0, clamp(vDepth / uDepthRange, 0.0, 1.0));
        vec3 col = mix(uShallow, uDeep, dt);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        col = mix(col, uSky, fres * 0.6);
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 220.0);
        col += uSunColor * spec * 3.0;
        // glitter
        float gl = step(0.985, vnoise(q * 2.3 + uTime * 0.8)) * (1.0 - dt * 0.3);
        col += uSunColor * gl * 0.35;
        // shoreline foam: a steady rim + a band that washes in and out
        float wave = 0.5 + 0.5 * sin(uTime * 1.1 + q.x * 0.05 + q.y * 0.04);
        float rim = 1.0 - smoothstep(0.0, uFoamWidth * 0.45, vDepth);
        float band = (1.0 - smoothstep(0.0, 0.35, abs(vDepth - uFoamWidth * (0.3 + 0.9 * wave)))) * step(0.42, n2);
        float foam = clamp(max(rim, band * 0.85), 0.0, 1.0) * step(-0.5, vDepth);
        col = mix(col, uFoam, foam);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    fog: true,
  });
  return mat as THREE.ShaderMaterial & { uniforms: { uTime: { value: number } } };
}

/** Horizontal grid plane (XZ) in world space with an `aDepth` attribute from a height function. */
export function waterGrid(
  x0: number, z0: number, x1: number, z1: number, segX: number, segZ: number, y: number,
  depthAt: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, segX, segZ);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const d = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) d[i] = depthAt(p.getX(i), p.getZ(i));
  g.setAttribute('aDepth', new THREE.BufferAttribute(d, 1));
  g.deleteAttribute('uv');
  return g;
}

// ───────────────────────────── Pits (below-deck visuals) ─────────────────────────────

export interface PitRun { side: -1 | 1; samples: number[] }

/** Contiguous runs of samples whose left/right edge is a pit. */
export function pitRuns(track: BuiltTrack): PitRun[] {
  const out: PitRun[] = [];
  const n = track.n;
  for (const side of [-1, 1] as const) {
    const edge = side < 0 ? track.edgeL : track.edgeR;
    let start = -1;
    for (let i = 0; i < n; i++) if (edge[i] !== 2) { start = i; break; }
    if (start < 0) { out.push({ side, samples: Array.from({ length: n + 1 }, (_, k) => k % n) }); continue; }
    let cur: number[] | null = null;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (edge[i] === 2) { (cur ??= []).push(i); }
      else if (cur) { out.push({ side, samples: cur }); cur = null; }
    }
    if (cur) out.push({ side, samples: cur });
  }
  return out;
}

/**
 * Flat strip beside a pit run at `level`, from under the road edge out to `width` metres
 * (clamped on the inside of curves so the ribbon never folds over itself).
 */
export function pitStrip(track: BuiltTrack, run: PitRun, width: number, level: number, pad = 4): THREE.BufferGeometry {
  const n = track.n;
  const idx: number[] = [];
  const first = run.samples[0]!, last = run.samples[run.samples.length - 1]!;
  const closed = run.samples.length > n;
  if (!closed) for (let k = pad; k > 0; k--) idx.push((first - k + n) % n);
  for (let k = 0; k < run.samples.length; k += 2) idx.push(run.samples[k]!);
  if (!closed) for (let k = 1; k <= pad; k++) idx.push((last + k) % n);
  else idx.push(run.samples[0]!);
  const pos: number[] = [];
  const ind: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    const tx = track.tx[i]!, tz = track.tz[i]!;
    const hl = Math.hypot(tx, tz) || 1;
    const rx = -tz / hl * run.side, rz = tx / hl * run.side;
    const kc = track.curvature[i]! * run.side;
    const limit = kc > 1e-4 ? Math.max(track.hw[i]! + 2, 0.9 / kc) : Infinity;
    const d0 = track.hw[i]! - 1.5;
    const d1 = Math.min(track.hw[i]! + width, limit);
    pos.push(track.px[i]! + rx * d0, level, track.pz[i]! + rz * d0);
    pos.push(track.px[i]! + rx * d1, level, track.pz[i]! + rz * d1);
    if (k > 0) {
      // counter-clockwise seen from above (+Y) so FrontSide materials are not culled:
      // right side: forward × outward = -up, so (inner, outer, next inner); left side the mirror
      const a = (k - 1) * 2, b = k * 2;
      if (run.side > 0) ind.push(a, a + 1, b, a + 1, b + 1, b);
      else ind.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(ind);
  const nrm = new Float32Array(pos.length);
  for (let v = 1; v < nrm.length; v += 3) nrm[v] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/**
 * (x, z) → true when the point lies in the ground drop beside a pit edge (within hw + pad of a
 * pit sample on its pit side). Use it to keep trees, buildings and props out of chasms/water.
 */
export function pitZone(track: BuiltTrack, pad = 46): (x: number, z: number) => boolean {
  const cell = 32;
  const map = new Map<number, number[]>();
  let any = false;
  for (let i = 0; i < track.n; i += 2) {
    if (track.edgeL[i] !== 2 && track.edgeR[i] !== 2) continue;
    any = true;
    const key = (Math.floor(track.px[i]! / cell) + 4096) * 8192 + Math.floor(track.pz[i]! / cell) + 4096;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(i);
  }
  if (!any) return () => false;
  return (x: number, z: number) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    const r = Math.ceil((pad + 14) / cell);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const arr = map.get((cx + dx + 4096) * 8192 + cz + dz + 4096);
      if (!arr) continue;
      for (const i of arr) {
        const ox = x - track.px[i]!, oz = z - track.pz[i]!;
        const lim = track.hw[i]! + pad;
        if (ox * ox + oz * oz > lim * lim) continue;
        const side = ox * track.rx[i]! + oz * track.rz[i]!;
        if ((side >= 0 ? track.edgeR[i] : track.edgeL[i]) === 2) return true;
      }
    }
    return false;
  };
}

export function runMinY(track: BuiltTrack, run: PitRun): number {
  let m = Infinity;
  for (const i of run.samples) m = Math.min(m, track.py[i]!);
  return m;
}

// ───────────────────────────── Sky extras ─────────────────────────────

/** A drifting ring of fluffy clouds merged into one mesh (rotate `mesh` to drift). */
export function buildClouds(o: {
  seed: number; count: number; cx: number; cz: number; rMin: number; rMax: number; yMin: number; yMax: number;
  top: THREE.ColorRepresentation; bottom: THREE.ColorRepresentation; size?: number; emissive?: THREE.ColorRepresentation; emissiveIntensity?: number;
}): THREE.Mesh {
  const rng = new Rng(o.seed);
  const clouds: THREE.BufferGeometry[] = [];
  for (let c = 0; c < o.count; c++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(o.rMin, o.rMax);
    const x = Math.cos(a) * r, z = Math.sin(a) * r, y = rng.range(o.yMin, o.yMax);
    const size = (o.size ?? 1) * rng.range(0.8, 1.5);
    const puffs: THREE.BufferGeometry[] = [];
    const np = rng.int(5, 9);
    const len = np * 7 * size;
    for (let p = 0; p < np; p++) {
      const t = np === 1 ? 0.5 : p / (np - 1);
      const pr = size * (9 + 9 * Math.sin(t * Math.PI) * rng.range(0.7, 1.2));
      const g = blob(pr, 14, 10, 0.25);
      g.translate((t - 0.5) * len, pr * 0.25 + rng.range(-2, 3) * size, rng.range(-6, 6) * size);
      puffs.push(g);
    }
    const cg = combine(puffs);
    gradientY(cg, o.bottom, o.top);
    cg.rotateY(a + Math.PI / 2 + rng.range(-0.4, 0.4));
    cg.translate(x, y, z);
    clouds.push(cg);
  }
  const geo = combine(clouds);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, fog: false,
    emissive: new THREE.Color(o.emissive ?? '#ffffff'), emissiveIntensity: o.emissiveIntensity ?? 0.25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(o.cx, 0, o.cz);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  return mesh;
}

export interface RingOptions {
  seed: number; cx: number; cz: number; radius: number; baseY: number;
  hMin: number; hMax: number; segments?: number;
  bottom: THREE.ColorRepresentation; top: THREE.ColorRepresentation;
  /** Snow-cap colour above this fraction of hMax. */
  snow?: { color: THREE.ColorRepresentation; above: number };
  /** Plateau (mesa) silhouettes instead of peaks. */
  mesa?: boolean;
  /** Strata stripes (canyon). */
  bands?: ReadonlyArray<THREE.ColorRepresentation>;
  /** Horizontal light direction for a subtle side shading. */
  sunDir?: [number, number, number];
  jag?: number;
  /** Height multiplier by ring angle (x = cos a, z = sin a), e.g. to sink the ring below a sea. */
  mask?: (a: number) => number;
  /** Low-poly look: flat per-face colours with baked sun shading (crisp snow caps and strata). */
  facets?: boolean;
  /** Exponent applied to the normalised height (>1 = sharper peaks, broader valleys). */
  peak?: number;
}

/** Distant silhouette ring (mountains, dunes, mesas) — unlit, fog-free, colours baked with haze. */
export function buildRing(o: RingOptions): THREE.Mesh {
  if (o.facets) return buildFacetRing(o);
  const N = o.segments ?? 220;
  const rows = 6;
  const pos: number[] = [], col: number[] = [], ind: number[] = [];
  const cB = new THREE.Color(o.bottom), cT = new THREE.Color(o.top), c = new THREE.Color();
  const snow = o.snow ? new THREE.Color(o.snow.color) : null;
  const bands = o.bands?.map(b => new THREE.Color(b));
  const sun = o.sunDir ? new THREE.Vector2(o.sunDir[0], o.sunDir[2]).normalize() : null;
  const jag = o.jag ?? 1;
  const hAt = (t: number): number => {
    const a = t * Math.PI * 2;
    const nx = Math.cos(a) * 3.1, nz = Math.sin(a) * 3.1;
    let v = 0.5 + 0.5 * fbm1(nx, nz, o.seed, 4);
    const ridge = 1 - Math.abs(fbm1(nx * 2.7, nz * 2.7, o.seed + 9, 3));
    v = v * 0.75 + ridge * 0.25 * jag;
    if (o.mesa) {
      const q = Math.floor(v * 3.2) / 3.2;
      const fr = v * 3.2 - Math.floor(v * 3.2);
      v = q + (fr > 0.82 ? (fr - 0.82) / 0.18 / 3.2 : 0);
    }
    return o.hMin + (o.hMax - o.hMin) * Math.min(1, Math.max(0, v));
  };
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const a = t * Math.PI * 2;
    const h = hAt(t) * (o.mask ? o.mask(a) : 1);
    const ca = Math.cos(a), sa = Math.sin(a);
    const shade = sun ? 0.9 + 0.12 * (-(ca * sun.x + sa * sun.y)) : 1;
    for (let r = 0; r < rows; r++) {
      const f = r / (rows - 1);
      const y = o.baseY - 40 + (h + 40) * f;
      const rad = o.radius + (1 - f) * 90 - f * 10;
      pos.push(o.cx + ca * rad, y, o.cz + sa * rad);
      c.copy(cB).lerp(cT, Math.pow(f, 0.9));
      if (bands) {
        const bi = Math.floor(((y - o.baseY) / 9) + 1000) % bands.length;
        c.lerp(bands[bi]!, 0.35 * f);
      }
      if (snow && f > 0.8 && h > o.hMax * o.snow!.above) c.lerp(snow, Math.min(1, (h - o.hMax * o.snow!.above) / (o.hMax * 0.12)) * (f > 0.95 ? 1 : 0.55));
      c.multiplyScalar(shade);
      col.push(c.r, c.g, c.b);
      if (k > 0 && r > 0) {
        const i0 = (k - 1) * rows + r - 1, i1 = k * rows + r - 1;
        ind.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(ind);
  g.computeBoundingSphere();
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'ring';
  mesh.renderOrder = -1;
  return mesh;
}

function ringHeight(o: RingOptions, t: number): number {
  const a = t * Math.PI * 2;
  const nx = Math.cos(a) * 3.1, nz = Math.sin(a) * 3.1;
  let v = 0.5 + 0.5 * fbm1(nx, nz, o.seed, 4);
  const ridge = 1 - Math.abs(fbm1(nx * 2.7, nz * 2.7, o.seed + 9, 3));
  v = v * 0.75 + ridge * 0.25 * (o.jag ?? 1);
  v = Math.min(1, Math.max(0, v));
  if (o.peak) v = Math.pow(v, o.peak);
  if (o.mesa) {
    const q = Math.floor(v * 3.2) / 3.2;
    const fr = v * 3.2 - Math.floor(v * 3.2);
    v = q + (fr > 0.82 ? (fr - 0.82) / 0.18 / 3.2 : 0);
  }
  return (o.hMin + (o.hMax - o.hMin) * Math.min(1, Math.max(0, v))) * (o.mask ? o.mask(a) : 1);
}

/** Low-poly silhouette ring: flat face colours, baked sun shading, crisp snow caps / strata. */
function buildFacetRing(o: RingOptions): THREE.Mesh {
  const N = o.segments ?? 180;
  const rows = 7;
  const rng = new Rng(o.seed + 5);
  const grid: number[] = [];
  const at = (k: number, r: number) => ((k % N) * rows + r) * 3;
  for (let k = 0; k < N; k++) {
    const t = k / N;
    const a = t * Math.PI * 2;
    const h = ringHeight(o, t);
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 0; r < rows; r++) {
      const f = r / (rows - 1);
      const jit = r > 0 && r < rows - 1 ? (rng.next() - 0.5) * 0.1 : 0;
      const ff = Math.min(1, Math.max(0, f + jit));
      const y = o.baseY - 40 + (h + 40) * Math.pow(ff, 0.8);
      const rad = o.radius + (1 - ff) * 110 - ff * 8 + (r < rows - 1 ? (rng.next() - 0.5) * 14 : 0);
      const da = r < rows - 1 ? (rng.next() - 0.5) * (0.4 / N) * Math.PI * 2 : 0;
      grid.push(o.cx + Math.cos(a + da) * rad, y, o.cz + Math.sin(a + da) * rad);
      void ca; void sa;
    }
  }
  const pos: number[] = [], col: number[] = [];
  const cB = new THREE.Color(o.bottom), cT = new THREE.Color(o.top), c = new THREE.Color();
  const snow = o.snow ? new THREE.Color(o.snow.color) : null;
  const bands = o.bands?.map(b => new THREE.Color(b));
  const sun = new THREE.Vector3(...(o.sunDir ?? [0.4, 0.8, 0.3])).normalize();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const tri = (i0: number, i1: number, i2: number, k: number) => {
    va.fromArray(grid, i0); vb.fromArray(grid, i1); vc.fromArray(grid, i2);
    nrm.crossVectors(e1.subVectors(vb, va), e2.subVectors(vc, va)).normalize();
    // face the ring centre (the camera is always inside)
    if ((o.cx - va.x) * nrm.x + (o.cz - va.z) * nrm.z < 0) nrm.negate();
    const cy = (va.y + vb.y + vc.y) / 3;
    const hy = cy - o.baseY;
    const frac = Math.min(1, Math.max(0, hy / Math.max(1, o.hMax)));
    c.copy(cB).lerp(cT, Math.pow(frac, 0.9));
    if (bands) {
      const bi = ((Math.floor(hy / 8) % bands.length) + bands.length) % bands.length;
      c.lerp(bands[bi]!, 0.55);
    }
    if (snow && o.snow) {
      const line = o.hMax * o.snow.above + fbm1(k * 0.21, 3.3, o.seed + 77, 2) * o.hMax * 0.12;
      if (hy > line) c.copy(snow);
    }
    const shade = 0.8 + 0.32 * Math.max(0, nrm.dot(sun)) - 0.06 * (1 - Math.abs(nrm.y));
    c.multiplyScalar(shade);
    for (const v of [va, vb, vc]) { pos.push(v.x, v.y, v.z); col.push(c.r, c.g, c.b); }
  };
  for (let k = 0; k < N; k++) {
    for (let r = 1; r < rows; r++) {
      const a0 = at(k, r - 1), a1 = at(k, r), b0 = at(k + 1, r - 1), b1 = at(k + 1, r);
      if ((k + r) % 2) { tri(a0, b0, a1, k); tri(a1, b0, b1, k); } else { tri(a0, b0, b1, k); tri(a0, b1, a1, k); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'ring';
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * Natural rock arch in the local XY plane: spans X (feet at x = ±span/2, y = 0, legs buried to
 * −bury), crown at y = height, thickness across Z = depth. Faceted, white vertex colour.
 */
export function naturalArchGeo(o: { span: number; height: number; thick: number; depth: number; seed: number; bury?: number; segs?: number; sides?: number }): THREE.BufferGeometry {
  const rng = new Rng(o.seed);
  const segs = o.segs ?? 22, sides = o.sides ?? 9, bury = o.bury ?? 10;
  const hx = o.span / 2;
  const pts: Array<[number, number]> = [];
  for (let k = 3; k >= 1; k--) pts.push([-hx - k * 0.5, -bury * k / 3]);
  for (let k = 0; k <= segs; k++) { const t = (k / segs) * Math.PI; pts.push([-Math.cos(t) * hx, Math.sin(t) * o.height]); }
  for (let k = 1; k <= 3; k++) pts.push([hx + k * 0.5, -bury * k / 3]);
  const M = pts.length;
  const pos: number[] = [], ind: number[] = [];
  for (let i = 0; i < M; i++) {
    const [px, py] = pts[i]!;
    const [ax, ay] = pts[Math.max(0, i - 1)]!, [bx, by] = pts[Math.min(M - 1, i + 1)]!;
    const tl = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / tl, ny = (bx - ax) / tl;
    const yN = Math.max(0, py) / o.height;
    const th = o.thick * (1 + 0.95 * (1 - yN) ** 2), dp = o.depth * (1 + 0.45 * (1 - yN) ** 2);
    const sway = (rng.next() - 0.5) * o.depth * 0.12;
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const rr = 0.82 + rng.next() * 0.3;
      const ox = Math.cos(ang) * th * 0.5 * rr, oz = Math.sin(ang) * dp * 0.5 * rr;
      pos.push(px + nx * ox, py + ny * ox, oz + sway);
    }
    if (i > 0) for (let s = 0; s < sides; s++) {
      const a0 = (i - 1) * sides + s, a1 = (i - 1) * sides + (s + 1) % sides, b0 = i * sides + s, b1 = i * sides + (s + 1) % sides;
      ind.push(a0, a1, b0, a1, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(ind);
  jitter(g, o.thick * 0.07, o.seed + 3);
  const f = faceted(g);
  return paint(f, '#ffffff');
}

/** 1-D-ish value-noise fbm (independent from terrain so rings stay seed-stable). */
function fbm1(x: number, z: number, seed: number, oct: number): number {
  let amp = 0.5, freq = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    const xi = Math.floor(x * freq), zi = Math.floor(z * freq);
    const fx = x * freq - xi, fz = z * freq - zi;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const h = (a: number, b: number) => hash3(a, b, o, seed);
    const n = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * u + (h(xi, zi + 1) - h(xi, zi)) * v
      + (h(xi, zi) - h(xi + 1, zi) - h(xi, zi + 1) + h(xi + 1, zi + 1)) * u * v;
    sum += amp * (n * 2 - 1);
    amp *= 0.5; freq *= 2.03;
  }
  return sum;
}

/** Flat ground annulus that fills the gap between the terrain edge and the silhouette ring. */
export function buildFarGround(cx: number, cz: number, rIn: number, rOut: number, y: number, color: THREE.ColorRepresentation, roughness = 1): THREE.Mesh {
  const g = new THREE.RingGeometry(rIn, rOut, 96, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'farGround';
  mesh.receiveShadow = false;
  return mesh;
}

/** Circling birds (instanced, flapping in the vertex shader). */
export class Flock {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: Array<{ cx: number; cz: number; y: number; r: number; w: number; ph: number; bob: number }> = [];
  private readonly m = new THREE.Matrix4();
  private readonly time = { value: 0 };
  constructor(o: { seed: number; count: number; cx: number; cz: number; spread: number; yMin: number; yMax: number; color: THREE.ColorRepresentation; size?: number; groups?: number }) {
    const rng = new Rng(o.seed);
    const s = o.size ?? 1;
    const wingL = new THREE.BufferGeometry();
    // body + two wings, facing +Z
    const v = [
      0, 0, 0.9 * s, -0.18 * s, 0, -0.5 * s, 0.18 * s, 0, -0.5 * s,
      0.1 * s, 0, 0.35 * s, 1.4 * s, 0.1 * s, -0.15 * s, 0.1 * s, 0, -0.3 * s,
      -0.1 * s, 0, 0.35 * s, -0.1 * s, 0, -0.3 * s, -1.4 * s, 0.1 * s, -0.15 * s,
    ];
    wingL.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    wingL.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: o.color, side: THREE.DoubleSide, fog: true });
    applyFlap(mat, this.time, 0.55, 9);
    this.mesh = new THREE.InstancedMesh(wingL, mat, o.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'flock';
    const groups = o.groups ?? Math.max(1, Math.round(o.count / 5));
    const centres = Array.from({ length: groups }, () => ({ cx: o.cx + rng.range(-o.spread, o.spread), cz: o.cz + rng.range(-o.spread, o.spread), y: rng.range(o.yMin, o.yMax), r: rng.range(25, 60), w: rng.range(0.12, 0.25) * (rng.chance(0.5) ? 1 : -1) }));
    for (let i = 0; i < o.count; i++) {
      const g = centres[i % groups]!;
      this.data.push({ cx: g.cx, cz: g.cz, y: g.y + rng.range(-4, 4), r: g.r + rng.range(-6, 6), w: g.w, ph: rng.range(0, 0.9), bob: rng.range(0, 6) });
    }
    this.update(0);
  }
  update(t: number): void {
    this.time.value = t;
    const e = this.m.elements;
    for (let i = 0; i < this.data.length; i++) {
      const b = this.data[i]!;
      const a = b.ph + t * b.w;
      const x = b.cx + Math.cos(a) * b.r, z = b.cz + Math.sin(a) * b.r;
      const y = b.y + Math.sin(t * 0.7 + b.bob) * 1.5;
      // heading: tangent of the circle
      const yaw = Math.atan2(-Math.sin(a) * b.w, Math.cos(a) * b.w);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const bank = b.w > 0 ? -0.35 : 0.35;
      const cb = Math.cos(bank), sb = Math.sin(bank);
      // R = Ry(yaw) * Rz(bank)
      e[0] = cy * cb; e[1] = sb; e[2] = -sy * cb; e[3] = 0;
      e[4] = -cy * sb; e[5] = cb; e[6] = sy * sb; e[7] = 0;
      e[8] = sy; e[9] = 0; e[10] = cy; e[11] = 0;
      e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

/**
 * Butterflies fluttering over flower patches (one instanced draw call, wings flap in the vertex
 * shader, per-instance colours). update() writes the matrices without allocating.
 */
export class Butterflies {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: Array<{ x: number; y: number; z: number; r: number; w: number; ph: number; s: number }> = [];
  private readonly m = new THREE.Matrix4();
  private readonly time = { value: 0 };
  constructor(spots: ReadonlyArray<{ x: number; y: number; z: number }>, perSpot: number, seed: number, colors: ReadonlyArray<THREE.ColorRepresentation>) {
    const rng = new Rng(seed);
    const v: number[] = [];
    for (const sx of [-1, 1]) {
      // forewing + hindwing lobes, facing +Z, wings spread along ±X
      v.push(0, 0, 0.06, sx * 0.36, 0.03, 0.2, sx * 0.3, 0, -0.04);
      v.push(0, 0, 0, sx * 0.25, 0, -0.06, sx * 0.13, 0, -0.26);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, side: THREE.DoubleSide, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.12 });
    applyFlap(mat, this.time, 2.4, 17);
    const n = spots.length * perSpot;
    this.mesh = new THREE.InstancedMesh(g, mat, Math.max(1, n));
    this.mesh.count = n;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'butterflies';
    const c = new THREE.Color();
    for (const p of spots) for (let k = 0; k < perSpot; k++) {
      this.mesh.setColorAt(this.data.length, c.set(colors[rng.int(0, colors.length)]!));
      this.data.push({ x: p.x + rng.range(-3, 3), y: p.y + rng.range(0.9, 1.8), z: p.z + rng.range(-3, 3), r: rng.range(1.5, 4), w: rng.range(0.5, 0.9) * (rng.chance(0.5) ? 1 : -1), ph: rng.range(0, 6.28), s: rng.range(1.1, 1.6) });
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.update(0);
  }
  update(t: number): void {
    this.time.value = t;
    const e = this.m.elements;
    for (let i = 0; i < this.data.length; i++) {
      const b = this.data[i]!;
      const a = b.ph + t * b.w;
      // wandering loop with a bobbing, fluttery climb
      const x = b.x + Math.cos(a) * b.r + Math.sin(t * 1.7 + b.ph) * 0.5;
      const z = b.z + Math.sin(a * 1.3) * b.r * 0.7;
      const y = b.y + Math.sin(t * 2.3 + b.ph) * 0.35 + Math.abs(Math.sin(t * 7 + b.ph)) * 0.12;
      const dx = -Math.sin(a) * b.w * b.r, dz = Math.cos(a * 1.3) * 1.3 * b.w * b.r * 0.7;
      const yaw = Math.atan2(dx, dz), cy = Math.cos(yaw), sy = Math.sin(yaw), s = b.s;
      e[0] = cy * s; e[1] = 0; e[2] = -sy * s; e[3] = 0;
      e[4] = 0; e[5] = s; e[6] = 0; e[7] = 0;
      e[8] = sy * s; e[9] = 0; e[10] = cy * s; e[11] = 0;
      e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

/** Star field on a sphere around the camera (one Points draw call). */
export function buildStars(seed: number, count: number, radius: number): THREE.Points {
  const rng = new Rng(seed);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rng.range(0.06, 1), a = rng.range(0, Math.PI * 2);
    const y = u * u * 0.95 + 0.05;
    const r = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(a) * r * radius; pos[i * 3 + 1] = y * radius; pos[i * 3 + 2] = Math.sin(a) * r * radius;
    c.setHSL(rng.pick([0.6, 0.62, 0.1, 0.75, 0.55]), 0.6, rng.range(0.7, 1)).multiplyScalar(rng.range(0.6, 1.4));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, depthWrite: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  p.name = 'stars';
  return p;
}

// ───────────────────────────── Generic templates ─────────────────────────────

/** Faceted rock (icosahedron, jittered and squashed). */
export function rockGeo(r: number, color: THREE.ColorRepresentation, seed: number, squash = 0.7, detail = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(1, squash, 1);
  jitter(g, r * 0.22, seed);
  const f = faceted(g);
  paint(f, color);
  return f;
}

/** Discs already taken by big props, so scattered vegetation keeps out of them. */
export class Reserve {
  private readonly d: number[] = [];
  private readonly blockers: Array<(x: number, z: number) => boolean> = [];
  add(x: number, z: number, r: number): void { this.d.push(x, z, r); }
  /** Also reject every point for which `fn` is true (e.g. pitZone). */
  block(fn: (x: number, z: number) => boolean): void { this.blockers.push(fn); }
  ok(x: number, z: number, r = 0): boolean {
    for (const b of this.blockers) if (b(x, z)) return false;
    for (let k = 0; k < this.d.length; k += 3) {
      const dx = x - this.d[k]!, dz = z - this.d[k + 1]!, rr = this.d[k + 2]! + r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }
}

/**
 * Footprints of the track-mesh structures whose feet stand just outside the barriers (start gantry legs, inflatable
 * arches and over-road banners, see track-mesh spanFoot): reserve them so lamps, fences, trees and other props
 * never grow through a leg.
 */
export function reserveTrackFurniture(track: BuiltTrack, reserve: Reserve): void {
  const spots: number[] = [track.startS];
  for (const l of track.landmarks) {
    const k = normKind(l.kind);
    if (l.side === 'over' && (k === 'arch' || k === 'banner' || k === 'banners' || k === 'grandstand' || k === 'grandstands')) spots.push(l.s);
  }
  const wallAt = (i: number, side: number) => ((side < 0 ? track.edgeL[i] : track.edgeR[i]) === 2 ? track.hw[i]! : side < 0 ? track.wallL[i]! : track.wallR[i]!);
  for (const s of spots) {
    const f = frameAt(track, s);
    for (const side of [-1, 1]) {
      const d = side * (wallAt(f.i, side) + 2.2);
      reserve.add(f.x + f.rx * d, f.z + f.rz * d, 3.2);
    }
  }
  // road-side grandstands (≤ 31 m long, ~7 m deep behind their front edge at max(dist, wall + 3.2), possibly pushed
  // out up to 12 m to fit) and sponsor boards (8.6 m wide at max(dist, wall + 1.4)); trees grew through their roofs
  const disc = (s: number, side: number, d: number, r: number) => {
    const f = frameAt(track, s);
    reserve.add(f.x + f.rx * side * d, f.z + f.rz * side * d, r);
  };
  for (const l of track.landmarks) {
    const k = normKind(l.kind);
    if (l.side === 'over') continue;
    const side = l.side === 'left' ? -1 : 1;
    const i = frameAt(track, l.s).i;
    if (k === 'grandstand' || k === 'grandstands') {
      const d0 = Math.max(l.dist, wallAt(i, side) + 3.2);
      const half = 16 * (l.scale ?? 1);
      for (let a = -half; a <= half + 0.01; a += 5) for (const dd of [2.5, 9]) disc(l.s + a, side, d0 + dd, 6.5);
    } else if (k === 'banner' || k === 'banners') {
      disc(l.s, side, Math.max(l.dist, wallAt(i, side) + 1.4), 5);
    }
  }
  for (const off of [-70, -40, 35, 65]) {
    for (const side of [-1, 1]) {
      const s = track.startS + off + (side > 0 ? 9 : 0);
      disc(s, side, wallAt(frameAt(track, s).i, side) + 1.4, 5);
    }
  }
}

/** Stripes by longitude on a sphere (beach-ball look). */
export function stripedBall(r: number, colors: ReadonlyArray<THREE.ColorRepresentation>, seg = 18): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, 12);
  const ng = g.toNonIndexed();
  g.dispose();
  const p = ng.attributes.position as THREE.BufferAttribute;
  const cols = colors.map(c => new THREE.Color(c));
  const col = new Float32Array(p.count * 3);
  for (let t = 0; t < p.count; t += 3) {
    const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3, cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
    const cy = (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3;
    const a = (Math.atan2(cz, cx) / (Math.PI * 2) + 1) % 1;
    const c = Math.abs(cy) > r * 0.93 ? new THREE.Color('#ffffff') : cols[Math.floor(a * cols.length) % cols.length]!;
    for (let k = 0; k < 3; k++) { col[(t + k) * 3] = c.r; col[(t + k) * 3 + 1] = c.g; col[(t + k) * 3 + 2] = c.b; }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return normalize(ng);
}

/**
 * Wraps a mover root around an inner object the theme animates.
 *
 * How the game drives it (game/race-session.ts): the returned `root` is parented to the glue's own
 * `outer` group, which receives the sim pose — a sweep mover's yaw faces its LATERAL travel
 * direction and flips 180° when it turns round — and for rolling looks ('boulder', 'rock', 'log',
 * 'snowball', 'meteor', 'lava') the glue adds distance / radius to `root.rotation.x` every frame.
 * So never read `root.position` for motion (it stays at the local origin) and never let a body that
 * sits above the origin be spun about the origin: see updateRoll / worldYaw.
 */
export interface MoverRig {
  root: THREE.Group; inner: THREE.Object3D; phase: number; kind: string; parts?: THREE.Object3D[];
  /** Rolling body turned by updateRoll; its PARENT is the pivot sitting at the body centre. */
  spin?: THREE.Object3D;
  /** Rest position of the body centre in root space (the pivot is kept at R_root⁻¹ · centre). */
  centre?: THREE.Vector3;
  /** Rolling radius (m). */
  radius?: number;
  /** The glue rolls this rig itself (root.rotation.x was seen non-zero). */
  external?: boolean;
  /** Last world position (self-driven rolling). */
  last?: THREE.Vector3;
  /** Smoothed world facing yaw. */
  face?: number;
}

export function makeRig(kind: string, inner: THREE.Object3D, phase: number): MoverRig {
  const root = new THREE.Group();
  root.name = `mover-${kind}`;
  root.add(inner);
  return { root, inner, phase, kind };
}

const _rp = new THREE.Vector3(), _rd = new THREE.Vector3(), _ra = new THREE.Vector3(), _rq = new THREE.Quaternion(), _rqa = new THREE.Quaternion();

/**
 * Keep a rolling body turning about its OWN centre. Whatever rotation the glue puts on `root` (it rolls
 * it about the root origin, i.e. the ground point), the pivot is placed at R_root⁻¹ · centre so that
 * root · pivot = T(centre) · R_root: the body spins in place instead of swinging through the ground. The
 * glue's value is never modified. Without an external roll the rig rolls from its own world-space motion
 * (harnesses that move the returned object directly). No allocations after the first call.
 */
export function updateRoll(rig: MoverRig): void {
  const body = rig.spin, pivot = body?.parent, centre = rig.centre;
  if (!body || !pivot || !centre) return;
  pivot.position.copy(centre).applyQuaternion(_rq.copy(rig.root.quaternion).invert());
  if (rig.root.rotation.x !== 0) rig.external = true;
  if (rig.external) return;
  rig.root.getWorldPosition(_rp);
  if (!rig.last) { rig.last = _rp.clone(); return; }
  _rd.subVectors(_rp, rig.last);
  _rd.y = 0;
  const dist = _rd.length();
  if (dist > 1e-4 && dist < 10) {
    _ra.set(_rd.z, 0, -_rd.x).divideScalar(dist); // up × motion
    rig.root.getWorldQuaternion(_rq).invert();
    _ra.applyQuaternion(_rq);
    body.quaternion.premultiply(_rqa.setFromAxisAngle(_ra, dist / (rig.radius ?? 1)));
  }
  rig.last.copy(_rp);
}

/** World yaw of an object's +Z axis (refreshes its world matrix chain). */
export function worldYaw(o: THREE.Object3D): number {
  o.getWorldQuaternion(_rq);
  const { x, y, z, w } = _rq;
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
}

/** Turn `current` toward `target` (radians) by at most `maxStep`, the short way round. */
export function turnToward(current: number, target: number, maxStep: number): number {
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

/**
 * Smoothly turn a rig's `inner` toward a world yaw (default: the root's own heading), so a sweep
 * mover walks round at the end of its sweep instead of snapping 180°. Returns the root's world yaw.
 */
export function faceSmooth(rig: MoverRig, dt: number, rate: number, target?: number): number {
  const rootYaw = worldYaw(rig.root);
  const want = target ?? rootYaw;
  rig.face = rig.face === undefined ? want : turnToward(rig.face, want, dt * rate);
  rig.inner.rotation.y = rig.face - rootYaw;
  return rootYaw;
}

/** Friendly fallback mover geometry: a striped toy ball centred on its origin. */
export function genericMoverGeo(accent: THREE.ColorRepresentation): THREE.BufferGeometry {
  return stripedBall(1.3, [accent, '#ffffff', '#ffd23f', '#ffffff']);
}

/** Fallback mover rig: a bouncing striped ball that rolls about its centre (see updateGeneric). */
export function makeGenericRig(geo: THREE.BufferGeometry, mat: THREE.Material, phase: number): MoverRig {
  const ball = new THREE.Mesh(geo, mat);
  ball.castShadow = true;
  const bounce = new THREE.Group();
  bounce.position.y = 1.3;
  bounce.add(ball);
  const rig = makeRig('generic', bounce, phase);
  rig.spin = ball;
  rig.centre = new THREE.Vector3(0, 1.3, 0);
  rig.radius = 1.3;
  return rig;
}

export function updateGeneric(rig: MoverRig, time: number): void {
  rig.centre!.y = 1.3 + Math.abs(Math.sin(time * 3 + rig.phase)) * 0.8;
  updateRoll(rig);
}

/** Water planes below every pit run (flat per run), with depth from the terrain for shoreline foam. */
export function waterPits(
  track: BuiltTrack, heightAt: (x: number, z: number) => number, mat: THREE.Material, bag: Bag, parent: THREE.Object3D,
  below = 7, width = 70, filter?: (run: PitRun) => boolean,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const run of pitRuns(track)) {
    if (filter && !filter(run)) continue;
    const level = runMinY(track, run) - below;
    const g = pitStrip(track, run, width, level);
    const p = g.attributes.position as THREE.BufferAttribute;
    const d = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) d[i] = level - heightAt(p.getX(i), p.getZ(i));
    g.setAttribute('aDepth', new THREE.BufferAttribute(d, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'pit-water';
    mesh.receiveShadow = false;
    bag.add(parent, mesh);
    out.push(mesh);
  }
  return out;
}

/** Re-tint the terrain's vertex colours in place: fn receives world x,y,z and the current colour to modify. */
export function recolorTerrain(mesh: THREE.Mesh, fn: (x: number, y: number, z: number, c: THREE.Color, nY: number) => void): void {
  const g = mesh.geometry;
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  if (!col) return;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    fn(p.getX(i), p.getY(i), p.getZ(i), c, n.getY(i));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

/**
 * Coarse distance-to-centreline field over the terrain bounds (bilinear sampled). Much cheaper
 * than terrain.nearestTrack for per-vertex recolouring; accurate to a few metres.
 */
export function distanceField(track: BuiltTrack, bounds: Terrain['bounds'], cell = 16): (x: number, z: number) => number {
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1, nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
  const d = new Float32Array(nx * nz);
  const step = Math.max(1, Math.round(4 / track.spacing));
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.minX + i * cell, z = bounds.minZ + j * cell;
      let best = Infinity;
      for (let k = 0; k < track.n; k += step) {
        const dx = x - track.px[k]!, dz = z - track.pz[k]!;
        const q = dx * dx + dz * dz;
        if (q < best) best = q;
      }
      d[j * nx + i] = Math.sqrt(best);
    }
  }
  return (x: number, z: number) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - bounds.minX) / cell)), fz = Math.min(nz - 1.001, Math.max(0, (z - bounds.minZ) / cell));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = d[j * nx + i]!, b = d[j * nx + i + 1]!, c = d[(j + 1) * nx + i]!, e = d[(j + 1) * nx + i + 1]!;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
  };
}

/** Value-noise fbm re-export for themes (terrain-independent). */
export function noise2(x: number, z: number, seed: number, oct = 3): number { return fbm1(x, z, seed, oct); }
