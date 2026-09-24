/**
 * Draw-call merge for rigidly animated part hierarchies (kart body + steering wheel + driver torso,
 * head, arms, ears, tail…): every part keeps its Object3D and is animated exactly as before, but the
 * parts that share one material are drawn by ONE SkinnedMesh whose bones are the part meshes
 * themselves (rigid skinning: one bone per vertex, weight 1, identity bind pose). The per-vertex
 * transform is therefore the part's own matrixWorld — the same pixels, one draw call instead of 6–9,
 * in the main pass and in the shadow pass.
 *
 * The original part meshes stay in the graph (their matrices drive the bones) but draw nothing: their
 * material is swapped for an invisible one. Their `visible` flags (and their ancestors' up to the root)
 * are still honoured: a hidden part collapses its bone to a degenerate matrix.
 *
 * Merged geometries are cached by the part geometries they were built from (karts of the same
 * character share one), and ref-counted.
 *
 * Optional shadow proxy: low-poly stand-ins (a few boxes / cylinders per part) are appended to the same
 * buffer, each skinned to one of the parts. The main pass draws only the parts' range; the shadow pass
 * (onBeforeShadow → onAfterShadow) swaps the draw range to the proxy range, so the silhouette casts a
 * shadow for a few hundred triangles instead of the whole model — still one draw, still animated by the
 * same bones (and collapsed with them when a part is hidden).
 */
import * as THREE from 'three';

const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
HIDDEN.name = 'rigid-merge:hidden';

interface CacheEntry { geo: THREE.BufferGeometry; refs: number; main: number; shadow: [number, number] | null }
let skinnedDepth: THREE.MeshDepthMaterial | null = null;
const cache = new Map<string, CacheEntry>();

export interface RigidMerge {
  readonly mesh: THREE.SkinnedMesh;
  dispose(): void;
}

/** A shadow-only stand-in: `geometry` is in the local space of `part` (one of the merged parts). */
export interface ShadowProxyPart { part: THREE.Mesh; geometry: THREE.BufferGeometry }

function readAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, c: number): number {
  return c === 0 ? a.getX(i) : c === 1 ? a.getY(i) : c === 2 ? a.getZ(i) : a.getW(i);
}

/**
 * One buffer for `geos` (geometry i skinned to bone `bones[i]`). Returns the geometry and the draw-range
 * end (vertices, or indices when indexed) of the first `mainCount` geometries.
 */
function buildGeometry(geos: readonly THREE.BufferGeometry[], bones: readonly number[], mainCount: number): { geo: THREE.BufferGeometry; mainEnd: number } | null {
  const names = new Map<string, number>();
  for (const g of geos) {
    if (Object.keys(g.morphAttributes).length > 0) return null;
    for (const [name, a] of Object.entries(g.attributes)) {
      const prev = names.get(name);
      if (prev !== undefined && prev !== a.itemSize) return null;
      names.set(name, a.itemSize);
    }
  }
  if (!names.has('position')) return null;
  const indexed = geos.every(g => g.index !== null);
  let vTotal = 0, iTotal = 0;
  for (const g of geos) {
    const n = g.attributes.position!.count;
    vTotal += indexed ? n : (g.index ? g.index.count : n);
    if (indexed) iTotal += g.index!.count;
  }
  const out = new THREE.BufferGeometry();
  const arrays = new Map<string, Float32Array>();
  for (const [name, size] of names) arrays.set(name, new Float32Array(vTotal * size));
  const skinIndex = new Uint16Array(vTotal * 4);
  const skinWeight = new Float32Array(vTotal * 4);
  const index = indexed ? (vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal)) : null;
  let vBase = 0, iBase = 0, mainEnd = 0;
  geos.forEach((g, gi) => {
    const bone = bones[gi]!;
    const src = g.index;
    const n = indexed || !src ? g.attributes.position!.count : src.count;
    for (const [name, size] of names) {
      const dst = arrays.get(name)!;
      const a = g.attributes[name];
      const plain = a && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !a.normalized
        && (a as THREE.BufferAttribute).array instanceof Float32Array ? (a as THREE.BufferAttribute).array as Float32Array : null;
      if (plain && (indexed || !src)) { dst.set(plain.subarray(0, n * size), vBase * size); continue; } // fast path: block copy
      for (let v = 0; v < n; v++) {
        const sv = !indexed && src ? src.getX(v) : v;
        const o = (vBase + v) * size;
        for (let c = 0; c < size; c++) dst[o + c] = a ? readAttr(a, sv, c) : (c === 3 ? 1 : 0); // unbound attribute default
      }
    }
    for (let v = 0; v < n; v++) { skinIndex[(vBase + v) * 4] = bone; skinWeight[(vBase + v) * 4] = 1; }
    if (index && src) {
      for (let k = 0; k < src.count; k++) index[iBase + k] = src.getX(k) + vBase;
      iBase += src.count;
    }
    vBase += n;
    if (gi === mainCount - 1) mainEnd = index ? iBase : vBase;
  });
  for (const [name, size] of names) out.setAttribute(name, new THREE.BufferAttribute(arrays.get(name)!, size));
  out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  if (index) out.setIndex(new THREE.BufferAttribute(index, 1));
  return { geo: out, mainEnd };
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _s = new THREE.Sphere();

/**
 * Merge `parts` (plain meshes sharing `material`, all descendants of `root`) into one rigid-skinned
 * mesh added to `root`. Returns null (and changes nothing) when the parts can't be merged.
 * Call after the hierarchy is assembled (matrices are read once for the culling sphere).
 * `shadowProxy` (optional): shadow-pass stand-ins, each in the local space of one of `parts` — when
 * given, the shadow pass draws only these instead of the parts (see the header).
 */
export function mergeRigidParts(
  root: THREE.Object3D, parts: readonly THREE.Mesh[], material: THREE.Material,
  shadowProxy: readonly ShadowProxyPart[] = [],
): RigidMerge | null {
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (p.material !== material || (p as THREE.InstancedMesh).isInstancedMesh || (p as THREE.SkinnedMesh).isSkinnedMesh) return null;
  }
  const proxies = shadowProxy.filter(sp => parts.includes(sp.part));
  const key = parts.map(p => p.geometry.uuid).join('|') + (proxies.length ? '#' + proxies.map(sp => `${parts.indexOf(sp.part)}:${sp.geometry.uuid}`).join('|') : '');
  let entry = cache.get(key);
  if (!entry) {
    const geos = [...parts.map(p => p.geometry), ...proxies.map(sp => sp.geometry)];
    const bones = [...parts.map((_p, i) => i), ...proxies.map(sp => parts.indexOf(sp.part))];
    const built = buildGeometry(geos, bones, parts.length);
    if (!built) return null;
    const total = built.geo.index ? built.geo.index.count : built.geo.attributes.position!.count;
    const shadow: [number, number] | null = proxies.length && total > built.mainEnd ? [built.mainEnd, total - built.mainEnd] : null;
    if (shadow) built.geo.setDrawRange(0, built.mainEnd); // the main pass never draws the proxy range
    entry = { geo: built.geo, refs: 0, main: built.mainEnd, shadow };
    cache.set(key, entry);
  }
  entry.refs++;

  const mesh = new THREE.SkinnedMesh(entry.geo, material);
  mesh.name = 'rigid-merge';
  // own depth material: sharing three's default one with plain casters would switch its program
  // (skinning on/off) at every change in the shadow traversal
  mesh.customDepthMaterial = (skinnedDepth ??= new THREE.MeshDepthMaterial());
  mesh.castShadow = parts[0]!.castShadow;
  mesh.receiveShadow = parts[0]!.receiveShadow;
  mesh.renderOrder = parts[0]!.renderOrder;
  if (entry.shadow) {
    // swap to the proxy range just for this object's shadow draw (synchronous: the geometry may be
    // shared by several karts of the same character, each restores the main range right after)
    const g = entry.geo, [s0, sN] = entry.shadow, main = entry.main;
    mesh.onBeforeShadow = () => { g.drawRange.start = s0; g.drawRange.count = sN; };
    mesh.onAfterShadow = () => { g.drawRange.start = 0; g.drawRange.count = main; };
    mesh.userData.shadowRange = { start: s0, count: sN };
  }
  root.add(mesh);
  const skeleton = new THREE.Skeleton(parts as unknown as THREE.Bone[], parts.map(() => new THREE.Matrix4()));
  mesh.bind(skeleton, new THREE.Matrix4());

  // culling sphere in the mesh's (root's) frame from the rest pose, padded for spins / tumbles / stretches
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const sphere = new THREE.Sphere();
  let first = true;
  for (const p of parts) {
    if (!p.geometry.boundingSphere) p.geometry.computeBoundingSphere();
    _m.multiplyMatrices(_inv, p.matrixWorld);
    _s.copy(p.geometry.boundingSphere!).applyMatrix4(_m);
    if (first) { sphere.copy(_s); first = false; } else sphere.union(_s);
  }
  sphere.radius = sphere.radius * 1.35 + 0.4;
  mesh.boundingSphere = sphere;

  // honour the parts' visibility (and their ancestors' up to root): collapse hidden parts
  const baseUpdate = skeleton.update.bind(skeleton);
  const bm = () => skeleton.boneMatrices!;
  skeleton.update = () => {
    baseUpdate();
    const arr = bm();
    for (let i = 0; i < parts.length; i++) {
      let o: THREE.Object3D | null = parts[i]!;
      let vis = true;
      while (o && o !== root) { if (!o.visible) { vis = false; break; } o = o.parent; }
      if (!vis) arr.fill(0, i * 16, i * 16 + 16);
    }
  };

  for (const p of parts) p.material = HIDDEN;

  let disposed = false;
  return {
    mesh,
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      skeleton.dispose();
      const e = cache.get(key);
      if (e && --e.refs <= 0) { e.geo.dispose(); cache.delete(key); }
    },
  };
}
