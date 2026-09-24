/**
 * Sunny Meadow scenery — rolling green hills, striped flower fields, round trees and
 * bushes, windmills with turning sails, a red barn with silo, farm fences, drifting
 * hot-air balloons, distant blue mountains and fluffy clouds. Bright midday.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, scatter } from '../terrain.js';
import {
  Bag, Batch, Butterflies, Flock, Materials, Reserve, Rng, addInstanced, applySway, blob, buildClouds, buildFarGround, buildRing,
  clearOf, combine, createWaterMaterial, distanceField, faceSmooth, frameAt, genericMoverGeo, gradientY, isTrackMeshKind, jitter,
  landmarkPlace, makeGenericRig, makeRig, noise2, normKind, part, qcount, recolorTerrain, rockGeo, trackExtent, trs, updateGeneric,
  waterPits, type MoverRig, type Xf, pitZone, reserveTrackFurniture, withCorridorGuard,
} from './props-a.js';

const PAL = THEME_PALETTES.meadow;

const SUN: [number, number, number] = [0.42, 0.78, 0.46];

export const MEADOW_ENV: EnvironmentSettings = {
  skyTop: '#3a8ef0', skyHorizon: '#c4e8ff', skyBottom: '#8fcf6e',
  fogColor: '#cbe7fb', fogNear: 160, fogFar: 1050,
  sunColor: '#fff2d9', sunIntensity: 2.7, sunDir: SUN,
  hemiSky: '#d2ecff', hemiGround: '#6aa84a', hemiIntensity: 1.05,
  exposure: 1.0, night: false, bloomStrength: 0.22,
};

const FLOWER_COLORS = ['#ff5d8f', '#ffd23f', '#ffffff', '#b47cff', '#ff7b3a', '#5fa8ff', '#ff4d6d'];
/** Patchwork farmland tones (toy quilt seen from the hills and the intro flyover). */
const FIELD_TONES = ['#8fd35a', '#6cbf4a', '#b8dd62', '#e6d36e', '#7ccf6e', '#a6da6a', '#5cb64a', '#d4dc66', '#9ccf52'];
const PATCH_U = 46, PATCH_V = 38;

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function hashI(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hedgeGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) { const g = jitter(blob(0.66, 6, 4, 0.45), 0.06, 11 + k); g.translate(0, 0.45, -0.7 + k * 0.7); parts.push(g); }
  return gradientY(combine(parts), '#2f7a2e', '#6cc04e');
}

// ───────────────────────────── Templates ─────────────────────────────

/** lod 1 = distant low-poly version (same silhouette, ~40% of the triangles). */
function roundTree(lod = 0): THREE.BufferGeometry {
  const trunk = part(new THREE.CylinderGeometry(0.3, 0.5, 3.4, lod ? 5 : 7), '#8a5a3b', 0, 1.7, 0);
  const blobs = [
    [2.3, 0, 4.7, 0], [1.75, 1.25, 5.5, 0.45], [1.65, -1.05, 5.35, -0.6], [1.45, 0.15, 6.55, -0.2],
  ].map(([r, x, y, z]) => { const g = jitter(blob(r!, lod ? 6 : 9, lod ? 4 : 6, 0.55), 0.1, 3); g.translate(x!, y!, z!); return g; });
  const fol = combine(blobs);
  gradientY(fol, '#3c9337', '#94de5c');
  return combine([trunk, fol]);
}

function pineTree(lod = 0): THREE.BufferGeometry {
  const trunk = part(new THREE.CylinderGeometry(0.28, 0.42, 2.4, lod ? 4 : 6), '#7a4e33', 0, 1.2, 0);
  const tiers = [[2.5, 3.3, 3.1], [2.0, 3.0, 4.9], [1.35, 2.6, 6.6]].map(([r, h, y]) => {
    const g = new THREE.ConeGeometry(r!, h!, lod ? 6 : 9, 1); g.translate(0, y!, 0); return g;
  });
  const fol = combine(tiers);
  gradientY(fol, '#2b7a4b', '#63bd6d');
  return combine([trunk, fol]);
}

function fruitTree(rng: Rng, lod = 0): THREE.BufferGeometry {
  const trunk = part(new THREE.CylinderGeometry(0.26, 0.42, 2.6, lod ? 5 : 7), '#8a5a3b', 0, 1.3, 0);
  const b1 = jitter(blob(2.0, lod ? 7 : 10, lod ? 5 : 7, 0.5), 0.1, 5); b1.translate(0, 3.9, 0);
  const b2 = jitter(blob(1.4, lod ? 6 : 9, lod ? 4 : 6, 0.5), 0.1, 6); b2.translate(0.9, 4.7, 0.3);
  const fol = combine([b1, b2]);
  gradientY(fol, '#3f9a3c', '#8ad85a');
  const apples: THREE.BufferGeometry[] = [];
  for (let k = 0; k < (lod ? 6 : 9); k++) {
    const a = rng.range(0, Math.PI * 2), e = rng.range(-0.3, 0.9);
    const r = 1.95;
    apples.push(part(lod ? new THREE.OctahedronGeometry(0.24, 0) : new THREE.SphereGeometry(0.2, 6, 4), k % 3 ? '#e8343f' : '#ffb13b', Math.cos(a) * Math.cos(e) * r, 3.9 + Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r));
  }
  return combine([trunk, fol, ...apples]);
}

function bushGeo(flowering: boolean, rng: Rng): THREE.BufferGeometry {
  const parts = [[1.1, 0, 0.55, 0], [0.9, 0.85, 0.45, 0.2], [0.8, -0.8, 0.4, -0.25]].map(([r, x, y, z]) => {
    const g = jitter(blob(r!, 9, 6, 0.4), 0.07, 9); g.translate(x!, y!, z!); return g;
  });
  const b = combine(parts);
  gradientY(b, '#347f31', '#7cc955');
  if (!flowering) return b;
  const dots: THREE.BufferGeometry[] = [b];
  for (let k = 0; k < 10; k++) {
    const a = rng.range(0, Math.PI * 2), e = rng.range(0.1, 1.2);
    dots.push(part(new THREE.IcosahedronGeometry(0.13, 0), k % 2 ? '#ff7eb6' : '#ffffff', Math.cos(a) * Math.cos(e) * 1.05, 0.55 + Math.sin(e) * 1.0, Math.sin(a) * Math.cos(e) * 1.05));
  }
  return combine(dots);
}

function flowerCluster(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = blob(0.55, 7, 4, 0.2); base.scale(1.6, 0.45, 1.6); paint0(base, '#4c9a3a'); parts.push(base);
  for (let k = 0; k < 9; k++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0.1, 1.1);
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = rng.range(0.35, 0.65);
    parts.push(part(new THREE.CylinderGeometry(0.025, 0.03, h, 3), '#3f8a33', x, h / 2, z));
    parts.push(part(new THREE.OctahedronGeometry(0.15, 0), rng.pick(FLOWER_COLORS), x, h + 0.05, z, 0, rng.range(0, 3), 0, 1.3, 0.8, 1.3));
  }
  return combine(parts);
}
function paint0(g: THREE.BufferGeometry, c: string): void { part(g, c); }

function grassTuft(rng: Rng): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const g = new THREE.ConeGeometry(0.07, rng.range(0.45, 0.8), 3, 1);
    g.translate(0, 0.3, 0);
    g.rotateZ(rng.range(-0.35, 0.35)); g.rotateX(rng.range(-0.35, 0.35));
    g.translate(rng.range(-0.25, 0.25), 0, rng.range(-0.25, 0.25));
    blades.push(g);
  }
  const t = combine(blades);
  gradientY(t, '#3f8a2f', '#a4e36e');
  return t;
}

function haybale(): THREE.BufferGeometry {
  const side = part(new THREE.CylinderGeometry(0.8, 0.8, 1.25, 14, 1, true), '#d9b25a');
  const capA = part(new THREE.CircleGeometry(0.8, 14), '#efd48c', 0, 0.625, 0, -Math.PI / 2);
  const capB = part(new THREE.CircleGeometry(0.8, 14), '#efd48c', 0, -0.625, 0, Math.PI / 2);
  const swirl = part(new THREE.TorusGeometry(0.42, 0.05, 4, 14), '#caa04a', 0, 0.63, 0, Math.PI / 2);
  const g = combine([side, capA, capB, swirl]);
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.78, 0);
  return g;
}

export function sheepGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wool = [[0.72, 0, 1.05, 0], [0.62, 0.35, 1.2, 0.5], [0.62, -0.35, 1.2, 0.5], [0.62, 0.35, 1.15, -0.45], [0.62, -0.35, 1.15, -0.45], [0.58, 0, 1.45, 0.05], [0.5, 0, 1.05, -0.85]];
  for (const [r, x, y, z] of wool) { const g = new THREE.SphereGeometry(r!, 10, 8); g.translate(x!, y!, z!); parts.push(g); }
  const body = combine(parts.splice(0));
  gradientY(body, '#e9e4da', '#ffffff');
  parts.push(body);
  const face = '#2f2a2e';
  parts.push(part(new THREE.SphereGeometry(0.4, 10, 8), face, 0, 1.3, 1.05, 0, 0, 0, 0.85, 1, 1.2));
  parts.push(part(new THREE.SphereGeometry(0.3, 8, 6), '#ffffff', 0, 1.62, 0.95));
  parts.push(part(new THREE.BoxGeometry(0.42, 0.14, 0.2), face, 0.42, 1.38, 0.95, 0, 0, -0.5));
  parts.push(part(new THREE.BoxGeometry(0.42, 0.14, 0.2), face, -0.42, 1.38, 0.95, 0, 0, 0.5));
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.SphereGeometry(0.1, 8, 6), '#ffffff', sx * 0.17, 1.42, 1.42));
    parts.push(part(new THREE.SphereGeometry(0.055, 6, 4), '#111111', sx * 0.18, 1.43, 1.5));
  }
  for (const [x, z] of [[0.35, 0.5], [-0.35, 0.5], [0.35, -0.5], [-0.35, -0.5]]) parts.push(part(new THREE.CylinderGeometry(0.11, 0.09, 0.75, 6), face, x!, 0.38, z!));
  return combine(parts);
}

function windmillBody(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(part(new THREE.CylinderGeometry(3.9, 4.4, 3.4, 10), '#b8b0a2', 0, -1.05, 0));
  p.push(part(new THREE.CylinderGeometry(2.3, 3.4, 11.8, 8), '#f4ead6', 0, 6.4, 0));
  p.push(part(new THREE.CylinderGeometry(2.55, 2.55, 0.45, 8), '#d94b4b', 0, 12.3, 0));
  p.push(part(new THREE.CylinderGeometry(3.4, 3.4, 0.25, 12), '#9a6a45', 0, 5.2, 0));
  p.push(part(new THREE.ConeGeometry(3.05, 3.9, 8), '#d94b4b', 0, 14.45, 0));
  p.push(part(new THREE.SphereGeometry(0.35, 8, 6), '#ffd23f', 0, 16.5, 0));
  p.push(part(new THREE.BoxGeometry(1.5, 2.4, 0.4), '#7a4a2a', 0, 2.5, 3.28, -0.09));
  p.push(part(new THREE.BoxGeometry(1.8, 0.3, 0.45), '#f4ead6', 0, 3.8, 3.3, -0.09));
  for (const [y, z] of [[7.5, 2.95], [10.2, 2.62]]) {
    p.push(part(new THREE.BoxGeometry(1.0, 1.2, 0.3), '#ffffff', 0, y!, z!, -0.09));
    p.push(part(new THREE.BoxGeometry(0.72, 0.9, 0.32), '#3b6ea8', 0, y!, z! + 0.03, -0.09));
  }
  p.push(part(new THREE.CylinderGeometry(0.55, 0.7, 1.6, 10), '#6d4a33', 0, 12.9, 2.6, Math.PI / 2));
  return combine(p);
}

function windmillBlades(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(part(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 12), '#d94b4b', 0, 0, 0.1, Math.PI / 2));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const arm = [
      part(new THREE.BoxGeometry(0.34, 7.6, 0.24), '#7a4a2a', 0, 4.0, 0),
      part(new THREE.BoxGeometry(1.9, 5.8, 0.1), k % 2 ? '#fbf6ea' : '#fde9e0', 1.08, 4.6, -0.05),
      part(new THREE.BoxGeometry(1.95, 0.35, 0.14), '#d94b4b', 1.08, 7.45, -0.03),
      part(new THREE.BoxGeometry(2.0, 0.08, 0.14), '#b98552', 1.08, 3.2, 0.03),
      part(new THREE.BoxGeometry(2.0, 0.08, 0.14), '#b98552', 1.08, 5.0, 0.03),
    ];
    const g = combine(arm);
    g.rotateZ(a);
    p.push(g);
  }
  return combine(p);
}

function gambrel(w: number, wallH: number, peak: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w, 0); s.lineTo(w, 0); s.lineTo(w, wallH); s.lineTo(w * 0.72, wallH + (peak - wallH) * 0.66);
  s.lineTo(0, peak); s.lineTo(-w * 0.72, wallH + (peak - wallH) * 0.66); s.lineTo(-w, wallH); s.closePath();
  return s;
}

function barnGeo(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  const W = 6, H = 6, PK = 10.6, D = 16;
  const body = new THREE.ExtrudeGeometry(gambrel(W, H, PK), { depth: D, bevelEnabled: false });
  body.translate(0, 0, -D / 2);
  p.push(part(body, '#c8323a'));
  // roof panels
  const pts: Array<[number, number]> = [[W, H], [W * 0.72, H + (PK - H) * 0.66], [0, PK], [-W * 0.72, H + (PK - H) * 0.66], [-W, H]];
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k]!, [x1, y1] = pts[k + 1]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    p.push(part(new THREE.BoxGeometry(len + 0.45, 0.32, D + 0.9), '#5b4a4f', (x0 + x1) / 2 + nx * 0.16, (y0 + y1) / 2 + ny * 0.16, 0, 0, 0, ang));
  }
  // front: big door, X boards, trim, loft
  const fz = D / 2 + 0.05;
  p.push(part(new THREE.BoxGeometry(5.2, 4.6, 0.2), '#a8242c', 0, 2.3, fz));
  p.push(part(new THREE.BoxGeometry(5.6, 0.3, 0.3), '#ffffff', 0, 4.7, fz + 0.05));
  p.push(part(new THREE.BoxGeometry(0.3, 4.7, 0.3), '#ffffff', 2.7, 2.35, fz + 0.05));
  p.push(part(new THREE.BoxGeometry(0.3, 4.7, 0.3), '#ffffff', -2.7, 2.35, fz + 0.05));
  p.push(part(new THREE.BoxGeometry(0.3, 4.7, 0.3), '#ffffff', 0, 2.35, fz + 0.05));
  for (const sx of [-1, 1]) for (const sgn of [-1, 1]) p.push(part(new THREE.BoxGeometry(0.26, 5.1, 0.25), '#ffffff', sx * 1.35, 2.3, fz + 0.1, 0, 0, sgn * 0.5));
  p.push(part(new THREE.BoxGeometry(2.2, 2.0, 0.2), '#ffffff', 0, 7.6, fz));
  p.push(part(new THREE.BoxGeometry(1.7, 1.5, 0.25), '#6b2a1f', 0, 7.6, fz + 0.03));
  for (const sx of [-1, 1]) p.push(part(new THREE.BoxGeometry(0.3, H, 0.3), '#ffffff', sx * (W - 0.1), H / 2, fz));
  // side windows
  for (const sx of [-1, 1]) for (const z of [-4, 0, 4]) {
    p.push(part(new THREE.BoxGeometry(0.2, 1.3, 1.3), '#ffffff', sx * (W + 0.05), 3.2, z));
    p.push(part(new THREE.BoxGeometry(0.25, 0.95, 0.95), '#3b5b8a', sx * (W + 0.07), 3.2, z));
  }
  // silo
  p.push(part(new THREE.CylinderGeometry(2.4, 2.5, 13.5, 16), '#a7b8c9', W + 3.6, 6.75, -3));
  p.push(part(new THREE.SphereGeometry(2.45, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#d5dde6', W + 3.6, 13.5, -3));
  for (const y of [3, 6.5, 10]) p.push(part(new THREE.CylinderGeometry(2.52, 2.52, 0.22, 16), '#7d8fa3', W + 3.6, y, -3));
  // weather vane
  p.push(part(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 4), '#333333', 0, PK + 0.9, 0));
  p.push(part(new THREE.ConeGeometry(0.25, 0.9, 4), '#ffd23f', 0, PK + 1.6, 0.3, Math.PI / 2));
  return combine(p);
}

function balloonGeo(colors: string[]): THREE.BufferGeometry {
  const prof = [[0.05, 0], [1.1, 0.45], [2.9, 2.1], [4.4, 4.5], [5.1, 7.0], [4.8, 9.3], [3.7, 11.0], [1.9, 12.0], [0.05, 12.3]]
    .map(([r, y]) => new THREE.Vector2(r!, y!));
  const lathe = new THREE.LatheGeometry(prof, 18);
  lathe.computeVertexNormals();
  const env = lathe.toNonIndexed();
  lathe.dispose();
  const pos = env.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const cs = colors.map(c => new THREE.Color(c));
  const band = new THREE.Color('#ffffff');
  for (let t = 0; t < pos.count; t += 3) {
    const cx = pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2), cz = pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2);
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const seg = Math.floor(((Math.atan2(cx, cz) / (Math.PI * 2) + 1) % 1) * 18) % 18;
    const c = cy > 6.4 && cy < 7.6 ? band : cs[seg % cs.length]!;
    for (let k = 0; k < 3; k++) { col[(t + k) * 3] = c.r; col[(t + k) * 3 + 1] = c.g; col[(t + k) * 3 + 2] = c.b; }
  }
  env.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const p: THREE.BufferGeometry[] = [env];
  p.push(part(new THREE.BoxGeometry(1.7, 1.2, 1.7), '#9a6233', 0, -3.1, 0));
  p.push(part(new THREE.TorusGeometry(0.95, 0.12, 5, 12), '#6e4424', 0, -2.5, 0, Math.PI / 2, 0, 0, 1, 1, 1));
  for (const [x, z] of [[0.75, 0.75], [-0.75, 0.75], [0.75, -0.75], [-0.75, -0.75]]) {
    const len = 3.0;
    p.push(part(new THREE.CylinderGeometry(0.04, 0.04, len, 3), '#5a4030', x! * 0.9, -1.1, z! * 0.9, z! * 0.12, 0, -x! * 0.12));
  }
  p.push(part(new THREE.ConeGeometry(0.3, 0.8, 6), '#ff9f1c', 0, -1.6, 0));
  return combine(p);
}

const BALLOON_SCHEMES = [
  ['#ff4d6d', '#ffd23f'], ['#3aa7e0', '#ffffff', '#ff9f1c'], ['#7bd389', '#ffffff'], ['#b47cff', '#ff7eb6', '#ffd23f'],
];

// ───────────────────────────── Builder ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildMeadowScenery(ctx));
}

function buildMeadowScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const q = quality.scenery;
  const bag = new Bag();
  const mats = new Materials(bag);
  const root = bag.add(scene, new THREE.Group());
  root.name = 'scenery-meadow';
  const seed = track.def.scenerySeed;
  const rng = new Rng(seed ^ 0x5eed);
  const ext = trackExtent(track);
  const terrain = buildTerrain(track, { ground: PAL.ground, groundAlt: PAL.groundAlt, pitColor: PAL.pitColor, hills: 16, seed });
  terrain.mesh.receiveShadow = true;
  bag.add(root, terrain.mesh);
  bag.track(terrain);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const lush = new THREE.Color('#3f9e3a'), sunny = new THREE.Color('#a9d95a'), clover = new THREE.Color('#58b85a');
  const distTo = distanceField(track, terrain.bounds, 16);
  const theta = rng.range(0, Math.PI), cT = Math.cos(theta), sT = Math.sin(theta);
  const fieldTones = FIELD_TONES.map(c => new THREE.Color(c));
  const colOff = (iu: number) => hashI(iu, 7, seed) * PATCH_V;
  const patchAt = (x: number, z: number) => {
    const u = x * cT + z * sT, v = -x * sT + z * cT;
    const iu = Math.floor(u / PATCH_U);
    return { iu, iv: Math.floor((v + colOff(iu)) / PATCH_V) };
  };
  recolorTerrain(terrain.mesh, (x, y, z, c, ny) => {
    if (c.g < c.r * 1.05) return; // pit / non-grass tones stay
    const a = noise2(x / 60, z / 60, seed + 3), b = noise2(x / 23, z / 23, seed + 5);
    c.lerp(a > 0 ? sunny : lush, Math.min(0.55, Math.abs(a) * 0.9));
    c.lerp(clover, Math.max(0, b) * 0.35);
    // mowed-lawn stripes around the circuit, patchwork fields further out
    const dT = distTo(x, z);
    const mow = 1 - smooth(40, 75, dT);
    if (mow > 0) c.multiplyScalar(1 + mow * (Math.floor((x * sT - z * cT) / 9) % 2 ? 0.05 : -0.06));
    const w = smooth(52, 110, dT);
    if (w > 0) {
      const p = patchAt(x, z), h = hashI(p.iu, p.iv, seed + 1);
      if (h < 0.82) c.lerp(fieldTones[Math.floor((h / 0.82) * fieldTones.length) % fieldTones.length]!, 0.72 * w);
    }
    c.multiplyScalar(0.94 + 0.1 * ny);
    void y;
  });
  const reserve = new Reserve();
  const inPit = pitZone(track);
  reserve.block(inPit);
  reserveTrackFurniture(track, reserve);
  const stat = new Batch(mats.vc(0.78), { chunk: 260, castShadow: true, receiveShadow: true, name: 'meadow-static' });
  // plain (non-instanced) meshes get their own copy of the 0.9 vertex-colour material (emissiveIntensity 1 is the
  // default, only the cache key differs): sharing one material between plain and instanced meshes makes three.js
  // re-resolve its shader program at every switch, every frame
  const plainVc09 = mats.vc(0.9, { emissiveIntensity: 1 });
  const fields = new Batch(plainVc09, { chunk: 260, receiveShadow: true, name: 'meadow-fields' });
  const m4 = new THREE.Matrix4();
  const Y = new THREE.Vector3(0, 1, 0);
  const swayTime = { value: 0 };
  const faceTrack = (x: number, z: number) => { const n = terrain.nearestTrack(x, z); return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z); };
  const groundMin = (x: number, z: number, r: number) => {
    let m = H(x, z);
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; m = Math.min(m, H(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
    return m;
  };

  // ── windmills ──
  const windmills: Array<{ blades: THREE.Object3D; speed: number; phase: number }> = [];
  const bodyGeo = bag.track(windmillBody());
  const bladeGeo = bag.track(windmillBlades());
  const addWindmill = (x: number, z: number, yaw: number, s: number) => {
    const y = groundMin(x, z, 3.5 * s) - 0.2;
    stat.add(bodyGeo, trs(x, y, z, 0, yaw, 0, s, s, s, m4));
    const blades = new THREE.Mesh(bladeGeo, mats.vc(0.7));
    blades.castShadow = true;
    const hub = new THREE.Vector3(0, 12.9, 3.5).multiplyScalar(s).applyAxisAngle(Y, yaw);
    blades.position.set(x + hub.x, y + hub.y, z + hub.z);
    blades.rotation.set(0, yaw, 0, 'YXZ');
    blades.scale.setScalar(s);
    bag.add(root, blades);
    windmills.push({ blades, speed: 0.55 + rng.range(0, 0.35), phase: rng.range(0, 6) });
    reserve.add(x, z, 8 * s);
  };

  // ── barn + silo + hay ──
  const barn = bag.track(barnGeo());
  const found = bag.track(part(new THREE.BoxGeometry(12.6, 3, 16.6), '#a39a8c', 0, -1.45, 0));
  const hay = bag.track(haybale());
  const sheepSpots: Xf[] = [];
  const addBarn = (x: number, z: number, yaw: number, s: number) => {
    const y = groundMin(x, z, 8 * s) + 0.05;
    stat.add(barn, trs(x, y, z, 0, yaw, 0, s, s, s, m4));
    stat.add(found, trs(x, y, z, 0, yaw, 0, s, s, s, m4));
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let k = 0; k < 5; k++) {
      const ox = -8 - (k % 3) * 1.8, oz = 9 + Math.floor(k / 3) * 2;
      const hx = x + (rx * ox + fx * oz) * s, hz = z + (rz * ox + fz * oz) * s;
      if (!terrain.inCorridor(hx, hz, 2)) stat.add(hay, trs(hx, H(hx, hz) - 0.1, hz, 0, yaw + k * 0.3, 0, s, s, s, m4));
    }
    reserve.add(x, z, 15 * s);
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(17, 28) * s;
      const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
      if (!terrain.inCorridor(sx, sz, 3) && reserve.ok(sx, sz, 1)) sheepSpots.push({ x: sx, y: H(sx, sz), z: sz, ry: rng.range(0, 6.3), s: rng.range(0.85, 1.1) });
    }
  };

  // ── balloons ──
  const balloonGeos = BALLOON_SCHEMES.map(sc => bag.track(balloonGeo(sc)));
  const balloons: Array<{ obj: THREE.Object3D; x: number; y: number; z: number; ph: number; drift: number }> = [];
  const addBalloon = (x: number, y: number, z: number, s: number) => {
    const m = new THREE.Mesh(balloonGeos[balloons.length % balloonGeos.length]!, mats.vc(0.6));
    // high in the sky: a crisp 20 m shadow blob on the grass reads as a hole, so no shadow
    m.scale.setScalar(s);
    m.position.set(x, y, z);
    bag.add(root, m);
    balloons.push({ obj: m, x, y, z, ph: rng.range(0, 6.28), drift: rng.range(4, 9) });
  };

  // ── big lone tree (landmark 'tree' / generic) ──
  const bigTree = bag.track(roundTree());
  const bush = bag.track(bushGeo(true, rng));
  const addGeneric = (x: number, z: number, s: number) => {
    stat.add(bigTree, trs(x, H(x, z) - 0.2, z, 0, rng.range(0, 6), 0, 1.9 * s, 1.9 * s, 1.9 * s, m4));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + rng.range(-0.3, 0.3), r = rng.range(5, 8) * s;
      const bx = x + Math.cos(a) * r, bz = z + Math.sin(a) * r;
      if (!terrain.inCorridor(bx, bz, 2)) stat.add(bush, trs(bx, H(bx, bz) - 0.1, bz, 0, a, 0, s, s, s, m4));
    }
    reserve.add(x, z, 9 * s);
  };

  // ── striped flower fields ──
  const rowTemplates = FLOWER_COLORS.slice(0, 5).map(c => {
    const p: THREE.BufferGeometry[] = [part(new THREE.BoxGeometry(1.25, 0.4, 1.05), '#3f8f38', 0, 0.12, 0)];
    for (let k = 0; k < 3; k++) p.push(part(new THREE.OctahedronGeometry(0.24, 0), c, (k - 1) * 0.38, 0.5 + (k % 2) * 0.08, (k % 2 - 0.5) * 0.3, 0, k, 0, 1.2, 0.85, 1.2));
    return bag.track(combine(p));
  });
  const addField = (x: number, z: number, yaw: number, s: number) => {
    const rows = 9, len = 34 * s, gap = 2.4;
    const cols = [...rowTemplates].sort(() => rng.next() - 0.5);
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let r = 0; r < rows; r++) {
      const off = (r - (rows - 1) / 2) * gap;
      const tpl = cols[r % 4]!;
      for (let a = -len / 2; a <= len / 2; a += 1.0) {
        const wx = x + rx * off + fx * a, wz = z + rz * off + fz * a;
        if (terrain.inCorridor(wx, wz, 1.5)) continue;
        fields.add(tpl, trs(wx, H(wx, wz) - 0.05, wz, 0, yaw, 0, 1, 1, 1, m4));
      }
    }
    reserve.add(x, z, Math.max(len, rows * gap) * 0.55);
  };

  // ── landmarks from the track ──
  let nWind = 0, nBarn = 0, nBalloon = 0, nField = 0;
  for (const l of track.landmarks) {
    if (isTrackMeshKind(l.kind)) continue;
    const k = normKind(l.kind);
    const pl = landmarkPlace(track, l, H);
    if (k === 'balloon' || k === 'balloons' || k === 'hotairballoon' || (pl.side === 'over' && k !== 'windmill')) {
      addBalloon(pl.x, pl.frame.y + 38 + 6 * pl.scale, pl.z, pl.scale); nBalloon++;
    } else if (k === 'windmill' || k === 'mill') { addWindmill(pl.x, pl.z, pl.yaw, pl.scale); nWind++; }
    else if (k === 'barn' || k === 'farm' || k === 'farmhouse' || k === 'silo') { addBarn(pl.x, pl.z, pl.yaw, pl.scale); nBarn++; }
    else if (k === 'flowers' || k === 'flowerfield' || k === 'field' || k === 'tulips') { addField(pl.x, pl.z, pl.yaw, pl.scale); nField++; }
    else if (k === 'haybale' || k === 'hay' || k === 'haybales') {
      for (let j = 0; j < 6; j++) { const hx = pl.x + rng.range(-5, 5), hz = pl.z + rng.range(-5, 5); stat.add(hay, trs(hx, H(hx, hz) - 0.1, hz, 0, rng.range(0, 6), 0, pl.scale, pl.scale, pl.scale, m4)); }
      reserve.add(pl.x, pl.z, 7);
    } else addGeneric(pl.x, pl.z, pl.scale);
  }

  // ── make sure the signature props exist on any layout ──
  const spots = scatter(terrain, 80, seed + 71, { minDist: 42, maxDist: 115, pad: 8 });
  const takeSpot = (r: number) => {
    for (const p of spots) if (clearOf(terrain, p.x, p.z, r) && reserve.ok(p.x, p.z, r + 4)) return p;
    return null;
  };
  while (nWind < 2) { const p = takeSpot(9); if (!p) break; addWindmill(p.x, p.z, faceTrack(p.x, p.z), rng.range(0.9, 1.15)); nWind++; }
  if (nBarn < 1) { const p = takeSpot(17); if (p) addBarn(p.x, p.z, faceTrack(p.x, p.z), 1); }
  const wantFields = Math.max(2, qcount(4, q));
  while (nField < wantFields) { const p = takeSpot(21); if (!p) break; addField(p.x, p.z, faceTrack(p.x, p.z), rng.range(0.8, 1.1)); nField++; }
  for (let k = nBalloon; k < 2; k++) {
    const f = frameAt(track, rng.range(0, track.length)), d = rng.chance(0.5) ? 36 : -36;
    addBalloon(f.x + f.rx * d, f.y + 40, f.z + f.rz * d, 1.2);
  }
  for (let k = 0; k < 3; k++) {
    const a = rng.range(0, Math.PI * 2), r = ext.r * rng.range(0.9, 1.4);
    addBalloon(ext.cx + Math.cos(a) * r, ext.maxY + rng.range(55, 90), ext.cz + Math.sin(a) * r, rng.range(1.4, 2));
  }

  // ── road-side farm fences in stretches ──
  const post = bag.track(part(new THREE.BoxGeometry(0.24, 1.35, 0.24), '#f6f1e6', 0, 0.55, 0));
  const rail = bag.track(combine([
    part(new THREE.BoxGeometry(0.1, 0.16, 1), '#f6f1e6', 0, 0.65, 0),
    part(new THREE.BoxGeometry(0.1, 0.16, 1), '#f6f1e6', 0, 1.05, 0),
  ]));
  for (const side of [-1, 1]) {
    let s = rng.range(0, 40);
    while (s < track.length) {
      const runLen = rng.range(25, 70);
      let prev: { x: number; y: number; z: number } | null = null;
      for (let a = 0; a < runLen; a += 2.8) {
        const f = frameAt(track, s + a);
        const i = f.i;
        const edge = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
        const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
        const d = side * (wall + 4.5);
        const x = f.x + f.rx * d, z = f.z + f.rz * d;
        if (edge !== 0 || terrain.inCorridor(x, z, 1.2) || !reserve.ok(x, z, 0.5)) { prev = null; continue; }
        const y = H(x, z);
        stat.add(post, trs(x, y, z, 0, f.yaw, 0, 1, 1, 1, m4));
        if (prev) {
          const dx = x - prev.x, dz = z - prev.z, dy = y - prev.y, len = Math.hypot(dx, dz);
          if (len < 4) stat.add(rail, trs((x + prev.x) / 2, (y + prev.y) / 2, (z + prev.z) / 2, -Math.atan2(dy, len), Math.atan2(dx, dz), 0, 1, 1, len, m4));
        }
        prev = { x, y, z };
      }
      s += runLen + rng.range(40, 120);
    }
  }

  // ── hedgerows along the patchwork field borders (+ the odd hedgerow tree) ──
  const hedgeXf: Xf[] = [], hedgeTrees: Array<{ x: number; y: number; z: number }> = [];
  {
    const tb = terrain.bounds;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const [x, z] of [[tb.minX, tb.minZ], [tb.maxX, tb.minZ], [tb.minX, tb.maxZ], [tb.maxX, tb.maxZ]] as const) {
      const u = x * cT + z * sT, v = -x * sT + z * cT;
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
    }
    const toW = (u: number, v: number) => ({ x: u * cT - v * sT, z: u * sT + v * cT });
    const inB = (x: number, z: number) => x > tb.minX + 25 && x < tb.maxX - 25 && z > tb.minZ + 25 && z < tb.maxZ - 25;
    const maxHedges = qcount(620, q);
    const edge = (u0: number, v0: number, u1: number, v1: number, h: number) => {
      const segs = 3;
      for (let k = 0; k < segs && hedgeXf.length < maxHedges; k++) {
        const a = toW(u0 + (u1 - u0) * (k / segs), v0 + (v1 - v0) * (k / segs));
        const b = toW(u0 + (u1 - u0) * ((k + 1) / segs), v0 + (v1 - v0) * ((k + 1) / segs));
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        if (!inB(mx, mz) || distTo(mx, mz) < 60 || distTo(mx, mz) > 420) continue;
        if (terrain.inCorridor(mx, mz, 8) || !reserve.ok(mx, mz, 3)) continue;
        const ya = H(a.x, a.z), yb = H(b.x, b.z), len = Math.hypot(b.x - a.x, b.z - a.z);
        hedgeXf.push({ x: mx, y: (ya + yb) / 2 - 0.15, z: mz, ry: Math.atan2(b.x - a.x, b.z - a.z), rx: -Math.atan2(yb - ya, len), sx: 1.35, sy: 1.25, sz: len / 2.55 });
        if (hashI(Math.round(mx), Math.round(mz), seed + 9) < h) hedgeTrees.push({ x: a.x, y: ya, z: a.z });
      }
    };
    for (let iu = Math.floor(uMin / PATCH_U); iu <= Math.ceil(uMax / PATCH_U); iu++) {
      const off = colOff(iu);
      for (let iv = Math.floor((vMin + off) / PATCH_V); iv <= Math.ceil((vMax + off) / PATCH_V); iv++) {
        const u0 = iu * PATCH_U, v0 = iv * PATCH_V - off;
        if (hashI(iu, iv, seed + 21) < 0.55) edge(u0, v0, u0, v0 + PATCH_V, 0.18);
        if (hashI(iu, iv, seed + 22) < 0.55) edge(u0, v0, u0 + PATCH_U, v0, 0.18);
      }
    }
  }
  addInstanced(root, bag, hedgeGeo(), mats.vc(0.9), hedgeXf, { colors: ['#ffffff', '#eaffd9', '#f4ffe6'], receiveShadow: true, name: 'hedgerows' });

  stat.build(root, bag);
  fields.build(root, bag);

  // ── instanced vegetation ──
  const treeMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  applySway(treeMat, swayTime, 0.0032, 1.1);
  const grassMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  applySway(grassMat, swayTime, 0.22, 2.1);
  const ok = (p: { x: number; z: number }, r: number) => reserve.ok(p.x, p.z, r);
  const treePts = [
    ...scatter(terrain, qcount(100, q), seed + 1, { minDist: 16, maxDist: 48, pad: 5 }),
    ...scatter(terrain, qcount(120, q), seed + 2, { minDist: 48, maxDist: 170, pad: 6 }),
    ...scatter(terrain, qcount(130, q), seed + 3, { minDist: 170, maxDist: 900, pad: 6 }),
  ].filter(p => ok(p, 3));
  // groves
  for (const c of scatter(terrain, qcount(9, q), seed + 33, { minDist: 50, maxDist: 220, pad: 10 })) {
    for (let k = 0; k < 7; k++) {
      const x = c.x + rng.range(-13, 13), z = c.z + rng.range(-13, 13);
      if (!terrain.inCorridor(x, z, 5) && reserve.ok(x, z, 3)) treePts.push({ x, y: H(x, z), z, r: rng.range(0, 6.3), s: rng.range(0.8, 1.3) });
    }
  }
  for (const t of hedgeTrees) treePts.push({ x: t.x, y: t.y, z: t.z, r: rng.range(0, 6.3), s: rng.range(0.9, 1.3) });
  const tints = ['#ffffff', '#eaffd9', '#fff3cf', '#dcffe9', '#f2ffe0'];
  const near: Xf[][] = [[], [], []], far: Xf[][] = [[], [], []];
  for (const p of treePts) {
    const t = rng.next();
    const k = t < 0.55 ? 0 : t < 0.8 ? 1 : 2;
    const list = distTo(p.x, p.z) < 110 ? near : far;
    list[k]!.push({ x: p.x, y: p.y - 0.2, z: p.z, ry: p.r, s: p.s * rng.range(0.85, 1.2) });
  }
  const treeGeos = [roundTree(), pineTree(), fruitTree(rng)];
  const treeLods = [roundTree(1), pineTree(1), fruitTree(rng, 1)];
  treeGeos.forEach((g, k) => {
    addInstanced(root, bag, g, treeMat, near[k]!, { colors: tints, castShadow: true, receiveShadow: true, name: `tree${k}` });
    addInstanced(root, bag, treeLods[k]!, treeMat, far[k]!, { colors: tints, name: `treeFar${k}` });
  });

  const bushPts = scatter(terrain, qcount(220, q), seed + 4, { minDist: 12, maxDist: 150, pad: 3 }).filter(p => ok(p, 1.5));
  const bushXf: Xf[][] = [[], []];
  bushPts.forEach((p, k) => bushXf[k % 2]!.push({ x: p.x, y: p.y - 0.1, z: p.z, ry: p.r, s: p.s }));
  [bushGeo(false, rng), bushGeo(true, rng)].forEach((g, k) => addInstanced(root, bag, g, treeMat, bushXf[k]!, { colors: tints, castShadow: true, receiveShadow: true, name: `bush${k}` }));

  // flowers: a light scatter plus dense wildflower patches
  const flowerPts = scatter(terrain, qcount(180, q), seed + 5, { minDist: 10, maxDist: 80, pad: 2 }).filter(p => ok(p, 1));
  const butterflySpots: Array<{ x: number; y: number; z: number }> = [];
  for (const c of scatter(terrain, qcount(34, q), seed + 55, { minDist: 12, maxDist: 70, pad: 4 })) {
    if (distTo(c.x, c.z) < 42 && butterflySpots.length < qcount(12, q) && reserve.ok(c.x, c.z, 2)) butterflySpots.push(c);
    for (let k = 0; k < 11; k++) {
      const a = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.next()) * 6.5;
      const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      if (!terrain.inCorridor(x, z, 2) && reserve.ok(x, z, 1)) flowerPts.push({ x, y: H(x, z), z, r: rng.range(0, 6.3), s: rng.range(0.8, 1.2) });
    }
  }
  const flXf: Xf[][] = [[], []];
  flowerPts.forEach((p, k) => flXf[k % 2]!.push({ x: p.x, y: p.y - 0.05, z: p.z, ry: p.r, s: p.s * 1.6 }));
  [flowerCluster(rng), flowerCluster(rng)].forEach((g, k) => addInstanced(root, bag, g, grassMat, flXf[k]!, { receiveShadow: true, name: `flowers${k}` }));

  const grassPts = scatter(terrain, qcount(1500, q), seed + 6, { minDist: 8, maxDist: 95, pad: 0.6 }).filter(p => !inPit(p.x, p.z));
  addInstanced(root, bag, grassTuft(rng), grassMat, grassPts.map(p => ({ x: p.x, y: p.y - 0.05, z: p.z, ry: p.r, s: p.s * 1.2 })), { receiveShadow: true, name: 'grass' });

  const rockPts = scatter(terrain, qcount(45, q), seed + 7, { minDist: 14, maxDist: 220, pad: 3 }).filter(p => ok(p, 1));
  addInstanced(root, bag, rockGeo(1, '#a9a49a', seed, 0.6), mats.vc(0.9), rockPts.map(p => ({ x: p.x, y: p.y - 0.2, z: p.z, ry: p.r, s: p.s * rng.range(0.5, 1.6) })), { castShadow: true, receiveShadow: true, name: 'rocks' });

  const hayPts = scatter(terrain, qcount(24, q), seed + 8, { minDist: 28, maxDist: 150, pad: 3 }).filter(p => ok(p, 1.5));
  addInstanced(root, bag, haybale(), mats.vc(0.9), hayPts.map(p => ({ x: p.x, y: p.y - 0.1, z: p.z, ry: p.r })), { castShadow: true, receiveShadow: true, name: 'hay' });

  for (const c of scatter(terrain, qcount(3, q), seed + 9, { minDist: 30, maxDist: 90, pad: 5 })) {
    for (let k = 0; k < 5; k++) {
      const x = c.x + rng.range(-7, 7), z = c.z + rng.range(-7, 7);
      if (!terrain.inCorridor(x, z, 2.5) && reserve.ok(x, z, 1)) sheepSpots.push({ x, y: H(x, z), z, ry: rng.range(0, 6.3), s: rng.range(0.8, 1.05) });
    }
  }
  addInstanced(root, bag, sheepGeo(), mats.vc(0.9), sheepSpots, { castShadow: true, receiveShadow: true, name: 'flock-sheep' });

  // ── pits (water under bridges) ──
  const water = createWaterMaterial({ deep: '#1c6fb8', shallow: PAL.pitColor, foam: '#f4fbff', sky: '#bfe3ff', sunDir: SUN, sunColor: '#fff2d9', waves: 0.5, depthRange: 7 });
  bag.track(water);
  waterPits(track, H, water, bag, root, 7);

  // ── horizon & sky extras ──
  const tb = terrain.bounds;
  const tcx = (tb.minX + tb.maxX) / 2, tcz = (tb.minZ + tb.maxZ) / 2;
  const half = Math.min(tb.maxX - tb.minX, tb.maxZ - tb.minZ) / 2;
  const base = ext.minY - 1;
  bag.add(root, buildFarGround(tcx, tcz, half * 0.8, half + 900, base - 9, '#5aa845'));
  bag.add(root, buildRing({ seed: seed + 11, cx: tcx, cz: tcz, radius: half + 50, baseY: base - 6, hMin: 16, hMax: 52, bottom: '#66a95c', top: '#8cc486', sunDir: SUN, jag: 0.5 }));
  bag.add(root, buildRing({ seed: seed + 12, cx: tcx, cz: tcz, radius: half + 300, baseY: base - 10, hMin: 45, hMax: 175, bottom: '#8fb5dc', top: '#6d92c9', snow: { color: '#f5f9ff', above: 0.66 }, sunDir: SUN, facets: true, peak: 1.45, jag: 1.3 }));
  bag.add(root, buildRing({ seed: seed + 15, cx: tcx, cz: tcz, radius: half + 560, baseY: base - 10, hMin: 90, hMax: 270, bottom: '#b0cdec', top: '#96b6e1', snow: { color: '#f7faff', above: 0.6 }, sunDir: SUN, facets: true, peak: 1.6, jag: 1.4, segments: 150 }));
  const clouds = buildClouds({ seed: seed + 13, count: Math.max(8, qcount(18, q)), cx: ext.cx, cz: ext.cz, rMin: 90, rMax: half + 320, yMin: 120, yMax: 200, top: '#ffffff', bottom: '#dde8f6', size: 1.1, emissiveIntensity: 0.55 });
  bag.add(root, clouds);
  const flock = bag.track(new Flock({ seed: seed + 14, count: qcount(14, q), cx: ext.cx, cz: ext.cz, spread: ext.r * 0.7, yMin: 38, yMax: 70, color: '#3a3848', size: 1.2 }));
  bag.add(root, flock.mesh);
  // butterflies over the road-side wildflower patches (seen at kart height)
  const butterflies = bag.track(new Butterflies(butterflySpots, 3, seed + 61, ['#ffd23f', '#ff7eb6', '#ffffff', '#7fd3ff', '#ff9f1c', '#c9a0ff']));
  bag.add(root, butterflies.mesh);

  // ── movers ──
  const rigs: MoverRig[] = [];
  let moverSheep: THREE.BufferGeometry | null = null, moverGeneric: THREE.BufferGeometry | null = null;

  return {
    environment: MEADOW_ENV,
    update(dt, time) {
      swayTime.value = time;
      for (const w of windmills) w.blades.rotation.z = -(time * w.speed + w.phase);
      for (const b of balloons) {
        b.obj.position.set(b.x + Math.sin(time * 0.05 + b.ph) * b.drift, b.y + Math.sin(time * 0.4 + b.ph) * 1.4, b.z + Math.cos(time * 0.043 + b.ph) * b.drift);
        b.obj.rotation.y = Math.sin(time * 0.1 + b.ph) * 0.6;
      }
      clouds.rotation.y = time * 0.0025;
      flock.update(time);
      butterflies.update(time);
      water.uniforms.uTime.value = time;
      for (const r of rigs) {
        const t = time * 7 + r.phase;
        if (r.kind === 'sheep') {
          // trot + waddle; walk round at the end of a sweep instead of snapping 180°
          faceSmooth(r, dt, 4.5);
          r.inner.position.y = Math.abs(Math.sin(t)) * 0.14; r.inner.rotation.z = Math.sin(t) * 0.07; r.inner.rotation.x = Math.cos(t * 2) * 0.03;
        } else updateGeneric(r, time);
      }
    },
    createMover(look) {
      const k = normKind(look);
      let rig: MoverRig;
      if (k === 'sheep' || k === 'lamb') {
        moverSheep ??= bag.track(sheepGeo());
        const inner = new THREE.Mesh(moverSheep, plainVc09);
        inner.scale.setScalar(k === 'lamb' ? 0.8 : 1.1);
        inner.rotation.order = 'YXZ'; // heading outermost, trot pitch/roll in the body frame
        inner.castShadow = true;
        rig = makeRig('sheep', inner, rigs.length * 1.7);
      } else {
        moverGeneric ??= bag.track(genericMoverGeo(PAL.accent));
        rig = makeGenericRig(moverGeneric, mats.vc(0.5), rigs.length * 1.7);
      }
      rigs.push(rig);
      return rig.root;
    },
    dispose() { bag.dispose(); rigs.length = 0; },
  };
}
