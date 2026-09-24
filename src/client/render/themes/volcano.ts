/**
 * Lava Fortress — volcano theme scenery.
 * Dark basalt terrain with glowing lava lakes/rivers (animated emissive shader, fills every valley and every 'pit'
 * section), a huge erupting volcano on the horizon with a smoke plume and lava bombs, fortress towers and crenellated
 * walls with torches, a fortress gate over the road, chain bridges over the lava, lava falls, spikes, obsidian,
 * charred trees, rising embers and falling ash under a smouldering red sky.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, fbm, scatter } from '../terrain.js';
import {
  Bin, GeoBatch, MoverAnimator, Rng, Shapes, SkyLayer,
  buildCards, buildSuspensionBridge, clamp01, clearOfRoad, cloudTexture, corridorHalf, createBatchMaterials, createPrecip,
  createPuffs, createTwinkles, disposeObjects, findPitRuns, frameAtIndex, glowTexture, indexAtS, instancedChunks, jitterTint,
  landmarkPose, lavaMaterial, lumpy, mountainGeometry, pitDepthFor, puffTexture, recolorTerrain, skyDir, smoothstep,
  trackStats, trs, trsTo, vGrad, viewHeight, wrapIndex,
  type ColorFn, type PointField, type Placement, type TrackFrame, withCorridorGuard, activeCorridorGuard,
} from './props-b.js';

const SKIP = new Set(['grandstand', 'arch', 'banner']);

export const VOLCANO_ENV: EnvironmentSettings = {
  skyTop: '#16060d', skyHorizon: '#8c2c12', skyBottom: '#3a120a',
  fogColor: '#4a1a10', fogNear: 90, fogFar: 760,
  // basalt, road and fortress stone are all very dark albedos: more sun/ambient lifts them out of the murk
  // (race views averaged ~30/255 luminance) without touching the self-lit lava, which carries the bloom
  sunColor: '#ffa06a', sunIntensity: 2.45, sunDir: [0.3, 0.55, -0.78],
  hemiSky: '#ff9a64', hemiGround: '#5a2414', hemiIntensity: 1.4,
  exposure: 1.12, night: true, bloomStrength: 1.0,
};

const C = {
  basalt: '#3a302e', basaltHi: '#5a4a44', ash: '#6d625c', obsidian: '#1d1620', iron: '#3b3434', ironHi: '#6b5f5a',
  stone: '#5c5250', stoneDark: '#3b3331', roof: '#5a1d1d', trim: '#ff6a00', glow: '#ffb347', ember: '#ff5a1a',
  banner: '#b3261e', bannerGold: '#ffc94a',
};

function sideMatrix(f: TrackFrame, y: number, out: THREE.Matrix4): THREE.Matrix4 {
  out.set(f.rx, 0, -f.fx, f.x, 0, 1, 0, y, f.rz, 0, -f.fz, f.z, 0, 0, 0, 1);
  return out;
}

function rockColor(rng: Rng, crackGlow = false): ColorFn {
  const a = new THREE.Color(C.basalt), b = new THREE.Color(C.basaltHi), ash = new THREE.Color(C.ash), hot = new THREE.Color('#ff5a1a');
  const o = rng.range(0, 40);
  return (x, y, z, out) => {
    const n = Math.sin((x + o) * 4.7) * Math.cos((z - o) * 3.9) + 0.4 * Math.sin((x + z) * 11 + o);
    out.copy(a).lerp(b, clamp01(0.45 + n * 0.3 + y * 0.15));
    if (y > 0.35) out.lerp(ash, clamp01((y - 0.35) * 2) * 0.5);
    if (crackGlow && Math.abs(n) < 0.08 && y < 0.4) out.lerp(hot, 0.85);
  };
}

const VOLCANO_PROFILE: Array<[number, number]> = [[1, -0.02], [0.82, 0.12], [0.62, 0.34], [0.44, 0.6], [0.3, 0.84], [0.22, 0.97], [0.19, 1], [0.14, 0.93], [0.08, 0.86], [0.001, 0.84]];

/** Volcano cone with a crater (unit radius / unit height), faceted, plus its outer-surface function. */
function volcanoGeometry(rng: Rng, seg = 28): { geo: THREE.BufferGeometry; surface(a: number, t: number, out: THREE.Vector3): THREE.Vector3 } {
  const pts = VOLCANO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  const lathe = new THREE.LatheGeometry(pts, seg);
  const g = lathe.toNonIndexed();
  lathe.dispose();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const ph = rng.range(0, 6);
  const ridge = (a: number, y: number) => 1 + 0.07 * Math.sin(a * 9 + ph) * (1 - y) + 0.04 * Math.sin(a * 23 + ph * 2);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const rr = r > 0.15 ? ridge(a, y) : 1;
    pos.setXYZ(k, x * rr, y + (r > 0.15 ? 0.02 * Math.sin(a * 13 + y * 9) : 0), z * rr);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  /** Outer flank point: t 0 = rim → 1 = base (angle a in the lathe's XZ convention). */
  const surface = (a: number, t: number, out: THREE.Vector3) => {
    // walk the outer profile (indices 0..6) from the rim (6) to the base (0)
    const f = Math.min(0.999, Math.max(0, t)) * 6;
    const k = 6 - Math.floor(f), fr = f - Math.floor(f);
    const p0 = VOLCANO_PROFILE[k]!, p1 = VOLCANO_PROFILE[Math.max(0, k - 1)]!;
    const r = p0[0] + (p1[0] - p0[0]) * fr, y = p0[1] + (p1[1] - p0[1]) * fr;
    // lathe: x = r·sin(φ), z = r·cos(φ); our a is atan2(z, x)
    const rr = r * ridge(a, y) + 0.012;
    return out.set(Math.cos(a) * rr, y + 0.02 * Math.sin(a * 13 + y * 9) + 0.01, Math.sin(a) * rr);
  };
  return { geo: g, surface };
}

// ───────────────────────────── scenery ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildVolcanoScenery(ctx));
}

function buildVolcanoScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const pal = THEME_PALETTES.volcano;
  const q = quality.scenery;
  const seed = track.def.scenerySeed;
  const root = new THREE.Group();
  root.name = 'scenery-volcano';
  scene.add(root);
  const bin = new Bin();
  const sh = new Shapes();
  const rng = new Rng((seed ^ 0x1a7a) >>> 0);
  const mats = createBatchMaterials(bin, 1.35);
  const stats = trackStats(track);
  const stats0 = stats;
  const base = stats.minY - 1;
  const level = base - 1.6;
  const terrain = buildTerrain(track, {
    ground: pal.ground, groundAlt: pal.groundAlt, pitColor: '#2a1410', hills: 22, cell: 6,
    pitDepth: pitDepthFor(track, level, 8), seed,
  });
  root.add(terrain.mesh);
  bin.add(terrain);
  const tb = terrain.bounds;
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const dry = (x: number, z: number, m = 0.6) => ground(x, z) > level + m;
  {
    const ash = new THREE.Color('#6a5c56'), dark = new THREE.Color('#2a2224'), hot = new THREE.Color('#9a3414');
    recolorTerrain(terrain.mesh, (x, y, z, ny, c) => {
      const n = fbm(x / 26, z / 26, seed + 31, 3);
      c.lerp(n > 0.15 ? ash : dark, clamp01(Math.abs(n) * 1.3) * 0.6);
      c.lerp(dark, smoothstep(0.82, 0.62, ny) * 0.7);
      c.lerp(hot, clamp01((level + 2.2 - y) / 2.2) * 0.9);
    });
  }

  // ───────── lava plane (fills valleys and every pit) ─────────
  // big lakes are seen up close from bridges and the intro flyover: more crust, less white-hot glare under bloom
  const lava = lavaMaterial(bin, { intensity: 1.05, scale: 0.045, flow: 0.1, hot: '#ffa62e', mid: '#e83a00', crust: '#1e0804', heat: 0.53 });
  {
    const geo = bin.add(new THREE.PlaneGeometry(tb.maxX - tb.minX, tb.maxZ - tb.minZ, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, lava);
    m.position.set((tb.minX + tb.maxX) / 2, level, (tb.minZ + tb.maxZ) / 2);
    m.name = 'lava-lakes';
    m.renderOrder = 1;   // after the terrain: early-z culls the lava shader under the ground
    root.add(m);
  }
  const lavaFlow = lavaMaterial(bin, { intensity: 1.3, hot: '#ffa530', mid: '#e83800', useUv: true, uvScale: [2.5, 7], flow: 0.35, flowDir: [0, 1] });
  const lavaStream = lavaMaterial(bin, { intensity: 0.95, hot: '#ff9a2a', mid: '#d83200', crust: '#240a05', useUv: true, uvScale: [1.6, 26], flow: 0.3, flowDir: [0, 1] });
  const lavaFar = lavaMaterial(bin, { intensity: 1.15, hot: '#ff8a20', mid: '#c83000', crust: '#200805', useUv: true, uvScale: [1.5, 30], flow: 0.25, flowDir: [0, 1] });
  lavaFar.fog = false;
  const lavaFarFlat = lavaMaterial(bin, { intensity: 2.4, scale: 0.08, flow: 0.15 });
  lavaFarFlat.fog = false;

  const stone = new GeoBatch();  // fortress, rocks (matte)
  const metal = new GeoBatch();  // iron, spikes, chains (gloss)
  const glowB = new GeoBatch();  // windows, embers, brazier coals
  const flows = new GeoBatch();  // lava falls (UV lava)
  const streams = new GeoBatch(); // lava rivers down the local volcano flanks
  const pools = new GeoBatch();  // lava pools (world lava)
  const farB = new GeoBatch();   // horizon volcano + ring (no fog)
  const farFlows = new GeoBatch();
  const farPools = new GeoBatch();
  const fireAt: Array<{ x: number; y: number; z: number; r?: number }> = [];
  const plumeAt: Array<{ x: number; y: number; z: number; r?: number }> = [];
  const bombAt: Array<{ x: number; y: number; z: number; r?: number }> = [];
  const splashAt: Array<{ x: number; y: number; z: number; r?: number }> = [];
  const glowCards: Array<{ x: number; y: number; z: number; s: number; color: string }> = [];
  const keepOut: Array<[number, number, number]> = [];
  const blocked = (x: number, z: number, pad = 0) => keepOut.some(([kx, kz, kr]) => (x - kx) ** 2 + (z - kz) ** 2 < (kr + pad) ** 2);
  const m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4();
  const local = (x: number, y: number, z: number, yaw: number, s = 1) => trsTo(m4b, x, y, z, yaw, s);
  const putL = (b: GeoBatch, g: THREE.BufferGeometry, col: THREE.ColorRepresentation | ColorFn, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) => {
    b.add(g, col, m4.multiplyMatrices(m4b, trs(lx, ly, lz, ry, sx, sy, sz, rx, rz)));
  };
  const worldOf = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx, ly, lz).applyMatrix4(m4b);

  // ───────── builders ─────────
  function volcano(x: number, y: number, z: number, H: number, R: number, far: boolean): void {
    const { geo: g, surface } = volcanoGeometry(rng);
    const rc = new THREE.Color('#2e2426'), rh = new THREE.Color('#4d3c38'), rim = new THREE.Color('#7a2a14'), haze = new THREE.Color(VOLCANO_ENV.skyHorizon);
    const col: ColorFn = (lx, ly, lz, out) => {
      out.copy(rc).lerp(rh, clamp01(Math.sin(Math.atan2(lz, lx) * 7) * 0.5 + 0.5) * 0.5);
      if (ly > 0.8) out.lerp(rim, clamp01((ly - 0.8) * 6));
      if (far) out.lerp(haze, 0.22 * (1 - ly * 0.5));
    };
    (far ? farB : stone).add(g, col, trs(x, y, z, 0, R, H, R));
    g.dispose();
    // crater lava
    const disc = new THREE.CircleGeometry(0.15 * R, 18);
    disc.rotateX(-Math.PI / 2);
    (far ? farPools : pools).add(disc, '#ffffff', trs(x, y + H * 0.86, z));
    disc.dispose();
    // lava streams down the flanks (on the side facing the track), hugging the real surface
    const nStreams = far ? 7 : 4;
    const toTrack = Math.atan2(stats0.cz - z, stats0.cx - x);
    const pA = new THREE.Vector3(), pB = new THREE.Vector3();
    for (let k = 0; k < nStreams; k++) {
      const a0 = far ? toTrack + (k / nStreams) * Math.PI * 2 + rng.range(-0.25, 0.25) : toTrack + rng.range(-1.1, 1.1);
      const w = far ? rng.range(0.03, 0.05) : rng.range(0.026, 0.04);
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      const N = 18;
      const len = rng.range(0.7, 1);
      for (let j = 0; j <= N; j++) {
        const t = (j / N) * len;
        const a = a0 + Math.sin(t * 7 + k) * 0.05;
        const ww = w * (0.6 + t * 1.3) / Math.max(0.2, 0.2 + t * 0.8);
        surface(a - ww, t, pA); surface(a + ww, t, pB);
        pos.push(x + pA.x * R, y + pA.y * H, z + pA.z * R, x + pB.x * R, y + pB.y * H, z + pB.z * R);
        uv.push(0, 1 - t, 1, 1 - t);
        if (j < N) { const b0 = j * 2; idx.push(b0, b0 + 2, b0 + 1, b0 + 1, b0 + 2, b0 + 3); }
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      sg.setIndex(idx);
      sg.computeVertexNormals();
      (far ? farFlows : streams).add(sg, '#ffffff');
      sg.dispose();
    }
    plumeAt.push({ x, y: y + H * 0.95, z, r: R * 0.06 });
    bombAt.push({ x, y: y + H * 0.9, z, r: R * 0.04 });
    glowCards.push({ x, y: y + H * 1.0, z, s: R * 0.7, color: '#ff4a10' });
    keepOut.push([x, z, R * 1.05]);
  }

  function tower(x: number, y: number, z: number, yaw: number, sc: number, h = 18): void {
    keepOut.push([x, z, 6 * sc]);
    local(x, y, z, yaw, sc);
    const r = 3.6;
    putL(stone, sh.cyl(12, 0.92), vGrad('#3e3533', C.stone, 0, 1), 0, -1, 0, r, h + 1, r);
    for (let k = 1; k < 4; k++) putL(stone, sh.cyl(12, 1, true), '#4a403e', 0, (h / 4) * k, 0, r * (1.005 - k * 0.02), 0.35, r * (1.005 - k * 0.02));
    putL(stone, sh.cyl(12), C.stoneDark, 0, -1, 0, r * 1.25, 3, r * 1.25);
    putL(stone, sh.cyl(12), C.stoneDark, 0, h - 0.2, 0, r * 1.12, 1.2, r * 1.12);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      putL(stone, sh.box(), C.stone, Math.cos(a) * r * 1.02, h + 1.4, Math.sin(a) * r * 1.02, 1.2, 1.6, 0.9, -a + Math.PI / 2);
    }
    putL(metal, sh.cone(12), vGrad(C.roof, '#8a2a22', 0, 1), 0, h + 1.8, 0, r * 1.2, 7, r * 1.2);
    putL(metal, sh.cyl(6), C.iron, 0, h + 8.6, 0, 0.12, 2.5, 0.12);
    putL(stone, sh.box(), C.banner, 0, h + 10.4, 0.4, 0.08, 0.9, 0.8);
    // glowing windows (two rows) + banner
    for (let row = 0; row < 2; row++) for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + row * 0.6;
      putL(glowB, sh.box(), row ? '#ff6a1a' : '#ff9a3a', Math.cos(a) * r * 0.93, h * (0.45 + row * 0.25), Math.sin(a) * r * 0.93, 0.7, 1.5, 0.25, -a + Math.PI / 2);
    }
    putL(stone, sh.box(), C.banner, 0, h * 0.62, r * 0.97, 1.8, 4.2, 0.12);
    putL(metal, sh.box(), C.bannerGold, 0, h * 0.62 + 0.8, r * 0.97 + 0.05, 0.9, 0.9, 0.08);
    // torches on brackets
    for (const sx of [-1, 1]) {
      putL(metal, sh.cyl(6, 1.4), C.iron, sx * 2.2, h * 0.36, r * 0.98 + 0.4, 0.2, 0.7, 0.2);
      putL(glowB, sh.sphere(6, 4), '#ff9a30', sx * 2.2, h * 0.36 + 0.8, r * 0.98 + 0.4, 0.3, 0.3, 0.3);
      const wp = worldOf(sx * 2.2, h * 0.36 + 0.9, r * 0.98 + 0.4);
      fireAt.push({ x: wp.x, y: wp.y, z: wp.z });
    }
  }

  function gate(f: TrackFrame, sc: number): void {
    const W = corridorHalf(track, f.i) + 2.5;
    sideMatrix(f, f.y - 0.8, m4b);
    const H = 13 * sc;
    for (const sx of [-1, 1]) {
      putL(stone, sh.box(), vGrad('#433a38', C.stone, 0, 1), sx * (W + 3), H * 0.6, 0, 6, H * 1.2, 7);
      for (let k = 0; k < 3; k++) putL(stone, sh.box(), C.stone, sx * (W + 3) + (k - 1) * 2.1, H * 1.2 + 0.8, 0, 1.3, 1.6, 7.2);
      putL(metal, sh.cone(4), vGrad(C.roof, '#8a2a22', 0, 1), sx * (W + 3), H * 1.2 + 1.6, 0, 4.4, 5, 5, Math.PI / 4);
      putL(glowB, sh.box(), '#ff8a2a', sx * (W + 3), H * 0.75, 3.52, 1.0, 2.0, 0.1);
      putL(stone, sh.box(), C.banner, sx * (W + 0.3), H * 0.62, 3.6, 2.2, 6, 0.12);
      putL(metal, sh.box(), C.bannerGold, sx * (W + 0.3), H * 0.62 + 1.2, 3.68, 1.1, 1.1, 0.08);
      putL(metal, sh.cyl(8, 1.3), C.iron, sx * (W - 0.4), 0, 4.2, 0.9, 2.2, 0.9);
      putL(glowB, sh.sphere(8, 5), '#ff9a30', sx * (W - 0.4), 2.3, 4.2, 0.8, 0.5, 0.8);
      const wp = worldOf(sx * (W - 0.4), 2.6, 4.2);
      fireAt.push({ x: wp.x, y: wp.y, z: wp.z, r: 0.5 });
    }
    // lintel with battlements + raised portcullis teeth
    putL(stone, sh.box(), vGrad('#433a38', C.stone, 0, 1), 0, H + 1.6, 0, 2 * W + 12, 4.2, 6.4);
    for (let k = -Math.floor(W / 2.4); k <= Math.floor(W / 2.4); k++) putL(stone, sh.box(), C.stone, k * 2.4, H + 4.4, 0, 1.2, 1.4, 6.6);
    for (let k = -Math.floor(W / 1.6); k <= Math.floor(W / 1.6); k++) {
      putL(metal, sh.cyl(4), C.iron, k * 1.6, H - 2.8, 0, 0.16, 3.4, 0.16);
      putL(metal, sh.cone(4), C.ironHi, k * 1.6, H - 2.8, 0, 0.3, 1.1, 0.3, 0, Math.PI);
    }
    putL(metal, sh.box(), C.iron, 0, H - 0.4, 0, 2 * W, 0.35, 0.35);
    putL(metal, sh.box(), C.iron, 0, H - 1.8, 0, 2 * W, 0.3, 0.3);
    putL(metal, sh.box(), C.bannerGold, 0, H + 1.6, 3.25, 2.2, 2.2, 0.12, 0, 0, Math.PI / 4);
    putL(stone, sh.box(), C.banner, 0, H + 1.6, 3.22, 4.6, 3.4, 0.1);
  }

  function wallRuns(): void {
    const step = Math.max(2, Math.round(4 / track.spacing));
    let torch = 0;
    for (let i = 0; i < track.n; i += step) {
      for (const side of [-1, 1] as const) {
        const e = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
        if (e !== 1) continue;
        const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
        const f = frameAtIndex(track, i, side * (wall + 2.6));
        if (terrain.inCorridor(f.x, f.z, 0.8)) continue;
        const gy = Math.min(ground(f.x, f.z), f.y) - 1;
        // an elevated section's wall stands on the ground far below it: never inside a lower section's corridor
        const guard = activeCorridorGuard();
        if (guard && guard.intrudes(sh.box(), trs(f.x, gy + 2.6, f.z, f.yaw, 2.2, 5.2, 4.25))) continue;
        const tone = rng.range(-0.05, 0.05);
        const wc = new THREE.Color(C.stone).offsetHSL(0, 0, tone);
        stone.add(sh.box(), vGrad('#3a302e', wc, 0, 1), trs(f.x, gy + 2.1, f.z, f.yaw, 2.2, 4.2, 4.25));
        stone.add(sh.box(), '#7a6c68', trs(f.x, gy + 4.25, f.z, f.yaw, 2.5, 0.35, 4.3));
        if ((i / step) % 2 === 0) {
          const mf = frameAtIndex(track, i, side * (wall + 2.6));
          stone.add(sh.box(), wc, trs(mf.x, gy + 5.0, mf.z, f.yaw, 2.3, 1.3, 2.0));
        }
        if (++torch % 4 === 0) {
          const tf = frameAtIndex(track, i, side * (wall + 1.1));
          if (guard && guard.intrudes(sh.box(), trs(tf.x, gy + 4.2, tf.z, 0, 0.8, 1.4, 0.8))) continue;
          metal.add(sh.cyl(6, 1.4), C.iron, trs(tf.x, gy + 3.6, tf.z, 0, 0.2, 0.8, 0.2));
          glowB.add(sh.sphere(6, 4), '#ff9a30', trs(tf.x, gy + 4.5, tf.z, 0, 0.3));
          fireAt.push({ x: tf.x, y: gy + 4.6, z: tf.z });
        }
      }
    }
  }

  function spikes(x: number, y: number, z: number, sc: number, n = 9): void {
    keepOut.push([x, z, 4 * sc]);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, 6.28), r = rng.range(0, 3.4) * sc;
      const h = rng.range(2.5, 7) * sc * (k === 0 ? 1.4 : 1);
      metal.add(sh.cone(5), vGrad(C.obsidian, '#8a2a3a', 0.6, 1), trs(x + Math.cos(a) * r, y - 0.4, z + Math.sin(a) * r, rng.range(0, 6), 0.55 * sc, h, 0.55 * sc, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)));
    }
    stone.add(lumpy(sh.dodeca(), rng, 0.3, true), rockColor(rng, true), trs(x, y - 0.3, z, 0, 3.4 * sc, 1.2 * sc, 3.4 * sc));
  }

  function lavaFall(x: number, gy: number, z: number, yaw: number, sc: number): void {
    const H = 16 * sc, Wf = 6 * sc;
    keepOut.push([x, z, 12 * sc]);
    local(x, gy, z, yaw);
    for (let k = 0; k < 8; k++) {
      const side = k < 4 ? -1 : 1, j = k % 4;
      const hh = H * (1.05 - j * 0.14) * rng.range(0.9, 1.1);
      const g = lumpy(sh.ico(1), rng, 0.25);
      putL(stone, g, rockColor(rng, true), side * (Wf / 2 + 2.5 * sc + j * 3 * sc), hh * 0.42, -4 * sc - j * 0.6 * sc, 3.6 * sc, hh * 0.58, 5 * sc, rng.range(0, 6));
      g.dispose();
    }
    {
      const g = lumpy(sh.box(), rng, 0.15);
      putL(stone, g, rockColor(rng), 0, H / 2 - 1, -7 * sc, Wf + 4 * sc, H + 1, 8 * sc);
      g.dispose();
    }
    const sheet = new THREE.PlaneGeometry(1, 1, 1, 10);
    const sp = sheet.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < sp.count; k++) { const t = sp.getY(k) + 0.5; sp.setZ(k, 1.0 * t * t - 0.2); }
    sheet.computeVertexNormals();
    flows.add(sheet, '#ffffff', m4.multiplyMatrices(m4b, trs(0, H / 2 - 0.4, -3 * sc, 0, Wf, H, sc)));
    sheet.dispose();
    const pc = worldOf(0, 0.3, 2 * sc);
    const disc = new THREE.CircleGeometry(8 * sc, 20);
    disc.rotateX(-Math.PI / 2);
    pools.add(disc, '#ffffff', trs(pc.x, Math.max(pc.y, level + 0.05), pc.z));
    disc.dispose();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const g = lumpy(sh.dodeca(), rng, 0.3, true);
      putL(stone, g, rockColor(rng), Math.cos(a) * 8.4 * sc, 0.1, 2 * sc + Math.sin(a) * 8.4 * sc, rng.range(1, 2) * sc, rng.range(0.6, 1.2) * sc, rng.range(1, 1.8) * sc, a);
      g.dispose();
    }
    const ep = worldOf(0, 0.5, -1.2 * sc);
    splashAt.push({ x: ep.x, y: ep.y, z: ep.z, r: Wf * 0.35 });
  }

  function brazier(x: number, y: number, z: number, s = 1): void {
    stone.add(sh.cyl(6, 0.8), C.stoneDark, trs(x, y - 0.2, z, 0, 0.8 * s, 1.6 * s, 0.8 * s));
    metal.add(sh.cyl(8, 1.5), C.iron, trs(x, y + 1.3 * s, z, 0, 0.55 * s, 0.6 * s, 0.55 * s));
    glowB.add(sh.dome(8, 3), '#ff7a24', trs(x, y + 1.85 * s, z, 0, 0.75 * s, 0.35 * s, 0.75 * s));
    fireAt.push({ x, y: y + 2.1 * s, z, r: 0.35 * s });
  }

  // ───────── landmarks ─────────
  const runs = findPitRuns(track);
  const bridged = new Set<number>();
  // no extra mid-span pylon: the track mesh already stands the decks on lava-lit brick piers, and the bridge's own
  // unlit basalt slab read as a flat black box between them
  const chainStyle = {
    tower: '#3b3331', towerTrim: '#5c5250', cable: '#2e2828', towerHeight: 8, cableRadius: 0.16, chain: true,
    pylons: false, torches: true, depth: 0,
  };
  const chainBridge = (runIdx: number) => {
    if (bridged.has(runIdx)) return;
    bridged.add(runIdx);
    const r = runs[runIdx]!;
    const mid = frameAtIndex(track, wrapIndex(track, r.i0 + Math.floor(r.len / 2)));
    const out = buildSuspensionBridge(track, r, { ...chainStyle, depth: Math.max(8, mid.y - level + 4) }, stone, metal, sh, rng);
    for (const t of out.torches) { glowB.add(sh.sphere(6, 4), '#ff9a30', trs(t.x, t.y - 0.4, t.z, 0, 0.35)); fireAt.push(t); }
  };
  let bigVolcano = false;
  for (const l of track.landmarks) {
    if (SKIP.has(l.kind)) continue;
    const p = landmarkPose(track, l);
    const f = p.frame, sc = p.scale;
    const gy = p.over ? f.y : ground(f.x, f.z);
    const k = l.kind.toLowerCase();
    if (k.includes('chain') || k.includes('bridge')) {
      const i = indexAtS(track, l.s);
      const ri = runs.findIndex(r => (r.i0 <= r.i1 ? i >= r.i0 && i <= r.i1 : i >= r.i0 || i <= r.i1));
      if (ri >= 0) chainBridge(ri);
      else {
        const half = Math.round(18 / track.spacing);
        buildSuspensionBridge(track, { i0: wrapIndex(track, i - half), i1: wrapIndex(track, i + half), len: half * 2 }, { ...chainStyle, depth: 8 }, stone, metal, sh, rng);
      }
      continue;
    }
    if (p.over) { gate(f, sc); continue; }
    if (k.includes('volcano')) {
      // the lumpy base reaches ~1.12 R: keep it 4 m clear of every corridor (at 70·sc a ridge of the cone rose through
      // the verge and road on the mirrored course)
      let clear = Infinity;
      for (let j = 0; j < track.n; j += 2) clear = Math.min(clear, Math.hypot(track.px[j]! - f.x, track.pz[j]! - f.z) - corridorHalf(track, j));
      const R = Math.max(20, Math.min(70 * sc, (clear - 4) / 1.12));
      volcano(f.x, gy - 6, f.z, 48 * sc, R, false); bigVolcano = true; continue;
    }
    if (k.includes('tower') || k.includes('fortress') || k.includes('castle') || k.includes('keep')) { tower(f.x, gy, f.z, p.yaw, sc, 18); continue; }
    if (k.includes('lava') || k.includes('fall')) { lavaFall(f.x, gy, f.z, p.yaw, sc); continue; }
    if (k.includes('spike')) { spikes(f.x, gy, f.z, 1.3 * sc, 12); continue; }
    if (k.includes('brazier') || k.includes('torch')) { brazier(f.x, gy, f.z, 1.4 * sc); continue; }
    // themed fallback: watchtower with spikes
    tower(f.x, gy, f.z, p.yaw, 0.8 * sc, 14);
    spikes(f.x + 8 * sc, gy, f.z + 4 * sc, sc, 7);
  }
  runs.forEach((r, k) => { if (r.len * track.spacing >= 14) chainBridge(k); });
  wallRuns();
  void bigVolcano;

  return assembleVolcano({
    ctx, root, bin, sh, rng, mats, terrain, stats, level, seed, q, lava, lavaFlow, lavaFar, lavaFarFlat,
    stone, metal, glowB, flows, streams, lavaStream, pools, farB, farFlows, farPools, fireAt, plumeAt, bombAt, splashAt, glowCards,
    volcano, tower, spikes, brazier, ground, dry, blocked,
  });
}

interface VolcanoParts {
  ctx: SceneryContext; root: THREE.Group; bin: Bin; sh: Shapes; rng: Rng;
  mats: ReturnType<typeof createBatchMaterials>; terrain: ReturnType<typeof buildTerrain>;
  stats: ReturnType<typeof trackStats>; level: number; seed: number; q: number;
  lava: THREE.ShaderMaterial; lavaFlow: THREE.ShaderMaterial; lavaFar: THREE.ShaderMaterial; lavaFarFlat: THREE.ShaderMaterial;
  stone: GeoBatch; metal: GeoBatch; glowB: GeoBatch; flows: GeoBatch; streams: GeoBatch; lavaStream: THREE.ShaderMaterial;
  pools: GeoBatch; farB: GeoBatch; farFlows: GeoBatch; farPools: GeoBatch;
  splashAt: Array<{ x: number; y: number; z: number; r?: number }>;
  fireAt: Array<{ x: number; y: number; z: number; r?: number }>;
  plumeAt: Array<{ x: number; y: number; z: number; r?: number }>;
  bombAt: Array<{ x: number; y: number; z: number; r?: number }>;
  glowCards: Array<{ x: number; y: number; z: number; s: number; color: string }>;
  volcano(x: number, y: number, z: number, H: number, R: number, far: boolean): void;
  tower(x: number, y: number, z: number, yaw: number, sc: number, h?: number): void;
  spikes(x: number, y: number, z: number, sc: number, n?: number): void;
  brazier(x: number, y: number, z: number, s?: number): void;
  ground(x: number, z: number): number;
  dry(x: number, z: number, m?: number): boolean;
  blocked(x: number, z: number, pad?: number): boolean;
}

function assembleVolcano(P: VolcanoParts): SceneryHandle {
  const { ctx, root, bin, sh, rng, mats, terrain, stats, level, seed, q } = P;
  const { track, quality } = ctx;
  const ground = P.ground;
  const facing = (x: number, z: number) => {
    const n = terrain.nearestTrack(x, z);
    return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z);
  };

  // ───────── horizon volcano (towards the sun glow) + jagged ring ─────────
  {
    const sd = VOLCANO_ENV.sunDir;
    const hl = Math.hypot(sd[0], sd[2]) || 1;
    const dist = stats.radius + 620;
    P.volcano(stats.cx + (sd[0] / hl) * dist, stats.minY - 30, stats.cz + (sd[2] / hl) * dist, 330, 520, true);
  }
  const haze = new THREE.Color(VOLCANO_ENV.skyHorizon);
  const rA = new THREE.Color('#1e1618'), rB = new THREE.Color('#3a2a28'), rim = new THREE.Color('#6a2412');
  const ringR = stats.radius + 400;
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * Math.PI * 2 + rng.range(-0.08, 0.08);
    const r = ringR + rng.range(60, 360);
    const g = mountainGeometry(rng, 16, 6, 0.45);
    const h = rng.range(70, 170);
    P.farB.add(g, (_x, y, _z, out) => { out.copy(rA).lerp(rB, clamp01(y * 1.3)); if (y < 0.15) out.lerp(rim, 0.5); out.lerp(haze, 0.18); },
      trs(stats.cx + Math.sin(a) * r, stats.minY - 12, stats.cz + Math.cos(a) * r, rng.range(0, 6), h * 1.5, h, h * 1.3));
    g.dispose();
  }

  // ───────── scattered props ─────────
  let nTower = 0, nSpike = 0;
  for (const p of scatter(terrain, 90, seed + 61, { minDist: 18, maxDist: 160, pad: 7 })) {
    if (!P.dry(p.x, p.z, 1) || P.blocked(p.x, p.z, 6) || !clearOfRoad(terrain, p.x, p.z, 7)) continue;
    const dist = terrain.nearestTrack(p.x, p.z).dist;
    if (nTower < 6 && dist > 35) { P.tower(p.x, p.y - 0.5, p.z, facing(p.x, p.z), rng.range(0.8, 1.2), rng.range(14, 22)); nTower++; continue; }
    if (nSpike < 14) { P.spikes(p.x, p.y, p.z, rng.range(0.7, 1.3), rng.int(5, 10)); nSpike++; }
  }
  // braziers lining the road (alternating sides), skipping pits
  {
    const step = Math.max(8, Math.round(38 / track.spacing));
    let side = 1;
    for (let i = 0; i < track.n; i += step) {
      side = -side;
      const e = side < 0 ? track.edgeL[i]! : track.edgeR[i]!;
      if (e === 2) continue;
      const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
      const f = frameAtIndex(track, i, side * (wall + 2.2));
      if (terrain.inCorridor(f.x, f.z, 0.6) || !P.dry(f.x, f.z, 0.3)) continue;
      P.brazier(f.x, Math.min(ground(f.x, f.z), f.y), f.z, 1.1);
    }
  }
  // glowing lava cracks meandering across the basalt plain (world-space lava, one mesh)
  const extraLava: THREE.ShaderMaterial[] = [];
  {
    const cracks = new GeoBatch();
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const nCracks = Math.round(70 * Math.max(q, 0.5));
    let made = 0;
    for (const p of scatter(terrain, nCracks * 3, seed + 63, { minDist: 12, maxDist: 220, pad: 4 })) {
      if (made >= nCracks) break;
      if (!P.dry(p.x, p.z, 1) || P.blocked(p.x, p.z, 3)) continue;
      made++;
      let x = p.x, z = p.z, a = rng.range(0, Math.PI * 2);
      const N = rng.int(8, 16);
      const w0 = rng.range(0.35, 0.8);
      const base = pos.length / 3;
      let ok = 0;
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const w = w0 * Math.sin(Math.PI * (0.08 + t * 0.84));
        const nx = -Math.sin(a), nz = Math.cos(a);
        const y1 = ground(x - nx * w, z - nz * w), y2 = ground(x + nx * w, z + nz * w);
        pos.push(x - nx * w, y1 + 0.18, z - nz * w, x + nx * w, y2 + 0.18, z + nz * w);
        uv.push(0, t, 1, t);
        ok++;
        a += rng.range(-0.6, 0.6);
        const step = rng.range(1.6, 3.2);
        x += Math.cos(a) * step; z += Math.sin(a) * step;
        if (terrain.inCorridor(x, z, 2) || !P.dry(x, z, 0.4)) break;
      }
      for (let k = 0; k < ok - 1; k++) { const b0 = base + k * 2; idx.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2); }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      cracks.add(g, '#ffffff');
      g.dispose();
      const crackMat = lavaMaterial(bin, { intensity: 1.25, hot: '#ffb040', mid: '#ff4a00', crust: '#3a0e04', scale: 0.35, flow: 0.2 });
      crackMat.polygonOffset = true; crackMat.polygonOffsetFactor = -2; crackMat.polygonOffsetUnits = -2;
      crackMat.side = THREE.DoubleSide;
      const cm = cracks.mesh(crackMat, 'lava-cracks', bin, { receive: false });
      if (cm) root.add(cm);
      extraLava.push(crackMat);
    }
  }
  // basalt column clusters (hexagonal prisms)
  const basaltG = new GeoBatch();
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2, r = k === 0 ? 0 : 1.05;
    const h = k === 0 ? 1 : rng.range(0.45, 0.85);
    basaltG.add(sh.cyl(6), vGrad('#2a2224', '#4d403c', 0, 1), trs(Math.cos(a) * r, -0.2, Math.sin(a) * r, 0, 0.58, h, 0.58));
    basaltG.add(sh.cyl(6), '#5e4e48', trs(Math.cos(a) * r, h - 0.2, Math.sin(a) * r, 0, 0.5, 0.04, 0.5));
  }
  const basaltGeo = bin.add(basaltG.geometry()!);
  const basalts: Placement[] = [];
  for (const p of scatter(terrain, Math.round(90 * q), seed + 64, { minDist: 16, maxDist: 240, pad: 6 })) {
    if (!P.dry(p.x, p.z, 0.8) || P.blocked(p.x, p.z, 4) || !clearOfRoad(terrain, p.x, p.z, 4)) continue;
    basalts.push({ x: p.x, y: p.y - 0.4, z: p.z, ry: p.r, s: rng.range(1.2, 2.4), sy: rng.range(1.6, 4.6), tint: jitterTint(rng, 0.1) });
  }
  for (const im of instancedChunks(basaltGeo, mats.matte, basalts, { cast: true, name: 'basalt-columns', grid: 2 })) root.add(im);

  // instanced: lava rocks, obsidian shards, charred trees
  const rockG = new GeoBatch();
  { const g = lumpy(sh.dodeca(), rng, 0.35, true); rockG.add(g, rockColor(rng, true)); g.dispose(); }
  const rockGeo = bin.add(rockG.geometry()!);
  const shardG = new GeoBatch();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    shardG.add(sh.cone(5), vGrad(C.obsidian, '#7a2a5a', 0.4, 1), trs(Math.cos(a) * 0.5, -0.2, Math.sin(a) * 0.5, a, 0.35, 1.6 + k * 0.5, 0.35, Math.sin(a) * 0.3, Math.cos(a) * 0.3));
  }
  shardG.add(sh.cone(5), vGrad(C.obsidian, '#ff4d6a', 0.5, 1), trs(0, -0.2, 0, 0, 0.5, 3.2, 0.5));
  const shardGeo = bin.add(shardG.geometry()!);
  const treeG = new GeoBatch();
  treeG.add(sh.cyl(6, 0.35), vGrad('#1a1414', '#3a2a26', 0, 1), trs(0, -0.3, 0, 0, 0.35, 6.3, 0.35));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    treeG.add(sh.cyl(4, 0.3), '#2a201e', trs(Math.cos(a) * 0.15, 3 + k * 0.7, Math.sin(a) * 0.15, -a, 0.14, 2.2 - k * 0.3, 0.14, 0, -0.9));
  }
  treeG.add(sh.sphere(5, 3), '#ff5a1a', trs(0.2, 1.4, 0.3, 0, 0.1, 0.4, 0.1));
  const treeGeo = bin.add(treeG.geometry()!);
  const lists = { rocks: [] as Placement[], shards: [] as Placement[], trees: [] as Placement[] };
  for (const p of scatter(terrain, Math.round(700 * q), seed + 62, { minDist: 0, maxDist: 300, pad: 3 })) {
    if (P.blocked(p.x, p.z, 1)) continue;
    const wet = !P.dry(p.x, p.z, 0.2);
    const r = rng.next();
    const pl: Placement = { x: p.x, y: wet ? level - 0.2 : p.y - 0.3, z: p.z, ry: p.r, s: p.s, tint: jitterTint(rng, 0.1) };
    const near = terrain.nearestTrack(p.x, p.z).dist < corridorHalf(track, terrain.nearestTrack(p.x, p.z).i) + 10;
    if (wet || r < 0.5) { pl.s = p.s * (near ? rng.range(0.5, 1.2) : rng.range(0.8, 3.2)); pl.sy = rng.range(0.5, 1); lists.rocks.push(pl); }
    else if (r < 0.75) { pl.s = p.s * rng.range(0.8, 1.8); lists.shards.push(pl); }
    else { pl.s = p.s * rng.range(0.8, 1.4); pl.rx = rng.range(-0.15, 0.15); lists.trees.push(pl); }
  }
  for (const im of [
    ...instancedChunks(rockGeo, mats.matte, lists.rocks, { cast: true, name: 'lava-rocks', grid: 2 }),
    ...instancedChunks(shardGeo, mats.gloss, lists.shards, { cast: true, name: 'obsidian', grid: 2 }),
    ...instancedChunks(treeGeo, mats.matte, lists.trees, { cast: true, name: 'charred-trees', grid: 2 }),
  ]) root.add(im);

  // ───────── merged statics ─────────
  const farMat = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, fog: false }));
  const statics: Array<[GeoBatch, THREE.Material, string, boolean]> = [
    [P.stone, mats.matte, 'fortress-stone', true], [P.metal, mats.gloss, 'iron', true], [P.glowB, mats.glow, 'volcano-glow', false],
    [P.flows, P.lavaFlow, 'lava-flows', false], [P.streams, P.lavaStream, 'lava-streams', false], [P.pools, P.lava, 'lava-pools', false],
    [P.farB, farMat, 'volcano-far', false], [P.farFlows, P.lavaFar, 'lava-far-flows', false], [P.farPools, P.lavaFarFlat, 'lava-far-crater', false],
  ];
  for (const [b, m, name, cast] of statics) {
    const mesh = b.mesh(m, name, bin, { cast });
    if (mesh) root.add(mesh);
  }
  const glowTex = glowTexture(bin);
  for (const gc of P.glowCards) {
    const sm = bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(gc.color).multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, opacity: 0.8 }));
    const sp = new THREE.Sprite(sm);
    sp.position.set(gc.x, gc.y, gc.z);
    sp.scale.setScalar(gc.s);
    sp.name = 'crater-glow';
    root.add(sp);
  }

  // ───────── sky: smouldering clouds lit from below, faint stars ─────────
  const sky = new SkyLayer();
  root.add(sky.group);
  const cards = [];
  for (let k = 0; k < 20; k++) {
    const w = rng.range(260, 520);
    cards.push({ dir: skyDir(rng, 5, 28), dist: 900, w, h: w * rng.range(0.3, 0.42), bottom: '#ff6a3a', top: '#2e141c' });
  }
  const clouds = buildCards(bin, cards, cloudTexture(bin, seed + 3), { opacity: 0.85, name: 'ember-clouds' });
  if (clouds) sky.group.add(clouds);
  const fields: PointField[] = [];
  {
    const n = 500;
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    for (let k = 0; k < n; k++) {
      const d = skyDir(rng, 25, 88);
      pts.push(d[0] * 950, d[1] * 950, d[2] * 950);
      const c = new THREE.Color(rng.chance(0.3) ? '#ffc9a0' : '#ffffff');
      cols.push(c.r, c.g, c.b);
      sizes.push(rng.range(0.8, 2.2));
    }
    const stars = createTwinkles(bin, rng, pts, cols, sizes, { size: 1.6, attenuate: false, twinkle: 0.6, speed: 1.5 });
    if (stars) { stars.points.frustumCulled = false; sky.group.add(stars.points); fields.push(stars); }
  }

  // ───────── particles: torches, plume, bombs, embers, ash ─────────
  const puffTex = puffTexture(bin, seed + 4);
  const fire = createPuffs(bin, rng, P.fireAt, Math.max(5, Math.round(10 * quality.particles)), {
    life: 0.8, rise: 2.0, spread: 0.3, size0: 0.95, size1: 0.2, color0: '#ffb03a', color1: '#ff2a00', opacity: 0.8, additive: true, fadeIn: 0.05, fadeOut: 0.55,
  });
  if (fire) { root.add(fire.points); fields.push(fire); }
  const plume = createPuffs(bin, rng, P.plumeAt, Math.max(16, Math.round(54 * quality.particles)), {
    life: 18, rise: 10, spread: 2.8, acc: [1.8, 0.25, 0.8], size0: 45, size1: 200, color0: '#4a2a26', color1: '#1c1414', opacity: 0.7, texture: puffTex, fog: false, fadeIn: 0.04, fadeOut: 0.5,
  });
  if (plume) { root.add(plume.points); fields.push(plume); }
  // lava-lit underside of the plume, right above the crater
  const plumeGlow = createPuffs(bin, rng, P.plumeAt, Math.max(8, Math.round(20 * quality.particles)), {
    life: 6, rise: 12, spread: 2, acc: [0.8, 0, 0.4], size0: 30, size1: 110, color0: '#ff6a2a', color1: '#3a1008', opacity: 0.4, texture: puffTex, additive: true, fog: false, fadeIn: 0.05, fadeOut: 0.7,
  });
  if (plumeGlow) { root.add(plumeGlow.points); fields.push(plumeGlow); }
  const bombs = createPuffs(bin, rng, P.bombAt, Math.max(8, Math.round(24 * quality.particles)), {
    life: 3.2, rise: 30, spread: 10, acc: [0, -20, 0], size0: 5, size1: 2, color0: '#ffe08a', color1: '#ff3a00', opacity: 1, additive: true, fog: false, fadeIn: 0.02, fadeOut: 0.25,
  });
  if (bombs) { root.add(bombs.points); fields.push(bombs); }
  const splash = createPuffs(bin, rng, P.splashAt, Math.max(8, Math.round(22 * quality.particles)), {
    life: 1.4, rise: 5.5, spread: 2.6, acc: [0, -9, 0], size0: 0.55, size1: 0.2, color0: '#ffc060', color1: '#ff3000', opacity: 0.95, additive: true, fadeIn: 0.02, fadeOut: 0.35,
  });
  if (splash) { root.add(splash.points); fields.push(splash); }
  const embers = createPrecip(bin, rng, { count: Math.round(1300 * quality.particles), box: [70, 36, 70], fall: -1.1, sway: 1.2, drift: [0.6, 0.2], size: 0.11, color: '#ff8a3a', opacity: 1, additive: true });
  embers.material.uniforms.uColor!.value = new THREE.Color('#ff8a3a').multiplyScalar(2.2);
  root.add(embers.points);
  fields.push(embers);
  const ashFall = createPrecip(bin, rng, { count: Math.round(700 * quality.particles), box: [70, 36, 70], fall: 0.6, sway: 1.6, drift: [0.4, 0.2], size: 0.09, color: '#8a7c78', opacity: 0.7 });
  root.add(ashFall.points);
  fields.push(ashFall);

  sh.dispose();

  // ───────── movers ─────────
  const movers = new MoverAnimator();
  const mShapes = new Shapes();
  const mRng = new Rng(seed + 99);
  const blobMat = lavaMaterial(bin, { intensity: 1.35, hot: '#ffa530', mid: '#e83a00', useUv: true, uvScale: [3, 3], flow: 0.6, flowDir: [0.3, 1] });
  const crustGeo = (() => {
    const b = new GeoBatch();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + mRng.range(-0.2, 0.2), e = mRng.range(-0.35, 1.1);
      const g = lumpy(mShapes.dodeca(), mRng, 0.3);
      b.add(g, vGrad('#1c1414', '#3a2a26', -1, 1), trs(Math.cos(a) * Math.cos(e) * 0.95, 1 + Math.sin(e) * 0.95, Math.sin(a) * Math.cos(e) * 0.95, a, 0.34, 0.2, 0.34, e));
      g.dispose();
    }
    return bin.add(b.geometry()!);
  })();
  const blobGeo = bin.add(new THREE.IcosahedronGeometry(1, 3).translate(0, 1, 0));
  const boulderGeo = (() => {
    const b = new GeoBatch();
    const g = lumpy(mShapes.ico(2), mRng, 0.12);
    b.add(g, rockColor(mRng, true));
    g.dispose();
    return bin.add(b.geometry()!);
  })();
  const haloMats: THREE.SpriteMaterial[] = [];
  function createMover(look: string): THREE.Object3D {
    const k = look.toLowerCase();
    if (k.includes('lava') || k.includes('magma') || k.includes('blob') || k.includes('fire')) {
      const r = 1.5;
      const halo = new THREE.Sprite(bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color('#ff4a10'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
      const hm = halo.material;
      haloMats.push(hm);
      const phase = Math.random() * 10;
      const { root: mr, body } = movers.make('wobble', r, (_dt, time) => {
        const fl = 0.75 + 0.25 * Math.sin(time * 13 + phase) * Math.sin(time * 7.3 + phase * 2);
        hm.opacity = 0.35 + fl * 0.4;
        halo.scale.setScalar(r * (3.6 + fl * 1.0));
      });
      const blob = new THREE.Mesh(blobGeo, blobMat);
      blob.scale.set(r, r * 0.85, r);
      const crust = new THREE.Mesh(crustGeo, mats.matte);
      crust.scale.set(r, r * 0.85, r);
      crust.castShadow = true;
      halo.position.y = r;
      body.add(blob, crust, halo);
      return mr;
    }
    const r = 1.6;
    const { root: mr, body } = movers.make('roll', r);
    const mesh = new THREE.Mesh(boulderGeo, mats.matte);
    mesh.scale.setScalar(r);
    mesh.castShadow = true;
    body.add(mesh);
    return mr;
  }

  const lavaMats = [P.lava, P.lavaFlow, P.lavaStream, P.lavaFar, P.lavaFarFlat, blobMat, ...extraLava];
  return {
    environment: VOLCANO_ENV,
    update(dt, time, camera) {
      for (const m of lavaMats) m.uniforms.uTime!.value = time;
      blobMat.uniforms.uIntensity!.value = 1.3 + 0.3 * Math.sin(time * 9) * Math.sin(time * 5.1);
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
      mShapes.dispose();
      bin.dispose();
    },
  };
}
