/**
 * Per-instance culling for widely scattered static InstancedMeshes (trees, bushes, flowers, grass,
 * rocks, tyre walls…), in both render passes.
 *
 * three.js culls an InstancedMesh as a whole, by the bounding sphere of ALL its instances. A prop
 * scattered along the whole circuit therefore always passes: every instance is vertex-processed
 * in the main pass even when it is behind the camera, and in the shadow pass even when it is far
 * outside the sun's ±70 m shadow box.
 *
 *  - Main pass: `prepareView(camera)` (called by the pipeline right before each view is rendered)
 *    writes only the instances whose bounding sphere intersects the view frustum into the mesh's
 *    own instance buffers (a full copy is kept here) and sets `count`.
 *  - Shadow pass: shadow casters get a hidden twin (same geometry/material, castShadow) and the
 *    source stops casting. `prepareShadow(light)` (called by the pipeline's shadow-map hook, after
 *    three.js has built the main render list) fills the twin with the instances inside the light's
 *    shadow frustum and shows it; `restore()` hides it again, so the main pass never draws it.
 *
 * Both are exact: instances outside a frustum contribute no pixels. Upload happens only when the
 * kept set changes. No per-frame allocation. Meshes whose owner rewrites the instance buffer
 * (dynamic usage, or a version change we did not make) are left alone / released.
 */
import * as THREE from 'three';
import { instancedDepthMaterial } from './scene-optimize.js';

interface Item {
  mesh: THREE.InstancedMesh;
  n: number;
  mats: Float32Array;
  cols: Float32Array | null;
  /** World-space bounding spheres per instance: x, y, z, r. */
  spheres: Float32Array;
  world: THREE.Matrix4;
  /** instanceMatrix / instanceColor versions and count after our last write (anything else = the owner changed them). */
  version: number;
  colVersion: number;
  count: number;
  viewKept: Int32Array; viewN: number;
  /** Instances grouped into CELL×CELL (XZ) buckets: `order` lists instance indices cell by cell,
   *  `cellStart[c]..cellStart[c+1]` is cell c, `cellSph` its bounding sphere (x, y, z, r). */
  order: Int32Array; cellStart: Int32Array; cellSph: Float32Array;
  proxy: THREE.InstancedMesh | null;
  shadowKept: Int32Array; shadowN: number;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _planes = new Float64Array(24);
const CELL = 64;

function loadPlanes(f: THREE.Frustum): void {
  for (let p = 0; p < 6; p++) {
    const pl = f.planes[p]!;
    _planes[p * 4] = pl.normal.x; _planes[p * 4 + 1] = pl.normal.y; _planes[p * 4 + 2] = pl.normal.z; _planes[p * 4 + 3] = pl.constant;
  }
}

/** Sphere vs the planes loaded by loadPlanes() (same test as Frustum.intersectsSphere). */
function sphereIn(x: number, y: number, z: number, r: number): boolean {
  const P = _planes;
  for (let o = 0; o < 24; o += 4) if (P[o]! * x + P[o + 1]! * y + P[o + 2]! * z + P[o + 3]! < -r) return false;
  return true;
}
const _pm = new THREE.Matrix4();
const registry = new WeakMap<THREE.Object3D, InstanceCulling>();
let depthMat: THREE.MeshDepthMaterial | null = null;

export interface InstanceCullingOptions {
  /** Only meshes whose instances spread wider than this radius (m). */
  minSpread?: number;
  /** Only meshes with at least this many instances. */
  minInstances?: number;
}

/** Write kept instances [from, k) (indices in `keptIdx`) from the full copies into the target's buffers. */
function compact(keptIdx: Int32Array, from: number, k: number, mats: Float32Array, cols: Float32Array | null, target: THREE.InstancedMesh): void {
  if (k <= from) return; // nothing new to upload (a shrink only changes `count`)
  const dst = target.instanceMatrix.array as Float32Array;
  for (let j = from; j < k; j++) {
    const so = keptIdx[j]! * 16, d = j * 16;
    for (let e = 0; e < 16; e++) dst[d + e] = mats[so + e]!;
  }
  const im = target.instanceMatrix;
  im.clearUpdateRanges();
  im.addUpdateRange(from * 16, (k - from) * 16);
  im.needsUpdate = true;
  if (cols && target.instanceColor) {
    const dc = target.instanceColor.array as Float32Array;
    for (let j = from; j < k; j++) {
      const i = keptIdx[j]! * 3, d = j * 3;
      dc[d] = cols[i]!; dc[d + 1] = cols[i + 1]!; dc[d + 2] = cols[i + 2]!;
    }
    const ic = target.instanceColor;
    ic.clearUpdateRanges();
    ic.addUpdateRange(from * 3, (k - from) * 3);
    ic.needsUpdate = true;
  }
}

export class InstanceCulling {
  private readonly items: Item[] = [];
  private shadowActive = false;

  constructor(root: THREE.Object3D, opts: InstanceCullingOptions = {}) {
    const minSpread = opts.minSpread ?? 60;
    const minInstances = opts.minInstances ?? 6;
    const found: THREE.InstancedMesh[] = [];
    root.traverse(o => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || !im.frustumCulled || !im.parent || Array.isArray(im.material)) return;
      if (im.count < minInstances || im.morphTexture !== null) return;
      if (im.instanceMatrix.usage !== THREE.StaticDrawUsage) return;
      if (Object.values(im.geometry.attributes).some(a => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute)) return;
      if (!im.boundingSphere) im.computeBoundingSphere();
      if (im.boundingSphere!.radius < minSpread) return;
      found.push(im);
    });
    for (const mesh of found) {
      const n = mesh.count;
      const it: Item = {
        mesh, n,
        mats: (mesh.instanceMatrix.array as Float32Array).slice(0, n * 16),
        cols: mesh.instanceColor ? (mesh.instanceColor.array as Float32Array).slice(0, n * 3) : null,
        spheres: new Float32Array(n * 4), world: new THREE.Matrix4(), version: mesh.instanceMatrix.version,
        colVersion: mesh.instanceColor ? mesh.instanceColor.version : 0, count: n,
        viewKept: new Int32Array(n), viewN: -1, order: new Int32Array(n), cellStart: new Int32Array(1), cellSph: new Float32Array(0),
        proxy: null, shadowKept: new Int32Array(n), shadowN: -1,
      };
      if (mesh.castShadow) {
        const proxy = new THREE.InstancedMesh(mesh.geometry, mesh.material, n);
        proxy.name = `${mesh.name || 'instanced'}:shadow`;
        proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        proxy.count = 0;
        proxy.visible = false;
        proxy.castShadow = true;
        proxy.receiveShadow = false;
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        // the twin carries no instance colours: a source on the colour variant of scene-optimize's shared depth
        // material would otherwise flip that material's program against the real colour casters every frame
        const d = mesh.customDepthMaterial;
        proxy.customDepthMaterial = d === instancedDepthMaterial(true) ? instancedDepthMaterial(false) : d ?? (depthMat ??= new THREE.MeshDepthMaterial());
        proxy.customDistanceMaterial = mesh.customDistanceMaterial;
        proxy.userData.shadowProxyOf = mesh;
        mesh.castShadow = false;
        mesh.parent!.add(proxy);
        it.proxy = proxy;
      }
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      it.world.elements[0] = NaN; // never equal: spheres are computed on the first cull (world matrices current)
      this.items.push(it);
    }
    registry.set(root, this);
  }

  get size(): number { return this.items.length; }

  private spheresFor(it: Item): void {
    const { mesh, spheres, mats } = it;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    for (let i = 0; i < it.n; i++) {
      _m.fromArray(mats, i * 16).premultiply(mesh.matrixWorld);
      _v.copy(bs.center).applyMatrix4(_m);
      const o = i * 4;
      spheres[o] = _v.x; spheres[o + 1] = _v.y; spheres[o + 2] = _v.z;
      spheres[o + 3] = bs.radius * _m.getMaxScaleOnAxis() + 0.5; // slack for vertex sway
    }
    // bucket into cells (only rebuilt when the mesh moves) so whole cells are rejected with one test
    const keyOf = new Map<string, number[]>();
    for (let i = 0; i < it.n; i++) {
      const key = `${Math.floor(spheres[i * 4]! / CELL)},${Math.floor(spheres[i * 4 + 2]! / CELL)}`;
      let list = keyOf.get(key);
      if (!list) { list = []; keyOf.set(key, list); }
      list.push(i);
    }
    const cells = [...keyOf.keys()].sort();
    it.cellStart = new Int32Array(cells.length + 1);
    it.cellSph = new Float32Array(cells.length * 4);
    let w = 0;
    cells.forEach((key, c) => {
      const list = keyOf.get(key)!;
      it.cellStart[c] = w;
      let cx = 0, cy = 0, cz = 0;
      for (const i of list) { cx += spheres[i * 4]!; cy += spheres[i * 4 + 1]!; cz += spheres[i * 4 + 2]!; }
      cx /= list.length; cy /= list.length; cz /= list.length;
      let r = 0;
      for (const i of list) {
        const o = i * 4;
        r = Math.max(r, Math.hypot(spheres[o]! - cx, spheres[o + 1]! - cy, spheres[o + 2]! - cz) + spheres[o + 3]!);
        it.order[w++] = i;
      }
      it.cellSph[c * 4] = cx; it.cellSph[c * 4 + 1] = cy; it.cellSph[c * 4 + 2] = cz; it.cellSph[c * 4 + 3] = r;
    });
    it.cellStart[cells.length] = w;
    it.world.copy(mesh.matrixWorld);
    it.viewN = -1; it.shadowN = -1;
  }

  /** Drop an item whose owner rewrote its instances: hand the mesh back untouched from now on. */
  private release(idx: number): void {
    const it = this.items[idx]!;
    const { mesh } = it;
    // Our view compaction reordered the buffers: put the full set back for every buffer the owner did
    // not rewrite itself (e.g. it only re-tinted instances — its colour writes use the original indices,
    // so leaving compacted matrices behind would move / duplicate / drop instances once count = n).
    if (mesh.instanceMatrix.version === it.version) {
      (mesh.instanceMatrix.array as Float32Array).set(it.mats);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (it.cols && mesh.instanceColor && mesh.instanceColor.version === it.colVersion) {
      (mesh.instanceColor.array as Float32Array).set(it.cols);
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.needsUpdate = true;
    }
    if (it.proxy) { it.proxy.removeFromParent(); it.proxy.dispose(); mesh.castShadow = true; }
    if (mesh.count === it.count) mesh.count = it.n;
    this.items.splice(idx, 1);
  }

  /** Cull every item against `frustum`, compacting into each target (the mesh itself, or its shadow twin). */
  private cull(frustum: THREE.Frustum, shadow: boolean): void {
    loadPlanes(frustum);
    for (let x = this.items.length - 1; x >= 0; x--) {
      const it = this.items[x]!;
      const { mesh } = it;
      if (mesh.instanceMatrix.version !== it.version || mesh.count !== it.count
        || (mesh.instanceColor !== null && mesh.instanceColor.version !== it.colVersion)) { this.release(x); continue; }
      const target = shadow ? it.proxy : mesh;
      if (!target) continue;
      if (!mesh.visible) { if (shadow) target.visible = false; continue; }
      if (!it.world.equals(mesh.matrixWorld)) this.spheresFor(it);
      if (shadow) target.matrixWorld.copy(mesh.matrixWorld);
      const S = it.spheres, C = it.cellSph, order = it.order, start = it.cellStart;
      const kept = shadow ? it.shadowKept : it.viewKept;
      const prevN = shadow ? it.shadowN : it.viewN;
      let k = 0, changedAt = prevN < 0 ? 0 : -1;
      const nc = start.length - 1;
      for (let c = 0; c < nc; c++) {
        if (!sphereIn(C[c * 4]!, C[c * 4 + 1]!, C[c * 4 + 2]!, C[c * 4 + 3]!)) continue;
        for (let j = start[c]!, e = start[c + 1]!; j < e; j++) {
          const i = order[j]!, o = i * 4;
          if (!sphereIn(S[o]!, S[o + 1]!, S[o + 2]!, S[o + 3]!)) continue;
          if (changedAt < 0 && (k >= prevN || kept[k] !== i)) changedAt = k;
          kept[k++] = i;
        }
      }
      if (changedAt < 0 && k !== prevN) changedAt = k;
      if (changedAt >= 0) {
        compact(kept, changedAt, k, it.mats, shadow ? null : it.cols, target);
        if (!shadow) { it.version = mesh.instanceMatrix.version; it.colVersion = mesh.instanceColor ? mesh.instanceColor.version : 0; }
      }
      if (shadow) { it.shadowN = k; target.count = k; target.visible = k > 0; }
      else { it.viewN = k; mesh.count = k; it.count = k; }
    }
  }

  /** Before a view is rendered: keep only the instances inside this camera's frustum. */
  prepareView(camera: THREE.Camera): void {
    if (this.items.length === 0) return;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.cull(_frustum, false);
  }

  /** Inside the shadow-map hook (world matrices are current): fill the shadow twins for this light. */
  prepareShadow(light: THREE.Light): void {
    const shadow = (light as THREE.DirectionalLight).shadow;
    if (!shadow || this.items.length === 0) return;
    shadow.updateMatrices(light);
    this.shadowActive = true;
    this.cull(shadow.getFrustum(), true);
  }

  /** Several shadow-casting lights: every instance casts (no per-light culling). */
  prepareShadowAll(): void {
    this.shadowActive = true;
    for (const it of this.items) {
      if (!it.proxy) continue;
      if (it.shadowN !== -2) {
        for (let i = 0; i < it.n; i++) it.shadowKept[i] = i;
        compact(it.shadowKept, 0, it.n, it.mats, null, it.proxy);
        it.shadowN = -2;
      }
      it.proxy.matrixWorld.copy(it.mesh.matrixWorld);
      it.proxy.count = it.n;
      it.proxy.visible = it.mesh.visible;
    }
  }

  /** After the shadow pass: hide the twins again so the main pass never draws them. */
  restoreShadow(): void {
    if (!this.shadowActive) return;
    this.shadowActive = false;
    for (const it of this.items) if (it.proxy) it.proxy.visible = false;
  }

  /** Put every mesh back as it was (full instance set, casting shadows) and drop the twins. */
  dispose(): void {
    for (const it of this.items) {
      const { mesh } = it;
      (mesh.instanceMatrix.array as Float32Array).set(it.mats);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (it.cols && mesh.instanceColor) { (mesh.instanceColor.array as Float32Array).set(it.cols); mesh.instanceColor.needsUpdate = true; }
      mesh.count = it.n;
      if (it.proxy) { it.proxy.removeFromParent(); it.proxy.dispose(); mesh.castShadow = true; }
    }
    this.items.length = 0;
  }
}

/** Build per-instance culling for a scene (replaces any previous set for it). */
export function attachInstanceCulling(scene: THREE.Object3D, opts?: InstanceCullingOptions): InstanceCulling {
  registry.get(scene)?.dispose();
  return new InstanceCulling(scene, opts);
}

export function instanceCullingOf(scene: THREE.Object3D): InstanceCulling | undefined {
  return registry.get(scene);
}
