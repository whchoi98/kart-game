/**
 * Red Canyon scenery — layered red/orange mesas and buttes with strata bands, sheer gorge walls
 * along walled sections, saguaro cacti and dry scrub, red rock arches, a windmill water pump,
 * covered wagons with a campfire, a rope-and-plank bridge, a deep chasm under the jump, circling
 * vultures and a warm golden-hour haze.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, scatter } from '../terrain.js';
import {
  Bag, Batch, Flock, Glows, Materials, Reserve, Rng, addInstanced, blob, buildClouds, buildFarGround, buildRing, clearOf,
  combine, faceted, frameAt, genericMoverGeo, gradientY, isTrackMeshKind, jitter, landmarkPlace, makeGenericRig, makeRig, naturalArchGeo,
  noise2, normalize, normKind, paint, part, pitRuns, pitStrip, qcount, radialTexture, recolorTerrain, rockGeo, runMinY, trackExtent, trs,
  updateGeneric, updateRoll, type MoverRig, type Xf, pitZone, reserveTrackFurniture, withCorridorGuard,
} from './props-a.js';

const PAL = THEME_PALETTES.canyon;
const SUN: [number, number, number] = [0.74, 0.36, 0.48];

export const CANYON_ENV: EnvironmentSettings = {
  skyTop: '#4d86d1', skyHorizon: '#ffc58c', skyBottom: '#d9895b',
  fogColor: '#f1b98c', fogNear: 150, fogFar: 980,
  sunColor: '#ffc27d', sunIntensity: 2.7, sunDir: SUN,
  hemiSky: '#ffd8b0', hemiGround: '#a8583a', hemiIntensity: 0.85,
  exposure: 1.0, night: false, bloomStrength: 0.3,
};

/** Strata palette, bottom → top, repeating. */
const STRATA = ['#b9502f', '#d86f45', '#f0a36b', '#c65a36', '#e98d58', '#f6c592', '#cf6a41', '#e2814f'];
const strataColor = (y: number, wobble: number, out: THREE.Color) => {
  const v = (y + wobble) / 3.2;
  const i = Math.floor(v), f = v - i;
  const a = STRATA[((i % STRATA.length) + STRATA.length) % STRATA.length]!;
  const b = STRATA[(((i + 1) % STRATA.length) + STRATA.length) % STRATA.length]!;
  out.set(a);
  if (f > 0.85) out.lerp(new THREE.Color(b), (f - 0.85) / 0.15);
  return out;
};

/** Warm rock base colour (bands come from the strata shader patch); flat tops get a scrubby cap tint. */
function strataPaint(g: THREE.BufferGeometry, yOffset: number, seed: number, topColor?: string, topAbove?: number): THREE.BufferGeometry {
  paint(g, '#ffffff');
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const c = g.attributes.color as THREE.BufferAttribute;
  const col = new THREE.Color(), top = new THREE.Color(topColor ?? '#c98a5a');
  const a = new THREE.Color('#c05a36'), b = new THREE.Color('#e8935c');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    col.copy(a).lerp(b, 0.5 + 0.5 * noise2(x / 18, (y + yOffset) / 9 + z / 18, seed));
    if (topAbove !== undefined && n.getY(i) > 0.8 && y > topAbove) col.lerp(top, 0.85);
    c.setXYZ(i, col.r, col.g, col.b);
  }
  return g;
}

/**
 * Sedimentary strata in the fragment shader, banded by WORLD height (so neighbouring mesas,
 * gorge walls and steep terrain share the same layers). Multiplies the vertex colour.
 */
function applyStrata(mat: THREE.MeshStandardMaterial, band = 2.7, steepOnly = false): void {
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStrataP;\nvarying float vStrataNY;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 sp = vec4(transformed, 1.0);
          vec3 sn = objectNormal;
          #ifdef USE_INSTANCING
            sp = instanceMatrix * sp;
            sn = mat3(instanceMatrix) * sn;
          #endif
          vStrataP = (modelMatrix * sp).xyz;
          vStrataNY = normalize(mat3(modelMatrix) * sn).y;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStrataP;\nvarying float vStrataNY;\nfloat strataHash(float n) { return fract(sin(n * 12.9898 + 4.1) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float w = sin(vStrataP.x * 0.043) * 1.7 + sin(vStrataP.z * 0.057 + 1.3) * 1.3 + sin((vStrataP.x + vStrataP.z) * 0.013) * 2.5;
          float b = (vStrataP.y + w) / ${band.toFixed(2)};
          float id = floor(b), f = fract(b);
          float h = strataHash(id);
          vec3 tint = mix(vec3(0.84, 0.74, 0.7), vec3(1.12, 1.04, 0.97), h);
          if (h > 0.8) tint = vec3(1.24, 1.16, 1.04);
          if (h < 0.16) tint = vec3(0.68, 0.52, 0.47);
          float seam = smoothstep(0.0, 0.07, f) * smoothstep(1.0, 0.93, f);
          tint = mix(tint * 0.86, tint, seam);
          float steep = 1.0 - smoothstep(0.55, 0.86, vStrataNY);
          diffuseColor.rgb *= mix(vec3(1.0), tint, ${steepOnly ? 'steep' : 'max(steep, 0.3)'});
        }`);
  };
  mat.customProgramCacheKey = () => `strata-${band}-${steepOnly}`;
}

/** Mesa / butte: talus skirt, sheer strata cliff, flat cap. Local origin at ground level. */
export function mesaGeo(radius: number, height: number, seed: number, sides = 14): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const rings: Array<[number, number, number]> = [ // [radius factor, y factor, noise]
    [1.45, -0.08, 0.15], [1.18, 0.1, 0.12], [1.02, 0.2, 0.1], [0.99, 0.55, 0.08], [0.96, 0.82, 0.06], [0.93, 1.0, 0.05],
  ];
  const noiseA = Array.from({ length: sides }, () => rng.range(0.82, 1.12));
  const pos: number[] = [], ind: number[] = [];
  const R = rings.length;
  for (let r = 0; r < R; r++) {
    const [rf, yf, nz] = rings[r]!;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const na = noiseA[k]! * (1 + (rng.next() - 0.5) * nz);
      pos.push(Math.cos(a) * radius * rf * na, yf * height + (r === R - 1 ? 0 : (rng.next() - 0.5) * height * 0.03), Math.sin(a) * radius * rf * na);
      if (r > 0) {
        const a0 = (r - 1) * sides + k, a1 = (r - 1) * sides + (k + 1) % sides, b0 = r * sides + k, b1 = r * sides + (k + 1) % sides;
        ind.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  const c = pos.length / 3;
  pos.push(0, height * 1.01, 0);
  for (let k = 0; k < sides; k++) ind.push((R - 1) * sides + k, c, (R - 1) * sides + (k + 1) % sides);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(ind);
  const f = faceted(g);
  return strataPaint(f, 0, seed, '#b98553', height * 0.95);
}

function hoodooGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  let y = 0;
  for (let k = 0; k < 4; k++) {
    const h = rng.range(1.6, 2.6), r = 1.3 - k * 0.18 + rng.range(-0.1, 0.1);
    const g = new THREE.CylinderGeometry(r * 0.85, r, h, 8, 1);
    g.translate(rng.range(-0.1, 0.1), y + h / 2, rng.range(-0.1, 0.1));
    parts.push(g);
    y += h * 0.95;
  }
  const cap = new THREE.CylinderGeometry(1.25, 0.9, 0.9, 8, 1); cap.translate(0, y + 0.4, 0);
  parts.push(cap);
  const g = faceted(jitter(combine(parts), 0.08, seed));
  return strataPaint(g, 0, seed, '#9a5a3a', y);
}

function saguaroGeo(rng: Rng, arms: number): THREE.BufferGeometry {
  const green = '#4f8f4a';
  const p: THREE.BufferGeometry[] = [];
  const H = rng.range(4.6, 6.0);
  p.push(part(new THREE.CylinderGeometry(0.42, 0.5, H, 10), green, 0, H / 2, 0));
  p.push(part(new THREE.SphereGeometry(0.42, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), green, 0, H, 0));
  for (let a = 0; a < arms; a++) {
    const side = a % 2 ? -1 : 1;
    const y0 = rng.range(1.8, H * 0.6), up = rng.range(1.2, 2.2), out = rng.range(0.9, 1.3);
    const az = rng.range(-0.5, 0.5) + (side > 0 ? 0 : Math.PI);
    const arm: THREE.BufferGeometry[] = [];
    arm.push(part(new THREE.CylinderGeometry(0.3, 0.3, out, 8), green, out / 2, y0, 0, 0, 0, Math.PI / 2));
    arm.push(part(new THREE.SphereGeometry(0.3, 8, 6), green, out, y0, 0));
    arm.push(part(new THREE.CylinderGeometry(0.3, 0.3, up, 8), green, out, y0 + up / 2, 0));
    arm.push(part(new THREE.SphereGeometry(0.3, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), green, out, y0 + up, 0));
    const g = combine(arm);
    g.rotateY(az);
    p.push(g);
  }
  if (rng.chance(0.5)) p.push(part(new THREE.SphereGeometry(0.16, 6, 4), '#ff6fa8', 0.1, H + 0.35, 0.1));
  const g = combine(p);
  // subtle rib shading: darker in vertical grooves
  const pos = g.attributes.position as THREE.BufferAttribute, col = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.88 + 0.16 * Math.abs(Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 5)) + pos.getY(i) * 0.008;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return g;
}

function pricklyGeo(rng: Rng): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  const pad = (x: number, y: number, z: number, rz: number, ry: number, s: number) => {
    const g = new THREE.SphereGeometry(0.55 * s, 9, 7); g.scale(1, 1.2, 0.3);
    p.push(part(g, '#6aa34f', x, y, z, 0, ry, rz));
    if (rng.chance(0.6)) p.push(part(new THREE.SphereGeometry(0.1, 6, 4), rng.pick(['#ff5d8f', '#ffd23f']), x + Math.sin(rz) * -0.6 * s, y + Math.cos(rz) * 0.62 * s, z));
  };
  pad(0, 0.6, 0, 0, 0, 1.1);
  pad(0.55, 1.35, 0.1, -0.5, 0.4, 0.85);
  pad(-0.5, 1.3, -0.1, 0.55, -0.3, 0.8);
  pad(0.1, 2.0, 0, 0.1, 1.2, 0.7);
  return combine(p);
}

function scrubGeo(rng: Rng, color: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) { const g = jitter(blob(rng.range(0.5, 0.8), 7, 5, 0.3), 0.12, k + 5); g.translate(rng.range(-0.5, 0.5), 0.35, rng.range(-0.5, 0.5)); parts.push(g); }
  return gradientY(combine(parts), new THREE.Color(color).multiplyScalar(0.7).getStyle(), color);
}

function windpumpGeo(): { body: THREE.BufferGeometry; fan: THREE.BufferGeometry; hubY: number } {
  const wood = '#8a5a3b', metal = '#8f98a3';
  const p: THREE.BufferGeometry[] = [];
  const H = 11;
  for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const g = new THREE.BoxGeometry(0.2, H + 0.3, 0.2);
    g.rotateZ(-x! * 0.09); g.rotateX(z! * 0.09);
    g.translate(x! * 1.05, H / 2, z! * 1.05);
    p.push(paint(g, wood));
  }
  for (let k = 1; k < 5; k++) {
    const y = k * 2.2, w = 2.1 * (1 - y / H * 0.85) + 0.3;
    for (const [rx, rz, sx, sz] of [[0, 1, 1, 0], [0, -1, 1, 0], [1, 0, 0, 1], [-1, 0, 0, 1]]) {
      p.push(part(new THREE.BoxGeometry(sx! ? w * 1.02 : 0.1, 0.1, sz! ? w * 1.02 : 0.1), wood, rx! * w / 2, y, rz! * w / 2));
    }
  }
  p.push(part(new THREE.BoxGeometry(1.4, 0.15, 1.4), wood, 0, H, 0));
  p.push(part(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 6), metal, 0, H + 0.5, 0.6, Math.PI / 2));
  const vane = new THREE.BufferGeometry();
  vane.setAttribute('position', new THREE.Float32BufferAttribute([0, H + 0.6, -0.4, 0, H + 1.6, -3.2, 0, H + 0.1, -3.4, 0, H + 0.6, -0.4, 0, H + 0.1, -3.4, 0, H + 1.6, -3.2], 3));
  vane.computeVertexNormals();
  p.push(part(vane, '#d9480f'));
  p.push(part(new THREE.BoxGeometry(0.1, 0.1, 2.9), metal, 0, H + 0.6, -1.8));
  // water tank + trough
  p.push(part(new THREE.CylinderGeometry(1.6, 1.6, 2.2, 14), '#8f98a3', 4.2, 4.4, 0));
  p.push(part(new THREE.CylinderGeometry(1.7, 1.7, 0.2, 14), '#6b737d', 4.2, 5.55, 0));
  for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) p.push(part(new THREE.BoxGeometry(0.18, 3.4, 0.18), wood, 4.2 + x! * 1.1, 1.65, z! * 1.1));
  p.push(part(new THREE.BoxGeometry(3.2, 0.7, 1.0), wood, 2.4, 0.35, 2.2));
  p.push(part(new THREE.BoxGeometry(3.0, 0.1, 0.8), '#4fb3d9', 2.4, 0.62, 2.2));
  const fanParts: THREE.BufferGeometry[] = [part(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 10), metal, 0, 0, 0, Math.PI / 2)];
  for (let k = 0; k < 16; k++) {
    const g = new THREE.BoxGeometry(0.34, 1.35, 0.04);
    g.translate(0, 1.0, 0);
    g.rotateY(0.35);
    g.rotateZ((k / 16) * Math.PI * 2);
    fanParts.push(paint(g, k % 4 ? '#dfe4e8' : '#d9480f'));
  }
  fanParts.push(part(new THREE.TorusGeometry(1.62, 0.05, 4, 32), metal));
  return { body: combine(p), fan: combine(fanParts), hubY: H + 0.6 };
}

function wagonGeo(): THREE.BufferGeometry {
  const wood = '#8a5a3b', dark = '#5e3b25';
  const p: THREE.BufferGeometry[] = [];
  p.push(part(new THREE.BoxGeometry(2.2, 0.9, 4.6), wood, 0, 1.35, 0));
  p.push(part(new THREE.BoxGeometry(2.3, 0.12, 4.7), dark, 0, 1.82, 0));
  // canvas bonnet: the z ≤ 0 half of an open cylinder becomes the UPPER half after rotateX(+90°)
  // (y' = −z); a reversed-winding copy shows the inside through the open ends
  const cover = new THREE.CylinderGeometry(1.25, 1.25, 4.2, 16, 1, true, Math.PI / 2, Math.PI);
  cover.rotateX(Math.PI / 2);
  const inside = normalize(cover.clone());
  const ii = inside.index!.array as Uint32Array;
  for (let t = 0; t < ii.length; t += 3) { const a = ii[t]!; ii[t] = ii[t + 1]!; ii[t + 1] = a; }
  inside.computeVertexNormals();
  p.push(part(cover, '#f4ead6', 0, 1.85, 0), part(inside, '#e2d3b6', 0, 1.85, 0));
  for (let k = 0; k < 4; k++) p.push(part(new THREE.TorusGeometry(1.27, 0.05, 4, 16, Math.PI), '#b98552', 0, 1.85, -1.8 + k * 1.2));
  for (const [x, z, r] of [[1.2, 1.5, 0.8], [-1.2, 1.5, 0.8], [1.2, -1.5, 0.95], [-1.2, -1.5, 0.95]]) {
    p.push(part(new THREE.TorusGeometry(r!, 0.09, 5, 16), dark, x!, r!, z!, 0, Math.PI / 2));
    for (let k = 0; k < 6; k++) p.push(part(new THREE.BoxGeometry(0.05, r! * 2, 0.07), wood, x!, r!, z!, (k / 6) * Math.PI, Math.PI / 2, 0));
    p.push(part(new THREE.CylinderGeometry(0.14, 0.14, 0.2, 8), dark, x!, r!, z!, 0, 0, Math.PI / 2));
  }
  p.push(part(new THREE.BoxGeometry(0.12, 0.12, 2.4), wood, 0.3, 0.8, 3.4, -0.2));
  p.push(part(new THREE.BoxGeometry(0.12, 0.12, 2.4), wood, -0.3, 0.8, 3.4, -0.2));
  p.push(part(new THREE.CylinderGeometry(0.35, 0.4, 0.8, 8), '#b98552', 0.7, 2.3, -2.6));
  return combine(p);
}

function campfireGeo(): { logs: THREE.BufferGeometry; flame: THREE.BufferGeometry } {
  const logs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) logs.push(part(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 6), '#6b4226', 0, 0.2, 0, Math.PI / 2 - 0.25, (k / 4) * Math.PI, 0));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; logs.push(part(new THREE.DodecahedronGeometry(0.22, 0), '#8c7b6a', Math.cos(a) * 0.8, 0.12, Math.sin(a) * 0.8)); }
  const flame = combine([part(new THREE.ConeGeometry(0.38, 1.1, 7), '#ffb347', 0, 0.75, 0), part(new THREE.ConeGeometry(0.22, 0.8, 6), '#fff2a8', 0, 0.62, 0)]);
  return { logs: combine(logs), flame };
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ───────────────────────────── Builder ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildCanyonScenery(ctx));
}

function buildCanyonScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const q = quality.scenery;
  const bag = new Bag();
  const mats = new Materials(bag);
  const root = bag.add(scene, new THREE.Group());
  root.name = 'scenery-canyon';
  const seed = track.def.scenerySeed + 303;
  const rng = new Rng(seed);
  const ext = trackExtent(track);
  const terrain = buildTerrain(track, { ground: PAL.ground, groundAlt: PAL.groundAlt, pitColor: PAL.pitColor, hills: 20, seed });
  terrain.mesh.receiveShadow = true;
  bag.add(root, terrain.mesh);
  bag.track(terrain);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const dust = new THREE.Color('#e9b07e'), sage = new THREE.Color('#b59a62'), tmp = new THREE.Color(), rockHi = new THREE.Color('#e8935c');
  recolorTerrain(terrain.mesh, (x, y, z, c, ny) => {
    const steep = 1 - smooth(0.72, 0.95, ny);
    tmp.set('#c9643c').lerp(rockHi, 0.5 + 0.5 * noise2(x / 25, z / 25 + y / 12, seed));
    c.lerp(tmp, Math.min(1, steep * 1.1));
    const n = noise2(x / 38, z / 38, seed + 4);
    c.lerp(n > 0 ? dust : sage, Math.abs(n) * 0.45 * (1 - steep));
  });
  applyStrata(terrain.mesh.material as THREE.MeshStandardMaterial, 2.7, true);
  applyStrata(mats.vc(0.9, { flat: true }));
  const reserve = new Reserve();
  const inPit = pitZone(track);
  reserve.block(inPit);
  reserveTrackFurniture(track, reserve);
  const stat = new Batch(mats.vc(0.85), { chunk: 260, castShadow: true, receiveShadow: true, name: 'canyon-static' });
  const rocksB = new Batch(mats.vc(0.9, { flat: true }), { chunk: 300, castShadow: true, receiveShadow: true, name: 'canyon-rock' });
  const m4 = new THREE.Matrix4();
  const faceTrack = (x: number, z: number) => { const n = terrain.nearestTrack(x, z); return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z); };
  const clearance = (x: number, z: number) => { const n = terrain.nearestTrack(x, z); return n.dist - Math.max(track.wallL[n.i]!, track.wallR[n.i]!); };
  const glows = bag.track(new Glows(32, bag.track(radialTexture())));
  bag.add(root, glows.mesh);

  // ── gorge cliffs along walled runs ──
  const cliffMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true, side: THREE.DoubleSide }));
  applyStrata(cliffMat);
  // landmarks standing where a gorge cliff would bury them (wagon camps, banners…): the cliff opens
  // into a low notch around them so they stay visible from the road
  const notches = track.landmarks
    .filter(l => l.side !== 'over')
    .map(l => { const f = frameAt(track, l.s); return { s: l.s, side: l.side === 'left' ? -1 : 1, reach: l.dist - Math.max(track.wallL[f.i]!, track.wallR[f.i]!) }; })
    .filter(n => n.reach < 30);
  // the start gantry and the track-mesh arches / over-road banners stand just outside the barriers: open the
  // gorge wall on both sides so their feet stand on a shelf instead of being swallowed by the cliff face
  for (const s of [track.startS, ...track.landmarks.filter(l => l.side === 'over' && isTrackMeshKind(l.kind)).map(l => l.s)]) {
    for (const side of [-1, 1]) notches.push({ s, side, reach: 0 });
  }
  const notchAt = (i: number, side: number): number => {
    let k = 1;
    for (const n of notches) {
      if (n.side !== side) continue;
      let ds = Math.abs(i * track.spacing - n.s);
      ds = Math.min(ds, track.length - ds);
      k = Math.min(k, smooth(9, 24, ds));
    }
    return k;
  };
  for (const side of [-1, 1] as const) {
    const edge = side < 0 ? track.edgeL : track.edgeR;
    const wallA = side < 0 ? track.wallL : track.wallR;
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < track.n; i++) {
      const ok = edge[i] === 1 && track.rampH[i]! === 0;
      if (ok) cur.push(i); else if (cur.length) { runs.push(cur); cur = []; }
    }
    if (cur.length) { if (runs.length && runs[0]![0] === 0) runs[0] = [...cur, ...runs[0]!]; else runs.push(cur); }
    for (const run of runs) {
      if (run.length < 14) continue;
      const pos: number[] = [], ind: number[] = [];
      const prof = [[0.9, -1.8, 0], [1.5, 0.5, 0.5], [2.6, 1.0, 1], [11, 0.97, 1], [26, -0.05, 0]] as const;
      let k = 0;
      for (let j = 0; j < run.length; j += 2, k++) {
        const i = run[j]!;
        const tx = track.tx[i]!, tz = track.tz[i]!, hl = Math.hypot(tx, tz) || 1;
        const rx = (-tz / hl) * side, rz = (tx / hl) * side;
        const kc = track.curvature[i]! * side;
        const limit = kc > 1e-4 ? 0.9 / kc : Infinity;
        const endTaper = smooth(0, 14, Math.min(j, run.length - 1 - j));
        const notch = notchAt(i, side);
        const h = (9 + 10 * (0.5 + 0.5 * noise2(i * 0.02, side * 7, seed + 11))) * endTaper * notch + 1.2;
        let prevD = 0;
        for (const [off, hf, isTop] of prof) {
          let d = Math.min(wallA[i]! + off, Math.max(limit, wallA[i]! + 1));
          const x0 = track.px[i]! + rx * d, z0 = track.pz[i]! + rz * d;
          if (off > 3 && terrain.inCorridor(x0, z0, 1)) d = Math.max(prevD, wallA[i]! + 2.6);
          prevD = d;
          const x = track.px[i]! + rx * d, z = track.pz[i]! + rz * d;
          let y = hf < 0 && isTop === 0 && off > 20 ? H(x, z) - 1 : track.py[i]! + h * hf + (isTop ? noise2(i * 0.11, off, seed) * 0.8 : 0);
          // inside a notch the cliff body flattens into a rock shelf at road level (the ground beside a
          // raised ledge road can be far below), then slopes down to the terrain as usual
          if (notch < 1 && off > 2 && off < 20) { const shelf = Math.max(H(x, z) - 0.6, track.py[i]! - 0.5); y = shelf + (y - shelf) * notch; }
          pos.push(x, y, z);
        }
        if (k > 0) {
          const a = (k - 1) * 5, b = k * 5;
          for (let r = 0; r < 4; r++) ind.push(a + r, b + r, a + r + 1, a + r + 1, b + r, b + r + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(ind);
      const f = faceted(g);
      strataPaint(f, 0, seed + 5, '#c08050', -1000);
      const mesh = new THREE.Mesh(f, cliffMat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'gorge-cliff';
      bag.add(root, mesh);
    }
  }

  // ── mesas, buttes, hoodoos ──
  const addMesa = (x: number, z: number, r: number, h: number, sd: number) => {
    const g = mesaGeo(r, h, sd);
    g.applyMatrix4(trs(x, Math.min(H(x, z), H(x + r, z), H(x - r, z), H(x, z + r), H(x, z - r)) - 1.5, z, 0, rng.range(0, 6), 0, 1, 1, 1, m4));
    rocksB.addRaw(g);
    reserve.add(x, z, r * 1.5);
  };
  let nMesa = 0;
  const hoodoos = [hoodooGeo(seed + 1), hoodooGeo(seed + 2), hoodooGeo(seed + 3)].map(g => bag.track(g));
  const hoodooXf: Xf[][] = [[], [], []];

  /**
   * Ground for a road-side landmark. Where the road runs on a raised ledge above much lower terrain
   * (the terrain follows the LOWEST nearby road), a prop at terrain height would sit out of sight far
   * below the barrier: raise a flat-topped rock plinth to road level instead and stand it on that.
   */
  const landmarkGround = (x: number, z: number, r: number): number => {
    const g = H(x, z);
    const n = terrain.nearestTrack(x, z);
    const roadY = track.py[n.i]! - 0.5;
    if (roadY - g < 3 || n.dist > 45) return g;
    const m = mesaGeo(r, roadY - g + 2, seed + 600 + Math.round(x * 13 + z * 7), 12);
    m.applyMatrix4(trs(x, g - 2, z, 0, rng.range(0, 6), 0, 1, 1, 1, m4));
    rocksB.addRaw(m);
    return roadY + 0.02;
  };

  // ── other landmark builders ──
  const wp = windpumpGeo();
  bag.track(wp.body); bag.track(wp.fan);
  const fans: Array<{ obj: THREE.Object3D; speed: number }> = [];
  const addPump = (x: number, z: number, yaw: number, s: number) => {
    const y = landmarkGround(x, z, 6.5 * s) - 0.1;
    stat.add(wp.body, trs(x, y, z, 0, yaw, 0, s, s, s, m4));
    const fan = new THREE.Mesh(wp.fan, mats.vc(0.6));
    fan.castShadow = true;
    const off = new THREE.Vector3(0, wp.hubY, 1.45).multiplyScalar(s).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    fan.position.set(x + off.x, y + off.y, z + off.z);
    fan.rotation.set(0, yaw, 0, 'YXZ');
    fan.scale.setScalar(s);
    bag.add(root, fan);
    fans.push({ obj: fan, speed: rng.range(1.4, 2.2) });
    reserve.add(x, z, 7 * s);
  };
  const wagon = bag.track(wagonGeo());
  const fire = campfireGeo();
  bag.track(fire.logs); bag.track(fire.flame);
  const fireBatch = new Batch(mats.glow(), { name: 'campfire' });
  const fireGlows: number[] = [];
  const addWagon = (x: number, z: number, yaw: number, s: number) => {
    const gy = landmarkGround(x, z, 8.5 * s), raised = gy > H(x, z) + 1;
    stat.add(wagon, trs(x, gy - 0.05, z, 0, yaw + 0.6, 0, s, s, s, m4));
    const fx = x + Math.cos(yaw) * 5 * s, fz = z - Math.sin(yaw) * 5 * s;
    if (!terrain.inCorridor(fx, fz, 2)) {
      const fy = raised ? gy : H(fx, fz);
      stat.add(fire.logs, trs(fx, fy, fz, 0, 0, 0, 1, 1, 1, m4));
      fireBatch.add(fire.flame, trs(fx, fy, fz, 0, 0, 0, 1, 1, 1, m4));
      fireGlows.push(glows.push(fx, fy + 1.0, fz, 3.2, '#ffab52', 0.9));
    }
    reserve.add(x, z, 7 * s);
  };
  const rockPieces = Array.from({ length: 8 }, (_, k) => {
    const g = rockGeo(2.4 + (k % 3) * 0.4, '#ffffff', 500 + k, 0.85);
    return bag.track(strataPaint(g, k * 1.7, seed + k));
  });
  /** Natural sandstone arch spanning the road (strata come from the world-height shader). */
  const addArchOver = (f: ReturnType<typeof frameAt>, s: number) => {
    const wall = Math.max(track.wallL[f.i]!, track.wallR[f.i]!);
    const thick = 3.6 * s, hx = wall + 2.4 + thick, base = f.y - 2.5;
    const g = naturalArchGeo({ span: hx * 2, height: 13 + 4 * s, thick, depth: 6.5 * s, seed: seed + f.i, bury: 18 });
    g.applyMatrix4(trs(f.x, base, f.z, 0, f.yaw + Math.PI, 0, 1, 1, 1, m4));
    rocksB.addRaw(strataPaint(g, 0, seed + f.i, '#b98553', base + 13 + 4 * s));
    for (const sx of [-1, 1]) {
      const px = f.x + f.rx * sx * (hx + 3.5), pz = f.z + f.rz * sx * (hx + 3.5);
      if (!terrain.inCorridor(px, pz, 2)) rocksB.add(rockPieces[(sx + 1) * 2]!, trs(px, Math.min(H(px, pz), base + 2) - 0.6, pz, rng.range(0, 3), rng.range(0, 3), 0, 1.5 * s, 1.1 * s, 1.5 * s, m4));
      reserve.add(f.x + f.rx * sx * hx, f.z + f.rz * sx * hx, 8 * s);
    }
  };
  const addArchSide = (x: number, z: number, yaw: number, s: number) => {
    const base = Math.min(H(x, z), H(x + Math.cos(yaw) * 8 * s, z - Math.sin(yaw) * 8 * s), H(x - Math.cos(yaw) * 8 * s, z + Math.sin(yaw) * 8 * s)) - 0.5;
    const g = naturalArchGeo({ span: 16 * s, height: 12 * s, thick: 3.2 * s, depth: 4.8 * s, seed: seed + Math.round(x * 7 + z), bury: 8 });
    g.applyMatrix4(trs(x, base, z, 0, yaw, 0, 1, 1, 1, m4));
    rocksB.addRaw(strataPaint(g, 0, seed + 17, '#b98553', base + 11 * s));
    reserve.add(x, z, 11 * s);
  };
  const plank = bag.track(part(new THREE.BoxGeometry(3.2, 0.14, 0.55), '#a8794f'));
  const ropeSeg = bag.track(part(new THREE.CylinderGeometry(0.05, 0.05, 1, 4), '#d6c29a', 0, 0.5, 0));
  const addRopeBridge = (f: ReturnType<typeof frameAt>, s: number) => {
    const wall = Math.max(track.wallL[f.i]!, track.wallR[f.i]!);
    const span = wall + 6;
    const deckY = f.y + 13 * s;
    for (const sx of [-1, 1]) {
      const px = f.x + f.rx * sx * (span + 1.5), pz = f.z + f.rz * sx * (span + 1.5);
      const gy = Math.min(H(px, pz), f.y) - 1;
      const g = mesaGeo(3.4, deckY - gy + 0.8, seed + 40 + sx, 9);
      g.applyMatrix4(trs(px, gy, pz, 0, rng.range(0, 6), 0, 1, 1, 1, m4));
      rocksB.addRaw(g);
      reserve.add(px, pz, 6);
    }
    const yaw = f.yaw;
    const N = Math.ceil((span * 2) / 0.62);
    let prev: Array<THREE.Vector3> | null = null;
    for (let k = 0; k <= N; k++) {
      const t = k / N, lx = -span + t * span * 2;
      const sag = Math.sin(Math.PI * t) * 1.3;
      const x = f.x + f.rx * lx, z = f.z + f.rz * lx, y = deckY - sag;
      // plank long axis along the track = across the bridge walkway; a little rustic jitter
      stat.add(plank, trs(x, y + (rng.next() - 0.5) * 0.04, z, (rng.next() - 0.5) * 0.05, yaw - Math.PI / 2 + (rng.next() - 0.5) * 0.06, 0, 1, 1, 1, m4));
      const rails = [-1.55, 1.55].map(o => new THREE.Vector3(x + Math.sin(yaw) * o, y + 1.1, z + Math.cos(yaw) * o));
      if (prev && k % 1 === 0) for (let r = 0; r < 2; r++) {
        const a = prev[r]!, b = rails[r]!;
        const d = b.clone().sub(a), len = d.length();
        const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
        const qq = new THREE.Quaternion().setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
        stat.add(ropeSeg, new THREE.Matrix4().compose(a, qq, new THREE.Vector3(1, len, 1)));
        if (k % 3 === 0) stat.add(ropeSeg, trs(b.x, y, b.z, 0, 0, 0, 1, 1.1, 1, m4));
      }
      prev = rails;
    }
  };

  const cactusXf: Xf[][] = [[], [], []];
  // ── landmarks from the track ──
  let nPump = 0, nWagon = 0, nArch = 0;
  for (const l of track.landmarks) {
    if (isTrackMeshKind(l.kind)) continue;
    const k = normKind(l.kind);
    const pl = landmarkPlace(track, l, H);
    if (k === 'rockarch' || k === 'naturalarch' || k === 'rockarches') { if (pl.side === 'over') addArchOver(pl.frame, pl.scale); else addArchSide(pl.x, pl.z, pl.yaw + Math.PI / 2, pl.scale); nArch++; }
    else if (k === 'bridge' || k === 'ropebridge' || k === 'footbridge') { if (pl.side === 'over') addRopeBridge(pl.frame, pl.scale); else addArchSide(pl.x, pl.z, pl.yaw, pl.scale); }
    else if (pl.side === 'over') addArchOver(pl.frame, pl.scale);
    else if (k === 'mesa' || k === 'butte' || k === 'plateau') {
      const cl = clearance(pl.x, pl.z) - 4;
      const r = Math.max(8, Math.min(34 * pl.scale, cl / 1.45));
      addMesa(pl.x, pl.z, r, r * rng.range(0.8, 1.0) + 16 * pl.scale, seed + 90 + nMesa++);
    } else if (k === 'windmillpump' || k === 'windpump' || k === 'windmill' || k === 'pump' || k === 'watertower') { addPump(pl.x, pl.z, pl.yaw, pl.scale); nPump++; }
    else if (k === 'wagon' || k === 'wagons' || k === 'coveredwagon' || k === 'camp') { addWagon(pl.x, pl.z, pl.yaw, pl.scale); nWagon++; }
    else if (k === 'cactus' || k === 'cacti' || k === 'saguaro') {
      const gy = landmarkGround(pl.x, pl.z, 9), raised = gy > H(pl.x, pl.z) + 1;
      for (let j = 0; j < 5; j++) { const x = pl.x + rng.range(-6, 6), z = pl.z + rng.range(-6, 6); if (!terrain.inCorridor(x, z, 2)) cactusXf[rng.int(0, 3)]!.push({ x, y: (raised ? gy : H(x, z)) - 0.1, z, ry: rng.range(0, 6), s: pl.scale * rng.range(0.9, 1.3) }); }
      reserve.add(pl.x, pl.z, 4);
    } else {
      const gy = landmarkGround(pl.x, pl.z, 8), raised = gy > H(pl.x, pl.z) + 1;
      for (let j = 0; j < 4; j++) { const x = pl.x + rng.range(-5, 5), z = pl.z + rng.range(-5, 5); if (!terrain.inCorridor(x, z, 3)) hoodooXf[j % 3]!.push({ x, y: (raised ? gy : H(x, z)) - 0.3, z, ry: rng.range(0, 6), s: pl.scale * rng.range(1, 1.6) }); }
      reserve.add(pl.x, pl.z, 8);
    }
  }

  const spots = scatter(terrain, 90, seed + 71, { minDist: 30, maxDist: 110, pad: 8 });
  const takeSpot = (r: number) => { for (const p of spots) if (clearOf(terrain, p.x, p.z, r) && reserve.ok(p.x, p.z, r + 4)) return p; return null; };
  if (nPump < 2) for (let j = nPump; j < 2; j++) { const p = takeSpot(8); if (p) addPump(p.x, p.z, faceTrack(p.x, p.z), 1); }
  if (nWagon < 2) for (let j = nWagon; j < 2; j++) { const p = takeSpot(8); if (p) addWagon(p.x, p.z, faceTrack(p.x, p.z), 1); }
  if (nArch < 2) { const p = takeSpot(12); if (p) addArchSide(p.x, p.z, faceTrack(p.x, p.z) + Math.PI / 2, 1.3); }
  // backdrop mesas and buttes
  for (const p of scatter(terrain, qcount(14, q), seed + 72, { minDist: 90, maxDist: 520, pad: 20 })) {
    const cl = clearance(p.x, p.z) - 6;
    const r = Math.min(rng.range(22, 46), cl / 1.45);
    if (r < 12 || !reserve.ok(p.x, p.z, r * 1.4)) continue;
    addMesa(p.x, p.z, r, r * rng.range(0.6, 1.0) + rng.range(14, 30), seed + 200 + nMesa++);
  }
  for (const p of scatter(terrain, qcount(16, q), seed + 73, { minDist: 45, maxDist: 300, pad: 12 })) {
    const cl = clearance(p.x, p.z) - 5;
    const r = Math.min(rng.range(6, 11), cl / 1.45);
    if (r < 4.5 || !reserve.ok(p.x, p.z, r * 1.4)) continue;
    addMesa(p.x, p.z, r, rng.range(24, 42), seed + 400 + nMesa++);
  }
  for (const p of scatter(terrain, qcount(36, q), seed + 74, { minDist: 18, maxDist: 110, pad: 5 })) {
    if (!reserve.ok(p.x, p.z, 2.5)) continue;
    hoodooXf[rng.int(0, 3)]!.push({ x: p.x, y: p.y - 0.3, z: p.z, ry: p.r, s: p.s * rng.range(0.8, 1.6) });
    reserve.add(p.x, p.z, 2.5);
  }

  // ── chasm below pit edges ──
  const chasmMat = mats.vc(0.95);
  for (const run of pitRuns(track)) {
    const top = runMinY(track, run);
    const floor = pitStrip(track, run, 60, top - 27);
    const pp = floor.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pp.count * 3);
    const cA = new THREE.Color('#5a2c1a'), cB = new THREE.Color('#8a4a2c');
    for (let i = 0; i < pp.count; i++) { tmp.copy(cA).lerp(cB, (i % 2) * 0.6 + 0.2 * noise2(pp.getX(i) / 9, pp.getZ(i) / 9, seed)); col.set([tmp.r, tmp.g, tmp.b], i * 3); }
    floor.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const fm = new THREE.Mesh(floor, chasmMat); fm.receiveShadow = true; fm.name = 'chasm-floor';
    bag.add(root, fm);
    for (let j = 0; j < run.samples.length; j += 3) {
      const i = run.samples[j]!, f = frameAt(track, i * track.spacing), d = run.side * (track.hw[i]! + rng.range(3, 18));
      rocksB.add(rockPieces[j % 8]!, trs(f.x + f.rx * d, top - 27, f.z + f.rz * d, rng.range(0, 3), rng.range(0, 3), 0, rng.range(0.4, 0.9), rng.range(0.4, 0.9), rng.range(0.4, 0.9), m4));
    }
  }

  // ── split-rail fences on open stretches ──
  const post = bag.track(part(new THREE.BoxGeometry(0.22, 1.3, 0.22), '#8a5a3b', 0, 0.55, 0));
  const rail = bag.track(combine([part(new THREE.BoxGeometry(0.1, 0.14, 1), '#9a6a45', 0, 0.55, 0), part(new THREE.BoxGeometry(0.1, 0.14, 1), '#9a6a45', 0, 1.0, 0)]));
  for (const side of [-1, 1]) {
    let s0 = rng.range(0, 40);
    while (s0 < track.length) {
      const runLen = rng.range(25, 60);
      let prev: { x: number; y: number; z: number } | null = null;
      for (let a = 0; a < runLen; a += 3) {
        const f = frameAt(track, s0 + a);
        const edge = side < 0 ? track.edgeL[f.i]! : track.edgeR[f.i]!;
        const d = side * ((side < 0 ? track.wallL[f.i]! : track.wallR[f.i]!) + 4);
        const x = f.x + f.rx * d, z = f.z + f.rz * d;
        if (edge !== 0 || terrain.inCorridor(x, z, 1.2) || !reserve.ok(x, z, 0.5)) { prev = null; continue; }
        const y = H(x, z);
        stat.add(post, trs(x, y, z, 0, f.yaw, 0, 1, 1, 1, m4));
        if (prev) { const dx = x - prev.x, dz = z - prev.z, dy = y - prev.y, len = Math.hypot(dx, dz); if (len < 5) stat.add(rail, trs((x + prev.x) / 2, (y + prev.y) / 2, (z + prev.z) / 2, -Math.atan2(dy, len), Math.atan2(dx, dz), 0, 1, 1, len, m4)); }
        prev = { x, y, z };
      }
      s0 += runLen + rng.range(60, 150);
    }
  }
  // a signpost near the start
  {
    const f = frameAt(track, track.startS + 30), d = -(track.wallL[f.i]! + 3);
    const x = f.x + f.rx * d, z = f.z + f.rz * d;
    if (!terrain.inCorridor(x, z, 1) && reserve.ok(x, z, 1)) {
      const sign = combine([
        part(new THREE.CylinderGeometry(0.12, 0.14, 3.4, 6), '#8a5a3b', 0, 1.7, 0),
        part(new THREE.BoxGeometry(2.2, 0.45, 0.1), '#c98a5a', 0.6, 2.9, 0, 0, 0, 0.05),
        part(new THREE.BoxGeometry(2.0, 0.45, 0.1), '#b97a4a', -0.5, 2.3, 0.05, 0, 0.5, -0.06),
        part(new THREE.ConeGeometry(0.32, 0.5, 3), '#c98a5a', 1.85, 2.9, 0, 0, 0, -Math.PI / 2),
      ]);
      stat.add(sign, trs(x, H(x, z), z, 0, f.yaw + Math.PI / 2, 0, 1, 1, 1, m4));
      sign.dispose();
    }
  }

  stat.build(root, bag);
  rocksB.build(root, bag);
  fireBatch.build(root, bag);

  // ── instanced desert flora ──
  for (const p of scatter(terrain, qcount(170, q), seed + 5, { minDist: 13, maxDist: 220, pad: 3 })) {
    if (!reserve.ok(p.x, p.z, 1)) continue;
    cactusXf[rng.int(0, 3)]!.push({ x: p.x, y: p.y - 0.15, z: p.z, ry: p.r, s: p.s });
  }
  const cactusMat = mats.vc(0.7);
  [saguaroGeo(rng, 1), saguaroGeo(rng, 2), saguaroGeo(rng, 3)].forEach((g, k) => addInstanced(root, bag, g, cactusMat, cactusXf[k]!, { castShadow: true, receiveShadow: true, name: `saguaro${k}` }));
  const small = scatter(terrain, qcount(260, q), seed + 6, { minDist: 11, maxDist: 150, pad: 2 }).filter(p => reserve.ok(p.x, p.z, 0.8));
  const pearXf: Xf[] = [], scrubXf: Xf[][] = [[], []];
  small.forEach((p, k) => (k % 3 === 0 ? pearXf : scrubXf[k % 2]!).push({ x: p.x, y: p.y - 0.1, z: p.z, ry: p.r, s: p.s }));
  addInstanced(root, bag, pricklyGeo(rng), cactusMat, pearXf, { castShadow: true, receiveShadow: true, name: 'prickly' });
  addInstanced(root, bag, scrubGeo(rng, '#a8a05a'), mats.vc(0.95), scrubXf[0]!, { castShadow: true, receiveShadow: true, name: 'scrubA' });
  addInstanced(root, bag, scrubGeo(rng, '#c9a268'), mats.vc(0.95), scrubXf[1]!, { castShadow: true, receiveShadow: true, name: 'scrubB' });
  hoodoos.forEach((g, k) => addInstanced(root, bag, g.clone(), mats.vc(0.9, { flat: true }), hoodooXf[k]!, { castShadow: true, receiveShadow: true, name: `hoodoo${k}` }));
  const rockPts = scatter(terrain, qcount(90, q), seed + 7, { minDist: 12, maxDist: 250, pad: 2 }).filter(p => reserve.ok(p.x, p.z, 1));
  addInstanced(root, bag, strataPaint(rockGeo(1, '#ffffff', seed, 0.65), 0, seed), mats.vc(0.9, { flat: true }), rockPts.map(p => ({ x: p.x, y: p.y - 0.3, z: p.z, ry: p.r, s: p.s * rng.range(0.6, 2.2) })), { castShadow: true, receiveShadow: true, name: 'rocks' });
  const grassMatPts = scatter(terrain, qcount(600, q), seed + 8, { minDist: 9, maxDist: 90, pad: 0.6 }).filter(p => !inPit(p.x, p.z));
  const tuft = (() => { const bl: THREE.BufferGeometry[] = []; for (let k = 0; k < 6; k++) { const g = new THREE.ConeGeometry(0.05, rng.range(0.4, 0.7), 3, 1); g.translate(0, 0.28, 0); g.rotateZ(rng.range(-0.6, 0.6)); g.rotateX(rng.range(-0.6, 0.6)); g.translate(rng.range(-0.25, 0.25), 0, rng.range(-0.25, 0.25)); bl.push(g); } return gradientY(combine(bl), '#9c7c45', '#e4c98a'); })();
  addInstanced(root, bag, tuft, mats.vc(0.95), grassMatPts.map(p => ({ x: p.x, y: p.y - 0.05, z: p.z, ry: p.r, s: p.s })), { receiveShadow: true, name: 'drygrass' });

  // ── horizon & sky ──
  const tb = terrain.bounds;
  const tcx = (tb.minX + tb.maxX) / 2, tcz = (tb.minZ + tb.maxZ) / 2;
  const half = Math.min(tb.maxX - tb.minX, tb.maxZ - tb.minZ) / 2;
  const base = ext.minY - 1;
  bag.add(root, buildFarGround(tcx, tcz, half * 0.8, half + 900, base - 12, '#c9784c'));
  bag.add(root, buildRing({ seed: seed + 11, cx: tcx, cz: tcz, radius: half + 50, baseY: base - 8, hMin: 18, hMax: 70, bottom: '#c46a44', top: '#d98a5c', mesa: true, bands: STRATA, sunDir: SUN, jag: 0.4, facets: true }));
  bag.add(root, buildRing({ seed: seed + 12, cx: tcx, cz: tcz, radius: half + 300, baseY: base - 10, hMin: 50, hMax: 170, bottom: '#d58f72', top: '#c98a86', mesa: true, sunDir: SUN, jag: 0.5 }));
  const clouds = buildClouds({ seed: seed + 13, count: Math.max(4, qcount(8, q)), cx: ext.cx, cz: ext.cz, rMin: 200, rMax: half + 380, yMin: 150, yMax: 230, top: '#fff1de', bottom: '#f3b890', size: 1.0, emissive: '#ffd2a8', emissiveIntensity: 0.5 });
  clouds.scale.set(1, 0.55, 1);
  bag.add(root, clouds);
  const vultures = bag.track(new Flock({ seed: seed + 14, count: qcount(9, q), cx: ext.cx, cz: ext.cz, spread: ext.r * 0.6, yMin: 45, yMax: 80, color: '#3a2a26', size: 1.8, groups: 3 }));
  bag.add(root, vultures.mesh);

  // ── movers ──
  const rigs: MoverRig[] = [];
  let boulderGeo: THREE.BufferGeometry | null = null, moverGeneric: THREE.BufferGeometry | null = null;

  return {
    environment: CANYON_ENV,
    update(dt, time) {
      for (const f of fans) f.obj.rotation.z = -time * f.speed;
      for (let k = 0; k < fireGlows.length; k++) glows.setLevel(fireGlows[k]!, 0.8 + 0.2 * Math.sin(time * 17 + k * 3) + 0.12 * Math.sin(time * 29 + k));
      clouds.rotation.y = time * 0.0015;
      vultures.update(time * 0.7);
      // boulders roll about their centre: the game glue's roll (root.rotation.x) is re-applied there,
      // otherwise the rig rolls from its own world motion
      for (const r of rigs) {
        if (r.kind === 'boulder') updateRoll(r);
        else updateGeneric(r, time);
      }
      void dt;
    },
    createMover(look) {
      const k = normKind(look);
      if (k === 'boulder' || k === 'rock' || k === 'rollingrock') {
        boulderGeo ??= bag.track(strataPaint(rockGeo(1.5, '#ffffff', seed + 77, 0.95, 1), 0, seed + 3));
        const inner = new THREE.Mesh(boulderGeo, mats.vc(0.9, { flat: true }));
        inner.castShadow = true;
        const holder = new THREE.Group();
        holder.position.y = 1.45;
        holder.add(inner);
        const rig = makeRig('boulder', holder, rigs.length);
        rig.spin = inner;
        rig.centre = new THREE.Vector3(0, 1.45, 0);
        rig.radius = 1.5;
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
