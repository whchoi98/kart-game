/**
 * Jungle Ruins — jungle theme scenery.
 * Dense layered jungle (instanced big-leaf trees, palms, ferns, bushes, elephant-ear plants, vines), stepped pyramids,
 * temples, totems, broken columns, stone heads, ruin walls behind barriers, ruins archways over the road, waterfalls
 * with animated water + mist, a river under the rope bridge (water below every 'pit' section), fireflies, pollen,
 * humid green haze, distant karst towers.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, fbm, scatter } from '../terrain.js';
import { createPlankTexture } from '../textures.js';
import type { LandmarkDef } from '../../../sim/types.js';
import {
  Bin, GeoBatch, MoverAnimator, Rng, Shapes, SkyLayer,
  buildCards, buildSuspensionBridge, clamp01, clearOfRoad, cloudTexture, corridorHalf, createBatchMaterials, createPrecip,
  createPuffs, createTwinkles, disposeObjects, fallMaterial, findPitRuns, frameAtIndex, indexAtS, instanced, instancedChunks, jitterTint, landmarkPose,
  liquidMaterial, lumpy, mixHex, mountainGeometry, pitDepthFor, puffTexture, recolorTerrain, skyDir, smoothstep,
  trackStats, trs, trsTo, tubeAlong, vGrad, viewHeight, wrapIndex,
  type ColorFn, type PointField, type Placement, type TrackFrame, withCorridorGuard, activeCorridorGuard, placementMatrix,
} from './props-b.js';

const SKIP = new Set(['grandstand', 'arch', 'banner']);

export const JUNGLE_ENV: EnvironmentSettings = {
  skyTop: '#3a93d2', skyHorizon: '#d4eed2', skyBottom: '#a8cdb0',
  fogColor: '#b9dcc2', fogNear: 80, fogFar: 700,
  sunColor: '#fff0c4', sunIntensity: 2.5, sunDir: [-0.38, 0.7, 0.6],
  hemiSky: '#d6f2d8', hemiGround: '#3d5f2c', hemiIntensity: 1.0,
  exposure: 1.05, night: false, bloomStrength: 0.35,
};

const C = {
  bark: '#6b4a2f', barkDark: '#4e3421', leafA: '#2f7d32', leafB: '#4aa33f', leafC: '#6cc24a', leafD: '#1e5e2c',
  stone: '#a39b82', stoneDark: '#7c7765', moss: '#5f9a3a', mossDark: '#3f7a2c',
  teal: '#2a9d8f', orange: '#f4a261', red: '#e76f51', yellow: '#e9c46a', ink: '#264653',
  water: '#2f8f7a', foam: '#e8fbff', flowers: ['#ff5d8f', '#ffb703', '#ff7b54', '#c77dff', '#ffffff'],
};

// ───────────────────────────── plant templates ─────────────────────────────

/** Leaf blade along +Z (length 1), drooping, with a raised midrib. Double-sided material recommended. */
function leafGeometry(width = 0.42, droop = 0.35, seg = 3): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const t = k / seg;
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(0.98, 0.08 + t * 0.92)), 0.75);
    const y = -droop * t * t;
    pos.push(-w, y - w * 0.18, t, 0, y, t, w, y - w * 0.18, t);
  }
  for (let k = 0; k < seg; k++) {
    const a = k * 3, b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function leafColor(base: string, tip: string): ColorFn {
  const a = new THREE.Color(base), b = new THREE.Color(tip), rib = new THREE.Color('#b8e08a');
  return (x, _y, z, out) => { out.copy(a).lerp(b, clamp01(z)); if (Math.abs(x) < 0.02) out.lerp(rib, 0.5); };
}

function canopyTree(sh: Shapes, rng: Rng, H = 10, crown = 1): THREE.BufferGeometry {
  const b = new GeoBatch();
  const bark = vGrad(C.barkDark, C.bark, 0, 1);
  b.add(sh.cyl(8, 0.5), bark, trs(0, -0.5, 0, 0, 0.7, H + 0.5, 0.7));
  // buttress roots
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.3;
    b.add(sh.prism(), C.barkDark, trs(Math.cos(a) * 0.8, -0.2, Math.sin(a) * 0.8, -a + Math.PI / 2, 0.35, 2.2, 1.7));
  }
  // branches
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
    b.add(sh.cyl(5, 0.5, true), C.bark, trs(Math.cos(a) * 0.4, H - 3 + k * 0.6, Math.sin(a) * 0.4, -a, 0.26, 3.8, 0.26, 0, -1.0));
  }
  // crown: a big rounded mass + lumps hanging lower and bulging on top
  const greens = [C.leafD, C.leafA, C.leafB, C.leafC];
  const S = 5.2 * crown;
  const main = lumpy(sh.ico(1), rng, 0.14);
  b.add(main, vGrad(C.leafD, C.leafB, -0.8, 0.9), trs(0, H + 1.4 * crown, 0, rng.range(0, 6), S, S * 0.72, S));
  main.dispose();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rng.range(-0.3, 0.3), r = rng.range(3.0, 4.2) * crown;
    const s = rng.range(2.6, 3.4) * crown;
    const up = k % 2 === 0;
    const g = lumpy(sh.ico(0), rng, 0.12);
    b.add(g, vGrad(greens[up ? 1 : 0]!, greens[up ? 3 : 2]!, -0.8, 0.9), trs(Math.cos(a) * r, H + (up ? 2.4 : 0.2) * crown, Math.sin(a) * r, a, s, s * 0.7, s));
    g.dispose();
  }
  // hanging vines
  for (let k = 0; k < 4; k++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(2.5, 4.5) * crown;
    const L = rng.range(3, 6);
    b.add(sh.cyl(4, 1, true), C.mossDark, trs(Math.cos(a) * r, H - 0.6 - L, Math.sin(a) * r, 0, 0.06, L + 0.5, 0.06));
    b.add(sh.cone(4), C.leafB, trs(Math.cos(a) * r, H - 0.3 - L, Math.sin(a) * r, 0, 0.3, 0.6, 0.3, Math.PI));
  }
  return b.geometry()!;
}

function palmTree(sh: Shapes, rng: Rng, leaf: THREE.BufferGeometry): THREE.BufferGeometry {
  const b = new GeoBatch();
  const segs = 5, H = 9;
  let x = 0, z = 0, lean = rng.range(0.05, 0.14);
  const dir = rng.range(0, Math.PI * 2);
  for (let k = 0; k < segs; k++) {
    const y = (k / segs) * H;
    b.add(sh.cyl(6, 0.9, true), k % 2 ? C.bark : '#7d5a3a', trs(x, y, z, 0, 0.42 - k * 0.03, H / segs + 0.1, 0.42 - k * 0.03, 0, 0));
    x += Math.cos(dir) * lean * (k + 1) * 0.35; z += Math.sin(dir) * lean * (k + 1) * 0.35;
  }
  const top = H;
  b.add(sh.ico(0), '#5a3d25', trs(x, top, z, 0, 0.55, 0.45, 0.55));
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + rng.range(-0.2, 0.2);
    b.add(leaf, leafColor(k % 2 ? C.leafA : C.leafB, C.leafC), trs(x, top + 0.1, z, a, 5.2, 3.2, 5.2, rng.range(-0.55, -0.15)));
  }
  // coconuts / fruit
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    b.add(sh.ico(0), '#6f8f2f', trs(x + Math.cos(a) * 0.45, top - 0.35, z + Math.sin(a) * 0.45, 0, 0.3));
  }
  return b.geometry()!;
}

function fernGeometry(leaf: THREE.BufferGeometry, rng: Rng): THREE.BufferGeometry {
  const b = new GeoBatch();
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    b.add(leaf, leafColor(C.leafD, k % 2 ? C.leafC : C.leafB), trs(0, 0.1, 0, a, 1.8, 1.4, 1.8, rng.range(-0.95, -0.6)));
  }
  return b.geometry()!;
}

function bushGeometry(sh: Shapes, rng: Rng, flowers: boolean, big = false): THREE.BufferGeometry {
  const b = new GeoBatch();
  if (big) {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2, r = k === 0 ? 0 : 1.1;
      const s = k === 0 ? 1.7 : 1.25;
      b.add(sh.ico(0), vGrad(C.leafD, [C.leafA, C.leafB, C.leafC][k]!, -1, 1), trs(Math.cos(a) * r, s * 0.75 + (k === 0 ? 0.4 : 0), Math.sin(a) * r, a, s, s * 0.9, s));
    }
    return b.geometry()!;
  }
  for (let k = 0; k < 4; k++) {
    const a = rng.range(0, 6.28), r = k === 0 ? 0 : rng.range(0.6, 1.1);
    const s = k === 0 ? 1.4 : rng.range(0.8, 1.1);
    b.add(sh.ico(0), vGrad(C.leafD, k % 2 ? C.leafB : C.leafA, -1, 1), trs(Math.cos(a) * r, s * 0.6, Math.sin(a) * r, a, s, s * 0.8, s));
  }
  if (flowers) {
    const col = rng.pick(C.flowers);
    for (let k = 0; k < 6; k++) {
      const a = rng.range(0, 6.28), e = rng.range(0.2, 1.2);
      b.add(sh.ico(0), col, trs(Math.cos(a) * 1.2 * Math.cos(e), 0.8 + Math.sin(e) * 1.0, Math.sin(a) * 1.2 * Math.cos(e), a, 0.2));
    }
  }
  return b.geometry()!;
}

/** Heliconia clump: paddle leaves + zig-zag bracts in hot colours (roadside colour accents). */
function heliconia(sh: Shapes, leaf: THREE.BufferGeometry, rng: Rng, bract: string, tip: string): THREE.BufferGeometry {
  const b = new GeoBatch();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
    b.add(leaf, leafColor('#2d7a34', '#5fb84a'), trs(Math.cos(a) * 0.15, rng.range(0.9, 1.6), Math.sin(a) * 0.15, Math.PI / 2 - a, 2.2, 1.8, 1.9, rng.range(-0.9, -0.4)));
  }
  for (let st = 0; st < 3; st++) {
    const a = (st / 3) * Math.PI * 2 + rng.range(-0.4, 0.4), r = st === 0 ? 0 : 0.35;
    const H = rng.range(1.5, 2.3);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    b.add(sh.cyl(4), '#3f8a3a', trs(x, 0, z, 0, 0.04, H, 0.04));
    for (let k = 0; k < 5; k++) {
      const side = k % 2 ? 1 : -1;
      const y = H - 0.15 - k * 0.2;
      b.add(sh.cone(4), vGrad(bract, tip, 0, 1), trs(x + side * 0.16, y, z, a, 0.13, 0.62 - k * 0.05, 0.2, 0, side * 1.15));
    }
  }
  return b.geometry()!;
}

function earPlant(sh: Shapes, leaf: THREE.BufferGeometry, rng: Rng): THREE.BufferGeometry {
  const b = new GeoBatch();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const L = rng.range(1.4, 2.2);
    const tilt = rng.range(0.35, 0.7);
    b.add(sh.cyl(4, 1, true), C.leafA, trs(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2, 0, 0.05, L, 0.05, Math.sin(a) * tilt, -Math.cos(a) * tilt));
    const tx = Math.cos(a) * (0.2 + Math.sin(tilt) * L), tz = Math.sin(a) * (0.2 + Math.sin(tilt) * L);
    b.add(leaf, leafColor('#2d8a3e', '#62c050'), trs(tx, Math.cos(tilt) * L, tz, Math.PI / 2 - a, 3.2, 2.2, 2.6, -0.25));
  }
  return b.geometry()!;
}

// ───────────────────────────── helpers ─────────────────────────────

function sideMatrix(f: TrackFrame, y: number, out: THREE.Matrix4): THREE.Matrix4 {
  out.set(f.rx, 0, -f.fx, f.x, 0, 1, 0, y, f.rz, 0, -f.fz, f.z, 0, 0, 0, 1);
  return out;
}

/** Mossy stone colour: stone body, moss creeping on upper faces and in patches. */
function mossStone(rng: Rng, mossAmt = 0.5): ColorFn {
  const a = new THREE.Color(C.stone), b = new THREE.Color(C.stoneDark), m = new THREE.Color(C.moss), md = new THREE.Color(C.mossDark);
  const ox = rng.range(0, 50), oz = rng.range(0, 50);
  const tint = rng.range(-0.06, 0.06);
  return (x, y, z, out) => {
    const n = Math.sin((x + ox) * 5.3) * Math.cos((z + oz) * 4.1) + Math.sin((x + z) * 9.1 + oz) * 0.4;
    out.copy(a).lerp(b, clamp01(0.4 + n * 0.3 - y * 0.2));
    out.r += tint; out.g += tint * 0.5;
    const moss = clamp01((y - 0.25) * 4) * mossAmt + clamp01(n - 0.6) * mossAmt;
    out.lerp(n > 0 ? m : md, clamp01(moss));
  };
}

// ───────────────────────────── scenery ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildJungleScenery(ctx));
}

function buildJungleScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const pal = THEME_PALETTES.jungle;
  const q = quality.scenery;
  const seed = track.def.scenerySeed;
  const root = new THREE.Group();
  root.name = 'scenery-jungle';
  scene.add(root);
  const bin = new Bin();
  const sh = new Shapes();
  const rng = new Rng((seed ^ 0x7a11) >>> 0);
  const mats = createBatchMaterials(bin, 1.8);
  const stats = trackStats(track);
  const base = stats.minY - 1;
  const level = base - 1.3;
  const terrain = buildTerrain(track, {
    ground: pal.ground, groundAlt: pal.groundAlt, pitColor: '#2c5a3a', hills: 20, cell: 6,
    pitDepth: pitDepthFor(track, level, 7), seed,
  });
  root.add(terrain.mesh);
  bin.add(terrain);
  const tb = terrain.bounds;
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const dry = (x: number, z: number, m = 0.5) => ground(x, z) > level + m;
  {
    const dark = new THREE.Color('#2d6e2e'), light = new THREE.Color('#7cc353'), mud = new THREE.Color('#7a6a45'), rock = new THREE.Color('#77705c');
    recolorTerrain(terrain.mesh, (x, y, z, ny, c) => {
      const n = fbm(x / 30, z / 30, seed + 21, 3);
      c.lerp(n > 0 ? light : dark, Math.min(0.55, Math.abs(n) * 1.1));
      c.lerp(mud, clamp01((level + 1.8 - y) / 1.6) * 0.85);
      c.lerp(rock, smoothstep(0.8, 0.6, ny) * 0.75);
    });
  }

  const water = liquidMaterial(bin, {
    deep: '#145247', shallow: '#2f9c86', sky: '#8fcfbf', sunColor: '#fff3cc', sunDir: JUNGLE_ENV.sunDir,
    scale: 0.07, flow: 0.35, flowDir: [1, 0.4], bump: 0.8, glint: 1.2, sparkle: 0.3,
  });
  {
    const geo = bin.add(new THREE.PlaneGeometry(tb.maxX - tb.minX, tb.maxZ - tb.minZ, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const river = new THREE.Mesh(geo, water);
    river.position.set((tb.minX + tb.maxX) / 2, level, (tb.minZ + tb.maxZ) / 2);
    river.name = 'river';
    river.receiveShadow = true;
    river.renderOrder = 1;   // after the terrain: early-z culls the water shader under the ground
    root.add(river);
  }

  const stone = new GeoBatch();   // ruins (matte, casts)
  const paint = new GeoBatch();   // painted totems, wood, rope (satin)
  const foliage = new GeoBatch(); // static leaves/moss blobs on ruins (leaf)
  const glowB = new GeoBatch();   // braziers, gem eyes
  const pools = new GeoBatch();   // waterfall pools (water material)
  const falls: Array<{ geo: THREE.BufferGeometry }> = [];
  const mistAt: Array<{ x: number; y: number; z: number; r?: number }> = [];
  const fireAt: Array<{ x: number; y: number; z: number }> = [];
  const m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4();
  const leaf = bin.add(leafGeometry());
  const extraFerns: Placement[] = [];
  const extraBush: Placement[] = [];
  const keepOut: Array<[number, number, number]> = [];
  const blocked = (x: number, z: number, pad = 0) => {
    for (const [kx, kz, kr] of keepOut) if ((x - kx) * (x - kx) + (z - kz) * (z - kz) < (kr + pad) * (kr + pad)) return true;
    return false;
  };

  const local = (x: number, y: number, z: number, yaw: number, s = 1) => trsTo(m4b, x, y, z, yaw, s);
  const putL = (b: GeoBatch, g: THREE.BufferGeometry, col: THREE.ColorRepresentation | ColorFn, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) => {
    b.add(g, col, m4.multiplyMatrices(m4b, trs(lx, ly, lz, ry, sx, sy, sz, rx, rz)));
  };
  const vine = (lx: number, ly: number, lz: number, L: number) => {
    putL(paint, sh.cyl(4), C.mossDark, lx, ly - L, lz, 0.07, L, 0.07);
    for (let k = 0; k < 3; k++) putL(foliage, leaf, leafColor(C.leafA, C.leafC), lx, ly - L * (0.3 + k * 0.3), lz, 0.6, 0.5, 0.6, k * 2.1, 0.6);
  };

  // ───────── ruins builders (local frames: +Z faces the road) ─────────
  function pyramid(x: number, y: number, z: number, yaw: number, sc: number, levels = 5, shrine = true): void {
    keepOut.push([x, z, 19 * sc]);
    local(x, y, z, yaw);
    const B = 26 * sc, h = 3.3 * sc, shrink = 0.16;
    const col = mossStone(rng, 0.55);
    for (let k = 0; k < levels; k++) {
      const w = B * (1 - k * shrink);
      putL(stone, sh.box(), col, 0, k * h + h / 2 - 0.4, 0, w, h, w);
      // lip/cornice
      putL(stone, sh.box(), C.stoneDark, 0, (k + 1) * h - 0.45, 0, w + 0.5 * sc, 0.35 * sc, w + 0.5 * sc);
      // vines draping the faces
      for (let v = 0; v < 4; v++) if (rng.chance(0.7)) {
        const side = rng.int(0, 4), off = rng.range(-0.4, 0.4) * w;
        const px = side === 0 ? off : side === 1 ? off : side === 2 ? w / 2 + 0.1 : -w / 2 - 0.1;
        const pz = side === 0 ? w / 2 + 0.1 : side === 1 ? -w / 2 - 0.1 : off;
        vine(px, (k + 1) * h - 0.3, pz, rng.range(1.5, h * 1.2));
      }
      if (rng.chance(0.8)) putL(foliage, sh.ico(1), vGrad(C.leafD, C.leafB, -1, 1), rng.range(-0.4, 0.4) * w, (k + 1) * h - 0.2, (rng.chance(0.5) ? 1 : -1) * w * 0.45, 1.6 * sc, 0.9 * sc, 1.6 * sc);
    }
    // front stairs
    const top = B * (1 - (levels - 1) * shrink);
    const N = levels * 3;
    const run = (B - top) / 2;
    for (let j = 0; j < N; j++) {
      const t = (j + 1) / N;
      putL(stone, sh.box(), j % 2 ? '#b3ab91' : '#a39b82', 0, (t * levels * h) / 2 - 0.4, B / 2 - run * (j / N) - run / N / 2 + 0.6, 5.5 * sc, t * levels * h, run / N + 0.05);
    }
    for (const sx of [-1, 1]) putL(stone, sh.box(), C.stoneDark, sx * 3.1 * sc, (levels * h) / 2 - 0.6, B / 2 - run / 2 + 0.6, 0.8 * sc, levels * h * 0.98, run * 1.02, 0, -Math.atan2(levels * h, run) + Math.PI / 2);
    const yTop = levels * h - 0.4;
    if (shrine) {
      const sw = top * 0.62;
      putL(stone, sh.box(), mossStone(rng, 0.3), 0, yTop + 2.3 * sc, 0, sw, 4.6 * sc, sw);
      putL(stone, sh.box(), C.stoneDark, 0, yTop + 4.9 * sc, 0, sw + 1.2 * sc, 0.7 * sc, sw + 1.2 * sc);
      putL(stone, sh.box(), '#b8ae93', 0, yTop + 5.7 * sc, 0, sw * 0.7, 1.0 * sc, sw * 0.7);
      putL(stone, sh.box(), '#1d1a14', 0, yTop + 1.7 * sc, sw / 2 + 0.02, sw * 0.32, 3.2 * sc, 0.1);
      // painted frieze
      for (let k = 0; k < 5; k++) putL(paint, sh.box(), [C.teal, C.orange, C.yellow, C.red, C.teal][k]!, -sw * 0.4 + k * sw * 0.2, yTop + 4.0 * sc, sw / 2 + 0.03, sw * 0.14, 0.6 * sc, 0.1);
      for (const sx of [-1, 1]) {
        putL(stone, sh.cyl(8), C.stoneDark, sx * sw * 0.36, yTop, sw / 2 + 1.2 * sc, 0.5 * sc, 1.2 * sc, 0.5 * sc);
        putL(glowB, sh.cone(6), '#ffb347', sx * sw * 0.36, yTop + 1.2 * sc, sw / 2 + 1.2 * sc, 0.35 * sc, 0.8 * sc, 0.35 * sc);
        const fp = new THREE.Vector3(sx * sw * 0.36, yTop + 1.9 * sc, sw / 2 + 1.2 * sc).applyMatrix4(m4b);
        fireAt.push({ x: fp.x, y: fp.y, z: fp.z });
      }
    } else {
      // open-roof temple on top: columns + lintel
      const sw = top * 0.8;
      for (let k = 0; k < 6; k++) {
        const cx = -sw / 2 + (k % 3) * sw / 2, cz = k < 3 ? sw * 0.35 : -sw * 0.35;
        putL(stone, sh.cyl(10), mossStone(rng, 0.25), cx, yTop, cz, 0.7 * sc, 5 * sc, 0.7 * sc);
        putL(stone, sh.box(), '#b8ae93', cx, yTop + 5.2 * sc, cz, 1.8 * sc, 0.5 * sc, 1.8 * sc);
      }
      putL(stone, sh.box(), mossStone(rng, 0.5), 0, yTop + 5.9 * sc, 0, sw + 2 * sc, 1.1 * sc, sw * 0.7 + 2 * sc);
      putL(stone, sh.prism(), C.stoneDark, 0, yTop + 6.4 * sc, 0, sw * 0.7 + 2 * sc, 2.2 * sc, sw + 2.4 * sc, Math.PI / 2);
    }
    // guardian heads at the stair foot
    for (const sx of [-1, 1]) stoneHead(0, 0, 0, 0, 0.55 * sc, sx * 5.2 * sc, B / 2 + 1.5 * sc);
    local(x, y, z, yaw);
  }

  function stoneHead(x: number, y: number, z: number, yaw: number, sc: number, ox = 0, oz = 0): void {
    const save = m4b.clone();
    if (ox !== 0 || oz !== 0) m4b.multiply(trs(ox, 0, oz, 0));
    else { local(x, y, z, yaw); keepOut.push([x, z, 4 * sc]); }
    const col = mossStone(rng, 0.45);
    putL(stone, sh.box(), col, 0, 2.4 * sc, 0, 4 * sc, 4.8 * sc, 3.4 * sc);
    putL(stone, sh.box(), C.stoneDark, 0, 3.3 * sc, 1.8 * sc, 4.2 * sc, 0.7 * sc, 0.6 * sc);
    putL(stone, sh.prism(), '#b3ab91', 0, 1.8 * sc, 1.7 * sc, 0.9 * sc, 1.6 * sc, 0.9 * sc, 0, -Math.PI / 2);
    for (const sx of [-1, 1]) {
      putL(stone, sh.box(), '#1f1c16', sx * 0.95 * sc, 2.75 * sc, 1.71 * sc, 0.9 * sc, 0.5 * sc, 0.1 * sc);
      putL(glowB, sh.box(), '#7fffd4', sx * 0.95 * sc, 2.75 * sc, 1.76 * sc, 0.35 * sc, 0.22 * sc, 0.08 * sc);
      putL(stone, sh.box(), col, sx * 2.2 * sc, 2.3 * sc, 0, 0.5 * sc, 2.4 * sc, 1.2 * sc);
    }
    putL(stone, sh.box(), '#1f1c16', 0, 0.9 * sc, 1.71 * sc, 2.2 * sc, 0.45 * sc, 0.1 * sc);
    for (let k = 0; k < 3; k++) putL(stone, sh.box(), k === 1 ? '#b8ae93' : C.stoneDark, 0, (4.9 + k * 0.55) * sc, -0.2 * sc, (4.4 - k * 1.1) * sc, 0.55 * sc, (3.6 - k * 0.8) * sc);
    putL(foliage, sh.ico(1), vGrad(C.leafD, C.leafB, -1, 1), 0.6 * sc, 6.4 * sc, -0.3 * sc, 1.3 * sc, 0.7 * sc, 1.2 * sc);
    m4b.copy(save);
  }

  function totem(x: number, y: number, z: number, yaw: number, sc: number): void {
    keepOut.push([x, z, 2.5 * sc]);
    local(x, y, z, yaw, sc);
    const cols = [C.teal, C.orange, C.red, C.yellow];
    const n = 4 + rng.int(0, 2);
    let yy = 0;
    putL(stone, sh.box(), C.stoneDark, 0, 0.3, 0, 2.4, 0.6, 2.4);
    yy = 0.6;
    for (let k = 0; k < n; k++) {
      const h = rng.range(1.5, 1.9);
      const c = cols[(k + rng.int(0, 4)) % 4]!;
      putL(paint, sh.box(), vGrad(mixHex(c, '#3a2a1a', 0.35), c, 0, 1), 0, yy + h / 2, 0, 1.7, h, 1.7);
      putL(paint, sh.box(), '#fffaf0', -0.42, yy + h * 0.62, 0.86, 0.5, 0.42, 0.06);
      putL(paint, sh.box(), '#fffaf0', 0.42, yy + h * 0.62, 0.86, 0.5, 0.42, 0.06);
      putL(paint, sh.box(), C.ink, -0.42, yy + h * 0.6, 0.9, 0.22, 0.24, 0.06);
      putL(paint, sh.box(), C.ink, 0.42, yy + h * 0.6, 0.9, 0.22, 0.24, 0.06);
      if (k % 2 === 0) putL(paint, sh.cone(4), C.yellow, 0, yy + h * 0.38, 0.9, 0.3, 0.7, 0.3, Math.PI / 4, Math.PI / 2);
      else putL(paint, sh.box(), C.ink, 0, yy + h * 0.25, 0.87, 1.0, 0.18, 0.06);
      putL(paint, sh.box(), C.ink, 0, yy + h - 0.06, 0, 1.8, 0.12, 1.8);
      yy += h;
    }
    // wings + crest
    for (const sx of [-1, 1]) putL(paint, sh.box(), vGrad(C.teal, C.yellow, -0.5, 0.5), sx * 1.6, yy - 0.8, 0, 1.6, 0.9, 0.3, 0, 0, sx * 0.35);
    putL(paint, sh.cone(5), C.red, 0, yy, 0, 0.8, 1.4, 0.8);
    for (let k = 0; k < 3; k++) putL(foliage, leaf, leafColor(C.leafA, C.leafC), 0, yy + 1.1, 0, 1.6, 1.4, 1.6, k * 2.1, -1.0);
  }

  function columns(x: number, y: number, z: number, yaw: number, sc: number): void {
    keepOut.push([x, z, 11 * sc]);
    local(x, y, z, yaw, sc);
    const n = rng.int(4, 7);
    for (let k = 0; k < n; k++) {
      const cx = (k - (n - 1) / 2) * 3.4 + rng.range(-0.3, 0.3), cz = rng.range(-0.8, 0.8);
      const broken = rng.chance(0.55);
      const H = broken ? rng.range(1.5, 5) : 6.5;
      const col = mossStone(rng, 0.35);
      putL(stone, sh.box(), C.stoneDark, cx, 0.25, cz, 1.9, 0.5, 1.9);
      putL(stone, sh.cyl(10), col, cx, 0.4, cz, 0.72, H, 0.72);
      if (!broken) putL(stone, sh.box(), '#b8ae93', cx, 0.4 + H, cz, 1.9, 0.55, 1.9);
      else putL(stone, sh.cyl(6, 0.4), col, cx, 0.4 + H, cz, 0.72, 0.5, 0.72, 0, rng.range(-0.3, 0.3));
      if (rng.chance(0.5)) vine(cx + 0.7, 0.4 + H, cz, rng.range(1, H * 0.7));
      if (rng.chance(0.5)) {
        const wp = new THREE.Vector3(cx + rng.range(-1.5, 1.5), 0, cz + rng.range(1, 2.5)).applyMatrix4(m4b);
        if (!terrain.inCorridor(wp.x, wp.z, 2)) extraFerns.push({ x: wp.x, y: ground(wp.x, wp.z) - 0.1, z: wp.z, ry: rng.range(0, 6), s: rng.range(0.8, 1.3) });
      }
    }
    // lintel across the two middle standing columns + fallen drums
    putL(stone, sh.box(), mossStone(rng, 0.6), 0, 7.2, 0, 7.5, 0.9, 1.7, 0, 0, rng.range(-0.05, 0.05));
    for (let k = 0; k < 2; k++) putL(stone, sh.cyl(10), mossStone(rng, 0.4), rng.range(-5, 5), 0.72, rng.range(2.5, 4), 0.72, rng.range(1.6, 2.6), 0.72, rng.range(0, 3), Math.PI / 2);
  }

  function ruinsArch(f: TrackFrame, sc: number): void {
    const W = corridorHalf(track, f.i) + 2.2;
    sideMatrix(f, f.y - 0.6, m4b);
    const H = 10.5 * sc;
    for (const sx of [-1, 1]) {
      let yy = 0;
      for (let k = 0; k < 4; k++) {
        const h = H / 4;
        putL(stone, sh.box(), mossStone(rng, 0.35 + k * 0.1), sx * (W + 1.8) + rng.range(-0.2, 0.2), yy + h / 2, rng.range(-0.2, 0.2), 3.6 - k * 0.15, h - 0.08, 3.6 - k * 0.15, rng.range(-0.05, 0.05));
        yy += h;
      }
      putL(foliage, sh.ico(1), vGrad(C.leafD, C.leafB, -1, 1), sx * (W + 2.6), 1.2, 1.2, 2.2, 1.6, 2.0);
    }
    putL(stone, sh.box(), mossStone(rng, 0.6), 0, H + 1.3, 0, 2 * W + 7.5, 2.6, 4.0);
    putL(stone, sh.box(), C.stoneDark, 0, H + 2.9, 0, 2 * W + 8.5, 0.6, 4.4);
    for (let k = -3; k <= 3; k++) putL(paint, sh.box(), [C.teal, C.orange, C.yellow][(k + 3) % 3]!, k * (W / 3.8), H + 1.3, 2.02, 1.4, 1.2, 0.08);
    // sun-face medallion
    putL(stone, sh.cyl(14), '#c9b98f', 0, H + 1.3, 2.0, 2.3, 0.4, 2.3, 0, Math.PI / 2);
    putL(glowB, sh.box(), '#7fffd4', -0.7, H + 1.7, 2.45, 0.45, 0.3, 0.08);
    putL(glowB, sh.box(), '#7fffd4', 0.7, H + 1.7, 2.45, 0.45, 0.3, 0.08);
    for (let k = 0; k < 12; k++) vine(rng.range(-W, W), H, rng.range(-1.6, 1.6), rng.range(1.5, 4.5));
    for (let k = 0; k < 5; k++) putL(foliage, sh.ico(1), vGrad(C.leafD, C.leafC, -1, 1), rng.range(-W, W), H + 3.2, rng.range(-1, 1), rng.range(1.2, 2.2), 0.8, 1.6);
  }

  function waterfall(x: number, gy: number, z: number, yaw: number, sc: number): void {
    const H = 20 * sc, Wf = 9 * sc;
    keepOut.push([x, z, 13 * sc]);
    local(x, gy, z, yaw);
    const cliffCol = (() => {
      const a = new THREE.Color('#6f6a5a'), b = new THREE.Color('#8f8a76'), m = new THREE.Color(C.moss);
      return ((lx: number, ly: number, lz: number, out: THREE.Color) => {
        out.copy(a).lerp(b, clamp01(0.5 + Math.sin(lx * 4 + lz * 3) * 0.3));
        out.lerp(m, clamp01((ly - 0.3) * 3) * 0.8);
      }) as ColorFn;
    })();
    // cliff: two rocky shoulders framing the fall + a back wall
    for (let k = 0; k < 10; k++) {
      const side = k < 5 ? -1 : 1;
      const j = k % 5;
      const cx = side * (Wf / 2 + 2.5 * sc + j * 3.2 * sc);
      const hh = H * (1.05 - j * 0.12) * rng.range(0.9, 1.1);
      const g = lumpy(sh.ico(1), rng, 0.22);
      putL(stone, g, cliffCol, cx, hh * 0.42, -4.5 * sc - j * 0.8 * sc, 3.6 * sc, hh * 0.58, 5 * sc, rng.range(0, 6));
      g.dispose();
      putL(foliage, sh.ico(0), vGrad(C.leafD, C.leafB, -1, 1), cx, hh * 0.93, -4 * sc, 2.3 * sc, 1.7 * sc, 2.1 * sc, rng.range(0, 6));
      putL(foliage, sh.ico(0), vGrad(C.leafA, C.leafC, -1, 1), cx + rng.range(-1, 1) * sc, hh * 0.93 + 1.2 * sc, -4.6 * sc, 1.5 * sc, 1.2 * sc, 1.4 * sc, rng.range(0, 6));
    }
    {
      const g = lumpy(sh.box(), rng, 0.15);
      putL(stone, g, cliffCol, 0, H / 2 - 1, -7.5 * sc, Wf + 4 * sc, H + 1, 8 * sc);
      g.dispose();
    }
    for (let k = 0; k < 8; k++) vine(rng.range(-1, 1) * (Wf / 2 + 4 * sc), H * rng.range(0.6, 1), -1.8 * sc, rng.range(2, 6));
    // lip + falling sheet (in front of the back wall, between the shoulders)
    putL(stone, sh.box(), '#6b6656', 0, H - 0.3, -3.2 * sc, Wf + 1.5 * sc, 1.0 * sc, 2.4 * sc);
    const sheet = new THREE.PlaneGeometry(1, 1, 1, 10);
    const sp = sheet.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < sp.count; k++) { const t = sp.getY(k) + 0.5; sp.setZ(k, 1.2 * t * t - 0.2); }
    sheet.computeVertexNormals();
    sheet.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m4b, trs(0, H / 2 - 0.4, -3.4 * sc, 0, Wf, H, sc)));
    falls.push({ geo: sheet });
    // pool, foam, rocks, mist
    const pc = new THREE.Vector3(0, 0.25, 2.2 * sc).applyMatrix4(m4b);
    const disc = new THREE.CircleGeometry(9 * sc, 22);
    disc.rotateX(-Math.PI / 2);
    pools.add(disc, '#ffffff', trs(pc.x, Math.max(pc.y, level + 0.05), pc.z));
    disc.dispose();
    for (let k = 0; k < 4; k++) putL(paint, sh.torus(1, 0.22, 5, 18), '#effffd', rng.range(-1, 1) * Wf * 0.3, 0.32, -1.5 * sc + k * 0.9 * sc, Wf * (0.3 + k * 0.08), Wf * (0.18 + k * 0.05), 0.5, 0, Math.PI / 2);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const g = lumpy(sh.dodeca(), rng, 0.3, true);
      putL(stone, g, mossStone(rng, 0.5), Math.cos(a) * 9.2 * sc, 0.2, 2.2 * sc + Math.sin(a) * 9.2 * sc, rng.range(0.8, 1.9) * sc, rng.range(0.6, 1.2) * sc, rng.range(0.8, 1.6) * sc, a);
      g.dispose();
    }
    for (const lx of [-Wf * 0.3, 0, Wf * 0.3]) {
      const mp = new THREE.Vector3(lx, 0.4, -1.2 * sc).applyMatrix4(m4b);
      mistAt.push({ x: mp.x, y: mp.y, z: mp.z, r: Wf * 0.2 });
    }
    for (let k = 0; k < 16; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(10, 16) * sc;
      const p = new THREE.Vector3(Math.cos(a) * r, 0, 2 * sc + Math.sin(a) * r).applyMatrix4(m4b);
      if (!terrain.inCorridor(p.x, p.z, 2)) extraFerns.push({ x: p.x, y: ground(p.x, p.z) - 0.1, z: p.z, ry: a, s: rng.range(0.9, 1.5) });
    }
  }

  function hut(x: number, y: number, z: number, yaw: number, sc: number): void {
    keepOut.push([x, z, 5 * sc]);
    local(x, y, z, yaw, sc);
    for (const [px, pz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) putL(paint, sh.cyl(6), C.barkDark, px, 0, pz, 0.2, 3, 0.2);
    putL(paint, sh.box(), '#b98552', 0, 3.1, 0, 5, 0.3, 5);
    putL(paint, sh.box(), '#a0703f', 0, 4.4, 0, 4.2, 2.4, 4.2);
    putL(paint, sh.box(), '#3a2a1a', 0, 4.1, 2.12, 1.1, 1.8, 0.06);
    putL(paint, sh.cone(4), vGrad('#c9a45c', '#e9c46a', 0, 1), 0, 5.5, 0, 4.4, 3.2, 4.4, Math.PI / 4);
    for (let k = 0; k < 7; k++) putL(paint, sh.box(), '#b98552', 0, 1.9 - k * 0.3, 3.1 + k * 0.28, 1.2, 0.12, 0.3);
  }

  function giantTree(x: number, y: number, z: number, sc: number): void {
    const g = canopyTree(sh, rng, 12, 1.2);
    foliage.add(g, null, trs(x, y - 0.3, z, rng.range(0, 6), 2.3 * sc, 2.0 * sc, 2.3 * sc));
    g.dispose();
  }

  function ruinWalls(): void {
    const n = track.n;
    for (let i = 0; i < n; i += Math.max(2, Math.round(3.6 / track.spacing))) {
      for (const side of [-1, 1] as const) {
        const e = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
        if (e !== 1 || rng.chance(0.18)) continue;
        const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
        const f = frameAtIndex(track, i, side * (wall + 2.2));
        if (terrain.inCorridor(f.x, f.z, 0.8)) continue;
        const gy = Math.min(ground(f.x, f.z), f.y);
        const h = rng.range(1.2, 3.6);
        stone.add(sh.box(), mossStone(rng, 0.5), trs(f.x, gy + h / 2 - 0.4, f.z, f.yaw + rng.range(-0.06, 0.06), 2.2, h + 0.8, 3.7));
        if (rng.chance(0.35)) foliage.add(sh.ico(1), vGrad(C.leafD, C.leafB, -1, 1), trs(f.x, gy + h + 0.1, f.z, rng.range(0, 6), 1.3, 0.6, 1.6));
      }
    }
  }

  // ───────── landmarks ─────────
  const runs = findPitRuns(track);
  const bridged = new Set<number>();
  const ropeStyle = {
    tower: '#7a5230', towerTrim: '#a0703f', cable: '#d2b27a', towerHeight: 6.8, cableRadius: 0.1,
    danglers: '#4c8a3a', depth: 0,
  };
  /**
   * Timber deck laid over a rope-bridge span. The road ribbon keeps its cobbles across pits, so without this the
   * signature bridge read as a stone causeway strung with ropes. One quad per plank (own tint, hairline gaps),
   * 2.5 cm above the road with polygon offset; the track mesh's plank trim caps both deck edges.
   */
  function plankDeck(r: { i0: number; len: number }): void {
    const n = track.n, sp = track.spacing;
    const s0 = (r.i0 - 1) * sp, len = (r.len + 2) * sp;
    const P = (s: number, d: number, out: THREE.Vector3) => {
      const f = ((s % track.length) + track.length) % track.length / sp;
      const i = Math.floor(f) % n, j = (i + 1) % n, k = f - Math.floor(f);
      const L = (a: Float64Array) => a[i]! + (a[j]! - a[i]!) * k;
      return out.set(L(track.px) + L(track.rx) * d, L(track.py) + L(track.ry) * d + 0.025, L(track.pz) + L(track.rz) * d);
    };
    const hwAt = (s: number) => track.hw[indexAtS(track, s)]!;
    const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
    const v = new THREE.Vector3();
    const PITCH = 0.34, GAP = 0.035;
    const count = Math.floor(len / PITCH);
    const pr = new Rng(seed + 404);   // own stream: the rest of the jungle layout stays exactly as authored
    for (let k = 0; k < count; k++) {
      const a0 = s0 + k * PITCH + GAP, a1 = s0 + (k + 1) * PITCH - GAP;
      const hw = hwAt((a0 + a1) / 2);
      const tone = pr.chance(0.08) ? pr.range(0.62, 0.72) : pr.range(0.84, 1.04);
      const warm = pr.range(-0.04, 0.04);
      const u0 = pr.range(0, 1), row = (k % 4) / 4;
      const base = pos.length / 3;
      for (const [a, d, vv] of [[a0, -hw, row + 0.012], [a0, hw, row + 0.012], [a1, hw, row + 0.238], [a1, -hw, row + 0.238]] as const) {
        P(a, d, v);
        pos.push(v.x, v.y, v.z);
        uv.push(u0 + (d + hw) / 4, vv);
        col.push(tone + warm, tone, tone - warm);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      // dark gap to the next plank, coplanar with the planks (no overlap, so no z-fight): an open gap showed the road
      // ribbon below, and the painted centre-line dashes read as a dotted white line along the timber deck
      if (k < count - 1) {
        const g0 = a1, g1 = a1 + 2 * GAP;
        const gb = pos.length / 3;
        for (const [a, d] of [[g0, -hw], [g0, hw], [g1, hw], [g1, -hw]] as const) {
          P(a, d, v);
          pos.push(v.x, v.y, v.z);
          uv.push(u0 + (d + hw) / 4, row + 0.24);
          col.push(0.2, 0.14, 0.09);
        }
        idx.push(gb, gb + 1, gb + 2, gb, gb + 2, gb + 3);
      }
    }
    const g = bin.add(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // make sure the planks face up whatever the travel direction
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    if (nrm.count && nrm.getY(0) < 0) {
      for (let t = 0; t < idx.length; t += 3) { const q = idx[t + 1]!; idx[t + 1] = idx[t + 2]!; idx[t + 2] = q; }
      g.setIndex(idx);
      g.computeVertexNormals();
    }
    const tex = bin.add(createPlankTexture('#b58450'));
    const mat = bin.add(new THREE.MeshStandardMaterial({
      map: tex, vertexColors: true, roughness: 0.86,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'rope-bridge-planks';
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    root.add(mesh);
  }

  function ropeBridgeAt(s: number, sc: number): void {
    const i = indexAtS(track, s);
    let run = -1;
    runs.forEach((r, k) => {
      const inRun = r.i0 <= r.i1 ? i >= r.i0 && i <= r.i1 : i >= r.i0 || i <= r.i1;
      if (inRun) run = k;
    });
    const depth = Math.max(8, frameAtIndex(track, i).y - level + 3);
    if (run >= 0) {
      if (bridged.has(run)) return;
      bridged.add(run);
      buildSuspensionBridge(track, runs[run]!, { ...ropeStyle, depth }, stone, paint, sh, rng);
      plankDeck(runs[run]!);
    } else {
      const half = Math.round((20 * sc) / track.spacing);
      buildSuspensionBridge(track, { i0: wrapIndex(track, i - half), i1: wrapIndex(track, i + half), len: half * 2 }, { ...ropeStyle, depth: 6 }, stone, paint, sh, rng);
    }
  }

  const handled = new Set<string>();
  for (const l of track.landmarks) {
    if (SKIP.has(l.kind)) continue;
    const p = landmarkPose(track, l);
    const f = p.frame, sc = p.scale;
    const gy = p.over ? f.y : ground(f.x, f.z);
    const k = l.kind.toLowerCase();
    handled.add(k);
    if (k.includes('rope') || k.includes('bridge')) { ropeBridgeAt(l.s, sc); continue; }
    if (p.over) { ruinsArch(f, sc); continue; }
    if (k.includes('waterfall') || k.includes('falls')) { waterfall(f.x, gy, f.z, p.yaw, sc); continue; }
    if (k.includes('pyramid')) { pyramid(f.x, gy - 0.3, f.z, p.yaw, sc, 6, true); continue; }
    if (k.includes('temple')) { pyramid(f.x, gy - 0.3, f.z, p.yaw, sc * 0.85, 3, false); continue; }
    if (k.includes('totem')) { totem(f.x, gy - 0.2, f.z, p.yaw, 1.15 * sc); continue; }
    if (k.includes('column') || k.includes('pillar') || k.includes('ruin')) { columns(f.x, gy - 0.2, f.z, p.yaw, sc); continue; }
    if (k.includes('head') || k.includes('statue') || k.includes('idol')) { stoneHead(f.x, gy - 0.3, f.z, p.yaw, 1.2 * sc); continue; }
    if (k.includes('hut') || k.includes('house')) { hut(f.x, gy - 0.2, f.z, p.yaw, sc); continue; }
    if (k.includes('tree')) { giantTree(f.x, gy, f.z, sc); continue; }
    // themed fallback: a small ruin garden
    columns(f.x, gy - 0.2, f.z, p.yaw, sc * 0.8);
    stoneHead(f.x + 7 * sc, gy - 0.3, f.z - 3 * sc, p.yaw, 0.8 * sc);
  }
  // any remaining pit runs get a rope bridge too (water below comes from the river plane)
  runs.forEach((r, k) => {
    if (bridged.has(k) || r.len * track.spacing < 14) return;
    const mid = wrapIndex(track, r.i0 + Math.floor(r.len / 2));
    ropeBridgeAt(mid * track.spacing, 1);
  });
  ruinWalls();

  return assembleJungle({
    ctx, root, bin, sh, rng, mats, terrain, stats, level, water, leaf, seed, q,
    stone, paint, foliage, glowB, pools, falls, mistAt, fireAt, extraFerns, extraBush,
    pyramid, totem, columns, stoneHead, hut, ground, dry, handled, blocked,
  });
}

interface JungleParts {
  ctx: SceneryContext; root: THREE.Group; bin: Bin; sh: Shapes; rng: Rng;
  mats: ReturnType<typeof createBatchMaterials>; terrain: ReturnType<typeof buildTerrain>;
  stats: ReturnType<typeof trackStats>; level: number; water: THREE.ShaderMaterial; leaf: THREE.BufferGeometry;
  seed: number; q: number;
  stone: GeoBatch; paint: GeoBatch; foliage: GeoBatch; glowB: GeoBatch; pools: GeoBatch;
  falls: Array<{ geo: THREE.BufferGeometry }>;
  mistAt: Array<{ x: number; y: number; z: number; r?: number }>;
  fireAt: Array<{ x: number; y: number; z: number }>;
  extraFerns: Placement[]; extraBush: Placement[];
  pyramid(x: number, y: number, z: number, yaw: number, sc: number, levels?: number, shrine?: boolean): void;
  totem(x: number, y: number, z: number, yaw: number, sc: number): void;
  columns(x: number, y: number, z: number, yaw: number, sc: number): void;
  stoneHead(x: number, y: number, z: number, yaw: number, sc: number): void;
  hut(x: number, y: number, z: number, yaw: number, sc: number): void;
  ground(x: number, z: number): number;
  dry(x: number, z: number, m?: number): boolean;
  handled: Set<string>;
  blocked(x: number, z: number, pad?: number): boolean;
}

function assembleJungle(P: JungleParts): SceneryHandle {
  const { ctx, root, bin, sh, rng, mats, terrain, stats, level, water, leaf, seed, q } = P;
  const { track, quality } = ctx;
  const ground = P.ground;
  const facing = (x: number, z: number) => {
    const n = terrain.nearestTrack(x, z);
    return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z);
  };

  // ───────── auto ruins (independent of authored landmarks) ─────────
  let nPyr = 0, nTot = 0, nCol = 0, nHead = 0, nHut = 0;
  for (const p of scatter(terrain, 80, seed + 51, { minDist: 22, maxDist: 190, pad: 10 })) {
    if (!P.dry(p.x, p.z, 1) || !clearOfRoad(terrain, p.x, p.z, 9)) continue;
    const yaw = facing(p.x, p.z);
    const dist = terrain.nearestTrack(p.x, p.z).dist;
    if (dist > 80 && nPyr < 2 && clearOfRoad(terrain, p.x, p.z, 26)) { P.pyramid(p.x, p.y - 0.4, p.z, yaw, rng.range(0.9, 1.25), 6, true); nPyr++; continue; }
    if (dist < 45 && nTot < 5) { P.totem(p.x, p.y - 0.2, p.z, yaw, rng.range(0.9, 1.2)); nTot++; continue; }
    if (nCol < 6) { P.columns(p.x, p.y - 0.2, p.z, yaw + rng.range(-0.5, 0.5), rng.range(0.8, 1.1)); nCol++; continue; }
    if (nHead < 3) { P.stoneHead(p.x, p.y - 0.3, p.z, yaw, rng.range(0.9, 1.4)); nHead++; continue; }
    if (nHut < 3 && dist < 70) { P.hut(p.x, p.y - 0.2, p.z, yaw, rng.range(0.9, 1.1)); nHut++; continue; }
  }

  // ───────── vegetation (instanced) ─────────
  const tA = bin.add(canopyTree(sh, new Rng(seed + 1), 8, 1.05));
  const tB = bin.add(canopyTree(sh, new Rng(seed + 2), 15, 1.3));
  const palm = bin.add(palmTree(sh, new Rng(seed + 3), leaf));
  const fern = bin.add(fernGeometry(leaf, new Rng(seed + 4)));
  const bush = bin.add(bushGeometry(sh, new Rng(seed + 5), false));
  const bushF = bin.add(bushGeometry(sh, new Rng(seed + 6), true));
  const ear = bin.add(earPlant(sh, leaf, new Rng(seed + 7)));
  const heliA = bin.add(heliconia(sh, leaf, new Rng(seed + 12), '#e63946', '#ffd23f'));
  const heliB = bin.add(heliconia(sh, leaf, new Rng(seed + 13), '#ff7b00', '#ffe066'));
  const heli: [Placement[], Placement[]] = [[], []];
  const L = { tA: [] as Placement[], tB: [] as Placement[], palm: [] as Placement[], fern: P.extraFerns, bush: P.extraBush, bushF: [] as Placement[], ear: [] as Placement[] };
  const density = (x: number, z: number) => fbm(x / 110, z / 110, seed + 9, 3);
  const wallBush = bin.add(bushGeometry(sh, new Rng(seed + 11), false, true));
  const L2 = { wall: [] as Placement[] };
  for (const p of scatter(terrain, Math.round(900 * q), seed + 52, { minDist: 0, maxDist: 320, pad: 6 })) {
    if (!P.dry(p.x, p.z, 0.8) || P.blocked(p.x, p.z, 4)) continue;
    const d = density(p.x, p.z);
    if (d < -0.25 && !rng.chance(0.25)) continue;
    const pl: Placement = { x: p.x, y: p.y - 0.3, z: p.z, ry: p.r, s: p.s * rng.range(0.8, 1.3), tint: jitterTint(rng, 0.14, 0.04) };
    const r = rng.next();
    (r < 0.45 ? L.tA : r < 0.72 ? L.tB : L.palm).push(pl);
  }
  for (const p of scatter(terrain, Math.round(1500 * q), seed + 53, { minDist: 0, maxDist: 150, pad: 2.5 })) {
    if (!P.dry(p.x, p.z, 0.3) || P.blocked(p.x, p.z, 1)) continue;
    const pl: Placement = { x: p.x, y: p.y - 0.15, z: p.z, ry: p.r, s: p.s * rng.range(0.7, 1.4), tint: jitterTint(rng, 0.15, 0.05) };
    const r = rng.next();
    (r < 0.42 ? L.fern : r < 0.68 ? L.bush : r < 0.82 ? L.bushF : L.ear).push(pl);
  }
  // roadside jungle wall: a dense band of big clumps and trees just beyond the barriers.
  // Big leaves spread several metres from their stems, so each roadside clump is slid outward until its leaves (not just
  // its stem) clear the drivable verge — the sim has no collider for them; they used to hang over the verge at kart height.
  const guard = activeCorridorGuard();
  const gm = new THREE.Matrix4();
  const settle = (geo: THREE.BufferGeometry, i: number, side: number, d0: number, pl: Placement, yOff: number): Placement | null => {
    for (let k = 0; k < 10; k++) {
      const f = frameAtIndex(track, i, side * (d0 + k * 0.8));
      pl.x = f.x; pl.z = f.z; pl.y = ground(f.x, f.z) + yOff;
      if (!guard || !guard.intrudes(geo, placementMatrix(pl, gm))) return pl;
    }
    return null;
  };
  {
    const step = Math.max(2, Math.round(3.2 / track.spacing / Math.max(q, 0.4)));
    for (let i = 0; i < track.n; i += step) {
      for (const side of [-1, 1] as const) {
        const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
        const edge = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
        if (edge === 2) continue;
        const dw = wall + rng.range(3.5, 13);
        const f = frameAtIndex(track, i, side * dw);
        if (terrain.inCorridor(f.x, f.z, 3) || !P.dry(f.x, f.z, 0.4) || P.blocked(f.x, f.z, 2)) continue;
        const wb = settle(wallBush, i, side, dw, { x: f.x, y: 0, z: f.z, ry: rng.range(0, 6), s: rng.range(1.3, 2.6), sy: rng.range(0.8, 1.3), tint: jitterTint(rng, 0.16, 0.05) }, -0.3);
        if (wb) L2.wall.push(wb);
        if (rng.chance(0.28)) {
          const f2 = frameAtIndex(track, i, side * (wall + rng.range(10, 26)));
          if (!terrain.inCorridor(f2.x, f2.z, 5) && P.dry(f2.x, f2.z, 0.8) && !P.blocked(f2.x, f2.z, 4)) {
            (rng.chance(0.6) ? L.tA : L.palm).push({ x: f2.x, y: ground(f2.x, f2.z) - 0.3, z: f2.z, ry: rng.range(0, 6), s: rng.range(0.85, 1.25), tint: jitterTint(rng, 0.14, 0.04) });
          }
        }
        if (rng.chance(0.2)) {
          const d3 = wall + rng.range(1.5, 4);
          const f3 = frameAtIndex(track, i, side * d3);
          if (!terrain.inCorridor(f3.x, f3.z, 1) && P.dry(f3.x, f3.z, 0.2)) {
            const pe = settle(ear, i, side, d3, { x: f3.x, y: 0, z: f3.z, ry: rng.range(0, 6), s: rng.range(1.2, 2.0) }, -0.1);
            if (pe && P.dry(pe.x, pe.z, 0.2)) L.ear.push(pe);
          }
        }
        if (rng.chance(0.22)) {
          const d4 = wall + rng.range(1.8, 3.5);
          const f4 = frameAtIndex(track, i, side * d4);
          if (!terrain.inCorridor(f4.x, f4.z, 0.8) && P.dry(f4.x, f4.z, 0.2)) {
            const k = rng.chance(0.5) ? 0 : 1;
            const ph = settle(k ? heliB : heliA, i, side, d4, { x: f4.x, y: 0, z: f4.z, ry: rng.range(0, 6), s: rng.range(1.2, 1.7) }, -0.1);
            if (ph && P.dry(ph.x, ph.z, 0.2)) heli[k].push(ph);
          }
        }
      }
    }
  }
  const veg: Array<[THREE.BufferGeometry, Placement[], boolean, string]> = [
    [tA, L.tA, true, 'trees-a'], [tB, L.tB, true, 'trees-b'], [palm, L.palm, true, 'palms'],
    [fern, L.fern, false, 'ferns'], [bush, L.bush, false, 'bushes'], [wallBush, L2.wall, true, 'jungle-wall'], [bushF, L.bushF, false, 'flower-bushes'], [ear, L.ear, false, 'ear-plants'],
    [heliA, heli[0], false, 'heliconia-a'], [heliB, heli[1], false, 'heliconia-b'],
  ];
  for (const [g, list, cast, name] of veg) {
    for (const im of instancedChunks(g, mats.leaf, list, { cast, name, grid: cast ? 3 : 2 })) root.add(im);
  }

  // ───────── far ring: jungle mountains + karst towers (no fog, pre-hazed) ─────────
  const far = new GeoBatch();
  const haze = new THREE.Color(JUNGLE_ENV.skyHorizon);
  const ringR = stats.radius + 380;
  const greenA = new THREE.Color('#2f6f3a'), greenB = new THREE.Color('#5fa04a'), rockK = new THREE.Color('#8a8c7a');
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const r = ringR + rng.range(150, 420);
    const g = mountainGeometry(rng, 18, 6, 0.18, true);
    const h = rng.range(70, 140);
    far.add(g, (_x, y, _z, out) => { out.copy(greenA).lerp(greenB, clamp01(y * 1.2)).lerp(haze, 0.45 + (1 - y) * 0.1); },
      trs(stats.cx + Math.sin(a) * r, stats.minY - 15, stats.cz + Math.cos(a) * r, rng.range(0, 6), h * 2.6, h, h * 2.3));
    g.dispose();
  }
  const karst = (x: number, y: number, z: number, h: number, rad: number, hz: number) => {
    const g0 = new THREE.CylinderGeometry(0.82, 1, 1, 10, 5);
    const g = lumpy(g0, rng, 0.22);
    g0.dispose();
    far.add(g, (_x, ly, _z, out) => {
      out.copy(rockK).lerp(greenA, clamp01((ly - 0.2) * 3) * 0.9);
      if (Math.sin(_x * 9 + _z * 7) > 0.6) out.lerp(greenB, 0.5);
      out.lerp(haze, hz);
    }, trs(x, y + h / 2, z, rng.range(0, 6), rad, h, rad));
    g.dispose();
    far.add(sh.dome(10, 5), (_x, _y, _z, out) => { out.copy(greenB).lerp(haze, hz); }, trs(x, y + h * 0.98, z, 0, rad * 0.92, rad * 0.55, rad * 0.92));
  };
  for (let k = 0; k < 26; k++) {
    const a = rng.range(0, Math.PI * 2);
    const r = ringR + rng.range(60, 300);
    karst(stats.cx + Math.sin(a) * r, stats.minY - 14, stats.cz + Math.cos(a) * r, rng.range(80, 170), rng.range(18, 34), 0.4 + (r - ringR) / 1500);
  }
  const farMat = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, fog: false }));
  const farMesh = far.mesh(farMat, 'jungle-far', bin, { receive: false });
  if (farMesh) root.add(farMesh);
  // mid-distance karst towers inside the terrain (fogged)
  let nk = 0;
  for (const p of scatter(terrain, 40, seed + 54, { minDist: 140, maxDist: 900, pad: 40 })) {
    if (nk >= Math.round(10 * Math.max(q, 0.5))) break;
    const h = rng.range(40, 85), rad = rng.range(10, 18);
    if (terrain.nearestTrack(p.x, p.z).dist < rad + 30) continue;
    const g0 = new THREE.CylinderGeometry(0.8, 1, 1, 10, 4);
    const g = lumpy(g0, rng, 0.25);
    g0.dispose();
    P.stone.add(g, (_x, ly, _z, out) => { out.set('#8f8d78').lerp(new THREE.Color(C.leafA), clamp01((ly - 0.15) * 2.5) * 0.75); }, trs(p.x, p.y + h / 2 - 3, p.z, rng.range(0, 6), rad, h, rad));
    g.dispose();
    P.foliage.add(sh.dome(9, 4), vGrad(C.leafA, C.leafC, 0, 1), trs(p.x, p.y + h - 3.5, p.z, 0, rad * 0.95, rad * 0.5, rad * 0.95));
    nk++;
  }

  // ───────── merged statics ─────────
  const statics: Array<[GeoBatch, THREE.Material, string, boolean]> = [
    [P.stone, mats.matte, 'ruins', true], [P.paint, mats.satin, 'painted', true], [P.foliage, mats.leaf, 'ruin-foliage', true],
    [P.glowB, mats.glow, 'jungle-glow', false], [P.pools, water, 'pools', false],
  ];
  for (const [b, m, name, cast] of statics) {
    const mesh = b.mesh(m, name, bin, { cast });
    if (mesh) root.add(mesh);
  }
  const fallMat = fallMaterial(bin, { water: '#6fd6cf', foam: '#ffffff', speed: 1.5, opacity: 0.95, glow: 1.15 });
  if (P.falls.length) {
    const fb = new GeoBatch();
    for (const f of P.falls) { fb.add(f.geo, '#ffffff'); f.geo.dispose(); }
    const fm = fb.mesh(fallMat, 'waterfalls', bin, { receive: false });
    if (fm) root.add(fm);
  }

  // ───────── parrot flocks circling above the canopy (flapping via wing-mesh Y scale) ─────────
  const flocks: Array<{ x: number; y: number; z: number; r: number; w: number; ph: number }> = [];
  for (const p of scatter(terrain, 30, seed + 57, { minDist: 38, maxDist: 90, pad: 10 })) {
    if (flocks.length >= Math.max(2, Math.round(4 * q))) break;
    if (flocks.some(f => Math.hypot(f.x - p.x, f.z - p.z) < 120)) continue;
    flocks.push({ x: p.x, y: Math.max(p.y, level) + rng.range(22, 30), z: p.z, r: rng.range(12, 20), w: rng.range(0.35, 0.55) * (rng.chance(0.5) ? 1 : -1), ph: rng.range(0, 6) });
  }
  const perFlock = 5;
  const nBirds = flocks.length * perFlock;
  let parrotUpdate: ((time: number) => void) | null = null;
  if (nBirds > 0) {
    const bodyB = new GeoBatch();
    bodyB.add(sh.ico(1), '#ffffff', trs(0, 0, 0, 0, 0.26, 0.26, 0.62));
    bodyB.add(sh.ico(1), '#ffffff', trs(0, 0.1, 0.5, 0, 0.2, 0.2, 0.2));
    bodyB.add(sh.cone(5), '#ffd23f', trs(0, 0.06, 0.66, 0, 0.07, 0.18, 0.07, Math.PI / 2));
    bodyB.add(sh.box(), '#1d3557', trs(0, -0.02, -0.75, 0, 0.16, 0.05, 0.7));
    for (const sx of [-1, 1]) bodyB.add(sh.sphere(5, 4), '#111111', trs(sx * 0.12, 0.16, 0.6, 0, 0.04, 0.04, 0.04));
    const bodyGeo = bin.add(bodyB.geometry()!);
    const wingB = new GeoBatch();
    for (const sx of [-1, 1]) {
      wingB.add(sh.box(), (x, _y, _z, out) => { out.set(x * sx > 0.18 ? '#1f6feb' : '#ffffff'); }, trs(sx * 0.62, 0.22, 0, 0, 1.1, 0.04, 0.42, 0, sx * 0.38));
    }
    const wingGeo = bin.add(wingB.geometry()!);
    const bodies = new THREE.InstancedMesh(bodyGeo, mats.satin, nBirds);
    const wings = new THREE.InstancedMesh(wingGeo, mats.leaf, nBirds);
    bodies.name = 'parrots'; wings.name = 'parrot-wings';
    const cols = ['#e63946', '#2a9d8f', '#ffb703', '#1f6feb', '#8ac926'];
    const tc = new THREE.Color();
    for (let k = 0; k < nBirds; k++) { tc.set(cols[k % cols.length]!); bodies.setColorAt(k, tc); wings.setColorAt(k, tc); }
    bodies.frustumCulled = false; wings.frustumCulled = false;
    bodies.castShadow = true;
    root.add(bodies, wings);
    const bm = new THREE.Matrix4(), wm = new THREE.Matrix4(), sm = new THREE.Matrix4(), bq = new THREE.Quaternion(), be = new THREE.Euler(0, 0, 0, 'YXZ'), bp = new THREE.Vector3(), bs = new THREE.Vector3(1.4, 1.4, 1.4);
    parrotUpdate = (time: number) => {
      let k = 0;
      for (const fl of flocks) {
        for (let j = 0; j < perFlock; j++, k++) {
          const a = time * fl.w + fl.ph + j * 0.42;
          const rr = fl.r + Math.sin(j * 1.7 + time * 0.3) * 2.5;
          bp.set(fl.x + Math.cos(a) * rr, fl.y + Math.sin(time * 0.9 + j * 1.3) * 1.2 + j * 0.4, fl.z + Math.sin(a) * rr);
          const dir = Math.sign(fl.w);
          be.set(0, Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir), -dir * 0.35);
          bq.setFromEuler(be);
          bm.compose(bp, bq, bs);
          bodies.setMatrixAt(k, bm);
          const flap = Math.sin(time * 11 + j * 2.1 + fl.ph);
          sm.makeScale(1, flap * 1.1, 1);
          wm.multiplyMatrices(bm, sm);
          wings.setMatrixAt(k, wm);
        }
      }
      bodies.instanceMatrix.needsUpdate = true;
      wings.instanceMatrix.needsUpdate = true;
    };
    parrotUpdate(0);
  }

  // ───────── sky: humid cumulus ─────────
  const sky = new SkyLayer();
  root.add(sky.group);
  const cards = [];
  for (let k = 0; k < 16; k++) {
    const w = rng.range(220, 420);
    cards.push({ dir: skyDir(rng, 4, 22), dist: 900, w, h: w * rng.range(0.38, 0.5), bottom: '#b7d2c4', top: '#ffffff' });
  }
  const clouds = buildCards(bin, cards, cloudTexture(bin, seed + 8), { opacity: 0.95, name: 'clouds' });
  if (clouds) sky.group.add(clouds);

  // ───────── particles ─────────
  const fields: PointField[] = [];
  {
    const n = Math.round(700 * quality.particles);
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    for (const p of scatter(terrain, n, seed + 55, { minDist: 5, maxDist: 90, pad: 1 })) {
      pts.push(p.x, Math.max(p.y, level) + rng.range(0.6, 3.5), p.z);
      const c = new THREE.Color(rng.chance(0.7) ? '#e8ff7a' : '#ffe38a');
      cols.push(c.r * 2.2, c.g * 2.2, c.b * 2.2);
      sizes.push(rng.range(0.7, 1.3));
    }
    const ff = createTwinkles(bin, rng, pts, cols, sizes, { size: 0.22, attenuate: true, twinkle: 0.9, speed: 2.2, wander: 1.4, fog: true });
    if (ff) { root.add(ff.points); fields.push(ff); }
  }
  const pollen = createPrecip(bin, rng, { count: Math.round(700 * quality.particles), box: [60, 22, 60], fall: -0.08, sway: 1.4, drift: [0.3, 0.1], size: 0.06, color: '#fff6c8', opacity: 0.55 });
  root.add(pollen.points);
  fields.push(pollen);
  const puffTex = puffTexture(bin, seed + 10);
  const mist = createPuffs(bin, rng, P.mistAt, Math.max(8, Math.round(26 * quality.particles)), {
    life: 4.5, rise: 1.1, spread: 1.4, acc: [0.1, 0.1, 0.1], size0: 2.5, size1: 8, color0: '#ffffff', color1: '#dff7ef', opacity: 0.38, texture: puffTex, fadeIn: 0.15, fadeOut: 0.6,
  });
  if (mist) { root.add(mist.points); fields.push(mist); }
  const fire = createPuffs(bin, rng, P.fireAt, Math.max(6, Math.round(12 * quality.particles)), {
    life: 0.9, rise: 1.8, spread: 0.25, size0: 0.9, size1: 0.2, color0: '#ffd35a', color1: '#ff4d00', opacity: 0.9, additive: true, fadeIn: 0.05, fadeOut: 0.5,
  });
  if (fire) { root.add(fire.points); fields.push(fire); }

  sh.dispose();

  // ───────── movers ─────────
  const movers = new MoverAnimator();
  const mShapes = new Shapes();
  const mRng = new Rng(seed + 88);
  const cache = new Map<string, THREE.BufferGeometry>();
  const logGeo = () => {
    let g = cache.get('log');
    if (!g) {
      const b = new GeoBatch();
      const ring = new THREE.Color('#e0b27a'), ringD = new THREE.Color('#b07a45');
      const barkF: ColorFn = (x, _y, _z, out) => { out.set(C.bark).lerp(new THREE.Color(C.barkDark), Math.abs(Math.sin(x * 9)) * 0.6); };
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 6, true);
      const lp = lumpy(cyl, mRng, 0.05);
      cyl.dispose();
      // 3.8 radii long (±2 m at r = 1.05): the ends stay inside the sim's round hitbox (mover radius + kart radius)
      b.add(lp, barkF, trs(0, 0, 0, 0, 1, 3.8, 1, 0, Math.PI / 2));
      lp.dispose();
      // end grain: concentric growth rings + a bark rim (a flat 12-gon read as a plain tan disc)
      const rings = [0.2, 0.42, 0.62, 0.8, 0.9, 0.99];
      const ringCols = ['#8a5a2e', ring, ringD, ring, '#c8945a', C.barkDark];
      for (const sx of [-1, 1]) {
        for (let k = 0; k < rings.length; k++) {
          const g = k === 0 ? new THREE.CircleGeometry(rings[0]!, 12) : new THREE.RingGeometry(rings[k - 1]!, rings[k]!, 12, 1);
          b.add(g, ringCols[k]!, trs(sx * 1.9, 0, 0, sx * Math.PI / 2));
          g.dispose();
        }
      }
      for (let k = 0; k < 4; k++) b.add(mShapes.ico(0), C.moss, trs(mRng.range(-1.5, 1.5), 0.85, mRng.range(-0.4, 0.4), mRng.range(0, 6), 0.5, 0.25, 0.4));
      b.add(leaf, leafColor(C.leafA, C.leafC), trs(0.8, 0.95, 0, 0.4, 0.9, 0.8, 0.9, -0.8));
      b.add(mShapes.cyl(5), C.bark, trs(-1.0, 0.6, 0.6, 0, 0.14, 0.9, 0.14, 0.7, 0.2));
      g = b.geometry()!;
      cache.set('log', g);
    }
    return g;
  };
  const tikiGeo = () => {
    let g = cache.get('tiki');
    if (!g) {
      const b = new GeoBatch();
      const wood = vGrad('#6e4424', '#b07a44', 0, 3);
      // round carved trunk, readable from every side
      b.add(mShapes.cyl(12, 0.92), wood, trs(0, 0.2, 0, 0, 1.05, 2.5, 1.0));
      for (const [y, c] of [[0.55, C.teal], [2.45, C.orange]] as const) b.add(mShapes.torus(1, 0.12, 5, 16), c, trs(0, y, 0, 0, 1.02, 1.02, 1.3, Math.PI / 2));
      // back + side carvings (zig-zag teeth band)
      for (let k = 0; k < 10; k++) {
        const a = Math.PI * 0.3 + (k / 9) * Math.PI * 1.4;
        b.add(mShapes.cone(3), k % 2 ? C.yellow : C.red, trs(Math.sin(a) * 1.0, 1.5, Math.cos(a) * 0.95, a, 0.16, 0.35, 0.1, Math.PI / 2 * (k % 2 ? 1 : -1)));
      }
      // face (front = +Z)
      b.add(mShapes.box(), '#4e2e18', trs(0, 2.05, 0.9, 0, 1.7, 0.32, 0.3));
      for (const sx of [-1, 1]) {
        b.add(mShapes.sphere(10, 6), '#fff6e0', trs(sx * 0.4, 1.68, 0.86, 0, 0.3, 0.28, 0.14));
        b.add(mShapes.sphere(8, 5), '#1d1a14', trs(sx * 0.4, 1.66, 0.97, 0, 0.14, 0.15, 0.06));
        b.add(mShapes.sphere(8, 5), C.teal, trs(sx * 1.02, 1.55, 0, 0, 0.2, 0.55, 0.42));
      }
      b.add(mShapes.prism(), '#8b5a2b', trs(0, 1.2, 0.95, 0, 0.45, 0.62, 0.4, -Math.PI / 2));
      b.add(mShapes.box(), '#1d1a14', trs(0, 0.72, 0.93, 0, 1.2, 0.42, 0.12));
      for (let k = 0; k < 5; k++) b.add(mShapes.box(), '#fff6e0', trs(-0.44 + k * 0.22, 0.82, 0.99, 0, 0.13, 0.18, 0.05));
      b.add(mShapes.box(), C.red, trs(0, 0.58, 0.98, 0, 0.6, 0.12, 0.05));
      // headdress: crown ring + tall leaves
      b.add(mShapes.cyl(10), C.orange, trs(0, 2.65, 0, 0, 1.08, 0.3, 1.02));
      for (let k = 0; k < 7; k++) b.add(leaf, leafColor(C.leafA, C.leafC), trs(0, 2.85, 0, (k / 7) * Math.PI * 2, 1.9, 1.6, 1.9, -1.2));
      for (let k = 0; k < 3; k++) b.add(mShapes.cone(5), [C.red, C.yellow, C.teal][k]!, trs((k - 1) * 0.42, 2.9, 0.55, 0, 0.16, 0.9 - Math.abs(k - 1) * 0.2, 0.16, 0.25));
      // stubby feet
      for (const sx of [-1, 1]) b.add(mShapes.sphere(8, 5), '#5a3520', trs(sx * 0.5, 0.15, 0.25, 0, 0.42, 0.25, 0.6));
      g = b.geometry()!;
      cache.set('tiki', g);
    }
    return g;
  };
  const stoneBall = () => {
    let g = cache.get('stone');
    if (!g) {
      const b = new GeoBatch();
      const core = lumpy(mShapes.ico(2), mRng, 0.08);
      b.add(core, mossStone(mRng, 0.5));
      core.dispose();
      for (let k = 0; k < 6; k++) {
        const a = mRng.range(0, 6.28), e = mRng.range(-1, 1);
        b.add(mShapes.box(), '#5a5648', trs(Math.cos(a) * Math.cos(e) * 0.98, Math.sin(e) * 0.98, Math.sin(a) * Math.cos(e) * 0.98, a, 0.3, 0.08, 0.3, e));
      }
      g = b.geometry()!;
      cache.set('stone', g);
    }
    return g;
  };
  function createMover(look: string): THREE.Object3D {
    const k = look.toLowerCase();
    if (k.includes('log')) {
      const r = 1.05;
      const { root: mr, body } = movers.make('rollLog', r);
      const mesh = new THREE.Mesh(logGeo(), mats.leaf);
      mesh.scale.setScalar(r);
      mesh.castShadow = true;
      body.add(mesh);
      return mr;
    }
    if (k.includes('tiki') || k.includes('idol') || k.includes('statue') || k.includes('totem')) {
      // the idol keeps staring at the oncoming karts (its carved face is the character) while it hops sideways
      const { root: mr, body } = movers.make('hop', 1.4, undefined, {
        face: (x, z) => { const n = terrain.nearestTrack(x, z); return Math.atan2(-track.tx[n.i]!, -track.tz[n.i]!); },
      });
      const mesh = new THREE.Mesh(tikiGeo(), mats.leaf);
      mesh.castShadow = true;
      body.add(mesh);
      return mr;
    }
    const r = 1.6;
    const { root: mr, body } = movers.make('roll', r);
    const mesh = new THREE.Mesh(stoneBall(), mats.matte);
    mesh.scale.setScalar(r);
    mesh.castShadow = true;
    body.add(mesh);
    return mr;
  }

  return {
    environment: JUNGLE_ENV,
    update(dt, time, camera) {
      water.uniforms.uTime!.value = time;
      fallMat.uniforms.uTime!.value = time;
      if (parrotUpdate) parrotUpdate(time);
      const vh = viewHeight(ctx.renderer);
      for (const f of fields) f.update(time, camera, vh);
      sky.follow(camera);
      movers.update(dt, time);
    },
    createMover,
    dispose() {
      ctx.scene.remove(root);
      disposeObjects(root);
      movers.clear();
      for (const g of cache.values()) g.dispose();
      cache.clear();
      mShapes.dispose();
      bin.dispose();
    },
  };
}
