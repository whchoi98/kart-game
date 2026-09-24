/**
 * Palm Beach scenery — a turquoise animated ocean (shader swell + breaking foam) along the
 * track's most coastal side, sandy dunes, swaying palms, a striped lighthouse with a turning
 * beam, a wooden pier, pastel beach huts, umbrellas and towels, sailboats, sea-stack rock
 * arches and distant islands. Warm late-morning light.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, fbm, scatter } from '../terrain.js';
import {
  Bag, Batch, Flock, Glows, Materials, Reserve, Rng, addInstanced, applySway, blob, buildClouds, buildRing,
  buildFarGround, clearOf, combine, createWaterMaterial, distanceField, faceSmooth, frameAt, genericMoverGeo, gradientY, isTrackMeshKind,
  jitter, landmarkPlace, makeGenericRig, makeRig, naturalArchGeo, noise2, normKind, normalize, paint, part, qcount, radialTexture,
  recolorTerrain, rockGeo, stripedBall, trackExtent, trs, updateGeneric, waterGrid, waterPits, type MoverRig, type Xf, pitZone, reserveTrackFurniture, withCorridorGuard,
} from './props-a.js';

const PAL = THEME_PALETTES.beach;
const SUN: [number, number, number] = [0.5, 0.66, -0.56];

export const BEACH_ENV: EnvironmentSettings = {
  skyTop: '#2b93e6', skyHorizon: '#bdf0ff', skyBottom: '#f2d49b',
  fogColor: '#d3f1fb', fogNear: 170, fogFar: 1150,
  sunColor: '#fff0cc', sunIntensity: 2.45, sunDir: SUN,
  hemiSky: '#c4ecff', hemiGround: '#d9b98a', hemiIntensity: 0.9,
  exposure: 0.96, night: false, bloomStrength: 0.26,
};

const PASTELS = ['#ff8fab', '#7bdff2', '#ffd166', '#95e1a3', '#cdb4db', '#ffb385'];

// ───────────────────────────── Templates ─────────────────────────────

/** Double-sided palm frond strip (duplicated with flipped winding for single-sided materials). */
function frond(len: number, width: number, rise: number, droop: number, steps = 6): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], ind: number[] = [];
  const cBase = new THREE.Color('#2e8a3a'), cTip = new THREE.Color('#79c94f'), c = new THREE.Color();
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = t * len, y = len * (rise * t - droop * t * t);
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.04)), 0.7) + 0.03;
    c.copy(cBase).lerp(cTip, t);
    pos.push(x, y - 0.12 * w, -w, x, y + 0.05, 0, x, y - 0.12 * w, w);
    for (let j = 0; j < 3; j++) col.push(c.r, c.g, c.b);
    if (k > 0) {
      const a = (k - 1) * 3, b = k * 3;
      ind.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
  }
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  front.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  front.setIndex(ind);
  front.computeVertexNormals();
  const back = front.clone();
  const bi = back.index!.array as Uint16Array | Uint32Array;
  for (let i = 0; i < bi.length; i += 3) { const t = bi[i]!; bi[i] = bi[i + 1]!; bi[i + 1] = t; }
  back.computeVertexNormals();
  return combine([front, back]);
}

/** lod 1 = distant version: same silhouette (same rng stream), ~35% of the triangles. */
function palmGeo(rng: Rng, lean: number, lod = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segs = lod ? 5 : 9, segH = 1.05 * 9 / segs, leanK = lean * 9 / segs;
  let x = 0, y = 0, ang = 0;
  for (let k = 0; k < segs; k++) {
    const r0 = 0.38 - k * 0.016 * 9 / segs;
    const g = new THREE.CylinderGeometry(r0 - 0.04, r0 + 0.05, segH * 1.02, lod ? 5 : 7, 1, true);
    part(g, k % 2 ? '#a0754b' : '#b98b5c', x + Math.sin(ang) * segH / 2, y + Math.cos(ang) * segH / 2, 0, 0, 0, -ang);
    parts.push(g);
    x += Math.sin(ang) * segH; y += Math.cos(ang) * segH;
    ang += leanK;
  }
  if (!lod) for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    parts.push(part(new THREE.SphereGeometry(0.26, 6, 4), '#6b4a2b', x + Math.cos(a) * 0.3, y - 0.35, Math.sin(a) * 0.3));
  }
  const n = 8;
  for (let f = 0; f < n; f++) {
    const az = (f / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const g = frond(rng.range(3.8, 4.8), 0.55, rng.range(0.3, 0.6), rng.range(0.9, 1.3), lod ? 3 : 6);
    g.rotateY(az);
    g.translate(x, y, 0);
    parts.push(g);
  }
  parts.push(part(lod ? new THREE.IcosahedronGeometry(0.42, 0) : new THREE.SphereGeometry(0.42, 7, 5), '#3d8f3a', x, y + 0.1, 0));
  return combine(parts);
}

function umbrellaGeo(a: string, b: string): THREE.BufferGeometry {
  const pole = part(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), '#f4f4f4', 0, 1.25, 0);
  const cone = new THREE.ConeGeometry(1.7, 0.65, 12, 1, true).toNonIndexed();
  const p = cone.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  for (let t = 0; t < p.count; t += 3) {
    const cx = p.getX(t) + p.getX(t + 1) + p.getX(t + 2), cz = p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2);
    const seg = Math.floor(((Math.atan2(cx, cz) / (Math.PI * 2) + 1) % 1) * 12) % 12;
    const c = seg % 2 ? ca : cb;
    for (let k = 0; k < 3; k++) { col[(t + k) * 3] = c.r; col[(t + k) * 3 + 1] = c.g; col[(t + k) * 3 + 2] = c.b; }
  }
  cone.setAttribute('color', new THREE.BufferAttribute(col, 3));
  cone.computeVertexNormals();
  const under = cone.clone();
  const ui = normalize(under).index!.array as Uint32Array;
  for (let i = 0; i < ui.length; i += 3) { const t = ui[i]!; ui[i] = ui[i + 1]!; ui[i + 1] = t; }
  under.computeVertexNormals();
  cone.translate(0, 2.45, 0); under.translate(0, 2.45, 0);
  const tip = part(new THREE.SphereGeometry(0.1, 6, 4), '#ffffff', 0, 2.8, 0);
  return combine([pole, cone, under, tip]);
}

function hutGeo(color: string): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[1.2, 1.1], [-1.2, 1.1], [1.2, -1.1], [-1.2, -1.1]]) p.push(part(new THREE.CylinderGeometry(0.12, 0.12, 1.6, 5), '#b98552', x!, -0.1, z!));
  p.push(part(new THREE.BoxGeometry(3.0, 0.2, 3.2), '#d9b07c', 0, 0.7, 0.2));
  p.push(part(new THREE.BoxGeometry(2.6, 2.6, 2.4), color, 0, 2.1, 0));
  for (let k = 0; k < 6; k++) p.push(part(new THREE.BoxGeometry(2.62, 0.05, 2.42), '#ffffff', 0, 1.0 + k * 0.42, 0));
  const roof = new THREE.CylinderGeometry(0.01, 2.2, 1.5, 4, 1);
  roof.rotateY(Math.PI / 4);
  p.push(part(roof, '#ffffff', 0, 4.1, 0, 0, 0, 0, 1.25, 1, 1.15));
  p.push(part(new THREE.BoxGeometry(1.0, 1.8, 0.1), '#ffffff', 0, 1.8, 1.22));
  p.push(part(new THREE.BoxGeometry(0.8, 1.6, 0.12), new THREE.Color(color).multiplyScalar(0.75).getStyle(), 0, 1.75, 1.24));
  p.push(part(new THREE.SphereGeometry(0.05, 5, 4), '#ffd23f', 0.28, 1.75, 1.32));
  p.push(part(new THREE.BoxGeometry(1.2, 0.12, 0.8), '#c9a06a', 0, 0.4, 2.0));
  return combine(p);
}

function lighthouseGeo(): { body: THREE.BufferGeometry; lamp: THREE.BufferGeometry; lampY: number } {
  const p: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) p.push(rockGeo(3.2 - k * 0.2, k % 2 ? '#8c8479' : '#a39a8d', 70 + k, 0.6));
  p.forEach((g, k) => g.translate(Math.cos(k * 1.1) * 2.6, -0.4, Math.sin(k * 1.1) * 2.6));
  const bands = 5, bandH = 3.2;
  for (let k = 0; k < bands; k++) {
    const r0 = 2.8 - k * 0.2, r1 = r0 - 0.2;
    p.push(part(new THREE.CylinderGeometry(r1, r0, bandH, 16), k % 2 ? '#e8414b' : '#fbfbf6', 0, 0.6 + bandH * (k + 0.5), 0));
  }
  const top = 0.6 + bands * bandH;
  p.push(part(new THREE.CylinderGeometry(2.6, 2.3, 0.45, 16), '#35424f', 0, top + 0.2, 0));
  p.push(part(new THREE.TorusGeometry(2.45, 0.07, 4, 24), '#35424f', 0, top + 1.25, 0, Math.PI / 2));
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; p.push(part(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 4), '#35424f', Math.cos(a) * 2.45, top + 0.75, Math.sin(a) * 2.45)); }
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; p.push(part(new THREE.BoxGeometry(0.12, 2.2, 0.12), '#35424f', Math.cos(a) * 1.45, top + 1.55, Math.sin(a) * 1.45)); }
  p.push(part(new THREE.ConeGeometry(1.9, 1.7, 16), '#e8414b', 0, top + 3.5, 0));
  p.push(part(new THREE.SphereGeometry(0.3, 8, 6), '#35424f', 0, top + 4.5, 0));
  // door + windows + keeper's cottage
  p.push(part(new THREE.BoxGeometry(1.2, 2.0, 0.4), '#35424f', 0, 1.6, 2.72, -0.06));
  // windows on the tapered tower wall (radius 2.8 at the base, −0.2 per 3.2 m band)
  const towerR = (y: number) => 2.8 - 0.0625 * (y - 0.6);
  for (const y of [6, 10.5, 14]) {
    p.push(part(new THREE.BoxGeometry(0.8, 1.12, 0.16), '#fbfbf6', 0, y, towerR(y) - 0.01, -0.0625));
    p.push(part(new THREE.BoxGeometry(0.56, 0.86, 0.16), '#35424f', 0, y, towerR(y) + 0.03, -0.0625));
  }
  p.push(part(new THREE.BoxGeometry(5, 3, 4), '#fbfbf6', 5.2, 1.5, -1));
  const roof = new THREE.CylinderGeometry(0.01, 3.6, 1.8, 4, 1); roof.rotateY(Math.PI / 4);
  p.push(part(roof, '#e8414b', 5.2, 3.9, -1, 0, 0, 0, 1, 1, 0.85));
  p.push(part(new THREE.BoxGeometry(0.9, 1.7, 0.1), '#35424f', 5.2, 0.9, 1.02));
  const lamp = part(new THREE.CylinderGeometry(1.3, 1.3, 2.0, 12), '#fff3b0', 0, top + 1.5, 0);
  return { body: combine(p), lamp, lampY: top + 1.5 };
}

function cottageGeo(wall: string, roof: string): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(part(new THREE.BoxGeometry(5.2, 0.5, 4.6), '#e9dcc3', 0, 0.1, 0));
  p.push(part(new THREE.BoxGeometry(5, 3.2, 4.4), wall, 0, 1.9, 0));
  const tri = new THREE.Shape(); tri.moveTo(-3.1, 0); tri.lineTo(3.1, 0); tri.lineTo(0, 2.1); tri.closePath();
  const r = new THREE.ExtrudeGeometry(tri, { depth: 5.0, bevelEnabled: false }); r.translate(0, 3.45, -2.5);
  p.push(part(r, roof));
  p.push(part(new THREE.BoxGeometry(1.1, 2.0, 0.12), '#ffffff', 0, 1.35, 2.22));
  p.push(part(new THREE.BoxGeometry(0.9, 1.8, 0.14), new THREE.Color(wall).multiplyScalar(0.7).getStyle(), 0, 1.3, 2.24));
  for (const sx of [-1.7, 1.7]) {
    p.push(part(new THREE.BoxGeometry(1.0, 1.0, 0.12), '#ffffff', sx, 2.1, 2.22));
    p.push(part(new THREE.BoxGeometry(0.8, 0.8, 0.14), '#5fb7d6', sx, 2.1, 2.24));
    p.push(part(new THREE.BoxGeometry(0.4, 1.0, 0.1), roof, sx - 0.72, 2.1, 2.25));
    p.push(part(new THREE.BoxGeometry(0.4, 1.0, 0.1), roof, sx + 0.72, 2.1, 2.25));
  }
  p.push(part(new THREE.BoxGeometry(5.4, 0.15, 1.6), '#ffffff', 0, 3.2, 3.0));
  for (const sx of [-2.5, 2.5]) p.push(part(new THREE.CylinderGeometry(0.09, 0.09, 3.0, 5), '#ffffff', sx, 1.7, 3.6));
  p.push(part(new THREE.BoxGeometry(0.7, 1.4, 0.7), '#d9c6a5', 1.5, 5.0, -1));
  return combine(p);
}

function boatGeo(kind: 'sail' | 'motor', hull: string, sail: string): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  const s = new THREE.Shape();
  s.moveTo(0, 3.4); s.quadraticCurveTo(1.35, 1.4, 1.3, -1.6); s.lineTo(1.1, -2.4); s.lineTo(-1.1, -2.4); s.lineTo(-1.3, -1.6); s.quadraticCurveTo(-1.35, 1.4, 0, 3.4);
  const h = new THREE.ExtrudeGeometry(s, { depth: 1.1, bevelEnabled: false, curveSegments: 6 });
  h.rotateX(-Math.PI / 2);
  h.translate(0, -0.35, 0);
  p.push(part(h, hull));
  const band = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false, curveSegments: 6 });
  band.rotateX(-Math.PI / 2);
  band.scale(1.03, 1, 1.03);
  band.translate(0, 0.45, 0);
  p.push(part(band, '#1f5f9e'));
  p.push(part(new THREE.BoxGeometry(2.1, 0.1, 4.6), '#d9b07c', 0, 0.72, 0.1));
  if (kind === 'sail') {
    p.push(part(new THREE.CylinderGeometry(0.08, 0.1, 8, 5), '#f4f4f4', 0, 4.7, 0.6));
    const tri = (w: number, hh: number, z: number, dir: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, z, 0, 1 + hh, z, 0, 1, z + dir * w, 0, 1, z, 0, 1, z + dir * w, 0, 1 + hh, z], 3));
      g.computeVertexNormals();
      return part(g, sail);
    };
    p.push(tri(3.2, 7.2, 0.5, -1));
    p.push(tri(2.2, 6.0, 0.7, 1));
  } else {
    p.push(part(new THREE.BoxGeometry(1.7, 1.2, 1.8), '#ffffff', 0, 1.35, -0.4));
    p.push(part(new THREE.BoxGeometry(1.72, 0.45, 1.0), '#3b6ea8', 0, 1.6, 0.2));
    p.push(part(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 4), '#35424f', 0, 2.5, -0.8));
    p.push(part(new THREE.BoxGeometry(0.6, 0.35, 0.05), sail, 0.3, 2.9, -0.8));
  }
  return combine(p);
}

function crabGeo(): { body: THREE.BufferGeometry; claw: THREE.BufferGeometry } {
  const red = '#ff5a3c', dark = '#d8412b';
  const p: THREE.BufferGeometry[] = [];
  const shell = new THREE.SphereGeometry(0.95, 16, 10);
  shell.scale(1.25, 0.55, 0.95);
  gradientY(shell, dark, '#ff7a52');
  shell.translate(0, 0.75, 0);
  p.push(shell);
  for (const sx of [-1, 1]) {
    p.push(part(new THREE.CylinderGeometry(0.06, 0.07, 0.55, 5), red, sx * 0.35, 1.3, 0.55));
    p.push(part(new THREE.SphereGeometry(0.2, 10, 8), '#ffffff', sx * 0.35, 1.62, 0.58));
    p.push(part(new THREE.SphereGeometry(0.1, 8, 6), '#1b1b1b', sx * 0.35, 1.66, 0.75));
    for (let k = 0; k < 3; k++) {
      const z = -0.45 + k * 0.4;
      p.push(part(new THREE.CylinderGeometry(0.07, 0.05, 1.0, 5), dark, sx * 1.35, 0.4, z, 0, 0, sx * 0.9));
    }
  }
  p.push(part(new THREE.TorusGeometry(0.22, 0.05, 4, 10, Math.PI), '#7a2a1a', 0, 0.82, 0.86, 0, 0, Math.PI));
  const claw: THREE.BufferGeometry[] = [];
  claw.push(part(new THREE.CylinderGeometry(0.12, 0.14, 0.7, 6), red, 0, 0, 0.35, Math.PI / 2));
  const pincer = new THREE.SphereGeometry(0.34, 12, 8); pincer.scale(1, 0.8, 1.3);
  claw.push(part(pincer, '#ff6a45', 0, 0.05, 0.85));
  claw.push(part(new THREE.ConeGeometry(0.12, 0.5, 6), '#ffd0c0', 0.1, 0.12, 1.3, Math.PI / 2));
  return { body: combine(p), claw: combine(claw) };
}

function kiteGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const v = [0, 2.2, 0, -1.5, 0, 0, 0, 0, 0.35, 0, 2.2, 0, 0, 0, 0.35, 1.5, 0, 0, 0, -2.8, 0, 0, 0, 0.35, -1.5, 0, 0, 0, -2.8, 0, 1.5, 0, 0, 0, 0, 0.35];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const cs = ['#ff4d6d', '#ff4d6d', '#ff4d6d', '#ffd23f', '#ffd23f', '#ffd23f', '#00c2d1', '#00c2d1', '#00c2d1', '#ffffff', '#ffffff', '#ffffff'].map(c => new THREE.Color(c));
  const col: number[] = [];
  cs.forEach(c => col.push(c.r, c.g, c.b));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const p: THREE.BufferGeometry[] = [g];
  for (let k = 0; k < 6; k++) p.push(part(new THREE.BoxGeometry(0.5, 0.25, 0.05), k % 2 ? '#ff4d6d' : '#ffd23f', Math.sin(k) * 0.4, -3.4 - k * 0.8, 0.1, 0, 0, k * 0.4));
  return combine(p);
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ───────────────────────────── Builder ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildBeachScenery(ctx));
}

function buildBeachScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const q = quality.scenery;
  const bag = new Bag();
  const mats = new Materials(bag);
  const root = bag.add(scene, new THREE.Group());
  root.name = 'scenery-beach';
  const seed = track.def.scenerySeed + 202;
  const rng = new Rng(seed);
  const ext = trackExtent(track);
  const terrain = buildTerrain(track, { ground: PAL.ground, groundAlt: PAL.groundAlt, pitColor: PAL.pitColor, hills: 8, seed });
  terrain.mesh.receiveShadow = true;
  bag.add(root, terrain.mesh);
  bag.track(terrain);

  // ── coast: sea direction from the author's hints (pier/lighthouse/boats, water pits), else the side the track hugs ──
  const SEA_KINDS = new Set(['pier', 'dock', 'jetty', 'lighthouse', 'boat', 'boats', 'sailboat', 'ship', 'yacht', 'seaarch', 'buoy']);
  const hints: Array<{ x: number; z: number; w: number }> = [];
  for (const l of track.landmarks) {
    if (!SEA_KINDS.has(normKind(l.kind)) || l.side === 'over') continue;
    const f = frameAt(track, l.s), d = l.side === 'left' ? -l.dist : l.dist;
    hints.push({ x: f.x + f.rx * d, z: f.z + f.rz * d, w: 3 });
  }
  for (let i = 0; i < track.n; i += 2) {
    for (const side of [-1, 1]) {
      if ((side < 0 ? track.edgeL[i] : track.edgeR[i]) !== 2) continue;
      const f = frameAt(track, i * track.spacing), d = side * (track.hw[i]! + 12);
      hints.push({ x: f.x + f.rx * d, z: f.z + f.rz * d, w: 0.2 });
    }
  }
  const cs = new Float64Array(track.n);
  let D: [number, number] = [0, 1], cShore = 0, bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const d: [number, number] = [Math.cos(a), Math.sin(a)];
    for (let i = 0; i < track.n; i++) cs[i] = track.px[i]! * d[0] + track.pz[i]! * d[1];
    const sorted = Float64Array.from(cs).sort();
    const shore = (hints.length ? sorted[Math.floor(track.n * 0.8)]! + 11 : sorted[track.n - 1]! + 24);
    let score = 0;
    for (const h of hints) if (h.x * d[0] + h.z * d[1] > shore - 6) score += h.w;
    let hug = 0;
    for (let i = 0; i < track.n; i++) if (cs[i]! > shore - 55 && cs[i]! <= shore) hug++;
    score += (hug / track.n) * 4 - (k % 4 ? 0.05 : 0);
    if (score > bestScore) { bestScore = score; D = d; cShore = shore; }
  }
  const E: [number, number] = [-D[1], D[0]];
  const W = (t: number, e: number) => ({ x: D[0] * (cShore + t) + E[0] * e, z: D[1] * (cShore + t) + E[1] * e });
  const cOf = (x: number, z: number) => x * D[0] + z * D[1] - cShore;
  const eOf = (x: number, z: number) => x * E[0] + z * E[1];
  let eMin = Infinity, eMax = -Infinity;
  for (let i = 0; i < track.n; i += 4) {
    if (cOf(track.px[i]!, track.pz[i]!) < -120) continue;
    const e = eOf(track.px[i]!, track.pz[i]!); eMin = Math.min(eMin, e); eMax = Math.max(eMax, e);
  }
  if (!Number.isFinite(eMin)) { eMin = -100; eMax = 100; }
  const waterY = ext.minY - 1.6;
  /** Beach profile: dry sand → waterline at t≈20 → seabed. */
  const beachH = (t: number) => Math.max(waterY - 14, waterY + 1.3 - Math.max(0, t) * 0.09 + Math.max(0, -t) * 0.015);
  /** 1 near road corridors (causeways/breakwaters keep their ground), 0 away from them. */
  const keepAt = (x: number, z: number) => {
    if (!terrain.inCorridor(x, z, 34)) return 0;
    const n = terrain.nearestTrack(x, z);
    const wall = Math.max(track.wallL[n.i]!, track.wallR[n.i]!);
    return 1 - smooth(wall + 5, wall + 28, n.dist);
  };
  const distTo = distanceField(track, terrain.bounds, 16);
  const nearPit = (x: number, z: number) => {
    if (distTo(x, z) > 75) return false;
    const n = terrain.nearestTrack(x, z);
    return n.dist < track.hw[n.i]! + 50 && (track.edgeL[n.i] === 2 || track.edgeR[n.i] === 2);
  };
  const floorY = waterY + 1.25;
  const lift = (x: number, z: number, y: number) => {
    // one-sided soft floor: identity at/above floorY (the ground hugging the LOWEST road sits exactly there, and
    // the old symmetric soft-max lifted it ~0.4 m, pushing sand through the road at the bottom of the lap),
    // easing to at most 0.3 m below it (C1 join)
    if (y >= floorY || nearPit(x, z)) return y;
    return floorY - 0.3 * (1 - Math.exp((y - floorY) / 0.3));
  };
  const coast = (x: number, z: number, y: number) => {
    const t = cOf(x, z);
    if (t <= -40) return lift(x, z, y);
    const b = smooth(-40, -8, t) * (1 - keepAt(x, z));
    const yl = t < -8 ? lift(x, z, y) : y;
    return yl + (beachH(t) - yl) * b;
  };
  {
    const pos = terrain.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, coast(pos.getX(i), pos.getZ(i), pos.getY(i)));
    pos.needsUpdate = true;
    terrain.mesh.geometry.computeVertexNormals();
    terrain.mesh.geometry.computeBoundingSphere();
  }
  const H = (x: number, z: number) => coast(x, z, terrain.heightAt(x, z));
  const wet = new THREE.Color('#d8b47a'), dry = new THREE.Color('#fbe9c2'), grass = new THREE.Color('#7fbf4f'), deep = new THREE.Color('#c9d7a6');
  const lushC = new THREE.Color('#5fae4a');
  const sandA = new THREE.Color(PAL.ground), sandB = new THREE.Color(PAL.groundAlt), sandBase = new THREE.Color();
  recolorTerrain(terrain.mesh, (x, y, z, c) => {
    const t = cOf(x, z);
    const above = y - waterY;
    // the terrain tints its pit drop-offs dark blue; where the coast profile lifted such cells back
    // above the sea they must read as sand again (same base colour terrain.ts computes)
    if (above > -0.5) {
      sandBase.copy(sandA).lerp(sandB, 0.5 + 0.5 * fbm(x / 35, z / 35, seed + 99, 3)).multiplyScalar(0.92 + 0.08 * fbm(x / 9, z / 9, seed + 5, 2));
      c.lerp(sandBase, smooth(-0.5, 0.6, above));
    }
    if (t > -14 || above < 1.2) {
      c.lerp(dry, 0.45 * smooth(-14, -2, t));
      if (above < 0.7) c.lerp(wet, smooth(0.7, 0.1, above));
      if (above < -0.4) c.lerp(deep, 0.5);
      return;
    }
    const dist = terrain.inCorridor(x, z, 14) ? 0 : 40;
    const n = noise2(x / 50, z / 50, seed + 1), n2 = noise2(x / 17, z / 17, seed + 2);
    const g = smooth(-14, -45, t) * (dist ? 1 : 0.35);
    c.lerp(grass, Math.min(0.85, g * (0.55 + n * 0.9)));
    if (n2 > 0.1) c.lerp(lushC, Math.min(0.5, (n2 - 0.1) * 2) * g);
  });
  const reserve = new Reserve();
  const inPit = pitZone(track);
  reserve.block(inPit);
  reserveTrackFurniture(track, reserve);
  const stat = new Batch(mats.vc(0.75), { chunk: 260, castShadow: true, receiveShadow: true, name: 'beach-static' });
  const glowBatch = new Batch(mats.glow(), { name: 'beach-glow' });
  const m4 = new THREE.Matrix4();
  const swayTime = { value: 0 };
  const faceTrack = (x: number, z: number) => { const n = terrain.nearestTrack(x, z); return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z); };
  const seaYaw = Math.atan2(D[0], D[1]);
  const free = (x: number, z: number, r: number, pad = 2) => !terrain.inCorridor(x, z, pad + r) && reserve.ok(x, z, r);
  const glowTex = bag.track(radialTexture());
  const glows = bag.track(new Glows(64, glowTex));
  bag.add(root, glows.mesh);

  // ── ocean (grid built in coast space, then rotated into the world) ──
  const water = bag.track(createWaterMaterial({ deep: '#0a7fc0', shallow: '#46e0d3', foam: '#ffffff', sky: '#bdf0ff', sunDir: SUN, sunColor: '#fff2d2', waves: 1, depthRange: 12, foamWidth: 1.7 }));
  const tb = terrain.bounds;
  const inBounds = (x: number, z: number) => x > tb.minX && x < tb.maxX && z > tb.minZ && z < tb.maxZ;
  const oceanGrid = (t0: number, t1: number, e0: number, e1: number, segT: number, segE: number, y: number, depth: (x: number, z: number) => number) => {
    const g = waterGrid(t0, e0, t1, e1, segT, segE, y, () => 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const dep = g.attributes.aDepth as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const w = W(pos.getX(i), pos.getZ(i));
      pos.setX(i, w.x); pos.setZ(i, w.z);
      dep.setX(i, depth(w.x, w.z));
    }
    // (t,e)→(x,z) is a proper rotation (E ⟂ D), so the winding stays upward-facing
    g.computeBoundingSphere();
    return g;
  };
  {
    const span = Math.max(eMax - eMin, 200) + 900;
    // depth drives colour + foam: exact near the waterline, a smooth offshore ramp beyond (pit drops and
    // terrain cells must not print blocky deep patches into the turquoise shallows)
    const depthAt = (x: number, z: number) => {
      const ramp = 2.6 + Math.max(0, cOf(x, z) - 20) * 0.075;
      return inBounds(x, z) ? Math.min(waterY - H(x, z), ramp) : Math.max(ramp, 12);
    };
    const g = oceanGrid(-46, 420, (eMin + eMax) / 2 - span / 2, (eMin + eMax) / 2 + span / 2, 116, Math.ceil(span / 8), waterY, depthAt);
    const near = new THREE.Mesh(g, water); near.name = 'ocean'; bag.add(root, near);
    // far swell: starts under the end of the near grid and sits well below it, so its wave crests
    // never poke through the shallower near water
    const fg = oceanGrid(395, 3400, (eMin + eMax) / 2 - 3600, (eMin + eMax) / 2 + 3600, 20, 30, waterY - 0.9, () => 40);
    const far = new THREE.Mesh(fg, water); far.name = 'ocean-far'; bag.add(root, far);
  }
  const causeway = bag.track(rockGeo(1.6, '#a39a8d', seed + 5, 0.7));
  const riprap: Xf[] = [];
  for (let i = 0; i < track.n; i += 3) {
    for (const side of [-1, 1]) {
      const edge = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
      if (edge === 2) continue;
      const f = frameAt(track, i * track.spacing), wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
      const d = side * (wall + 7 + (i % 5));
      const x = f.x + f.rx * d, z = f.z + f.rz * d;
      if (cOf(x, z) < 8 || terrain.inCorridor(x, z, 3)) continue;
      riprap.push({ x, y: waterY + (i % 3) * 0.2 - 0.3, z, ry: i * 0.7, s: 0.8 + (i % 4) * 0.2 });
    }
  }
  // ── palms ──
  const palmMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  applySway(palmMat, swayTime, 0.0028, 0.9);
  const palmXf: Xf[][] = [[], [], [], []]; // [straight, leaning] × [near, far]
  const addPalm = (x: number, z: number, s = 1, y?: number) => {
    const far = distTo(x, z) > 105 ? 2 : 0;
    palmXf[(rng.next() < 0.5 ? 0 : 1) + far]!.push({ x, y: (y ?? H(x, z)) - 0.2, z, ry: rng.range(0, 6.28), s: s * rng.range(0.85, 1.2) });
    reserve.add(x, z, 1.5);
  };

  // ── landmarks helpers ──
  const lh = lighthouseGeo();
  bag.track(lh.body); bag.track(lh.lamp);
  const beams: THREE.Object3D[] = [];
  const beamGeo = bag.track(new THREE.ConeGeometry(3.2, 46, 18, 1, true));
  beamGeo.rotateX(-Math.PI / 2); beamGeo.translate(0, 0, 23);
  // daylight: only a faint shimmer of the beam (the lantern glint does the work)
  const beamMat = bag.track(new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true }));
  const addLighthouse = (x: number, z: number, s: number) => {
    const y = H(x, z) - 0.3;
    stat.add(lh.body, trs(x, y, z, 0, seaYaw + Math.PI, 0, s, s, s, m4));
    glowBatch.add(lh.lamp, trs(x, y, z, 0, 0, 0, s, s, s, m4));
    const beam = new THREE.Group();
    beam.position.set(x, y + lh.lampY * s, z);
    const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat);
    b2.rotation.y = Math.PI;
    b1.renderOrder = b2.renderOrder = 3;
    beam.add(b1, b2);
    bag.add(root, beam);
    beams.push(beam);
    glows.push(x, y + lh.lampY * s, z, 5 * s, '#fff1b8', 0.7);
    reserve.add(x, z, 9 * s);
  };

  const hutGeos = PASTELS.map(c => bag.track(hutGeo(c)));
  const addHuts = (c0: number, e0: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const p = W(c0 + rng.range(-0.5, 0.5), e0 + k * 6.5);
      if (!free(p.x, p.z, 2.5)) continue;
      stat.add(hutGeos[k % hutGeos.length]!, trs(p.x, H(p.x, p.z) + 0.9, p.z, 0, seaYaw + Math.PI, 0, 1, 1, 1, m4));
      reserve.add(p.x, p.z, 3.2);
    }
  };

  const plank = bag.track(part(new THREE.BoxGeometry(4.2, 0.22, 1.15), '#c89a66'));
  const plankDark = bag.track(part(new THREE.BoxGeometry(4.2, 0.22, 1.15), '#b5875a'));
  const pile = bag.track(part(new THREE.CylinderGeometry(0.2, 0.22, 9, 6), '#7d5a3a', 0, -4.5, 0));
  const railPost = bag.track(part(new THREE.BoxGeometry(0.14, 1.1, 0.14), '#f4efe4', 0, 0.55, 0));
  const railBar = bag.track(part(new THREE.BoxGeometry(0.1, 0.12, 4.0), '#f4efe4', 0, 1.05, 0));
  const lamp = bag.track(combine([part(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6), '#35424f', 0, 1.6, 0), part(new THREE.BoxGeometry(0.5, 0.3, 0.5), '#35424f', 0, 3.3, 0)]));
  const bulb = bag.track(part(new THREE.SphereGeometry(0.2, 8, 6), '#fff4c4', 0, 3.05, 0));
  const shack = bag.track(combine([
    part(new THREE.BoxGeometry(3.6, 2.6, 3.2), '#7bdff2', 0, 1.3, 0),
    part(new THREE.BoxGeometry(4.2, 0.3, 3.8), '#ffffff', 0, 2.75, 0),
    part(new THREE.BoxGeometry(1, 1.8, 0.12), '#35424f', 0, 0.9, 1.62),
    part(new THREE.BoxGeometry(2.8, 0.6, 0.12), '#ff5d8f', 0, 3.3, 1.5),
  ]));
  const addPier = (e: number, len: number) => {
    const deckY = waterY + 2.1;
    const c0 = -6;
    for (let a = 0; a < len; a += 1.2) {
      const p = W(c0 + a, e);
      if (terrain.inCorridor(p.x, p.z, 2)) continue;
      stat.add(Math.floor(a / 1.2) % 3 ? plank : plankDark, trs(p.x, deckY, p.z, 0, seaYaw, 0, 1, 1, 1, m4));
      if (Math.floor(a / 1.2) % 4 === 0) for (const side of [-1, 1]) {
        const q2 = W(c0 + a, e + side * 1.9);
        stat.add(pile, trs(q2.x, deckY, q2.z, 0, 0, 0, 1, 1, 1, m4));
        stat.add(railPost, trs(q2.x, deckY + 0.1, q2.z, 0, seaYaw, 0, 1, 1, 1, m4));
        if (a + 4.8 <= len) { const q3 = W(c0 + a + 2.4, e + side * 1.9); stat.add(railBar, trs(q3.x, deckY + 0.1, q3.z, 0, seaYaw, 0, 1, 1, 1.2, m4)); }
      }
      if (Math.floor(a / 1.2) % 12 === 6) {
        const q2 = W(c0 + a, e + 1.9);
        stat.add(lamp, trs(q2.x, deckY, q2.z, 0, seaYaw, 0, 1, 1, 1, m4));
        glowBatch.add(bulb, trs(q2.x, deckY, q2.z, 0, 0, 0, 1, 1, 1, m4));
        glows.push(q2.x, deckY + 3.05, q2.z, 1.0, '#fff1c4', 0.3);
      }
    }
    const end = W(c0 + len - 2.5, e);
    stat.add(shack, trs(end.x, deckY + 0.1, end.z, 0, seaYaw + Math.PI, 0, 1, 1, 1, m4));
    const st = W(c0 + 4, e);
    reserve.add(st.x, st.z, 4);
  };

  const archPieces: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 9; k++) archPieces.push(bag.track(rockGeo(2.4 + (k % 3) * 0.4, k % 2 ? '#9c8f80' : '#b3a594', 300 + k, 0.85)));
  const rockA = new THREE.Color('#9d9080'), rockB = new THREE.Color('#c4b6a2'), moss = new THREE.Color('#7fae55'), wetRock = new THREE.Color('#7d7266');
  /** Sandstone sea-rock colouring: warm grey noise, a grassy cap on top, darker wet band at the waterline. */
  const seaRockPaint = (g: THREE.BufferGeometry, wy: number) => {
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, c = g.attributes.color as THREE.BufferAttribute;
    const col = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      col.copy(rockA).lerp(rockB, 0.5 + 0.5 * noise2(x / 6, y / 4 + z / 6, seed + 8));
      if (n.getY(i) > 0.72) col.lerp(moss, 0.85);
      if (y < wy + 1.2) col.lerp(wetRock, 0.6);
      c.setXYZ(i, col.r, col.g, col.b);
    }
    return g;
  };
  const addRockArch = (x: number, z: number, yaw: number, s: number, baseY: number) => {
    const g = naturalArchGeo({ span: 15 * s, height: 13 * s, thick: 3.4 * s, depth: 5 * s, seed: seed + Math.round(x * 3 + z), bury: 8 });
    g.applyMatrix4(trs(x, baseY + 2.5, z, 0, yaw, 0, 1, 1, 1, m4));
    stat.addRaw(seaRockPaint(g, waterY));
    for (let k = 0; k < 4; k++) { const a = rng.range(0, 6.28), r = rng.range(8, 13) * s; stat.add(archPieces[k]!, trs(x + Math.cos(a) * r, waterY - 1.2, z + Math.sin(a) * r, 0, rng.range(0, 6), 0, 0.7 * s, 0.7 * s, 0.7 * s, m4)); }
    reserve.add(x, z, 10 * s);
  };

  const addOverArch = (f: ReturnType<typeof frameAt>, s: number) => {
    const wall = Math.max(track.wallL[f.i]!, track.wallR[f.i]!);
    const thick = 3.2 * s;
    const hx = wall + 2.2 + thick;
    const base = f.y - 2.5;
    const g = naturalArchGeo({ span: hx * 2, height: 12 + 3 * s, thick, depth: 5.2 * s, seed: seed + f.i, bury: 16 });
    g.applyMatrix4(trs(f.x, base, f.z, 0, f.yaw + Math.PI, 0, 1, 1, 1, m4));
    stat.addRaw(seaRockPaint(g, waterY));
    for (const sx of [-1, 1]) {
      const px = f.x + f.rx * sx * (hx + 3), pz = f.z + f.rz * sx * (hx + 3);
      if (!terrain.inCorridor(px, pz, 2)) stat.add(archPieces[(sx + 1) * 2]!, trs(px, Math.min(H(px, pz), base + 2) - 0.8, pz, 0, rng.range(0, 3), 0, 1.3 * s, 1.0, 1.3 * s, m4));
      reserve.add(f.x + f.rx * sx * hx, f.z + f.rz * sx * hx, 7 * s);
    }
  };
  const addHutsAt = (x: number, z: number, yaw: number, count: number) => {
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let k = 0; k < count; k++) {
      const o = (k - (count - 1) / 2) * 6.5;
      const hx = x + rx * o, hz = z + rz * o;
      if (!free(hx, hz, 2.5)) continue;
      stat.add(hutGeos[(((k + Math.round(x)) % hutGeos.length) + hutGeos.length) % hutGeos.length]!, trs(hx, H(hx, hz) + 0.9, hz, 0, yaw, 0, 1, 1, 1, m4));
      reserve.add(hx, hz, 3.2);
    }
  };
  const boats: Array<{ obj: THREE.Object3D; ph: number; y: number }> = [];
  const boatGeos = [
    bag.track(boatGeo('sail', '#ffffff', '#ff5d8f')), bag.track(boatGeo('sail', '#ffe7b0', '#ffffff')),
    bag.track(boatGeo('motor', '#ffffff', '#ff7b54')), bag.track(boatGeo('sail', '#f4f4f4', '#00c2d1')),
  ];
  const addBoat = (x: number, z: number, sc = 1) => {
    const m = new THREE.Mesh(boatGeos[boats.length % boatGeos.length]!, mats.vc(0.6));
    m.scale.setScalar(sc * 1.3);
    m.position.set(x, waterY, z);
    m.rotation.y = rng.range(0, 6.28);
    m.castShadow = true;
    bag.add(root, m);
    boats.push({ obj: m, ph: rng.range(0, 6.28), y: waterY });
  };

  const umbrellas = [bag.track(umbrellaGeo('#ff5d8f', '#ffffff')), bag.track(umbrellaGeo('#00c2d1', '#ffffff')), bag.track(umbrellaGeo('#ffd23f', '#ff7b54'))];
  const umbXf: Xf[][] = [[], [], []];
  const towelXf: Xf[] = [];
  const ballXf: Xf[] = [];
  const addUmbrellaSpot = (x: number, z: number) => {
    if (!free(x, z, 2.2)) return;
    const y = H(x, z);
    if (y < waterY + 0.35) return;
    umbXf[rng.int(0, 3)]!.push({ x, y: y - 0.1, z, ry: rng.range(0, 6.28), rx: rng.range(-0.12, 0.12), rz: rng.range(-0.12, 0.12) });
    const a = rng.range(0, 6.28);
    for (let k = 0; k < rng.int(1, 3); k++) {
      const tx = x + Math.cos(a + k * 0.7) * 1.6, tz = z + Math.sin(a + k * 0.7) * 1.6;
      towelXf.push({ x: tx, y: H(tx, tz) + 0.02, z: tz, ry: a + k * 0.7 + rng.range(-0.3, 0.3) });
    }
    if (rng.chance(0.3)) { const bx = x + rng.range(-3, 3), bz = z + rng.range(-3, 3); ballXf.push({ x: bx, y: H(bx, bz), z: bz, ry: rng.range(0, 6) }); }
    reserve.add(x, z, 2.5);
  };

  const guard = bag.track(combine([
    ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => part(new THREE.BoxGeometry(0.18, 3.2, 0.18), '#ffffff', a! * 1.1, 1.6, b! * 1.1)),
    part(new THREE.BoxGeometry(2.8, 0.2, 2.8), '#e8414b', 0, 3.2, 0),
    part(new THREE.BoxGeometry(2.2, 1.6, 2.0), '#ffffff', 0, 4.1, -0.2),
    part(new THREE.BoxGeometry(2.6, 0.2, 2.6), '#e8414b', 0, 5.0, -0.2),
    part(new THREE.BoxGeometry(1.2, 0.2, 2.6), '#c89a66', 0, 1.2, 2.1, -0.9),
    part(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 4), '#35424f', 1.2, 6.0, -1.2),
    part(new THREE.BoxGeometry(0.05, 0.6, 0.9), '#ff3b3b', 1.2, 6.8, -0.75),
  ]));
  const castle = bag.track(combine([
    part(new THREE.CylinderGeometry(0.9, 1.1, 0.8, 8), '#e9c98c', 0, 0.4, 0),
    ...[0, 1, 2, 3].map(k => part(new THREE.CylinderGeometry(0.3, 0.35, 1.2, 6), '#efd49c', Math.cos(k * 1.57) * 0.8, 0.6, Math.sin(k * 1.57) * 0.8)),
    ...[0, 1, 2, 3].map(k => part(new THREE.ConeGeometry(0.34, 0.5, 6), '#e2bf82', Math.cos(k * 1.57) * 0.8, 1.45, Math.sin(k * 1.57) * 0.8)),
    part(new THREE.CylinderGeometry(0.45, 0.5, 1.4, 8), '#efd49c', 0, 1.1, 0),
    part(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 3), '#35424f', 0, 2.1, 0),
    part(new THREE.BoxGeometry(0.02, 0.22, 0.35), '#ff5d8f', 0, 2.35, 0.17),
  ]));
  const net = bag.track(combine([
    part(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5), '#f4f4f4', -4, 1.3, 0), part(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5), '#f4f4f4', 4, 1.3, 0),
    part(new THREE.BoxGeometry(8, 0.9, 0.03), '#35424f', 0, 2.0, 0), part(new THREE.BoxGeometry(8, 0.1, 0.06), '#ffffff', 0, 2.45, 0),
  ]));
  const kiosk = bag.track(combine([
    part(new THREE.BoxGeometry(4, 1.2, 2.4), '#b98552', 0, 0.6, 0), part(new THREE.BoxGeometry(4.2, 0.15, 2.6), '#f4efe4', 0, 1.25, 0),
    ...[[1.8, 1.1], [-1.8, 1.1], [1.8, -1.1], [-1.8, -1.1]].map(([a, b]) => part(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 5), '#8a5a3b', a!, 1.3, b!)),
    part(new THREE.ConeGeometry(3.6, 1.8, 8), '#d9b25a', 0, 3.4, 0), part(new THREE.ConeGeometry(3.7, 0.4, 8), '#c49a44', 0, 2.55, 0),
    part(new THREE.BoxGeometry(2.6, 0.7, 0.1), '#00c2d1', 0, 2.0, 1.35), part(new THREE.BoxGeometry(2.2, 0.35, 0.12), '#ffffff', 0, 2.0, 1.36),
  ]));

  const kites: Array<{ obj: THREE.Object3D; x: number; y: number; z: number; ph: number }> = [];
  const kite = bag.track(kiteGeo());
  const addKite = (x: number, y: number, z: number, s: number) => {
    const m = new THREE.Mesh(kite, mats.vc(0.6, { side: THREE.DoubleSide }));
    m.scale.setScalar(1.3 * s);
    bag.add(root, m);
    kites.push({ obj: m, x, y, z, ph: rng.range(0, 6.28) });
  };
  const addGeneric = (x: number, z: number, s: number) => {
    for (let k = 0; k < 4; k++) { const a = rng.range(0, 6.28), r = rng.range(2, 7) * s; const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r; if (!terrain.inCorridor(px, pz, 2)) addPalm(px, pz, s); }
    if (free(x, z, 2.5)) stat.add(hutGeos[rng.int(0, hutGeos.length)]!, trs(x, H(x, z) + 0.9, z, 0, faceTrack(x, z), 0, s, s, s, m4));
    reserve.add(x, z, 6 * s);
  };

  // ── landmarks from the track ──
  let nLight = 0, nPier = 0, nArch = 0, nHuts = 0;
  const midE = (eMin + eMax) / 2;
  for (const l of track.landmarks) {
    if (isTrackMeshKind(l.kind)) continue;
    const k = normKind(l.kind);
    const pl = landmarkPlace(track, l, H);
    const e = eOf(pl.x, pl.z);
    if (k === 'lighthouse') { addLighthouse(pl.x, pl.z, pl.scale); nLight++; }
    else if (k === 'pier' || k === 'dock' || k === 'jetty' || k === 'boardwalk') { addPier(e, 60 * pl.scale); nPier++; }
    else if (k === 'hut' || k === 'huts' || k === 'beachhut' || k === 'beachhuts' || k === 'cabana') { addHutsAt(pl.x, pl.z, pl.yaw, 3); nHuts++; }
    else if (k === 'rockarch' || k === 'seaarch' || k === 'rockarches' || k === 'searock') {
      if (pl.side === 'over') addOverArch(pl.frame, pl.scale);
      else addRockArch(pl.x, pl.z, pl.yaw + Math.PI / 2, pl.scale, Math.min(H(pl.x, pl.z), waterY) - 3);
      nArch++;
    }
    else if (k === 'boat' || k === 'boats' || k === 'sailboat' || k === 'ship' || k === 'yacht') {
      const inSea = (x: number, z: number) => cOf(x, z) > 24 && !terrain.inCorridor(x, z, 8) && H(x, z) < waterY - 1.5;
      if (inSea(pl.x, pl.z)) addBoat(pl.x, pl.z, pl.scale); else { const p = W(rng.range(70, 160), e); addBoat(p.x, p.z, pl.scale); }
    }
    else if (k === 'umbrella' || k === 'umbrellas' || k === 'parasol') { for (let j = 0; j < 9; j++) addUmbrellaSpot(pl.x + rng.range(-12, 12), pl.z + rng.range(-12, 12)); }
    else if (k === 'palm' || k === 'palms' || k === 'palmtree') { for (let j = 0; j < 6; j++) { const x = pl.x + rng.range(-8, 8), z = pl.z + rng.range(-8, 8); if (!terrain.inCorridor(x, z, 2)) addPalm(x, z, pl.scale); } }
    else if (k === 'lifeguard' || k === 'lifeguardtower') { if (free(pl.x, pl.z, 2.5)) { stat.add(guard, trs(pl.x, H(pl.x, pl.z), pl.z, 0, seaYaw + Math.PI, 0, pl.scale, pl.scale, pl.scale, m4)); reserve.add(pl.x, pl.z, 3); } }
    else if (k === 'kiosk' || k === 'surfshop' || k === 'shop' || k === 'tikibar' || k === 'bar' || k === 'cafe') { if (free(pl.x, pl.z, 3.5)) { stat.add(kiosk, trs(pl.x, H(pl.x, pl.z), pl.z, 0, pl.yaw, 0, pl.scale, pl.scale, pl.scale, m4)); reserve.add(pl.x, pl.z, 4.5); } }
    else if (k === 'kite' || k === 'kites' || pl.side === 'over') addKite(pl.x, pl.frame.y + 24, pl.z, pl.scale);
    else addGeneric(pl.x, pl.z, pl.scale);
  }

  // ── signature props on any layout ──
  if (!nPier) { addPier(midE + (eMax - eMin) * 0.18, 64); nPier++; }
  if (!nLight) { const p = W(26, eMax + 30); addLighthouse(p.x, p.z, 1.1); }
  if (!nHuts) { addHuts(-8, midE - (eMax - eMin) * 0.22, 6); addHuts(-8, midE + (eMax - eMin) * 0.36, 4); }
  { const p = W(75, midE - (eMax - eMin) * 0.3); if (!terrain.inCorridor(p.x, p.z, 20)) addRockArch(p.x, p.z, 0.4, 1.2, waterY - 3); const p2 = W(110, eMin - 40); if (!terrain.inCorridor(p2.x, p2.z, 20)) addRockArch(p2.x, p2.z, 1.2, 0.9, waterY - 3); }
  for (let j = boats.length, guard = 0; j < 6 && guard < 40; guard++) { const p = W(rng.range(60, 280), rng.range(eMin - 120, eMax + 120)); if (terrain.inCorridor(p.x, p.z, 15) || H(p.x, p.z) > waterY - 2) continue; addBoat(p.x, p.z); j++; }
  if (!kites.length) { const f = frameAt(track, rng.range(0, track.length)); addKite(f.x + f.rx * 30, f.y + 26, f.z + f.rz * 30, 1); }

  // beach band dressing
  for (let j = 0; j < qcount(34, q); j++) { const p = W(rng.range(-5, 14), rng.range(eMin - 90, eMax + 90)); addUmbrellaSpot(p.x, p.z); }
  { const p = W(6, midE - 8); if (free(p.x, p.z, 3)) { stat.add(guard, trs(p.x, H(p.x, p.z), p.z, 0, seaYaw + Math.PI, 0, 1, 1, 1, m4)); reserve.add(p.x, p.z, 3); } }
  { const p = W(2, midE + 22); if (free(p.x, p.z, 5)) { stat.add(net, trs(p.x, H(p.x, p.z), p.z, 0, seaYaw + Math.PI / 2, 0, 1, 1, 1, m4)); reserve.add(p.x, p.z, 5); } }
  for (let j = 0; j < 4; j++) { const p = W(rng.range(10, 16), rng.range(eMin, eMax)); if (free(p.x, p.z, 1.5)) stat.add(castle, trs(p.x, H(p.x, p.z) - 0.1, p.z, 0, rng.range(0, 6), 0, 1, 1, 1, m4)); }
  for (let j = 0; j < 2; j++) { const p = W(-12, midE + (j ? 1 : -1) * (eMax - eMin) * 0.1); if (free(p.x, p.z, 3.5)) { stat.add(kiosk, trs(p.x, H(p.x, p.z), p.z, 0, faceTrack(p.x, p.z), 0, 1, 1, 1, m4)); reserve.add(p.x, p.z, 4.5); } }
  // palm row along the sand, palm-lined boulevard, inland palms
  for (let e = eMin - 60; e < eMax + 60; e += rng.range(9, 16)) { const p = W(rng.range(-15, -9), e); if (free(p.x, p.z, 1.2) && H(p.x, p.z) > waterY + 0.6) addPalm(p.x, p.z); }
  for (const p of scatter(terrain, qcount(90, q), seed + 3, { minDist: 14, maxDist: 38, pad: 4 })) if (reserve.ok(p.x, p.z, 1.5) && H(p.x, p.z) > waterY + 0.8) addPalm(p.x, p.z);
  for (const p of scatter(terrain, qcount(120, q), seed + 4, { minDist: 38, maxDist: 300, pad: 5 })) if (reserve.ok(p.x, p.z, 1.5) && H(p.x, p.z) > waterY + 0.8) addPalm(p.x, p.z, 1.1);
  // palm groves with flowering undergrowth
  const groves: Array<{ x: number; z: number }> = [];
  for (const c of scatter(terrain, qcount(16, q), seed + 31, { minDist: 30, maxDist: 260, pad: 10 })) {
    if (cOf(c.x, c.z) > -22 || !reserve.ok(c.x, c.z, 5)) continue;
    groves.push(c);
    for (let k = 0; k < 9; k++) {
      const a = rng.range(0, 6.28), rr = Math.sqrt(rng.next()) * 12;
      const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      if (!terrain.inCorridor(x, z, 3) && reserve.ok(x, z, 1.5) && H(x, z) > waterY + 0.8) addPalm(x, z, rng.range(0.95, 1.3));
    }
  }
  // islands
  const island = bag.track((() => { const g = blob(1, 18, 10, 0.1); g.scale(34, 7, 26); return gradientY(g, '#e9cf98', '#f7e3b5'); })());
  for (let j = 0; j < 3; j++) {
    const p = W(rng.range(240, 480), rng.range(eMin - 200, eMax + 200));
    const s = rng.range(0.7, 1.3);
    stat.add(island, trs(p.x, waterY - 2.5, p.z, 0, rng.range(0, 6), 0, s, s, s, m4));
    for (let k = 0; k < 5; k++) addPalm(p.x + rng.range(-12, 12) * s, p.z + rng.range(-9, 9) * s, 1.3, waterY + 3.2 * s);
    for (let k = 0; k < 3; k++) stat.add(archPieces[k]!, trs(p.x + rng.range(-20, 20) * s, waterY, p.z + rng.range(-16, 16) * s, 0, rng.range(0, 6), 0, 1.2, 1.2, 1.2, m4));
  }

  // inland pastel cottages
  const cottages = PASTELS.map((c, k) => bag.track(cottageGeo(c, k % 2 ? '#e8414b' : '#3b8ea5')));
  for (const p of scatter(terrain, qcount(22, q), seed + 21, { minDist: 26, maxDist: 110, pad: 6 })) {
    if (cOf(p.x, p.z) > -30 || !clearOf(terrain, p.x, p.z, 5) || !reserve.ok(p.x, p.z, 6)) continue;
    stat.add(cottages[rng.int(0, cottages.length)]!, trs(p.x, H(p.x, p.z) - 0.1, p.z, 0, faceTrack(p.x, p.z), 0, 1, 1, 1, m4));
    reserve.add(p.x, p.z, 6);
    for (let k = 0; k < 2; k++) { const a2 = rng.range(0, 6.28); const px = p.x + Math.cos(a2) * 7, pz = p.z + Math.sin(a2) * 7; if (!terrain.inCorridor(px, pz, 2)) addPalm(px, pz, 0.9); }
  }
  // rope fences along the dunes
  const post = bag.track(part(new THREE.CylinderGeometry(0.1, 0.12, 1.2, 5), '#9a7048', 0, 0.5, 0));
  const rope = bag.track(part(new THREE.BoxGeometry(0.06, 0.06, 1), '#6b4a2b', 0, 0.85, 0));
  for (const side of [-1, 1]) {
    let s0 = rng.range(0, 30);
    while (s0 < track.length) {
      const runLen = rng.range(20, 60);
      let prev: { x: number; y: number; z: number } | null = null;
      for (let a2 = 0; a2 < runLen; a2 += 3) {
        const f = frameAt(track, s0 + a2);
        const edge = side < 0 ? track.edgeL[f.i]! : track.edgeR[f.i]!;
        const d = side * ((side < 0 ? track.wallL[f.i]! : track.wallR[f.i]!) + 3.5);
        const x = f.x + f.rx * d, z = f.z + f.rz * d;
        const y = H(x, z);
        if (edge !== 0 || terrain.inCorridor(x, z, 1) || !reserve.ok(x, z, 0.3) || y < waterY + 0.8) { prev = null; continue; }
        stat.add(post, trs(x, y, z, 0, f.yaw, 0, 1, 1, 1, m4));
        if (prev) { const dx = x - prev.x, dz = z - prev.z, dy = y - prev.y, len = Math.hypot(dx, dz); stat.add(rope, trs((x + prev.x) / 2, (y + prev.y) / 2 - 0.08, (z + prev.z) / 2, -Math.atan2(dy, len), Math.atan2(dx, dz), 0, 1, 1, len, m4)); }
        prev = { x, y, z };
      }
      s0 += runLen + rng.range(50, 130);
    }
  }
  stat.build(root, bag);
  glowBatch.build(root, bag);
  addInstanced(root, bag, causeway, mats.vc(0.9), riprap, { castShadow: true, receiveShadow: true, name: 'riprap' });
  palmXf.forEach((xf, k) => {
    const lean = k % 2 ? 0.085 : 0.035, far = k >= 2;
    addInstanced(root, bag, palmGeo(new Rng(seed + 900 + (k % 2)), lean, far ? 1 : 0), palmMat, xf, { colors: ['#ffffff', '#f0ffe8', '#fff6e0'], castShadow: !far, receiveShadow: true, name: `palm${k}` });
  });
  umbXf.forEach((xf, k) => addInstanced(root, bag, umbrellas[k]!.clone(), mats.vc(0.6), xf, { castShadow: true, name: `umbrella${k}` }));
  addInstanced(root, bag, part(new THREE.BoxGeometry(1.0, 0.04, 1.9), '#ffffff'), mats.vc(0.9), towelXf, { colors: ['#ff5d8f', '#00c2d1', '#ffd23f', '#7bd389', '#b47cff', '#ff7b54'], receiveShadow: true, name: 'towels' });
  addInstanced(root, bag, (() => { const g = stripedBall(0.35, ['#ff4d6d', '#ffffff', '#ffd23f', '#00c2d1']); g.translate(0, 0.35, 0); return g; })(), mats.vc(0.5), ballXf, { castShadow: true, name: 'balls' });
  const boards: Xf[] = [];
  for (let j = 0; j < qcount(14, q); j++) { const p = W(rng.range(-8, -2), rng.range(eMin, eMax)); if (free(p.x, p.z, 0.6)) boards.push({ x: p.x, y: H(p.x, p.z) - 0.3, z: p.z, ry: rng.range(0, 6), rz: rng.range(-0.15, 0.15) }); }
  addInstanced(root, bag, (() => { const g = new THREE.SphereGeometry(1, 12, 8); g.scale(0.32, 1.15, 0.07); g.translate(0, 1.1, 0); return part(g, '#ffffff'); })(), mats.vc(0.45), boards, { colors: ['#ff7b54', '#00c2d1', '#ffd23f', '#ff5d8f', '#ffffff'], castShadow: true, name: 'surfboards' });
  const starXf: Xf[] = [];
  for (let j = 0; j < qcount(40, q); j++) { const p = W(rng.range(15, 19.5), rng.range(eMin - 80, eMax + 80)); const y = H(p.x, p.z); if (y > waterY + 0.05) starXf.push({ x: p.x, y: y + 0.03, z: p.z, ry: rng.range(0, 6), s: rng.range(0.7, 1.3) }); }
  addInstanced(root, bag, (() => { const g = new THREE.CylinderGeometry(0.35, 0.35, 0.08, 5, 1); const pp = g.attributes.position as THREE.BufferAttribute; for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i); const r = Math.hypot(x, z); if (r > 0.2) { pp.setX(i, x * 1.6); pp.setZ(i, z * 1.6); } } g.computeVertexNormals(); return part(g, '#ff8a5b'); })(), mats.vc(0.8), starXf, { colors: ['#ff8a5b', '#ffb13b', '#ff5d8f'], name: 'starfish' });
  // dune grass + tropical shrubs + rocks
  const grassMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  applySway(grassMat, swayTime, 0.25, 2.0);
  const tuft = (() => { const bl: THREE.BufferGeometry[] = []; for (let k = 0; k < 7; k++) { const g = new THREE.ConeGeometry(0.06, rng.range(0.6, 1.1), 3, 1); g.translate(0, 0.4, 0); g.rotateZ(rng.range(-0.5, 0.5)); g.rotateX(rng.range(-0.5, 0.5)); g.translate(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3)); bl.push(g); } return gradientY(combine(bl), '#7f9a45', '#e4dc92'); })();
  const tuftPts = scatter(terrain, qcount(1100, q), seed + 5, { minDist: 9, maxDist: 140, pad: 0.6 }).filter(p => H(p.x, p.z) > waterY + 0.9 && reserve.ok(p.x, p.z, 0.4));
  addInstanced(root, bag, tuft, grassMat, tuftPts.map(p => ({ x: p.x, y: H(p.x, p.z) - 0.05, z: p.z, ry: p.r, s: p.s })), { receiveShadow: true, name: 'dunegrass' });
  const shrub = (() => {
    const b = combine([[1.0, 0, 0.5, 0], [0.8, 0.8, 0.4, 0.2], [0.75, -0.7, 0.45, -0.2]].map(([r, x, y, z]) => { const g = jitter(blob(r!, 9, 6, 0.4), 0.07, 4); g.translate(x!, y!, z!); return g; }));
    gradientY(b, '#2f8a3f', '#6fd05a');
    const dots: THREE.BufferGeometry[] = [b];
    for (let k = 0; k < 14; k++) { const a = rng.range(0, 6.28), e2 = rng.range(0.1, 1.2); dots.push(part(new THREE.IcosahedronGeometry(0.14, 0), k % 3 ? '#ff4fa3' : '#ffd23f', Math.cos(a) * Math.cos(e2), 0.5 + Math.sin(e2) * 0.95, Math.sin(a) * Math.cos(e2))); }
    return combine(dots);
  })();
  const shrubPts = scatter(terrain, qcount(160, q), seed + 6, { minDist: 12, maxDist: 160, pad: 3 }).filter(p => H(p.x, p.z) > waterY + 1 && reserve.ok(p.x, p.z, 1.2));
  for (const c of groves) for (let k = 0; k < 7; k++) {
    const a = rng.range(0, 6.28), rr = rng.range(3, 15);
    const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
    if (!terrain.inCorridor(x, z, 2) && reserve.ok(x, z, 1) && H(x, z) > waterY + 1) shrubPts.push({ x, y: H(x, z), z, r: rng.range(0, 6.3), s: rng.range(0.8, 1.3) });
  }
  addInstanced(root, bag, shrub, grassMat, shrubPts.map(p => ({ x: p.x, y: H(p.x, p.z) - 0.1, z: p.z, ry: p.r, s: p.s })), { castShadow: true, receiveShadow: true, name: 'shrubs' });
  const rockPts = scatter(terrain, qcount(50, q), seed + 7, { minDist: 14, maxDist: 220, pad: 3 }).filter(p => reserve.ok(p.x, p.z, 1));
  addInstanced(root, bag, rockGeo(1, '#b3a594', seed, 0.6), mats.vc(0.9), rockPts.map(p => ({ x: p.x, y: H(p.x, p.z) - 0.25, z: p.z, ry: p.r, s: p.s * rng.range(0.5, 1.8) })), { castShadow: true, receiveShadow: true, name: 'rocks' });
  // decorative crabs on the sand
  const crab = crabGeo();
  bag.track(crab.body); bag.track(crab.claw);
  const crabDecor = combine([crab.body.clone(), crab.claw.clone().rotateY(0.5).translate(0.95, 0.7, 0.55), crab.claw.clone().rotateY(-0.5).translate(-0.95, 0.7, 0.55)]);
  const crabXf: Xf[] = [];
  for (let j = 0; j < qcount(10, q); j++) { const p = W(rng.range(4, 17), rng.range(eMin, eMax)); if (free(p.x, p.z, 0.8)) crabXf.push({ x: p.x, y: H(p.x, p.z), z: p.z, ry: rng.range(0, 6), s: 0.35 }); }
  addInstanced(root, bag, crabDecor, mats.vc(0.5), crabXf, { castShadow: true, name: 'crabs' });

  // ── pits: water under bridges ──
  const pitWater = bag.track(createWaterMaterial({ deep: '#0b6fa8', shallow: PAL.pitColor, foam: '#ffffff', sky: '#bdf0ff', sunDir: SUN, sunColor: '#fff2d2', waves: 0.5, depthRange: 7 }));
  waterPits(track, H, pitWater, bag, root, 7, 70, run => {
    let sea = 0;
    for (const i of run.samples) { const f = frameAt(track, i * track.spacing), d = run.side * (track.hw[i]! + 20); if (H(f.x + f.rx * d, f.z + f.rz * d) < waterY - 1) sea++; }
    return sea < run.samples.length * 0.5;
  });

  // ── horizon & sky ──
  const tcx = (tb.minX + tb.maxX) / 2, tcz = (tb.minZ + tb.maxZ) / 2;
  const half = Math.min(tb.maxX - tb.minX, tb.maxZ - tb.minZ) / 2;
  const seaMask = (a: number) => 1 - smooth(-0.35, 0.1, Math.cos(a) * D[0] + Math.sin(a) * D[1]);
  const base = ext.minY - 1;
  bag.add(root, buildFarGround(tcx, tcz, half * 0.85, half + 900, waterY - 2.5, '#c9c282'));
  bag.add(root, buildRing({ seed: seed + 11, cx: tcx, cz: tcz, radius: half + 40, baseY: base - 7, hMin: 10, hMax: 34, bottom: '#e9cf98', top: '#a9c472', sunDir: SUN, jag: 0.3, mask: seaMask }));
  bag.add(root, buildRing({ seed: seed + 12, cx: tcx, cz: tcz, radius: half + 250, baseY: base - 10, hMin: 30, hMax: 115, bottom: '#8fc49a', top: '#4f9a6e', sunDir: SUN, mask: seaMask, facets: true, peak: 1.2, jag: 1.1 }));
  bag.add(root, buildRing({ seed: seed + 16, cx: tcx, cz: tcz, radius: half + 470, baseY: base - 10, hMin: 60, hMax: 175, bottom: '#aed3c3', top: '#83b7a8', sunDir: SUN, mask: seaMask, facets: true, peak: 1.35, jag: 1.3, segments: 140 }));
  const clouds = buildClouds({ seed: seed + 13, count: Math.max(6, qcount(13, q)), cx: ext.cx, cz: ext.cz, rMin: 120, rMax: half + 380, yMin: 130, yMax: 210, top: '#ffffff', bottom: '#e3eef8', size: 1.2, emissiveIntensity: 0.55 });
  bag.add(root, clouds);
  const gulls = bag.track(new Flock({ seed: seed + 14, count: qcount(16, q), cx: W(30, midE).x, cz: W(30, midE).z, spread: (eMax - eMin) * 0.5, yMin: 22, yMax: 45, color: '#f4f6f8', size: 1.1 }));
  bag.add(root, gulls.mesh);

  // ── movers ──
  const rigs: MoverRig[] = [];
  let moverGeneric: THREE.BufferGeometry | null = null;
  const crabPos = new THREE.Vector3();

  return {
    environment: BEACH_ENV,
    update(dt, time, camera) {
      swayTime.value = time;
      water.uniforms.uTime.value = time;
      pitWater.uniforms.uTime.value = time;
      for (const b of beams) b.rotation.y = time * 0.8;
      for (const b of boats) {
        b.obj.position.y = b.y + Math.sin(time * 1.1 + b.ph) * 0.25;
        b.obj.rotation.z = Math.sin(time * 0.9 + b.ph) * 0.06;
        b.obj.rotation.x = Math.cos(time * 0.7 + b.ph) * 0.04;
      }
      for (const k of kites) {
        k.obj.position.set(k.x + Math.sin(time * 0.35 + k.ph) * 5, k.y + Math.sin(time * 0.8 + k.ph) * 2, k.z + Math.cos(time * 0.3 + k.ph) * 3);
        k.obj.rotation.set(Math.sin(time * 0.9 + k.ph) * 0.2, time * 0.05, Math.sin(time * 1.3 + k.ph) * 0.35);
      }
      clouds.rotation.y = time * 0.002;
      gulls.update(time);
      const ce = camera.matrixWorld.elements;
      for (const r of rigs) {
        if (r.kind === 'crab') {
          // the sim heads a sweep mover along its lateral travel; the crab instead keeps its eyes on the
          // player (the camera looks down the track), so it scuttles sideways across the road
          r.root.getWorldPosition(crabPos);
          faceSmooth(r, dt, 5, Math.atan2(ce[12]! - crabPos.x, ce[14]! - crabPos.z));
          const t = time * 9 + r.phase;
          r.inner.position.y = Math.abs(Math.sin(time * 6 + r.phase)) * 0.06;
          r.inner.rotation.z = Math.sin(time * 6 + r.phase) * 0.06;
          if (r.parts) { r.parts[0]!.rotation.x = -0.3 + Math.max(0, Math.sin(t)) * 0.6; r.parts[1]!.rotation.x = -0.3 + Math.max(0, Math.sin(t + 1.3)) * 0.6; }
        } else updateGeneric(r, time);
      }
    },
    createMover(look) {
      const k = normKind(look);
      if (k === 'crab' || k === 'crabs') {
        const inner = new THREE.Group();
        const body = new THREE.Mesh(crab.body, mats.vc(0.5));
        body.castShadow = true;
        inner.add(body);
        const claws: THREE.Object3D[] = [];
        for (const sx of [1, -1]) {
          const pivot = new THREE.Group();
          pivot.position.set(sx * 0.95, 0.75, 0.55);
          pivot.rotation.y = sx * 0.5;
          const c = new THREE.Mesh(crab.claw, mats.vc(0.5));
          c.castShadow = true;
          pivot.add(c);
          inner.add(pivot);
          claws.push(pivot);
        }
        inner.scale.setScalar(1.15);
        inner.rotation.order = 'YXZ';
        const rig = makeRig('crab', inner, rigs.length * 1.9);
        rig.parts = claws;
        rigs.push(rig);
        return rig.root;
      }
      moverGeneric ??= bag.track(genericMoverGeo(PAL.accent));
      const rig = makeGenericRig(moverGeneric, mats.vc(0.5), rigs.length * 1.7);
      rigs.push(rig);
      return rig.root;
    },
    dispose() { bag.dispose(); rigs.length = 0; },
  };
}
