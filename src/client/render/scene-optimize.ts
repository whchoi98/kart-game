/**
 * Look-preserving render-cost hygiene for a freshly built scene (run once after the race scene is
 * assembled). Every rule here produces the same pixels; it only removes work three.js would redo
 * every frame:
 *
 *  1. Order-independent transparent DoubleSide materials (additive blending, no depth writes) get
 *     `forceSinglePass`. three.js otherwise draws them twice (back faces, then front faces), flipping
 *     `side` and `needsUpdate` twice per frame, which re-resolves the shader program each time.
 *     With additive blending and no depth writes the two passes sum to exactly the single pass.
 *  2. Instanced shadow casters get a shared, program-stable `customDepthMaterial`. By default every
 *     caster renders with one shared MeshDepthMaterial, so each switch between a plain mesh and an
 *     InstancedMesh (with / without instance colours) in the shadow traversal re-resolves the depth
 *     program (getParameters + cache key: CPU and several KB of garbage per switch).
 *  3. An InstancedMesh without instance colours that shares its material with one that has them
 *     gets white instance colours (colour × 1 = same shading), so both resolve to one program.
 *  4. Huge static single meshes (terrain, whole-lap track ribbons such as neon tubes) are split into
 *     ~400 m spatial tiles (children of the original, which moves to an unrendered layer), so the
 *     parts behind the camera / outside the shadow box are frustum-culled like everything else.
 *
 *  5. A material shared by plain meshes and InstancedMeshes (instancing on/off = another program at
 *     every switch, every frame) gets a prototype-linked twin on the InstancedMeshes: every property
 *     (colours, maps, roughness, version / needsUpdate, onBeforeCompile…) is read live from the source,
 *     so an owner animating the source animates both; only three's per-material state is the twin's own.
 *
 * Materials three.js itself mutates while drawing (transparent DoubleSide back/front passes,
 * transmission) and ShaderMaterials are not twinned, only reported.
 */
import * as THREE from 'three';

export interface SceneOptimizeReport {
  singlePass: number;
  instancedDepth: number;
  whitened: number;
  /** Meshes split into spatial tiles, and the number of tiles made. */
  tiled: number;
  tiles: number;
  /** Plain + instanced materials given an instancing twin. */
  twinned: number;
  /** Materials still used by both plain meshes and InstancedMeshes (program switch every frame). */
  mixedInstancing: string[];
}

let depthInst: THREE.MeshDepthMaterial | null = null;
let depthInstColor: THREE.MeshDepthMaterial | null = null;

function sharedDepth(color: boolean): THREE.MeshDepthMaterial {
  if (color) return (depthInstColor ??= new THREE.MeshDepthMaterial());
  return (depthInst ??= new THREE.MeshDepthMaterial());
}

/** The shared, program-stable depth material for instanced casters with / without instance colours. */
export function instancedDepthMaterial(color: boolean): THREE.MeshDepthMaterial { return sharedDepth(color); }

/** three.js writes `side` / `needsUpdate` / uniform flags on these while drawing: a twin would stop following. */
function twinnable(m: THREE.Material): boolean {
  if ((m as THREE.ShaderMaterial).isShaderMaterial) return false;
  if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) return false;
  if (((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0) return false;
  return true;
}

interface Twin { src: THREE.Material; twin: THREE.Material; onDispose: () => void }

/** Live view of `src` with its own three.js identity (programs, dispose event); disposed with `src`
 *  or, at the latest, with the scene optimisation (a source that outlives the race keeps no reference). */
function instancingTwin(src: THREE.Material): Twin {
  const twin = Object.create(src) as THREE.Material;
  // own listener table: three registers its per-material dispose hook on the twin itself
  (twin as unknown as { _listeners?: unknown })._listeners = undefined;
  const onDispose = () => twin.dispose();
  src.addEventListener('dispose', onDispose);
  return { src, twin, onDispose };
}

function materialsOf(o: THREE.Object3D): THREE.Material[] {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  return m ? (Array.isArray(m) ? m : [m]) : [];
}

/** Depth rendering of this material needs three's per-material variant (alpha test, displacement, clipping). */
function needsDepthVariant(m: THREE.Material): boolean {
  const s = m as THREE.MeshStandardMaterial;
  return (m.clippingPlanes !== null && m.clippingPlanes.length > 0)
    || (!!s.displacementMap && s.displacementScale !== 0)
    || ((!!s.alphaMap || !!s.map) && m.alphaTest > 0)
    || m.alphaToCoverage;
}

/** Layer no camera renders: a tiled mesh stays in the graph (transform, visibility, material) but draws via its tiles. */
const HIDDEN_LAYER = 31;
// Big tiles, big meshes only: every visible tile is a draw call, and at the low tier the call budget
// binds before the triangle budget. 400 m tiles over ≥24k-triangle meshes (terrain, neon rails, stone
// walls) keep ~40-50 % of their triangles out of view for +2..5 draws per mesh.
const TILE = 400;
const TILE_MIN_TRIS = 24000;
const TILE_MIN_RADIUS = 220;

type TypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int8Array | Int16Array | Int32Array | Float64Array;

function tileable(mesh: THREE.Mesh): boolean {
  const g = mesh.geometry;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return false;
  if (Array.isArray(mesh.material) || mesh.material.transparent || g.groups.length > 0 || mesh.children.length > 0) return false;
  // per-object hooks would stop running once the original no longer renders
  if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || mesh.onAfterRender !== THREE.Object3D.prototype.onAfterRender) return false;
  if ((g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry || Object.keys(g.morphAttributes).length > 0) return false;
  if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity || !mesh.frustumCulled || !mesh.layers.isEnabled(0)) return false;
  for (const a of Object.values(g.attributes)) {
    const b = a as THREE.BufferAttribute;
    if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || b.usage !== THREE.StaticDrawUsage) return false;
  }
  const pos = g.attributes.position;
  if (!pos) return false;
  const tris = (g.index ? g.index.count : pos.count) / 3;
  if (tris < TILE_MIN_TRIS) return false;
  if (!g.boundingSphere) g.computeBoundingSphere();
  return g.boundingSphere!.radius * mesh.matrixWorld.getMaxScaleOnAxis() >= TILE_MIN_RADIUS;
}

/** Split `mesh` into TILE×TILE (local XZ) child meshes; returns the new geometries (empty if not worth it). */
function tileMesh(mesh: THREE.Mesh): THREE.BufferGeometry[] {
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index;
  const nTri = (idx ? idx.count : pos.count) / 3;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!;
  const nx = Math.max(1, Math.ceil((bb.max.x - bb.min.x) / TILE)), nz = Math.max(1, Math.ceil((bb.max.z - bb.min.z) / TILE));
  if (nx * nz < 2) return [];
  const vi = (t: number, c: number) => (idx ? idx.getX(t * 3 + c) : t * 3 + c);
  const tileOf = new Int32Array(nTri);
  const counts = new Int32Array(nx * nz);
  for (let t = 0; t < nTri; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const tx = Math.min(nx - 1, Math.max(0, Math.floor((cx - bb.min.x) / TILE)));
    const tz = Math.min(nz - 1, Math.max(0, Math.floor((cz - bb.min.z) / TILE)));
    const k = tz * nx + tx;
    tileOf[t] = k; counts[k]!++;
  }
  let used = 0;
  for (let k = 0; k < counts.length; k++) if (counts[k]! > 0) used++;
  if (used < 2) return [];
  const out: THREE.BufferGeometry[] = [];
  const remap = new Int32Array(pos.count);
  const names = Object.keys(g.attributes);
  for (let k = 0; k < counts.length; k++) {
    const nt = counts[k]!;
    if (nt === 0) continue;
    remap.fill(-1);
    let nv = 0;
    const index = new Uint32Array(nt * 3);
    let w = 0;
    for (let t = 0; t < nTri; t++) {
      if (tileOf[t] !== k) continue;
      for (let c = 0; c < 3; c++) {
        const v = vi(t, c);
        let r = remap[v]!;
        if (r < 0) { r = nv++; remap[v] = r; }
        index[w++] = r;
      }
    }
    const tg = new THREE.BufferGeometry();
    for (const name of names) {
      const src = g.attributes[name] as THREE.BufferAttribute;
      const size = src.itemSize;
      const sa = src.array as TypedArray;
      const dst = new (sa.constructor as { new (n: number): TypedArray })(nv * size);
      for (let v = 0; v < pos.count; v++) {
        const r = remap[v]!;
        if (r < 0) continue;
        for (let e = 0; e < size; e++) dst[r * size + e] = sa[v * size + e]!;
      }
      tg.setAttribute(name, new THREE.BufferAttribute(dst, size, src.normalized));
    }
    tg.setIndex(new THREE.BufferAttribute(nv > 65535 ? index : Uint16Array.from(index), 1));
    tg.computeBoundingSphere();
    tg.computeBoundingBox();
    const tile = new THREE.Mesh(tg, mesh.material);
    tile.name = `${mesh.name || 'mesh'}:tile`;
    tile.castShadow = mesh.castShadow;
    tile.receiveShadow = mesh.receiveShadow;
    tile.renderOrder = mesh.renderOrder;
    tile.customDepthMaterial = mesh.customDepthMaterial;
    tile.customDistanceMaterial = mesh.customDistanceMaterial;
    tile.matrixAutoUpdate = false;
    mesh.add(tile);
    out.push(tg);
  }
  mesh.layers.set(HIDDEN_LAYER);
  return out;
}

export interface SceneOptimization {
  readonly report: SceneOptimizeReport;
  /** Frees the tile geometries (the scene's owners dispose everything else). */
  dispose(): void;
}

export function optimizeScene(root: THREE.Object3D): SceneOptimization {
  const report: SceneOptimizeReport = { singlePass: 0, instancedDepth: 0, whitened: 0, tiled: 0, tiles: 0, twinned: 0, mixedInstancing: [] };
  const toTile: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  const seen = new Set<THREE.Material>();
  const users = new Map<THREE.Material, { plain: number; inst: THREE.InstancedMesh[]; instColor: number; label: string }>();
  const twins: Twin[] = [];

  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (tileable(mesh)) toTile.push(mesh);
    const mats = materialsOf(mesh);
    const im = (o as THREE.InstancedMesh).isInstancedMesh ? o as THREE.InstancedMesh : null;
    for (const m of mats) {
      if (!seen.has(m)) {
        seen.add(m);
        if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass
          && m.blending === THREE.AdditiveBlending && !m.depthWrite) {
          m.forceSinglePass = true;
          report.singlePass++;
        }
      }
      let u = users.get(m);
      if (!u) { u = { plain: 0, inst: [], instColor: 0, label: o.name || m.name || m.type }; users.set(m, u); }
      if (im) { u.inst.push(im); if (im.instanceColor) u.instColor++; } else u.plain++;
    }
    if (im && im.castShadow && im.customDepthMaterial === undefined && im.morphTexture === null
      && mats.length > 0 && !mats.some(needsDepthVariant)) {
      im.customDepthMaterial = sharedDepth(im.instanceColor !== null);
      report.instancedDepth++;
    }
  });

  for (const [m, u] of users) {
    if (u.instColor > 0 && u.instColor < u.inst.length) {
      for (const im of u.inst) {
        if (im.instanceColor) continue;
        const n = im.instanceMatrix.count;
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
        if (im.customDepthMaterial === depthInst) im.customDepthMaterial = sharedDepth(true);
        report.whitened++;
      }
    }
    if (u.plain > 0 && u.inst.length > 0) {
      const single = u.inst.filter(im => im.material === m);
      if (twinnable(m) && single.length === u.inst.length) {
        const t = instancingTwin(m);
        twins.push(t);
        for (const im of single) im.material = t.twin;
        report.twinned++;
      } else {
        report.mixedInstancing.push(u.label);
      }
    }
  }
  const tileGeos: THREE.BufferGeometry[] = [];
  for (const m of toTile) {
    const made = tileMesh(m);
    if (made.length) { report.tiled++; report.tiles += made.length; tileGeos.push(...made); }
  }
  return {
    report,
    dispose() {
      for (const g of tileGeos) g.dispose();
      tileGeos.length = 0;
      for (const t of twins) { t.src.removeEventListener('dispose', t.onDispose); t.twin.dispose(); }
      twins.length = 0;
    },
  };
}
