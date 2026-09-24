/**
 * Item boxes, coins, projectiles and held-item meshes — all procedural.
 *
 * Pickups and projectiles are InstancedMeshes (one draw call per part regardless of count):
 *   pickups:     box shell (iridescent), "?" core, box ground shadows, coins        → 4 calls
 *   projectiles: banana peel, orb, rocket, rocket flame, skybomb, skybomb light,
 *                skybomb trail                                                      → ≤7 calls
 * Geometry & materials live in a ref-counted module cache shared by every visual.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { HeldItem, ProjectileKind } from '../../sim/types.js';
import type { PickupVisuals, ProjectileVisuals, RenderQuality } from './contracts.js';
import { lensFade } from './camera.js';
import {
  INK, RefCache, createAdditiveMaterial, createPaintMaterial, getFlameTexture, getShadowTexture,
  merge, paint, revolve, shade, shadeByHeight, useKartEnv, xf,
} from './kart-materials.js';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const CYL = (r0: number, r1: number, h: number, seg = 12) => new THREE.CylinderGeometry(r1, r0, h, seg, 1);
const clamp = THREE.MathUtils.clamp;
const easeOutBack = (x: number) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// ───────────────────────────── geometry ─────────────────────────────

// (slightly below full-scale yellow / cream: at #ffd21a / #fff1b8 the sunlit peel clipped to a flat,
// blooming blob with no shading)
const BANANA = '#f6c417', BANANA_DARK = '#7a5a12', CREAM = '#f4dea0';

/** Petal-shaped peel flap (outer + inner surface), from the fruit neck curling outward and down. */
function peelFlap(center: number, halfW: number, NU = 8, NV = 6): THREE.BufferGeometry[] {
  const prof = (u: number): [number, number] => {
    // radius, height along the flap
    const r = 0.09 + Math.sin(u * Math.PI * 0.55) * 0.26;
    const y = 0.3 - u * 0.24 - Math.pow(u, 3) * 0.1;
    return [r, Math.max(0.012, y)];
  };
  const build = (offset: number, flip: boolean) => {
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const [r0, y] = prof(u);
      const r = r0 + offset;
      const w = halfW * (1 - Math.pow(u, 2.2) * 0.85);
      for (let j = 0; j <= NV; j++) {
        const v = j / NV * 2 - 1;
        const a = center + v * w;
        pos.push(Math.sin(a) * r, y + offset * 0.5 + (1 - v * v) * 0.012 * u, Math.cos(a) * r);
        uv.push(u, (v + 1) / 2);
      }
    }
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j, b = a + NV + 1;
      if (flip) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  return [
    paint(build(0, false), BANANA, { rough: 0.45, colorFn: u => (u > 0.9 ? shade(BANANA, -0.35) : null) }),
    paint(build(-0.012, true), CREAM, { rough: 0.7 }),
  ];
}

/** `lite` = held/trailing LOD (small on screen, up to 3 per kart). */
function bananaGeometry(lite = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const seg = lite ? 10 : 16;
  // fruit core
  parts.push(paint(revolve([[0.001, 0.14], [0.085, 0.16], [0.1, 0.26], [0.098, 0.38], [0.08, 0.47], [0.04, 0.52], [0.001, 0.53]], seg), CREAM, { rough: 0.6 }));
  // upright peel sleeve around the base + flaps
  parts.push(paint(revolve([[0.105, 0.12], [0.112, 0.2], [0.108, 0.3]], seg), BANANA, { rough: 0.45 }));
  for (let i = 0; i < 4; i++) parts.push(...peelFlap(Math.PI / 4 + (i * Math.PI) / 2, 0.52, lite ? 5 : 8, lite ? 4 : 6));
  // stem + tip
  parts.push(paint(xf(CYL(0.03, 0.022, 0.1, lite ? 6 : 8), 0, 0.57, 0, 0.2, 0, 0), BANANA_DARK, { rough: 0.7 }));
  parts.push(paint(new THREE.SphereGeometry(0.1, lite ? 8 : 12, lite ? 4 : 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(1, 0.4, 1).translate(0, 0.13, 0), shade(BANANA, -0.1), { rough: 0.5 }));
  const g = merge(parts);
  shadeByHeight(g, 0.02, 0.4, 0.62); // fake AO: darker toward the ground so the flaps read as shapes
  return g;
}

function orbGeometry(lite = false): THREE.BufferGeometry {
  const light = '#38e36b', dark = '#0f7a35';
  const parts = [paint(new THREE.SphereGeometry(0.42, lite ? 18 : 32, lite ? 11 : 20), light, {
    rough: 0.14,
    colorFn: (u, v) => {
      const s = (u * 3 + v * 1.2) % 1;
      return s < 0.2 ? dark : Math.abs(v - 0.5) < 0.035 ? '#f4fff0' : null;
    },
  })];
  return merge(parts);
}

function rocketGeometry(lite = false): THREE.BufferGeometry {
  const red = '#ff3b3b', dark = '#8c1010';
  const parts: THREE.BufferGeometry[] = [];
  const prof: Array<[number, number]> = [[0.001, -0.5], [0.12, -0.5], [0.16, -0.42], [0.175, -0.2], [0.175, 0.12], [0.16, 0.28], [0.12, 0.42], [0.06, 0.52], [0.001, 0.55]];
  const body = revolve(prof, lite ? 14 : 24).rotateX(Math.PI / 2);
  parts.push(paint(body, red, { rough: 0.3, colorFn: (_u, _v, _x, _y, z) => (z > 0.4 ? '#ffffff' : z > -0.16 && z < -0.06 ? '#ffffff' : null) }));
  for (let i = 0; i < 4; i++) {
    const fin = (lite ? new THREE.BoxGeometry(0.02, 0.2, 0.26) : new RoundedBoxGeometry(0.02, 0.2, 0.26, 1, 0.01)).translate(0, 0.24, -0.34);
    fin.rotateZ(Math.PI / 4 + (i * Math.PI) / 2);
    parts.push(paint(fin, dark, { rough: 0.4 }));
  }
  // cartoon eyes
  for (const s of [1, -1]) {
    parts.push(paint(new THREE.SphereGeometry(1, lite ? 8 : 12, lite ? 6 : 8).scale(0.05, 0.06, 0.03).translate(s * 0.075, 0.1, 0.3).rotateY(s * 0.4), '#ffffff', { rough: 0.2 }));
    parts.push(paint(new THREE.SphereGeometry(1, lite ? 6 : 10, lite ? 4 : 6).scale(0.026, 0.034, 0.02).translate(s * 0.08, 0.1, 0.325).rotateY(s * 0.42), INK, { rough: 0.1 }));
    parts.push(paint((lite ? new THREE.BoxGeometry(0.08, 0.018, 0.02) : new RoundedBoxGeometry(0.08, 0.018, 0.02, 1, 0.008)).rotateZ(s * 0.35).translate(s * 0.078, 0.16, 0.3).rotateY(s * 0.4), dark, { rough: 0.4 }));
  }
  parts.push(paint(revolve([[0.1, 0], [0.13, -0.08], [0.1, -0.1], [0.07, -0.02]], lite ? 10 : 18).rotateX(Math.PI / 2).translate(0, 0, -0.5), '#dfe5ee', { rough: 0.15, metal: 1 }));
  return merge(parts);
}

function skybombGeometry(): THREE.BufferGeometry {
  const blue = '#2f6bff', pale = '#b8e1ff';
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.SphereGeometry(1, 28, 18).scale(0.36, 0.36, 0.56), blue, {
    rough: 0.3, colorFn: (_u, v) => (Math.abs(v - 0.5) < 0.05 ? '#ffffff' : null),
  }));
  parts.push(paint(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0, 0.5), '#1b2a6b', { rough: 0.25 }));
  // swept wings
  for (const s of [1, -1]) {
    const w = new RoundedBoxGeometry(0.9, 0.05, 0.34, 2, 0.024).translate(s * 0.55, 0, 0);
    w.rotateY(s * -0.32);
    parts.push(paint(w.translate(0, 0.02, -0.02), pale, { rough: 0.35 }));
    parts.push(paint(new RoundedBoxGeometry(0.05, 0.22, 0.28, 1, 0.02).translate(s * 0.98, 0.08, -0.34), blue, { rough: 0.35 }));
  }
  // tail fins
  for (let i = 0; i < 3; i++) {
    const fin = new RoundedBoxGeometry(0.035, 0.26, 0.26, 1, 0.015).translate(0, 0.2, -0.56);
    fin.rotateZ((i * Math.PI * 2) / 3);
    parts.push(paint(fin, pale, { rough: 0.35 }));
  }
  // light housing
  parts.push(paint(CYL(0.07, 0.06, 0.06, 12).translate(0, 0.37, 0.05), '#dfe5ee', { rough: 0.2, metal: 1 }));
  return merge(parts);
}

/** Chunky extruded question mark, centred, ~0.6 tall, facing ±Z. */
function questionGeometry(lite = false): THREE.BufferGeometry {
  const C = new THREE.Vector2(0, 0.14), Ro = 0.22, Ri = 0.1, a0 = THREE.MathUtils.degToRad(205), a1 = THREE.MathUtils.degToRad(-50);
  const pts: THREE.Vector2[] = [];
  const N = lite ? 14 : 24;
  for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * (i / N); pts.push(new THREE.Vector2(C.x + Math.cos(a) * Ro, C.y + Math.sin(a) * Ro)); }
  pts.push(new THREE.Vector2(0.075, -0.05), new THREE.Vector2(0.075, -0.12), new THREE.Vector2(-0.075, -0.12), new THREE.Vector2(-0.075, -0.02));
  for (let i = 0; i <= N; i++) { const a = a1 + (a0 - a1) * (i / N); pts.push(new THREE.Vector2(C.x + Math.cos(a) * Ri, C.y + Math.sin(a) * Ri)); }
  const rm = (Ro + Ri) / 2, rw = (Ro - Ri) / 2;
  const M = new THREE.Vector2(C.x + Math.cos(a0) * rm, C.y + Math.sin(a0) * rm);
  const NC = lite ? 6 : 10;
  for (let i = 1; i < NC; i++) { const th = a0 + Math.PI - (i / NC) * Math.PI; pts.push(new THREE.Vector2(M.x + Math.cos(th) * rw, M.y + Math.sin(th) * rw)); }
  const hook = new THREE.Shape(pts);
  const dot = new THREE.Shape(); dot.absarc(0, -0.27, 0.08, 0, Math.PI * 2, false);
  const opts = { depth: 0.1, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.03, bevelSegments: lite ? 2 : 3, curveSegments: lite ? 9 : 16 };
  const g1 = new THREE.ExtrudeGeometry(hook, opts), g2 = new THREE.ExtrudeGeometry(dot, opts);
  const g = merge([paint(g1, '#ffffff', { rough: 0.25 }), paint(g2, '#ffffff', { rough: 0.25 })]);
  g.translate(0, 0.03, -0.05);
  return g;
}

function coinGeometry(lite = false): THREE.BufferGeometry {
  const gold = '#ffc21a';
  const prof: Array<[number, number]> = [[0.001, 0.028], [0.26, 0.028], [0.285, 0.05], [0.33, 0.05], [0.36, 0.03], [0.36, -0.03], [0.33, -0.05], [0.285, -0.05], [0.26, -0.028], [0.001, -0.028]];
  const parts = [paint(revolve(prof, lite ? 22 : 36).rotateX(Math.PI / 2), gold, { rough: 0.26, metal: 1 })];
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 === 0 ? 0.19 : 0.085;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  const sg = () => new THREE.ExtrudeGeometry(star, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.01, bevelSegments: 1 });
  parts.push(paint(sg().translate(0, 0, 0.026), '#ffe066', { rough: 0.22, metal: 1 }));
  parts.push(paint(sg().rotateY(Math.PI).translate(0, 0, -0.026), '#ffe066', { rough: 0.22, metal: 1 }));
  return merge(parts);
}

// ───────────────────────────── shared assets ─────────────────────────────

interface ItemAssets {
  banana: THREE.BufferGeometry; orb: THREE.BufferGeometry; rocket: THREE.BufferGeometry; skybomb: THREE.BufferGeometry;
  /** Lighter LODs for items held behind / orbiting a kart (keeps a kart with 3 shields near its triangle budget). */
  heldBanana: THREE.BufferGeometry; heldOrb: THREE.BufferGeometry; heldRocket: THREE.BufferGeometry;
  question: THREE.BufferGeometry; coin: THREE.BufferGeometry;
  /** Lighter pickup LOD for the low / medium tiers (dozens of boxes and coins per lap, drawn in both passes). */
  questionLite: THREE.BufferGeometry; coinLite: THREE.BufferGeometry; boxLite: THREE.BufferGeometry;
  box: THREE.BufferGeometry; flame: THREE.BufferGeometry; trail: THREE.BufferGeometry; light: THREE.BufferGeometry;
  shadowPlane: THREE.BufferGeometry;
  paint: THREE.MeshStandardMaterial;
  /** Same look as `paint` for PLAIN meshes (held / orbiting items, displays): `paint` is drawn by the
   *  projectile InstancedMeshes, and one material on both kinds re-resolves its program at every switch. */
  heldPaint: THREE.MeshStandardMaterial;
  coinMat: THREE.MeshStandardMaterial;
  boxMat: THREE.MeshStandardMaterial;
  /** Single-sided halves of boxMat for the instanced pickups: three.js draws a transparent DoubleSide
   *  material as back-then-front by flipping `side` + `needsUpdate` twice per frame, which re-resolves
   *  the shader program every frame. Two fixed-side meshes draw the same passes without that churn. */
  boxBackMat: THREE.MeshStandardMaterial;
  boxFrontMat: THREE.MeshStandardMaterial;
  qMat: THREE.MeshStandardMaterial;
  flameMat: THREE.MeshBasicMaterial;
  trailMat: THREE.MeshBasicMaterial;
  lightMat: THREE.MeshBasicMaterial;
  shadowMat: THREE.MeshBasicMaterial;
  time: { value: number };
}

function boxMaterial(time: { value: number }, side: THREE.Side = THREE.DoubleSide): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: '#ffffff', roughness: 0.08, metalness: 0, transparent: true, depthWrite: false, side,
  });
  useKartEnv(m, 1.2);
  m.onBeforeCompile = shader => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHue;\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = position;
        #ifdef USE_INSTANCING
          vHue = fract((instanceMatrix[3].x + instanceMatrix[3].z) * 0.0137);
        #else
          vHue = 0.0;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vHue;\nvarying vec3 vLocal;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 Vv = normalize(vViewPosition);
          float fres = 1.0 - abs(dot(normalize(normal), Vv));
          float hue = fract(fres * 1.1 + (vLocal.y * 0.9 + vLocal.x * 0.6 - vLocal.z * 0.4) + uTime * 0.22 + vHue);
          vec3 rainbow = clamp(abs(fract(hue + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
          rainbow = mix(vec3(1.0), rainbow, 0.78);
          vec3 a = abs(vLocal) / 0.55;
          float edge = smoothstep(0.74, 0.97, max(max(min(a.x, a.y), min(a.y, a.z)), min(a.x, a.z)));
          // clear-ish centre so the '?' inside reads at speed; colour concentrates on rims + edges
          totalEmissiveRadiance += rainbow * (0.12 + 1.15 * fres * fres + edge * 0.95);
          diffuseColor.rgb = rainbow;
          diffuseColor.a = clamp(0.14 + 0.62 * fres * fres + edge * 0.5, 0.0, 0.96);
        }`);
  };
  m.customProgramCacheKey = () => 'tp-itembox-v3';
  return m;
}

function buildItemAssets(): ItemAssets {
  const time = { value: 0 };
  const paintMat = createPaintMaterial(null);
  const qMat = createPaintMaterial(null, 1.2);
  const coinMat = createPaintMaterial(null, 2.2);
  coinMat.emissive.set('#6b4300');
  coinMat.emissiveIntensity = 0.55;
  qMat.emissive.set('#ffe9a0');
  qMat.emissiveIntensity = 0.8;
  const flame = new THREE.ConeGeometry(0.5, 1, 14, 2, true).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
  const trail = new THREE.ConeGeometry(0.5, 1, 14, 2, true).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
  for (const g of [flame, trail]) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count * 3).fill(1), 3));
  return {
    banana: bananaGeometry(), orb: orbGeometry(), rocket: rocketGeometry(), skybomb: skybombGeometry(),
    heldBanana: bananaGeometry(true), heldOrb: orbGeometry(true), heldRocket: rocketGeometry(true),
    question: questionGeometry(), coin: coinGeometry(),
    box: new RoundedBoxGeometry(1.1, 1.1, 1.1, 4, 0.2),
    questionLite: questionGeometry(true), coinLite: coinGeometry(true), boxLite: new RoundedBoxGeometry(1.1, 1.1, 1.1, 3, 0.2),
    flame, trail,
    light: new THREE.SphereGeometry(0.065, 12, 8),
    shadowPlane: new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2),
    paint: paintMat, heldPaint: createPaintMaterial(null), coinMat, boxMat: boxMaterial(time), qMat,
    boxBackMat: boxMaterial(time, THREE.BackSide), boxFrontMat: boxMaterial(time, THREE.FrontSide),
    flameMat: createAdditiveMaterial(getFlameTexture(), '#ffb14a'),
    trailMat: createAdditiveMaterial(getFlameTexture(), '#5aa8ff', 0.38),
    lightMat: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    shadowMat: new THREE.MeshBasicMaterial({
      map: getShadowTexture(), color: '#000000', transparent: true, opacity: 0.35, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    time,
  };
}

const itemCache = new RefCache<ItemAssets>(a => {
  for (const g of [a.banana, a.orb, a.rocket, a.skybomb, a.heldBanana, a.heldOrb, a.heldRocket, a.question, a.coin, a.box, a.questionLite, a.coinLite, a.boxLite, a.flame, a.trail, a.light, a.shadowPlane]) g.dispose();
  for (const m of [a.paint, a.heldPaint, a.coinMat, a.boxMat, a.boxBackMat, a.boxFrontMat, a.qMat, a.flameMat, a.trailMat, a.lightMat, a.shadowMat]) m.dispose();
});
const acquireItems = () => itemCache.acquire('items', buildItemAssets);
const releaseItems = () => itemCache.release('items');

// ───────────────────────────── held items ─────────────────────────────

/**
 * Mesh for an item held behind / orbiting a kart. Shares geometry & material with every other
 * item visual; call `obj.userData.release()` when discarding it.
 */
export function createHeldItemMesh(kind: HeldItem['kind']): THREE.Object3D {
  const a = acquireItems();
  const g = new THREE.Group();
  const geo = kind === 'banana' ? a.heldBanana : kind === 'orb' ? a.heldOrb : a.heldRocket;
  const mesh = new THREE.Mesh(geo, a.heldPaint);
  g.add(mesh);
  if (kind === 'rocket') {
    const f = new THREE.Mesh(a.flame, a.flameMat);
    f.position.set(0, 0, -0.55);
    f.scale.set(0.16, 0.16, 0.35);
    g.add(f);
  }
  let released = false;
  g.userData.release = () => { if (!released) { released = true; releaseItems(); } };
  return g;
}

// ───────────────────────────── pickups ─────────────────────────────

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _pm = new THREE.Matrix4();
const _sph = new THREE.Sphere();
/** Slack (m) around each pickup for the view test: covers its shadow falling into view from just outside
 *  (≈ 2 m height × 3.9 at the pipeline's lowest sun elevation). */
const VIEW_SLACK = 9;

/** Optional per-frame view culling for the pickup instances (race-session feeds the player cameras). */
export interface PickupCulling {
  /** Cameras of this frame (matrices are refreshed here); instances outside every view frustum are skipped,
   *  and a box / coin right at one of these lenses shrinks away (it would otherwise fill that view). */
  setViewers(cameras: readonly THREE.Camera[]): void;
}

/** Lens proximity (m, centre to camera): pickups shrink from START and are gone by GONE. A chase camera is
 *  ≥ 5 m behind its kart and karts collect within 2.1 m (boxes) / 1.7 m (coins), so anything this close to
 *  the lens is behind the kart already (the wide-angle edge of the view made such boxes look huge). */
export const BOX_LENS_GONE = 2.0, BOX_LENS_START = 4.2;
export const COIN_LENS_GONE = 1.4, COIN_LENS_START = 3.0;

interface PickAnim { s: number; outT: number; popT: number; was: boolean }

export function createPickupVisuals(boxCount: number, coinCount: number, quality: RenderQuality): PickupVisuals & PickupCulling {
  const a = acquireItems();
  const group = new THREE.Group();
  group.name = 'pickups';
  const nb = Math.max(1, boxCount), nc = Math.max(1, coinCount);
  const lite = quality.level !== 'high';
  const q = new THREE.InstancedMesh(lite ? a.questionLite : a.question, a.qMat, nb);
  // back faces first, then front faces (created in this order: equal renderOrder/depth → sorted by id)
  const boxGeo = lite ? a.boxLite : a.box;
  const shellBack = new THREE.InstancedMesh(boxGeo, a.boxBackMat, nb);
  const shell = new THREE.InstancedMesh(boxGeo, a.boxFrontMat, nb);
  shellBack.instanceMatrix = shell.instanceMatrix; // one matrix buffer drives both halves
  const shadows = new THREE.InstancedMesh(a.shadowPlane, a.shadowMat, nb);
  const coins = new THREE.InstancedMesh(lite ? a.coinLite : a.coin, a.coinMat, nc);
  shellBack.renderOrder = shell.renderOrder = 2;
  shadows.renderOrder = -1;
  for (const m of [q, shellBack, shell, shadows, coins]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    group.add(m);
  }
  q.castShadow = quality.shadows;
  coins.castShadow = quality.shadows;
  const boxAnim: PickAnim[] = Array.from({ length: nb }, () => ({ s: 1, outT: 0, popT: 1, was: true }));
  const coinAnim: PickAnim[] = Array.from({ length: nc }, () => ({ s: 1, outT: 0, popT: 1, was: true }));

  const step = (an: PickAnim, active: boolean, dt: number): number => {
    if (active) {
      if (!an.was) { an.popT = 0; an.was = true; }
      an.popT = Math.min(1, an.popT + dt / 0.45);
      an.s = an.popT >= 1 ? 1 : Math.max(0, easeOutBack(an.popT));
    } else {
      if (an.was) { an.outT = 0; an.was = false; }
      an.outT += dt;
      an.s = an.outT < 0.07 ? 1 + an.outT * 3 : Math.max(0, 1.21 - (an.outT - 0.07) * 9);
    }
    return an.s;
  };

  // Pickups are spread over the whole lap and never frustum-culled as a mesh (one InstancedMesh each);
  // only instances inside a player's view are written, so the rest cost no vertices in either pass.
  const frusta = [new THREE.Frustum(), new THREE.Frustum()];
  const eyes = [new THREE.Vector3(), new THREE.Vector3()];
  let views = 0;
  /** Scale left to a pickup at (x, y, z) by the nearest viewer lens (1 = untouched). */
  const lensScale = (x: number, y: number, z: number, gone: number, start: number): number => {
    let f = 0;
    for (let v = 0; v < views; v++) {
      const e = eyes[v]!;
      const d = Math.hypot(x - e.x, y - e.y, z - e.z);
      if (d < start) f = Math.max(f, lensFade(d, gone, start));
    }
    return 1 - f;
  };
  const inView = (x: number, y: number, z: number): boolean => {
    if (views === 0) return true;
    _sph.center.set(x, y, z);
    _sph.radius = VIEW_SLACK;
    for (let v = 0; v < views; v++) if (frusta[v]!.intersectsSphere(_sph)) return true;
    return false;
  };

  return {
    group,
    setViewers(cameras) {
      views = Math.min(cameras.length, frusta.length);
      for (let v = 0; v < views; v++) {
        const cam = cameras[v]!;
        cam.updateMatrixWorld();
        frusta[v]!.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        eyes[v]!.setFromMatrixPosition(cam.matrixWorld);
      }
    },
    update(boxes, coinList, dt, time) {
      a.time.value = time;
      const d = clamp(dt, 0, 0.1);
      let n = 0;
      for (let i = 0; i < boxes.length && i < nb; i++) {
        const b = boxes[i]!;
        const s0 = step(boxAnim[i]!, b.active, d);
        if (s0 <= 0.001 || !inView(b.x, b.y, b.z)) continue;
        const s = s0 * lensScale(b.x, b.y, b.z, BOX_LENS_GONE, BOX_LENS_START);
        if (s <= 0.001) continue;
        const bob = Math.sin(time * 2.2 + i * 1.7) * 0.12;
        _p.set(b.x, b.y + bob, b.z);
        _e.set(0.42, time * 1.25 + i * 0.9, 0.3, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p, _q, _s.setScalar(s));
        shell.setMatrixAt(n, _m);
        _e.set(0, -time * 2.1 + i, Math.sin(time * 3 + i) * 0.12, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p, _q, _s.setScalar(s * 1.05));
        q.setMatrixAt(n, _m);
        const hs = s * (1 - bob * 0.3);
        _q.identity();
        _m.compose(_p.set(b.x, b.y - 1.03, b.z), _q, _s.set(hs, 1, hs));
        shadows.setMatrixAt(n, _m);
        n++;
      }
      shellBack.count = shell.count = q.count = shadows.count = n;
      shellBack.visible = shell.visible = q.visible = shadows.visible = n > 0; // empty instanced meshes would still cost a draw
      shell.instanceMatrix.needsUpdate = true;
      q.instanceMatrix.needsUpdate = true;
      shadows.instanceMatrix.needsUpdate = true;
      let c = 0;
      for (let i = 0; i < coinList.length && i < nc; i++) {
        const k = coinList[i]!;
        const s0 = step(coinAnim[i]!, k.active, d);
        if (s0 <= 0.001 || !inView(k.x, k.y, k.z)) continue;
        const s = s0 * lensScale(k.x, k.y, k.z, COIN_LENS_GONE, COIN_LENS_START);
        if (s <= 0.001) continue;
        _p.set(k.x, k.y + Math.sin(time * 3 + i * 0.8) * 0.08, k.z);
        _e.set(0, time * 3.2 + i * 0.35, 0);
        _q.setFromEuler(_e);
        _m.compose(_p, _q, _s.setScalar(s));
        coins.setMatrixAt(c++, _m);
      }
      coins.count = c;
      coins.visible = c > 0;
      coins.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      group.removeFromParent();
      for (const m of [q, shellBack, shell, shadows, coins]) m.dispose();
      releaseItems();
    },
  };
}

// ───────────────────────────── projectiles ─────────────────────────────

interface ProjState { stamp: number; born: number; yaw: number; pitch: number; roll: number; lastX: number; lastY: number; lastZ: number; seed: number }

const CAP: Record<ProjectileKind, number> = { banana: 64, orb: 32, rocket: 24, skybomb: 6 };
const BOMB_LIGHT_ON = new THREE.Color('#ffffff');
const BOMB_LIGHT_DIVE = new THREE.Color('#ff3030');
const BOMB_LIGHT_OFF = new THREE.Color('#5a1010');

function wrapAngle(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

export function createProjectileVisuals(quality: RenderQuality): ProjectileVisuals {
  const a = acquireItems();
  const group = new THREE.Group();
  group.name = 'projectiles';
  const mk = (g: THREE.BufferGeometry, m: THREE.Material, n: number, shadow: boolean) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = shadow && quality.shadows;
    group.add(im);
    return im;
  };
  const banana = mk(a.banana, a.paint, CAP.banana, true);
  const orb = mk(a.orb, a.paint, CAP.orb, true);
  const rocket = mk(a.rocket, a.paint, CAP.rocket, true);
  const rocketFlame = mk(a.flame, a.flameMat, CAP.rocket, false);
  const bomb = mk(a.skybomb, a.paint, CAP.skybomb, true);
  const bombLight = mk(a.light, a.lightMat, CAP.skybomb, false);
  const bombTrail = mk(a.trail, a.trailMat, CAP.skybomb, false);
  bombLight.setColorAt(0, BOMB_LIGHT_ON);
  const meshes = [banana, orb, rocket, rocketFlame, bomb, bombLight, bombTrail];
  const states = new Map<number, ProjState>();
  let stamp = 0;
  let clock = 0;
  const prune = (st: ProjState, id: number) => { if (st.stamp !== stamp) states.delete(id); };

  return {
    group,
    update(list, dt, time) {
      stamp++;
      const d = clamp(dt, 0, 0.1);
      clock += d;
      let nb = 0, no = 0, nr = 0, ns = 0;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        let st = states.get(p.id);
        if (!st) {
          const seed = (p.id * 2654435761) % 1000 / 1000;
          st = { stamp, born: clock, yaw: Math.atan2(p.vx, p.vz) || seed * 6.28, pitch: 0, roll: 0, lastX: p.x, lastY: p.y, lastZ: p.z, seed };
          states.set(p.id, st);
        }
        st.stamp = stamp;
        const age = clock - st.born;
        const pop = age < 0.3 ? Math.max(0.05, easeOutBack(age / 0.3)) : 1;
        const vh = Math.hypot(p.vx, p.vz);
        const dx = p.x - st.lastX, dy = p.y - st.lastY, dz = p.z - st.lastZ;
        const moved = Math.hypot(dx, dz);
        if (vh > 0.5) st.yaw = Math.atan2(p.vx, p.vz);
        else if (moved > 1e-3 && d > 0) {
          // position-driven projectiles (the skybomb) report vx = vz = 0: face the direction of travel
          st.yaw += wrapAngle(Math.atan2(dx, dz) - st.yaw) * Math.min(1, d * 10);
        }
        if (d > 0) {
          const wantPitch = moved + Math.abs(dy) > 1e-3 ? Math.atan2(-dy, Math.max(moved, 1e-4)) : 0;
          st.pitch += (clamp(wantPitch, -0.6, 1.35) - st.pitch) * Math.min(1, d * 8);
        }
        st.lastX = p.x; st.lastY = p.y; st.lastZ = p.z;
        if (p.kind === 'banana' && nb < CAP.banana) {
          _e.set(Math.sin(time * 3 + st.seed * 9) * 0.06, st.seed * 6.28, Math.cos(time * 2.6 + st.seed * 5) * 0.06, 'YXZ');
          _q.setFromEuler(_e);
          _m.compose(_p.set(p.x, p.y - 0.35, p.z), _q, _s.setScalar(pop * 1.15));
          banana.setMatrixAt(nb++, _m);
        } else if (p.kind === 'orb' && no < CAP.orb) {
          st.roll += moved / 0.42 + d * 2;
          _e.set(st.roll, st.yaw, 0, 'YXZ');
          _q.setFromEuler(_e);
          _m.compose(_p.set(p.x, p.y, p.z), _q, _s.setScalar(pop));
          orb.setMatrixAt(no++, _m);
        } else if (p.kind === 'rocket' && nr < CAP.rocket) {
          _e.set(st.pitch * 0.8 + Math.sin(time * 9 + st.seed * 7) * 0.05, st.yaw, Math.sin(time * 6 + st.seed) * 0.25, 'YXZ');
          _q.setFromEuler(_e);
          _p.set(p.x, p.y + Math.sin(time * 12 + st.seed * 3) * 0.04, p.z);
          _m.compose(_p, _q, _s.setScalar(pop * 1.2));
          rocket.setMatrixAt(nr, _m);
          // flame behind the nozzle
          const fl = 0.55 + 0.25 * Math.abs(Math.sin(time * 37 + st.seed * 11));
          _m.compose(_p.set(p.x - Math.sin(st.yaw) * 0.72, p.y, p.z - Math.cos(st.yaw) * 0.72), _q, _s.set(0.22 * pop, 0.22 * pop, fl * pop));
          rocketFlame.setMatrixAt(nr++, _m);
        } else if (p.kind === 'skybomb' && ns < CAP.skybomb) {
          const dive = p.state === 'dive';
          // nose follows the actual climb/descent (steep during the dive); gentle wobble on top
          const pitch = dive ? Math.max(0.5, st.pitch) : st.pitch * 0.5 + Math.sin(time * 2) * 0.05;
          _e.set(pitch, st.yaw, dive ? Math.sin(time * 20) * 0.1 : Math.sin(time * 1.7) * 0.18, 'YXZ');
          _q.setFromEuler(_e);
          _p.set(p.x, p.y + (dive ? 0 : Math.sin(time * 2.4 + st.seed) * 0.15), p.z);
          _m.compose(_p, _q, _s.setScalar(pop * 1.35));
          bomb.setMatrixAt(ns, _m);
          // blinking light on top (local 0, 0.45, 0.05)
          _s.set(0, 0.45 * 1.35, 0.05 * 1.35).applyQuaternion(_q);
          const blinkRate = dive ? 14 : 4;
          const on = Math.floor(time * blinkRate) % 2 === 0;
          _m.compose(_p2.copy(_p).add(_s), _q, _s.setScalar(pop * (on ? 1.3 : 0.9)));
          bombLight.setMatrixAt(ns, _m);
          bombLight.setColorAt(ns, on ? (dive ? BOMB_LIGHT_DIVE : BOMB_LIGHT_ON) : BOMB_LIGHT_OFF);
          // glow trail behind
          _s.set(0, 0, -0.75 * 1.35).applyQuaternion(_q);
          _m.compose(_p.add(_s), _q, _s.set(0.28 * pop, 0.28 * pop, (dive ? 1.8 : 1.1) * (0.85 + 0.15 * Math.sin(time * 30)) * pop));
          bombTrail.setMatrixAt(ns++, _m);
        }
      }
      banana.count = nb; orb.count = no; rocket.count = nr; rocketFlame.count = nr;
      bomb.count = ns; bombLight.count = ns; bombTrail.count = ns;
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i]!;
        m.visible = m.count > 0; // skip the (shadow +) main pass draw for empty pools
        m.instanceMatrix.needsUpdate = true;
      }
      if (bombLight.instanceColor) bombLight.instanceColor.needsUpdate = true;
      states.forEach(prune);
    },
    dispose() {
      group.removeFromParent();
      for (const m of meshes) m.dispose();
      states.clear();
      releaseItems();
    },
  };
}

/** Standalone meshes for UI/showroom use (shared assets; call userData.release() when done). */
export function createItemDisplayMesh(kind: ProjectileKind | 'box' | 'coin'): THREE.Object3D {
  const a = acquireItems();
  const g = new THREE.Group();
  if (kind === 'box') {
    g.add(new THREE.Mesh(a.question, a.qMat), new THREE.Mesh(a.box, a.boxMat));
  } else {
    const geo = kind === 'banana' ? a.banana : kind === 'orb' ? a.orb : kind === 'rocket' ? a.rocket : kind === 'skybomb' ? a.skybomb : a.coin;
    g.add(new THREE.Mesh(geo, kind === 'coin' ? a.coinMat : a.heldPaint));
  }
  let released = false;
  g.userData.release = () => { if (!released) { released = true; releaseItems(); } };
  return g;
}

