/**
 * Shared materials, canvas textures and geometry helpers for karts, drivers,
 * items and the showroom.
 *
 * Draw-call strategy: every static part of a model is baked into ONE
 * non-indexed geometry per material with per-vertex colour (`color`),
 * per-vertex roughness/metalness (`rm`, read by a patched MeshStandardMaterial)
 * and UVs into a per-character decal atlas (plain parts sample its white area).
 * Geometries are cached with reference counts so that N karts of the same
 * character share GPU buffers and the last dispose() frees them.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ───────────────────────────── colour helpers ─────────────────────────────

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/** Linear-space colour from any representation (hex strings are treated as sRGB). */
export function col(c: THREE.ColorRepresentation): THREE.Color {
  return new THREE.Color(c);
}

/** Mix two colours in sRGB space (perceptually nicer for paint tints). Returns a CSS hex string. */
export function mixHex(a: THREE.ColorRepresentation, b: THREE.ColorRepresentation, t: number): string {
  _c1.set(a); _c2.set(b);
  _c1.lerp(_c2, t);
  return `#${_c1.getHexString()}`;
}

/** Lighten (t>0) toward white or darken (t<0) toward black. */
export function shade(a: THREE.ColorRepresentation, t: number): string {
  return t >= 0 ? mixHex(a, '#ffffff', t) : mixHex(a, '#000000', -t);
}

/** Relative luminance 0..1 of a CSS colour (sRGB). */
export function luminance(a: THREE.ColorRepresentation): number {
  _c1.set(a);
  return 0.2126 * _c1.r + 0.7152 * _c1.g + 0.0722 * _c1.b;
}

// ───────────────────────────── decal atlas layout ─────────────────────────────

/** Atlas is ATLAS_SIZE² px. Rects are canvas pixel rects (x, y from the top-left, w, h). */
export const ATLAS_SIZE = 512;
export interface AtlasRect { x: number; y: number; w: number; h: number }
export const ATLAS = {
  plate: { x: 0, y: 0, w: 256, h: 256 } as AtlasRect,
  roundel: { x: 256, y: 0, w: 256, h: 256 } as AtlasRect,
  stripe: { x: 0, y: 256, w: 512, h: 128 } as AtlasRect,
  white: { x: 0, y: 384, w: 512, h: 128 } as AtlasRect,
};

/** UV of a point (u, v in 0..1, v up) inside an atlas rect (texture flipY = true). */
export function atlasUV(r: AtlasRect, u: number, v: number): [number, number] {
  const px = r.x + u * r.w;
  const py = r.y + (1 - v) * r.h;
  return [px / ATLAS_SIZE, 1 - py / ATLAS_SIZE];
}

export const WHITE_UV = atlasUV(ATLAS.white, 0.5, 0.5);

// ───────────────────────────── geometry helpers ─────────────────────────────

export interface PaintOpts {
  /** Roughness 0..1 (default 0.5). */
  rough?: number;
  /** Metalness 0..1 (default 0). */
  metal?: number;
  /** Map the geometry's own 0..1 UVs into this atlas rect. */
  rect?: AtlasRect;
  /** Force a constant UV (default: white area). */
  uv?: [number, number];
  /** Per-vertex colour override from the geometry's own UV (evaluated before UVs are rewritten). */
  colorFn?: (u: number, v: number, x: number, y: number, z: number) => THREE.ColorRepresentation | null;
}

/**
 * Normalise a geometry for merging: non-indexed, attributes position/normal/uv/color/rm.
 * The input geometry is consumed (disposed if a copy had to be made).
 */
export function paint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: PaintOpts = {}): THREE.BufferGeometry {
  let g = geo;
  if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  g.morphAttributes = {};
  const n = g.attributes.position!.count;
  const c = new THREE.Color(color);
  const cols = new Float32Array(n * 3);
  const rm = new Float32Array(n * 2);
  const rough = o.rough ?? 0.5, metal = o.metal ?? 0;
  const srcUV = g.attributes.uv as THREE.BufferAttribute | undefined;
  const posA = g.attributes.position as THREE.BufferAttribute;
  const alt = new THREE.Color();
  for (let i = 0; i < n; i++) {
    let cc = c;
    if (o.colorFn && srcUV) {
      const r = o.colorFn(srcUV.getX(i), srcUV.getY(i), posA.getX(i), posA.getY(i), posA.getZ(i));
      if (r !== null) cc = alt.set(r);
    }
    cols[i * 3] = cc.r; cols[i * 3 + 1] = cc.g; cols[i * 3 + 2] = cc.b;
    rm[i * 2] = rough; rm[i * 2 + 1] = metal;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  const uvs = new Float32Array(n * 2);
  const src = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (o.rect && src) {
    for (let i = 0; i < n; i++) {
      const [u, v] = atlasUV(o.rect, THREE.MathUtils.clamp(src.getX(i), 0, 1), THREE.MathUtils.clamp(src.getY(i), 0, 1));
      uvs[i * 2] = u; uvs[i * 2 + 1] = v;
    }
  } else {
    const [u, v] = o.uv ?? WHITE_UV;
    for (let i = 0; i < n; i++) { uvs[i * 2] = u; uvs[i * 2 + 1] = v; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return g;
}

/** Merge painted parts into one geometry (parts are disposed). */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('mergeGeometries failed (attribute mismatch)');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Scale → rotate (Euler XYZ, radians) → translate a geometry in place. */
export function xf(
  g: THREE.BufferGeometry, x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx,
): THREE.BufferGeometry {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _m4.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  g.applyMatrix4(_m4);
  return g;
}

/** Orient a geometry so its +Z axis points along `dir`, then translate to `pos`. `twist` rotates about the axis first. */
export function orient(g: THREE.BufferGeometry, pos: THREE.Vector3, dir: THREE.Vector3, twist = 0): THREE.BufferGeometry {
  if (twist) g.rotateZ(twist);
  _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  _m4.compose(pos, _q, _s.set(1, 1, 1));
  g.applyMatrix4(_m4);
  return g;
}

/** Fake ambient occlusion: darken vertex colours toward the bottom (y0 → factor `min`, y1 → 1). */
export function shadeByHeight(g: THREE.BufferGeometry, y0: number, y1: number, min: number): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colA = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.smoothstep(pos.getY(i), y0, y1);
    const f = min + (1 - min) * t;
    colA.setXYZ(i, colA.getX(i) * f, colA.getY(i) * f, colA.getZ(i) * f);
  }
  colA.needsUpdate = true;
}

/** Recolour vertices of a painted geometry with a function of position. */
export function recolor(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, out: THREE.Color) => boolean): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colA = g.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.setRGB(colA.getX(i), colA.getY(i), colA.getZ(i));
    if (fn(pos.getX(i), pos.getY(i), pos.getZ(i), c)) colA.setXYZ(i, c.r, c.g, c.b);
  }
  colA.needsUpdate = true;
}

/**
 * Surface of revolution around the Y axis from a (radius, y) profile with an optional
 * radial displacement fn(phi, profileIndex) → extra radius. Indexed; normals recomputed.
 */
export function revolve(
  profile: ReadonlyArray<[number, number]>, segments: number,
  displace?: (phi: number, j: number, r: number, y: number) => number,
  phiStart = 0, phiLength = Math.PI * 2,
): THREE.BufferGeometry {
  const np = profile.length;
  const full = phiLength >= Math.PI * 2 - 1e-6;
  const pos = new Float32Array((segments + 1) * np * 3);
  const uv = new Float32Array((segments + 1) * np * 2);
  for (let i = 0; i <= segments; i++) {
    const phi = phiStart + (i / segments) * phiLength;
    const s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < np; j++) {
      const [r0, y] = profile[j]!;
      const r = r0 + (displace ? displace(full && i === segments ? phiStart : phi, j, r0, y) : 0);
      const k = (i * np + j) * 3;
      pos[k] = r * s; pos[k + 1] = y; pos[k + 2] = r * c;
      uv[(i * np + j) * 2] = i / segments; uv[(i * np + j) * 2 + 1] = j / (np - 1);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < np - 1; j++) {
      const a = i * np + j, b = (i + 1) * np + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals (first and last ring share positions)
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  for (let j = 0; full && j < np; j++) {
    const a = j, b = segments * np + j;
    const x = nrm.getX(a) + nrm.getX(b), y = nrm.getY(a) + nrm.getY(b), z = nrm.getZ(a) + nrm.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l); nrm.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Tube along a Catmull-Rom path (capped with spheres at both ends). */
export function tube(points: THREE.Vector3[], radius: number, tubular = 16, radial = 8, caps = true): THREE.BufferGeometry[] {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const out: THREE.BufferGeometry[] = [new THREE.TubeGeometry(curve, tubular, radius, radial, false)];
  if (caps) {
    for (const p of [points[0]!, points[points.length - 1]!]) {
      out.push(new THREE.SphereGeometry(radius, radial, Math.max(4, radial >> 1)).translate(p.x, p.y, p.z));
    }
  }
  return out;
}

/**
 * Swept tube with a radius profile r(t), t ∈ [0,1] along a Catmull-Rom path. UV.y = t so
 * `paint(..., { colorFn })` can band it (tail rings, tips). Ends are closed with fans.
 */
export function taperTube(
  points: THREE.Vector3[], radius: (t: number) => number, tubular = 20, radial = 10,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const frames = curve.computeFrenetFrames(tubular, false);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    const N = frames.normals[i]!, B = frames.binormals[i]!;
    const r = Math.max(0.0005, radius(t));
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cx = -Math.cos(v), sx = Math.sin(v); // same handedness as THREE.TubeGeometry
      pos.push(P.x + r * (cx * N.x + sx * B.x), P.y + r * (cx * N.y + sx * B.y), P.z + r * (cx * N.z + sx * B.z));
      uv.push(j / radial, t);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = (i + 1) * row + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // end fans
  for (const [ring, tv, flip] of [[0, 0, true], [tubular, 1, false]] as Array<[number, number, boolean]>) {
    curve.getPointAt(tv, P);
    const c = pos.length / 3;
    pos.push(P.x, P.y, P.z); uv.push(0.5, tv);
    for (let j = 0; j < radial; j++) {
      const a = ring * row + j, b = ring * row + j + 1;
      if (flip) idx.push(c, b, a); else idx.push(c, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Ellipsoid point + outward normal for (azimuth around Y from +Z toward +X, elevation) angles. */
export function ellipsoidPoint(
  cx: number, cy: number, cz: number, rx: number, ry: number, rz: number,
  az: number, el: number, lift = 0,
): { p: THREE.Vector3; n: THREE.Vector3 } {
  const ce = Math.cos(el), se = Math.sin(el);
  const sa = Math.sin(az), ca = Math.cos(az);
  const ux = ce * sa, uy = se, uz = ce * ca;
  const n = new THREE.Vector3(ux / rx, uy / ry, uz / rz).normalize();
  const p = new THREE.Vector3(cx + rx * ux, cy + ry * uy, cz + rz * uz).addScaledVector(n, lift);
  return { p, n };
}

// ───────────────────────────── ref-counted cache ─────────────────────────────

export class RefCache<T> {
  private readonly map = new Map<string, { value: T; refs: number }>();
  constructor(private readonly destroy: (v: T) => void) {}
  acquire(key: string, create: () => T): T {
    let e = this.map.get(key);
    if (!e) { e = { value: create(), refs: 0 }; this.map.set(key, e); }
    e.refs++;
    return e.value;
  }
  release(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    e.refs--;
    if (e.refs <= 0) { this.destroy(e.value); this.map.delete(key); }
  }
  clear(): void {
    for (const e of this.map.values()) this.destroy(e.value);
    this.map.clear();
  }
}

export function disposeGeometryMap(m: Record<string, THREE.BufferGeometry | null | undefined>): void {
  for (const g of Object.values(m)) g?.dispose();
}

// ───────────────────────────── canvas helpers ─────────────────────────────

export function makeCanvas(w: number, h = w): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

export function canvasTexture(canvas: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ───────────────────────────── shared textures (lazy singletons) ─────────────────────────────

const shared = new Map<string, THREE.Texture>();
function sharedTex(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = shared.get(key);
  if (!t) { t = make(); shared.set(key, t); }
  return t;
}

/**
 * Studio-style equirect environment for glossy toy paint & chrome. Assigned as
 * material.envMap; three.js converts it to a PMREM on first use.
 */
export function getKartEnvMap(): THREE.Texture {
  return sharedTex('env', () => {
    const W = 512, H = 256;
    const { canvas, ctx } = makeCanvas(W, H);
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.5);
    sky.addColorStop(0, '#ffffff');
    sky.addColorStop(0.35, '#cfe6ff');
    sky.addColorStop(1, '#8fc4f5');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.5);
    const gnd = ctx.createLinearGradient(0, H * 0.5, 0, H);
    gnd.addColorStop(0, '#d9d2c0');
    gnd.addColorStop(0.15, '#8f9180');
    gnd.addColorStop(1, '#3f423c');
    ctx.fillStyle = gnd; ctx.fillRect(0, H * 0.5, W, H * 0.5);
    // horizon glow
    const hz = ctx.createLinearGradient(0, H * 0.42, 0, H * 0.56);
    hz.addColorStop(0, 'rgba(255,248,230,0)');
    hz.addColorStop(0.5, 'rgba(255,248,230,0.95)');
    hz.addColorStop(1, 'rgba(255,248,230,0)');
    ctx.fillStyle = hz; ctx.fillRect(0, H * 0.42, W, H * 0.14);
    // soft boxes (key overhead + two strip lights) → crisp toy highlights
    ctx.fillStyle = '#ffffff';
    ctx.filter = 'blur(3px)';
    roundRect(ctx, W * 0.36, H * 0.05, W * 0.28, H * 0.12, 10); ctx.fill();
    roundRect(ctx, W * 0.08, H * 0.2, W * 0.05, H * 0.2, 6); ctx.fill();
    roundRect(ctx, W * 0.87, H * 0.2, W * 0.05, H * 0.2, 6); ctx.fill();
    ctx.fillStyle = '#ffeccc';
    roundRect(ctx, W * 0.6, H * 0.26, W * 0.12, H * 0.08, 6); ctx.fill();
    ctx.filter = 'none';
    const t = canvasTexture(canvas);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.anisotropy = 1;
    return t;
  });
}

/** Soft radial blob for contact shadows (alpha in the texture). */
export function getShadowTexture(): THREE.Texture {
  return sharedTex('shadow', () => {
    const { canvas, ctx } = makeCanvas(128);
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    return canvasTexture(canvas);
  });
}

/** White star-burst spark with a soft core. */
export function getSparkTexture(): THREE.Texture {
  return sharedTex('spark', () => {
    const S = 128, h = S / 2;
    const { canvas, ctx } = makeCanvas(S);
    // halo falls to zero well inside the quad: a long faint tail read as a square haze once
    // additive blending + bloom stacked several large sprites
    const g = ctx.createRadialGradient(h, h, 0, h, h, h * 0.92);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.2)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.04)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.translate(h, h);
      ctx.rotate((i * Math.PI) / 4);
      const len = i % 2 === 0 ? h * 0.98 : h * 0.6;
      const lg = ctx.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(-len, 0); ctx.lineTo(0, -3.2); ctx.lineTo(len, 0); ctx.lineTo(0, 3.2); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    return canvasTexture(canvas);
  });
}

/** Soft round glow. */
export function getGlowTexture(): THREE.Texture {
  return sharedTex('glow', () => {
    const S = 64, h = S / 2;
    const { canvas, ctx } = makeCanvas(S);
    const g = ctx.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return canvasTexture(canvas);
  });
}

/** Puffy smoke disc (white; tinted by vertex colour). */
export function getSmokeTexture(): THREE.Texture {
  return sharedTex('smoke', () => {
    const S = 128;
    const { canvas, ctx } = makeCanvas(S);
    const blobs: Array<[number, number, number]> = [[64, 64, 40], [44, 56, 26], [84, 58, 28], [60, 84, 26], [78, 80, 22], [52, 40, 20]];
    for (const [x, y, r] of blobs) {
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    return canvasTexture(canvas);
  });
}

/** Flame gradient for cone meshes: v = 0 at the nozzle (hot) → v = 1 at the tip (transparent). */
export function getFlameTexture(): THREE.Texture {
  return sharedTex('flame', () => {
    const W = 64, H = 128;
    const { canvas, ctx } = makeCanvas(W, H);
    const g = ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // tongues
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const x = (i + 0.5) * (W / 7);
      const lg = ctx.createLinearGradient(0, H * 0.7, 0, 0);
      lg.addColorStop(0, 'rgba(0,0,0,0)');
      lg.addColorStop(1, 'rgba(0,0,0,0.65)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.ellipse(x, H * 0.18, 3.2, H * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const t = canvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ───────────────────────────── materials ─────────────────────────────

/** Global multiplier for the env reflections on kart/item paint (night themes may lower it). */
let envIntensity = 0.55;
const liveEnvMaterials = new Set<THREE.MeshStandardMaterial>();

export function setKartEnvIntensity(v: number): void {
  envIntensity = v;
  for (const m of liveEnvMaterials) m.envMapIntensity = (m.userData.envScale as number ?? 1) * v;
}

/** Register a standard material to receive the studio env map (and follow setKartEnvIntensity). */
export function useKartEnv(m: THREE.MeshStandardMaterial, scale = 1): void {
  m.envMap = getKartEnvMap();
  m.userData.envScale = scale;
  m.envMapIntensity = scale * envIntensity;
  liveEnvMaterials.add(m);
  m.addEventListener('dispose', () => liveEnvMaterials.delete(m));
}

/** Per-material uniforms of the paint shader: star rainbow amount (0..1) and its clock, and the near-camera
 *  screen-door fade (view depth in m: x = fully gone, y = fully drawn; y = 0 disables it). */
export interface PaintUniforms { uStar: { value: number }; uStarTime: { value: number }; uNearFade: { value: THREE.Vector2 } }

/** 4×4 ordered dither (0..15/16) + the near-fade discard, shared by the paint and unlit kart shaders. */
const NEAR_FADE_PARS = /* glsl */ `
uniform vec2 uNearFade;
float tpBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float tpBayer4(vec2 a) { return tpBayer2(0.5 * a) * 0.25 + tpBayer2(a); }`;
// compiled only into materials that opted in (setNearFadeEnabled): item / showroom paint keeps a discard-free program
const nearFadeTest = (depth: string) => /* glsl */ `
  #ifdef TP_NEAR_FADE
  if (uNearFade.y > 0.0) {
    float tpFade = clamp((${depth} - uNearFade.x) / (uNearFade.y - uNearFade.x), 0.0, 1.0);
    if (tpFade < 1.0 && tpFade <= tpBayer4(gl_FragCoord.xy) + 0.03) discard;
  }
  #endif`;

/** Compile (or drop) the near-camera fade test into a paint / attachNearFade material. */
export function setNearFadeEnabled(m: THREE.Material, on: boolean): void {
  const d = ((m as THREE.ShaderMaterial).defines ??= {}) as Record<string, string>;
  if (on === ('TP_NEAR_FADE' in d)) return;
  if (on) d.TP_NEAR_FADE = ''; else delete d.TP_NEAR_FADE;
  m.needsUpdate = true;
}

function patchRM(m: THREE.MeshStandardMaterial, u: PaintUniforms = { uStar: { value: 0 }, uStarTime: { value: 0 }, uNearFade: { value: new THREE.Vector2() } }): void {
  m.userData.paint = u;
  m.onBeforeCompile = shader => {
    shader.uniforms.uStar = u.uStar;
    shader.uniforms.uStarTime = u.uStarTime;
    shader.uniforms.uNearFade = u.uNearFade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 rm;\nvarying vec2 vRM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = rm;');
    // rm.x < 0 marks UNLIT vertices (markUnlit: cartoon eyes merged into the paint draw at the lower tiers):
    // they output their vertex colour exactly like createUnlitMaterial() and skip the star tint.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vRM;\nuniform float uStar;\nuniform float uStarTime;${NEAR_FADE_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${nearFadeTest('vViewPosition.z')}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * abs(vRM.x);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vRM.y;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uStar > 0.0 && vRM.x >= 0.0) {
          float fr = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
          float hue = fract(uStarTime * 1.4 + vViewPosition.y * 0.55 + vViewPosition.x * 0.35 + fr * 0.4);
          vec3 rb = clamp(abs(fract(hue + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5 + rb * 0.5, uStar);
          totalEmissiveRadiance += rb * uStar * (0.28 + 0.9 * fr * fr);
        }`)
      .replace('#include <opaque_fragment>', 'if (vRM.x < 0.0) outgoingLight = diffuseColor.rgb;\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'tp-rm-v4';
}

/**
 * Mark a painted geometry UNLIT for the paint shader (negative `rm.x`): it then renders like
 * createUnlitMaterial() — vertex colour only, no lighting, shadows or star tint — so it can share the
 * kart's paint draw (rigid-merge) instead of needing a draw of its own.
 */
export function markUnlit(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const rm = g.attributes.rm as THREE.BufferAttribute | undefined;
  if (!rm) return g;
  for (let i = 0; i < rm.count; i++) rm.setX(i, -Math.max(1e-3, Math.abs(rm.getX(i))));
  rm.needsUpdate = true;
  return g;
}

/**
 * Give an unlit kart material (eyes, antenna lamp) the same near-camera fade as the kart's paint, driven
 * by the paint's `uNearFade` uniform (otherwise the eyes would stay floating in front of a faded kart).
 */
export function attachNearFade(m: THREE.MeshBasicMaterial, nearFade: { value: THREE.Vector2 }): void {
  m.onBeforeCompile = shader => {
    shader.uniforms.uNearFade = nearFade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTpDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTpDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vTpDepth;${NEAR_FADE_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${nearFadeTest('vTpDepth')}`);
  };
  m.customProgramCacheKey = () => 'tp-nf-basic-v1';
  m.needsUpdate = true;
}

export function paintUniforms(m: THREE.Material): PaintUniforms | null {
  return (m.userData.paint as PaintUniforms | undefined) ?? null;
}

/**
 * The workhorse material: vertex colours × optional atlas map, per-vertex roughness/metalness
 * (`rm` attribute) and the studio env map. One instance per kart (so star/ghost effects can
 * tint it); shaders are shared between instances.
 */
export function createPaintMaterial(map: THREE.Texture | null = null, envScale = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, map });
  patchRM(m);
  useKartEnv(m, envScale);
  return m;
}

/**
 * Twin of a paint material for the InstancedMesh parts of the same kart (wheels, drone rotors).
 * three.js keeps one program per material, so one material shared by instanced and plain meshes
 * re-resolves its program (getParameters + cache key, ~KBs of garbage) at every switch — twice per
 * kart per frame. The twin shares the star uniforms and the env-map registration; keep its
 * transparency/opacity in step with the source (ghost mode).
 */
export function createPaintTwin(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, map: src.map });
  patchRM(m, paintUniforms(src) ?? undefined);
  useKartEnv(m, (src.userData.envScale as number | undefined) ?? 1);
  return m;
}

/** Unlit vertex-coloured material for cartoon eyes and glowing lamps. */
export function createUnlitMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ vertexColors: true });
}

/** Additive textured material (flames, glows, blur discs). */
export function createAdditiveMaterial(map: THREE.Texture, color: THREE.ColorRepresentation = '#ffffff', opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, vertexColors: true, fog: false,
    // additive + no depth writes is order-independent: one pass equals three's back-then-front pair
    forceSinglePass: true,
  });
}

/**
 * PointsMaterial with a per-vertex size multiplier (`psize` attribute) and RGBA vertex colours.
 * Used for kart-attached sparks, sparkles and smoke puffs.
 */
export function createFxPointsMaterial(map: THREE.Texture, additive: boolean): THREE.PointsMaterial {
  const m = new THREE.PointsMaterial({
    size: 1, sizeAttenuation: true, map, vertexColors: true, transparent: true,
    depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !additive,
  });
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float psize;')
      .replace('gl_PointSize = size;', 'gl_PointSize = size * psize;')
      // A point sprite is a camera-facing quad at ONE depth: a glow hovering 0.2 m over the road
      // had its lower half cut off by the ground in front of it (a hard horizontal edge). Pull the
      // sprite plane toward the camera by about its radius (size stays computed from the true depth).
      .replace('#include <worldpos_vertex>', `{
          float tpDepth = max(-mvPosition.z, 0.05);
          float tpPull = min(size * psize * 0.4, tpDepth * 0.4);
          gl_Position = projectionMatrix * vec4(mvPosition.xy, mvPosition.z + tpPull, 1.0);
        }
        #include <worldpos_vertex>`);
  };
  m.customProgramCacheKey = () => 'tp-psize-v2';
  return m;
}

/** Free every shared texture (call only when no kart/item visuals remain). */
export function disposeSharedKartTextures(): void {
  for (const t of shared.values()) t.dispose();
  shared.clear();
}

// ───────────────────────────── per-character decal atlas ─────────────────────────────

export const INK = '#1b1036';

type EmblemFn = (ctx: CanvasRenderingContext2D, fill: string, alt: string) => void;

/** Emblems drawn in a 100×100 design box centred on (50, 50). */
const EMBLEMS: Record<string, EmblemFn> = {
  penguin: (ctx, fill) => { // snowflake
    ctx.strokeStyle = fill; ctx.lineCap = 'round'; ctx.lineWidth = 9;
    for (let i = 0; i < 6; i++) {
      ctx.save(); ctx.translate(50, 50); ctx.rotate((i * Math.PI) / 3);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -36);
      ctx.moveTo(0, -20); ctx.lineTo(-11, -30); ctx.moveTo(0, -20); ctx.lineTo(11, -30);
      ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(50, 50, 9, 0, Math.PI * 2); ctx.fill();
  },
  bear: (ctx, fill) => { // paw
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(50, 62, 22, 18, 0, 0, Math.PI * 2); ctx.fill();
    for (const [x, y, r] of [[24, 40, 9], [40, 26, 10], [60, 26, 10], [76, 40, 9]] as const) {
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 1.2, 0, 0, Math.PI * 2); ctx.fill();
    }
  },
  rabbit: (ctx, fill, alt) => { // carrot
    ctx.fillStyle = '#2fbf5a';
    for (const a of [-0.5, 0, 0.5]) {
      ctx.save(); ctx.translate(56, 30); ctx.rotate(a + 0.6);
      ctx.beginPath(); ctx.ellipse(0, -12, 6, 14, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.fillStyle = fill;
    ctx.save(); ctx.translate(50, 55); ctx.rotate(0.6);
    ctx.beginPath(); ctx.moveTo(-15, -26); ctx.quadraticCurveTo(0, -34, 15, -26); ctx.lineTo(2, 34); ctx.quadraticCurveTo(0, 38, -2, 34); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = alt; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const y of [-12, 0, 12]) { ctx.beginPath(); ctx.moveTo(-8 + y * 0.2, y); ctx.lineTo(0, y); ctx.stroke(); }
    ctx.restore();
  },
  dino: (ctx, fill) => { // footprint
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(50, 64, 20, 22, 0, 0, Math.PI * 2); ctx.fill();
    for (const [a, len] of [[-0.62, 30], [0, 34], [0.62, 30]] as const) {
      ctx.save(); ctx.translate(50, 56); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(0, -len - 12); ctx.lineTo(9, 0); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  },
  fox: (ctx, fill, alt) => { // flame
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(50, 12); ctx.bezierCurveTo(62, 30, 80, 40, 76, 62); ctx.bezierCurveTo(73, 80, 60, 88, 50, 88);
    ctx.bezierCurveTo(36, 88, 24, 78, 24, 62); ctx.bezierCurveTo(24, 48, 34, 44, 36, 32);
    ctx.bezierCurveTo(44, 40, 44, 46, 46, 50); ctx.bezierCurveTo(52, 38, 54, 26, 50, 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = alt;
    ctx.beginPath(); ctx.moveTo(50, 50); ctx.bezierCurveTo(58, 60, 64, 66, 60, 76); ctx.bezierCurveTo(56, 84, 44, 84, 40, 76); ctx.bezierCurveTo(37, 68, 46, 62, 50, 50); ctx.fill();
  },
  raccoon: (ctx, fill) => { // four-leaf clover
    ctx.fillStyle = fill;
    for (let i = 0; i < 4; i++) {
      ctx.save(); ctx.translate(50, 46); ctx.rotate((i * Math.PI) / 2 + Math.PI / 4);
      ctx.beginPath(); ctx.arc(-8, -14, 12, 0, Math.PI * 2); ctx.arc(8, -14, 12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-18, -12); ctx.lineTo(0, 2); ctx.lineTo(18, -12); ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = fill; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(50, 50); ctx.quadraticCurveTo(54, 74, 66, 88); ctx.stroke();
  },
  cat: (ctx, fill, alt) => { // fish
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(44, 50, 30, 20, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(66, 50); ctx.lineTo(90, 30); ctx.lineTo(84, 50); ctx.lineTo(90, 70); ctx.closePath(); ctx.fill();
    ctx.fillStyle = alt; ctx.beginPath(); ctx.arc(30, 45, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = alt; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(46, 50, 12, -1, 1); ctx.stroke();
  },
  robot: (ctx, fill) => { // lightning bolt
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.moveTo(58, 8); ctx.lineTo(24, 56); ctx.lineTo(46, 56); ctx.lineTo(38, 92); ctx.lineTo(76, 40); ctx.lineTo(54, 40); ctx.lineTo(64, 8); ctx.closePath(); ctx.fill();
  },
};

export interface AtlasInfo {
  species: string; number: number;
  body: string; accent: string; fur: string; detail: string;
}

/** Draw an emblem (with ink outline) centred at (cx, cy) with the given box size. */
export function drawEmblem(ctx: CanvasRenderingContext2D, species: string, cx: number, cy: number, size: number, fill: string, alt: string): void {
  const fn = EMBLEMS[species] ?? EMBLEMS.robot!;
  // ink outline: draw dilated dark copy first
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 100, size / 100);
  ctx.save();
  ctx.shadowColor = INK; ctx.shadowBlur = 0;
  for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2.2, -2.2], [2.2, 2.2], [-2.2, 2.2], [2.2, -2.2]] as const) {
    ctx.save(); ctx.translate(dx, dy); fn(ctx, INK, INK); ctx.restore();
  }
  ctx.restore();
  fn(ctx, fill, alt);
  ctx.restore();
}

function contrastInk(bg: string): string {
  return luminance(bg) > 0.45 ? INK : '#ffffff';
}

const atlasCache = new RefCache<THREE.Texture>(t => t.dispose());

/** Build the decal atlas for a character (plate emblem, number roundel, body stripe, white area). */
function buildAtlas(a: AtlasInfo): THREE.Texture {
  const { canvas, ctx } = makeCanvas(ATLAS_SIZE);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  const emblemFill = luminance(a.body) > 0.8 ? a.detail : a.body;
  const emblemAlt = luminance(a.accent) > 0.85 ? a.detail : a.accent;

  // plate (rounded square badge)
  {
    const r = ATLAS.plate;
    ctx.save(); ctx.translate(r.x, r.y);
    ctx.fillStyle = INK; roundRect(ctx, 6, 6, 244, 244, 52); ctx.fill();
    ctx.fillStyle = emblemAlt; roundRect(ctx, 14, 14, 228, 228, 46); ctx.fill();
    ctx.fillStyle = '#fffdf6'; roundRect(ctx, 32, 32, 192, 192, 34); ctx.fill();
    drawEmblem(ctx, a.species, 128, 128, 150, emblemFill, emblemAlt);
    // gloss
    const gl = ctx.createLinearGradient(0, 32, 0, 140);
    gl.addColorStop(0, 'rgba(255,255,255,0.55)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl; roundRect(ctx, 40, 38, 176, 70, 26); ctx.fill();
    ctx.restore();
  }
  // roundel (number)
  {
    const r = ATLAS.roundel;
    ctx.save(); ctx.translate(r.x + 128, r.y + 128);
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(0, 0, 124, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = emblemAlt; ctx.beginPath(); ctx.arc(0, 0, 116, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, 0, 92, 0, Math.PI * 2); ctx.fill();
    ctx.font = '900 150px "Black Han Sans", "Arial Black", "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 14; ctx.strokeStyle = INK;
    ctx.strokeText(String(a.number), 0, 8);
    ctx.fillStyle = emblemFill; ctx.fillText(String(a.number), 0, 8);
    ctx.restore();
  }
  // stripe strip: body colour with a centred accent racing stripe + pinstripes
  {
    const r = ATLAS.stripe;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = a.body; ctx.fillRect(r.x, r.y, r.w, r.h);
    const stripe = luminance(a.accent) > 0.9 && luminance(a.body) > 0.5 ? a.detail : a.accent;
    const pin = contrastInk(stripe) === INK ? '#ffffff' : '#ffffff';
    const cx = r.x + r.w / 2;
    ctx.fillStyle = pin; ctx.fillRect(cx - r.w * 0.16, r.y, r.w * 0.32, r.h);
    ctx.fillStyle = stripe; ctx.fillRect(cx - r.w * 0.135, r.y, r.w * 0.27, r.h);
    ctx.fillStyle = pin; ctx.fillRect(cx - r.w * 0.012, r.y, r.w * 0.024, r.h);
  }
  const t = canvasTexture(canvas);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function acquireCharacterAtlas(key: string, info: AtlasInfo): THREE.Texture {
  return atlasCache.acquire(key, () => buildAtlas(info));
}
export function releaseCharacterAtlas(key: string): void {
  atlasCache.release(key);
}
