/**
 * Frost Peak — snow theme scenery.
 * Ring of snowy peaks, instanced snow-capped pine forests, log cabins with warm windows and chimney smoke,
 * snowmen, a ski lift with moving chairs, ice arches, a rock/ice tunnel ('tunnel' landmark), frozen lakes,
 * sparkling snow, falling snow around the camera and soft clouds.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, fbm, scatter, type Terrain } from '../terrain.js';
import type { LandmarkDef } from '../../../sim/types.js';
import {
  Bin, GeoBatch, MoverAnimator, Rng, Shapes, SkyLayer,
  buildCards, clamp01, clearOfRoad, smoothstep, cloudTexture, disposeObjects, corridorHalf, createBatchMaterials, createPrecip, createPuffs, createTwinkles,
  frameAtIndex, indexAtS, instanced, instancedChunks, wrapIndex, jitterTint, landmarkPose, liquidMaterial, lumpy, mixHex, mountainGeometry, recolorTerrain,
  pitDepthFor, puffTexture, skyDir, trackStats, trs, trsTo, tubeAlong, vGrad, viewHeight,
  type ColorFn, type PointField, type Placement, type TrackFrame, withCorridorGuard, activeCorridorGuard, CorridorGuard,
} from './props-b.js';

const SKIP = new Set(['grandstand', 'arch', 'banner']);

export const SNOW_ENV: EnvironmentSettings = {
  skyTop: '#2c7be0', skyHorizon: '#cfeaff', skyBottom: '#eef6fb',
  fogColor: '#d9eefc', fogNear: 170, fogFar: 1050,
  sunColor: '#fff4e2', sunIntensity: 2.7, sunDir: [0.45, 0.62, -0.64],
  hemiSky: '#d7ecff', hemiGround: '#9fb9d4', hemiIntensity: 1.05,
  exposure: 0.98, night: false, bloomStrength: 0.3,
};

const C = {
  bark: '#6e4426', pine: '#2c6b4f', pineHi: '#3f8c5f', snow: '#f5fbff', snowShade: '#dce9f5',
  rock: '#6d7f96', rockDark: '#4f5d72', log: '#9a6139', logDark: '#6e4225', roofRed: '#c8423b',
  window: '#ffc868', ice: '#a9e2ff', iceDeep: '#5fb4e6', coal: '#2a2a33', carrot: '#ff8a2a', scarf: '#e63946',
  steel: '#8a94a6', chairs: ['#e63946', '#ffd23f', '#1f6feb', '#2a9d8f'],
};

/** Local frame with X = lateral right (+d), Y = up, Z = backward (right-handed). */
function sideMatrix(f: TrackFrame, y: number, out: THREE.Matrix4): THREE.Matrix4 {
  out.set(
    f.rx, 0, -f.fx, f.x,
    0, 1, 0, y,
    f.rz, 0, -f.fz, f.z,
    0, 0, 0, 1,
  );
  return out;
}

/** Superellipse arch point (θ 0 → right base, π/2 → top, π → left base). */
function archPt(theta: number, w: number, h: number): [number, number] {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [w * Math.sign(c) * Math.pow(Math.abs(c), 0.62), h * Math.pow(Math.abs(s), 0.85)];
}

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildSnowScenery(ctx));
}

function buildSnowScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const pal = THEME_PALETTES.snow;
  const q = quality.scenery;
  const root = new THREE.Group();
  root.name = 'scenery-snow';
  scene.add(root);
  const bin = new Bin();
  const sh = new Shapes();
  const rng = new Rng((track.def.scenerySeed ^ 0x51a0) >>> 0);
  const mats = createBatchMaterials(bin, 1.9);
  const stats = trackStats(track);
  const base = stats.minY - 1;
  const iceLevel = base - 2.6;

  const terrain = buildTerrain(track, {
    ground: pal.ground, groundAlt: pal.groundAlt, pitColor: pal.pitColor,
    hills: 22, pitDepth: pitDepthFor(track, iceLevel, 10), seed: track.def.scenerySeed,
  });
  root.add(terrain.mesh);
  bin.add(terrain);
  const tb = terrain.bounds;
  // drivable-corridor guard of this build (explicit checks for merged props; instanced ones are filtered for us)
  const guard = activeCorridorGuard() ?? new CorridorGuard(track);
  {
    const blue = new THREE.Color('#b9d3ec'), rockC = new THREE.Color('#8494ac'), bright = new THREE.Color('#ffffff');
    const sd = track.def.scenerySeed;
    recolorTerrain(terrain.mesh, (x, y, z, ny, c) => {
      const n = fbm(x / 22, z / 22, sd + 12, 2);
      c.lerp(bright, clamp01(0.25 + n * 0.5));
      c.lerp(blue, clamp01((base + 4 - y) / 10) * 0.45 + clamp01(-n) * 0.25);
      c.lerp(rockC, smoothstep(0.84, 0.66, ny) * 0.8);
    });
  }

  const iceMat = bin.add(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.86,
    emissive: new THREE.Color('#2f7fb8'), emissiveIntensity: 0.28,
  }));

  const matte = new GeoBatch();   // wood, stone, snow bodies
  const satin = new GeoBatch();   // painted / plastic details
  const glow = new GeoBatch();    // warm windows, lamps
  const ice = new GeoBatch();     // ice arches, crystals, icicles
  const smokeAt: Array<{ x: number; y: number; z: number }> = [];
  const updaters: Array<(dt: number, time: number) => void> = [];
  const pines: Placement[] = [];
  const firs: Placement[] = [];
  const rocks: Placement[] = [];
  const m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4();
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const dryLand = (x: number, z: number) => ground(x, z) > iceLevel + 0.6;

  // ───────── frozen lakes (ice sheet at a fixed level, terrain valleys dip below it) ─────────
  {
    const w = tb.maxX - tb.minX, d = tb.maxZ - tb.minZ;
    const geo = bin.add(new THREE.PlaneGeometry(w, d, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = liquidMaterial(bin, {
      deep: '#7fbfe3', shallow: '#c7ecfb', sky: '#eaf7ff', sunColor: '#ffffff', sunDir: SNOW_ENV.sunDir,
      scale: 0.05, flow: 0, bump: 0.35, glint: 1.4, sparkle: 1.4,
    });
    const lake = new THREE.Mesh(geo, mat);
    lake.position.set((tb.minX + tb.maxX) / 2, iceLevel, (tb.minZ + tb.maxZ) / 2);
    lake.receiveShadow = true;
    lake.name = 'frozen-lakes';
    // drawn after the terrain (renderOrder 1): early-z then skips the expensive ice shader wherever ground covers it
    lake.renderOrder = 1;
    root.add(lake);
    updaters.push((_dt, time) => { mat.uniforms.uTime!.value = time; });
  }

  // ───────── builders ─────────
  const snowRock: ColorFn = (() => {
    const a = new THREE.Color(C.rockDark), b = new THREE.Color(C.rock), s = new THREE.Color(C.snow);
    return (x, y, z, out) => {
      out.copy(a).lerp(b, clamp01(0.5 + y * 0.6));
      const n = Math.sin(x * 3.1) * Math.cos(z * 2.7) * 0.18;
      out.lerp(s, clamp01((y + n - 0.15) * 5));
    };
  })();

  function cabin(x: number, y: number, z: number, yaw: number, s: number, roof: string = C.roofRed): void {
    const W = 6 * s, D = 5 * s, H = 3.3 * s;
    trsTo(m4b, x, y, z, yaw, 1);
    const put = (b: GeoBatch, g: THREE.BufferGeometry, col: string | ColorFn, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) => {
      b.add(g, col, m4.multiplyMatrices(m4b, trs(lx, ly, lz, ry, sx, sy, sz, rx, rz)));
    };
    // stone footing + log walls with grooves
    put(matte, sh.box(), '#8a8f9c', 0, 0.25 * s, 0, W + 0.5 * s, 0.9 * s, D + 0.5 * s);
    put(matte, sh.box(), C.log, 0, 0.7 * s + H / 2, 0, W, H, D);
    for (let k = 0; k < 4; k++) {
      const yy = 0.7 * s + (k + 0.5) * (H / 4);
      put(matte, sh.box(), C.logDark, 0, yy, D / 2 + 0.02, W + 0.3 * s, 0.12 * s, 0.1 * s);
      put(matte, sh.box(), C.logDark, 0, yy, -D / 2 - 0.02, W + 0.3 * s, 0.12 * s, 0.1 * s);
      for (const sx of [-1, 1]) {
        put(matte, sh.box(), C.logDark, sx * (W / 2 + 0.02), yy, 0, 0.1 * s, 0.12 * s, D + 0.3 * s);
        // log ends at corners
        for (const sz of [-1, 1]) put(matte, sh.cyl(6), '#c08a5a', sx * (W / 2 + 0.05 * s), yy - 0.35 * s, sz * (D / 2 + 0.05 * s), 0.3 * s, 0.7 * s, 0.3 * s, 0, Math.PI / 2);
      }
    }
    // roof: red eaves under a thick snow blanket
    const ry = 0.7 * s + H;
    put(satin, sh.prism(), roof, 0, ry - 0.1 * s, 0, D + 1.4 * s, 2.6 * s, W + 1.4 * s, Math.PI / 2);
    put(matte, sh.prism(), C.snow, 0, ry + 0.25 * s, 0, D + 1.5 * s, 2.55 * s, W + 1.7 * s, Math.PI / 2);
    // snow drip lip along the eaves
    for (const sz of [-1, 1]) put(matte, sh.box(), C.snowShade, 0, ry + 0.02 * s, sz * (D / 2 + 0.7 * s), W + 1.7 * s, 0.35 * s, 0.35 * s);
    // chimney
    put(matte, sh.box(), '#7c818d', W * 0.28, ry + 2.3 * s, -D * 0.12, 0.9 * s, 2.6 * s, 0.9 * s);
    put(matte, sh.box(), C.snow, W * 0.28, ry + 3.65 * s, -D * 0.12, 1.1 * s, 0.25 * s, 1.1 * s);
    const cp = new THREE.Vector3(W * 0.28, ry + 3.9 * s, -D * 0.12).applyMatrix4(m4b);
    smokeAt.push({ x: cp.x, y: cp.y, z: cp.z });
    // door + windows (front = +Z)
    put(matte, sh.box(), '#5a3520', -W * 0.18, 0.7 * s + 1.1 * s, D / 2 + 0.06 * s, 1.2 * s, 2.2 * s, 0.12 * s);
    put(satin, sh.sphere(6, 4), '#ffd23f', -W * 0.18 + 0.4 * s, 0.7 * s + 1.1 * s, D / 2 + 0.16 * s, 0.08 * s, 0.08 * s, 0.08 * s);
    const win = (lx: number, lz: number, ryw: number) => {
      put(matte, sh.box(), '#4a2a18', lx, 0.7 * s + H * 0.55, lz, 1.35 * s, 1.2 * s, 0.12 * s, ryw);
      put(glow, sh.box(), C.window, lx, 0.7 * s + H * 0.55, lz, 1.05 * s, 0.9 * s, 0.16 * s, ryw);
      // window sill snow
      put(matte, sh.box(), C.snow, lx, 0.7 * s + H * 0.55 - 0.62 * s, lz, 1.5 * s, 0.14 * s, 0.3 * s, ryw);
    };
    win(W * 0.22, D / 2 + 0.05 * s, 0);
    win(-W / 2 - 0.05 * s, 0, Math.PI / 2);
    win(W / 2 + 0.05 * s, 0, Math.PI / 2);
    // porch lamp + woodpile + snow drifts
    put(glow, sh.sphere(6, 4), '#ffe2a0', -W * 0.18 + 1.0 * s, 0.7 * s + 2.5 * s, D / 2 + 0.3 * s, 0.18 * s, 0.18 * s, 0.18 * s);
    for (let k = 0; k < 6; k++) put(matte, sh.cyl(6), k % 2 ? '#b98352' : '#a0703f', W / 2 + 0.9 * s, 0.3 * s + Math.floor(k / 3) * 0.42 * s, -D * 0.3 + (k % 3) * 0.45 * s, 0.2 * s, 1.4 * s, 0.2 * s, 0, 0, Math.PI / 2);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.5;
      put(matte, sh.dome(8, 4), C.snow, Math.cos(a) * W * 0.62, 0, Math.sin(a) * D * 0.7, 1.6 * s, 0.6 * s, 1.2 * s);
    }
  }

  function snowman(x: number, y: number, z: number, yaw: number, s: number, hat: string): void {
    trsTo(m4b, x, y, z, yaw, s);
    const put = (b: GeoBatch, g: THREE.BufferGeometry, col: string | ColorFn, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) => {
      b.add(g, col, m4.multiplyMatrices(m4b, trs(lx, ly, lz, ry, sx, sy, sz, rx, rz)));
    };
    const snowCol = vGrad(C.snowShade, C.snow, -0.6, 0.8);
    put(matte, sh.sphere(12, 9), snowCol, 0, 0.85, 0, 1.0, 0.92, 1.0);
    put(matte, sh.sphere(12, 9), snowCol, 0, 2.1, 0, 0.72, 0.7, 0.72);
    put(matte, sh.sphere(12, 9), snowCol, 0, 3.05, 0, 0.52, 0.5, 0.52);
    put(satin, sh.cone(8), C.carrot, 0, 3.08, 0.45, 0.09, 0.55, 0.09, 0, Math.PI / 2);
    for (const ex of [-0.18, 0.18]) put(satin, sh.sphere(6, 4), C.coal, ex, 3.2, 0.44, 0.06, 0.06, 0.06);
    for (let k = 0; k < 3; k++) put(satin, sh.sphere(6, 4), C.coal, 0, 1.95 - k * 0.3 + 0.3, 0.7 - Math.abs(k - 1) * 0.03, 0.07, 0.07, 0.07);
    put(satin, sh.torus(1, 0.28, 6, 14), C.scarf, 0, 2.62, 0, 0.5, 0.5, 0.5, 0, Math.PI / 2);
    put(satin, sh.box(), C.scarf, 0.25, 2.3, 0.35, 0.2, 0.55, 0.08, 0, 0.2, 0.2);
    put(satin, sh.cyl(10), hat, 0, 3.45, 0, 0.42, 0.62, 0.42);
    put(satin, sh.cyl(10), hat, 0, 3.45, 0, 0.62, 0.07, 0.62);
    for (const sx of [-1, 1]) put(matte, sh.cyl(4), C.bark, sx * 0.6, 2.2, 0, 0.05, 1.2, 0.05, 0, 0, -sx * 1.0);
  }

  function crystals(x: number, y: number, z: number, s: number, count = 6): void {
    for (let k = 0; k < count; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0, 1.4) * s;
      const h = rng.range(1.6, 4.2) * s * (k === 0 ? 1.5 : 1);
      const col = mixHex(C.ice, '#ffffff', rng.range(0, 0.4));
      ice.add(sh.cone(5), col, trs(x + Math.cos(a) * r, y - 0.3, z + Math.sin(a) * r, rng.range(0, 3), 0.45 * s, h, 0.45 * s, rng.range(-0.35, 0.35), rng.range(-0.35, 0.35)));
    }
  }

  /** Icicles hanging from h(x) (local to the row base y); tips never drop below `minTip` (local) over |x| < `clearX`. */
  function icicleRow(f: TrackFrame, y: number, x0: number, x1: number, h: (x: number) => number, minTip = -Infinity, clearX = 0): void {
    for (let x = x0; x <= x1; x += rng.range(0.9, 1.8)) {
      let L = rng.range(0.5, 1.8);
      if (Math.abs(x) < clearX) L = Math.min(L, h(x) + 0.15 - minTip);
      if (L < 0.35) continue;
      ice.add(sh.cone(5), C.ice, m4.multiplyMatrices(sideMatrix(f, y, m4b), trs(x, h(x) + 0.15, rng.range(-1.2, 1.2), 0, 0.22, L, 0.22, Math.PI)));
    }
  }

  function peak(x: number, y: number, z: number, s: number, r: Rng, into: GeoBatch, haze?: THREE.Color): void {
    const g = mountainGeometry(r, 22, 8, 0.34);
    const rockA = new THREE.Color('#4c5d78'), rockB = new THREE.Color('#7d90ad'), sn = new THREE.Color(C.snow), shd = new THREE.Color('#cfe0f2');
    const capAt = r.range(0.42, 0.6);
    const ph = r.range(0, 6.28);
    const col: ColorFn = (lx, ly, lz, out) => {
      const a = Math.atan2(lz, lx);
      out.copy(rockA).lerp(rockB, clamp01(ly * 1.4));
      const jag = Math.sin(a * 7 + ph) * 0.06 + Math.sin(a * 17 + ph * 2) * 0.04;
      const streak = Math.max(0, Math.sin(a * 11 + ph)) * 0.25;
      const t = clamp01((ly + jag + streak * (1 - ly) - capAt) * 9);
      out.lerp(Math.cos(a - 0.9) > 0 ? sn : shd, t);
      if (ly < 0.12) out.lerp(sn, clamp01((0.12 - ly) * 6));
      if (haze) out.lerp(haze, 0.3);
    };
    const w = s * r.range(1.3, 1.9);
    into.add(g, col, trs(x, y, z, r.range(0, 6.28), w, s, w * r.range(0.8, 1.2)));
    g.dispose();
  }

  // ───────── landmarks ─────────
  const lmHandled = new Set<string>();
  function tunnel(l: LandmarkDef & { s: number }): void {
    const sc = l.scale ?? 1;
    const half = 22 * sc;
    const step = 2;
    const segs = Math.max(4, Math.ceil((half * 2) / step));
    const M = 18;
    const frames: Array<{ f: TrackFrame; W: number; H: number }> = [];
    for (let j = 0; j <= segs; j++) {
      const s = l.s - half + (j / segs) * half * 2;
      const i = indexAtS(track, s);
      const f = frameAtIndex(track, i, 0);
      // widest corridor within ±4 m: at the mouths the barriers still fan out to the verge beyond the portal
      let cw = 0;
      for (let k = -4; k <= 4; k++) cw = Math.max(cw, corridorHalf(track, wrapIndex(track, i + k)));
      let W = cw + 1.4;
      let H = Math.min(13, Math.max(8, W * 0.72));
      // headroom: the vault (ribs ~0.4 m inside it) stays above 4.9 m over the whole drivable width, right up to the
      // barrier line — a rounded vault springing from the wall line otherwise dips to ~4 m over the verge lanes
      for (let g = 0; g < 48 && archHeightAt(cw, W - 0.45, H - 0.45) - 1.6 < 4.9; g++) { W += 0.25; H = Math.min(13, Math.max(8, W * 0.72)); }
      frames.push({ f, W, H });
    }
    // lamp positions (world) — the vault colours bake a warm light pool around each one
    const lampPts: THREE.Vector3[] = [];
    for (let j = 0; j <= segs; j += 3) {
      const { f, W, H } = frames[j]!;
      for (const th of [Math.PI * 0.3, Math.PI * 0.7]) {
        const [cx, cy] = archPt(th, W, H);
        lampPts.push(new THREE.Vector3(cx * 0.96, cy - 0.35, 0).applyMatrix4(sideMatrix(f, f.y - 1.6, m4b)));
      }
    }
    // rough-hewn rock vault: vertices pushed OUTWARD (never into the lanes) by smooth noise, flat-shaded facets
    const vsd = track.def.scenerySeed + 131;
    const grid: THREE.Vector3[][] = frames.map(({ f, W, H }) => {
      const row: THREE.Vector3[] = [];
      for (let k = 0; k <= M; k++) {
        const th = (k / M) * Math.PI;
        let [lx, ly] = archPt(th, W, H);
        if (k > 0 && k < M) {
          const dx = lx, dy = ly - H * 0.3, dl = Math.hypot(dx, dy) || 1;
          const n = 0.5 + 0.5 * fbm((f.x + f.rx * lx) * 0.22 + ly * 0.17, (f.z + f.rz * lx) * 0.22 - ly * 0.13, vsd, 2);
          const amt = (0.25 + 1.1 * n) * Math.min(1, Math.sin(th) * 2.5);
          lx += (dx / dl) * amt; ly += (dy / dl) * amt;
        }
        row.push(new THREE.Vector3(f.x + f.rx * lx, f.y - 1.6 + ly, f.z + f.rz * lx));
      }
      return row;
    });
    const vpos: number[] = [], vcol: number[] = [];
    const rockLo = new THREE.Color('#2c374d'), rockHi = new THREE.Color('#56688a'), vein = new THREE.Color('#5fa9d4');
    const warm = new THREE.Color('#ffbf6e'), frost = new THREE.Color('#d9e8f5'), fc = new THREE.Color();
    const cen = new THREE.Vector3();
    const face = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, j: number, k: number) => {
      vpos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      const n = fbm(cen.x / 5 + cen.y / 7, cen.z / 5 - cen.y / 9, vsd + 3, 2);
      fc.copy(rockLo).lerp(rockHi, clamp01(0.5 + n * 0.9 + (k % 3 === 0 ? 0.08 : 0)));
      // ice veins on the walls only: bright facets along the crown read as a skylight
      if ((k < 5 || k > M - 6) && Math.abs(fbm(cen.x / 9, cen.z / 9 + cen.y / 6, vsd + 8, 2) - 0.1) < 0.04) fc.lerp(vein, 0.5);
      else if (k >= 6 && k <= M - 7) fc.multiplyScalar(0.82);   // darker crown: depth and contrast for the lamps
      let lit = 0;
      for (const lp of lampPts) lit = Math.max(lit, Math.exp(-cen.distanceToSquared(lp) / 6));
      fc.lerp(warm, lit * 0.62);
      const edge = Math.min(j, segs - 1 - j);
      if (edge < 2) fc.lerp(frost, 0.45 - edge * 0.18);          // snow blown in at the mouths
      if (k === 0 || k === M - 1) fc.lerp(frost, 0.35);          // drifts along the foot of the walls
      for (let v = 0; v < 3; v++) vcol.push(fc.r, fc.g, fc.b);
    };
    for (let j = 0; j < segs; j++) {
      for (let k = 0; k < M; k++) {
        const a = grid[j]![k]!, b = grid[j]![k + 1]!, c = grid[j + 1]![k]!, d = grid[j + 1]![k + 1]!;
        face(a, b, c, j, k);
        face(b, d, c, j, k);
      }
    }
    const geo = bin.add(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vpos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(vcol, 3));
    geo.computeVertexNormals();
    // the vault is in the shell's shadow: a little self-illumination proportional to the baked colour keeps the lamp
    // pools and ice veins readable (instead of a flat emissive tint that read as open sky)
    const vaultMat = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.42 }));
    vaultMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
    };
    vaultMat.customProgramCacheKey = () => 'snow-tunnel-vault';
    const vault = new THREE.Mesh(geo, vaultMat);
    vault.name = 'tunnel-vault';
    vault.castShadow = true;
    vault.receiveShadow = true;
    root.add(vault);
    // lamps + wall light strips
    for (let j = 0; j <= segs; j += 3) {
      const { f, W, H } = frames[j]!;
      for (const th of [Math.PI * 0.3, Math.PI * 0.7]) {
        const [cx, cy] = archPt(th, W, H);
        glow.add(sh.box(), '#ffe2a8', m4.multiplyMatrices(sideMatrix(f, f.y - 1.6, m4b), trs(cx * 0.96, cy - 0.35, 0, 0, 0.5, 0.18, 1.2, 0, -Math.cos(th) * 0.9)));
      }
      for (const sx of [-1, 1]) {
        const [wx] = archPt(sx > 0 ? 0.25 : Math.PI - 0.25, W, H);
        glow.add(sh.box(), j % 2 ? '#7fe0ff' : '#ffd23f', m4.multiplyMatrices(sideMatrix(f, f.y, m4b), trs(wx - sx * 0.35, 1.4, 0, 0, 0.2, 0.35, 3.8)));
      }
    }
    // ribs: arched steel/timber frames every ~6 m (speed readability inside)
    for (let j = 1; j < segs; j += 3) {
      const { f, W, H } = frames[j]!;
      const m = sideMatrix(f, f.y - 1.6, m4b);
      const R = 12;
      for (let k = 0; k < R; k++) {
        const [ax, ay] = archPt((k / R) * Math.PI, W - 0.15, H - 0.15);
        const [bx, by] = archPt(((k + 1) / R) * Math.PI, W - 0.15, H - 0.15);
        const len = Math.hypot(bx - ax, by - ay);
        matte.add(sh.box(), '#4a566e', m4.multiplyMatrices(m, trs((ax + bx) / 2, (ay + by) / 2, 0, 0, len + 0.12, 0.45, 0.8, 0, Math.atan2(by - ay, bx - ax))));
      }
    }
    tunnelShell(l.s, frames, sc);
    // portals
    for (const end of [0, segs]) {
      const { f, W, H } = frames[end]!;
      const shape = new THREE.Shape();
      const T = 2.6;
      const K = 18;
      for (let k = 0; k <= K; k++) {
        const [x, y] = archPt(Math.PI - (k / K) * Math.PI, W + T, H + T);
        if (k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      }
      for (let k = 0; k <= K; k++) {
        const [x, y] = archPt((k / K) * Math.PI, W, H);
        shape.lineTo(x, y);
      }
      const ex = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: true, bevelSize: 0.5, bevelThickness: 0.5, bevelSegments: 1, curveSegments: 4 });
      ex.translate(0, 0, -1.5);
      const pc = vGrad('#72829c', '#aabbd3', 0, H + T);
      matte.add(ex, pc, sideMatrix(f, f.y - 1.6, m4b));
      ex.dispose();
      // keystone + stone blocks + snow cap + icicles
      matte.add(sh.box(), '#9fb0c8', m4.multiplyMatrices(sideMatrix(f, f.y - 1.6, m4b), trs(0, H + T * 0.5, 0, 0, 2.6, T + 0.9, 3.8)));
      for (const sx of [-1, 1]) matte.add(sh.box(), '#56647a', m4.multiplyMatrices(sideMatrix(f, f.y - 1.6, m4b), trs(sx * (W + T * 0.5), 1.2, 0, 0, T + 1.4, 2.4, 4.2)));
      icicleRow(f, f.y - 1.6, -W * 0.8, W * 0.8, x => {
        const th = Math.acos(Math.max(-1, Math.min(1, Math.sign(x) * Math.pow(Math.abs(x) / W, 1 / 0.62))));
        return archPt(th, W, H)[1];
      }, 1.6 + 4.9, W);
      // frosty sign lamps
      for (const sx of [-1, 1]) glow.add(sh.sphere(8, 6), '#bff3ff', m4.multiplyMatrices(sideMatrix(f, f.y - 1.6, m4b), trs(sx * (W + T * 0.5), H * 0.55, -1.9, 0, 0.5, 0.5, 0.5)));
    }
  }

  /** Arch height at lateral |x| for the superellipse vault. */
  function archHeightAt(ax: number, W: number, H: number): number {
    if (ax >= W) return 0;
    const c = Math.pow(ax / W, 1 / 0.62);
    return H * Math.pow(Math.sqrt(Math.max(0, 1 - c * c)), 0.85);
  }

  /** Per-triangle colours for a non-indexed geometry (crisp low-poly facets). */
  function facetPaint(g: THREE.BufferGeometry, fn: (cx: number, cy: number, cz: number, ny: number, out: THREE.Color) => void): void {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3(), out = new THREE.Color();
    for (let t = 0; t + 2 < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2);
      n.subVectors(b, a).cross(e.subVectors(c, a)).normalize();
      if (n.y < 0) n.negate();
      fn((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, n.y, out);
      for (let v = 0; v < 3; v++) { col[(t + v) * 3] = out.r; col[(t + v) * 3 + 1] = out.g; col[(t + v) * 3 + 2] = out.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  /**
   * Mountain shoulder the tunnel bores through: a continuous faceted rock shell over the vault that meets the terrain
   * on both sides, closed at each end by a rock face with the arch opening. Snow settles on the gentle facets.
   */
  function tunnelShell(s0: number, frames: Array<{ f: TrackFrame; W: number; H: number }>, sc: number): void {
    const segs = frames.length - 1;
    const E = 24 * sc;
    // how far the shell may spread sideways before it would bury another part of the course
    const reach = (side: -1 | 1) => frames.map(({ f, W }) => {
      for (let t = 4; t <= E; t += 2) {
        if (terrain.inCorridor(f.x + f.rx * side * (W + t), f.z + f.rz * side * (W + t), 3)) return Math.max(5, t - 5);
      }
      return E;
    });
    const smoothA = (a: number[]) => a.map((_, j) => {
      let s = 0, c = 0;
      for (let k = -3; k <= 3; k++) { const v = a[j + k]; if (v !== undefined) { s += v; c++; } }
      return s / c;
    });
    const eL = smoothA(reach(-1)), eR = smoothA(reach(1));
    const K = 30;
    const sd = track.def.scenerySeed + 77;
    const topH = frames.reduce((m, fr) => Math.max(m, fr.H), 0) + 6 * sc;
    // local (x, y) profile at frame j; y relative to the vault base (road − 1.6)
    const profile = (j: number): Array<[number, number]> => {
      const { f, W, H } = frames[j]!;
      const y0 = f.y - 1.6;
      const pts: Array<[number, number]> = [];
      for (let k = 0; k <= K; k++) {
        const u = (k / K) * 2 - 1;
        const X = W + (u < 0 ? eL[j]! : eR[j]!);
        const x = u * X;
        const wx = f.x + f.rx * x, wz = f.z + f.rz * x;
        const a = Math.abs(u);
        const gEdge = terrain.heightAt(wx, wz) - y0 - 1.2;
        const endLift = 1 + 0.12 * (1 - Math.min(j, segs - j) / Math.max(1, segs / 2));
        let y = topH * endLift + (gEdge - topH * endLift) * Math.pow(smoothstep(0.2, 1, a), 0.9);
        y += (fbm(wx / 11, wz / 11, sd, 2) * 3.4 + fbm(wx / 4.5, wz / 4.5, sd + 5, 2) * 1.3) * sc * (1 - a * a);
        if (Math.abs(x) < W + 1.6) y = Math.max(y, archHeightAt(Math.abs(x), W, H) + 2.4);
        if (a >= 0.999) y = gEdge;
        pts.push([x, y]);
      }
      return pts;
    };
    const profiles = frames.map((_, j) => profile(j));
    // shell surface (world space)
    const pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const { f } = frames[j]!;
      const y0 = f.y - 1.6;
      for (const [x, y] of profiles[j]!) pos.push(f.x + f.rx * x, y0 + y, f.z + f.rz * x);
    }
    for (let j = 0; j < segs; j++) {
      for (let k = 0; k < K; k++) {
        const a = j * (K + 1) + k, b = a + K + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const shell0 = new THREE.BufferGeometry();
    shell0.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    shell0.setIndex(idx);
    const shell = shell0.toNonIndexed();
    shell0.dispose();
    shell.computeVertexNormals();
    // make sure faces point outward (up): flip winding if the first facet points down
    {
      const n = shell.getAttribute('normal') as THREE.BufferAttribute;
      let up = 0;
      for (let v = 0; v < n.count; v += 3) up += n.getY(v);
      if (up < 0) {
        const p = shell.getAttribute('position') as THREE.BufferAttribute;
        for (let v = 0; v + 2 < p.count; v += 3) {
          const x = p.getX(v + 1), y = p.getY(v + 1), z = p.getZ(v + 1);
          p.setXYZ(v + 1, p.getX(v + 2), p.getY(v + 2), p.getZ(v + 2));
          p.setXYZ(v + 2, x, y, z);
        }
        shell.computeVertexNormals();
      }
    }
    const baseY = frames[Math.floor(segs / 2)]!.f.y - 1.6;
    const rockA = new THREE.Color('#7686a0'), rockB = new THREE.Color('#aab9cf'), snowC = new THREE.Color(C.snow), snowS = new THREE.Color('#dde9f4'), iceC = new THREE.Color('#a6dcf6');
    const paintRock = (cx: number, cy: number, cz: number, ny: number, out: THREE.Color) => {
      const n = fbm(cx / 7, cz / 7, sd + 3, 2);
      const streak = Math.sin(cx * 0.9 + cz * 0.7 + n * 4) > 0.55;
      const h = (cy - baseY) / topH;
      if (ny > 0.5 - n * 0.25 || h > 0.97 || (streak && ny > 0.25)) out.copy(ny > 0.8 ? snowC : snowS);
      else {
        out.copy(rockA).lerp(rockB, clamp01(0.5 + n * 0.9));
        if (n > 0.38) out.lerp(iceC, 0.45);
      }
    };
    facetPaint(shell, paintRock);
    matte.add(shell, null);
    shell.dispose();
    // end faces with the arch opening (thin extruded slabs so both sides render)
    for (const end of [0, segs]) {
      const { f, W, H } = frames[end]!;
      const prof = profiles[end]!;
      const shape = new THREE.Shape();
      shape.moveTo(prof[0]![0], -3);
      for (const [x, y] of prof) shape.lineTo(x, y);
      shape.lineTo(prof[prof.length - 1]![0], -3);
      shape.closePath();
      const hole = new THREE.Path();
      const M = 18;
      for (let k = 0; k <= M; k++) {
        const [x, y] = archPt((k / M) * Math.PI, W, H);
        if (k === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
      }
      hole.lineTo(-W, -0.6);
      hole.lineTo(W, -0.6);
      hole.closePath();
      shape.holes.push(hole);
      const ex = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false, curveSegments: 1 });
      // entrance slab sits just inside (−Z = forward), exit slab just inside the other way
      ex.translate(0, 0, end === 0 ? -1.2 : -0.6);
      const g = ex.index ? ex.toNonIndexed() : ex;
      if (g !== ex) ex.dispose();
      g.computeVertexNormals();
      g.applyMatrix4(sideMatrix(f, f.y - 1.6, m4b));
      // snowy cliff: mostly packed snow with rock bands (it usually faces away from the sun)
      const cliffRock = new THREE.Color('#8e9db5'), cliffSnow = new THREE.Color('#eef5fb');
      facetPaint(g, (cx, cy, cz, _ny, out) => {
        const n = fbm(cx / 6, cy / 4 + cz / 6, sd + 9, 2);
        out.copy(n > 0.12 ? cliffRock : cliffSnow);
        if (cy - baseY > topH * 0.86) out.copy(snowC);
      });
      matte.add(g, null);
      g.dispose();
      // half-buried boulders + ice lumps break up the face (kept clear of the opening)
      const prof0 = profiles[end]!;
      const Xmax = Math.min(Math.abs(prof0[0]![0]), Math.abs(prof0[prof0.length - 1]![0]));
      for (let k = 0; k < 10; k++) {
        const sx = k % 2 ? 1 : -1;
        const lx = sx * rng.range(W + 4, Math.max(W + 5, Xmax * 0.85));
        const kk = Math.round(((lx / (sx > 0 ? Math.abs(prof0[prof0.length - 1]![0]) : Math.abs(prof0[0]![0]))) * sx * 0.5 + 0.5) * K);
        const yTop = prof0[Math.max(0, Math.min(K, kk))]![1];
        if (yTop < 3) continue;
        const ly = rng.range(1, yTop - 1.5);
        const R = rng.range(1.8, 3.6) * sc;
        const wp = new THREE.Vector3(lx, ly, 0).applyMatrix4(sideMatrix(f, f.y - 1.6, m4b));
        const gb = lumpy(sh.dodeca(), rng, 0.3);
        matte.add(gb, k % 3 ? snowRock : ((_x: number, y: number, _z: number, o: THREE.Color) => { o.set('#bfe6fb').lerp(new THREE.Color('#ffffff'), clamp01(y + 0.5)); }) as ColorFn,
          trs(wp.x, wp.y, wp.z, rng.range(0, 6), R, R * rng.range(0.7, 1), R));
        gb.dispose();
      }
      // boulders flanking the portal + a snow drift at its foot
      for (const sx of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const R = rng.range(1.6, 3.4) * sc;
          const lx = sx * (W + 3.4 + k * 2.6 + rng.range(0, 1.5));
          const lz = (end === 0 ? 1 : -1) * rng.range(1.2, 3.5);
          const wp = new THREE.Vector3(lx, 0, lz).applyMatrix4(sideMatrix(f, 0, m4b));
          if (terrain.inCorridor(wp.x, wp.z, 1.5)) continue;
          const gb = lumpy(sh.dodeca(), rng, 0.3, true);
          matte.add(gb, snowRock, trs(wp.x, ground(wp.x, wp.z) + R * 0.35, wp.z, rng.range(0, 6), R, R * rng.range(0.7, 1.1), R));
          gb.dispose();
        }
      }
    }
    // rocky crags crowning the spur so it reads as a mountain shoulder from afar
    {
      const mid = Math.floor(segs / 2);
      for (const [jf, kf, hs] of [[0.35, 0.22, 1], [0.62, 0.8, 0.8], [0.5, 0.5, 0.55]] as const) {
        const j = Math.round(segs * jf), k = Math.round(K * kf);
        const { f } = frames[j]!;
        const [x, y] = profiles[j]![k]!;
        const wx = f.x + f.rx * x, wz = f.z + f.rz * x;
        const Hc = (10 + rng.range(0, 5)) * sc * hs;
        const g = mountainGeometry(rng, 12, 5, 0.4);
        const ph = rng.range(0, 6);
        matte.add(g, (lx, ly, lz, out) => {
          const a = Math.atan2(lz, lx);
          out.copy(rockA).lerp(rockB, clamp01(ly * 1.2 + Math.sin(a * 5 + ph) * 0.2));
          if (ly > 0.62 + Math.sin(a * 7 + ph) * 0.1 || ly < 0.12) out.copy(snowC);
        }, trs(wx, f.y - 1.6 + y - 3, wz, rng.range(0, 6), Hc * 0.62, Hc, Hc * 0.55));
        g.dispose();
      }
      void mid;
    }
    // a few firs and rocks perched on the shoulder
    for (let t = 0; t < 26 * sc; t++) {
      const j = rng.int(1, segs);
      const k = rng.chance(0.5) ? rng.int(1, Math.floor(K * 0.3)) : rng.int(Math.ceil(K * 0.7), K - 1);
      const { f } = frames[j]!;
      const [x, y] = profiles[j]![k]!;
      const wx = f.x + f.rx * x, wz = f.z + f.rz * x;
      if (terrain.inCorridor(wx, wz, 2.5)) continue;
      firs.push({ x: wx, y: f.y - 1.6 + y - 0.4, z: wz, ry: rng.range(0, 6), s: rng.range(0.7, 1.2), tint: jitterTint(rng, 0.1) });
    }
    void s0;
  }

  /** Half-span of an ice arch over the road: its feet (ice pillar r = 3·sc, drift, crystals) stand outside the widest
   *  barrier within ±4 m, so none of it reaches the drivable verge. */
  function overArchHalf(i: number, sc: number): number {
    let cw = 0;
    for (let k = -4; k <= 4; k++) cw = Math.max(cw, corridorHalf(track, wrapIndex(track, i + k)));
    return cw + 3.0 * sc + 0.5;
  }

  function iceArch(f: TrackFrame, y: number, W: number, sc: number, over: boolean): void {
    const Hs = over ? 0.72 : 0.9;
    const tube = (over ? 2.0 : 1.4) * sc;
    const g0 = new THREE.TorusGeometry(W, tube, 6, 22, Math.PI);
    const g = lumpy(g0, rng, 0.08);
    g0.dispose();
    const m = sideMatrix(f, y, m4b);
    const col: ColorFn = (lx, ly, _lz, out) => { out.set(C.ice).lerp(new THREE.Color('#ffffff'), clamp01(ly / W * 0.7 + Math.sin(lx * 0.8) * 0.15)); };
    ice.add(g, col, m4.multiplyMatrices(m, trs(0, 0, 0, 0, 1, Hs, 1)));
    g.dispose();
    for (const sx of [-1, 1]) {
      ice.add(sh.cyl(7, 0.8), vGrad(C.iceDeep, C.ice, 0, 1), m4.multiplyMatrices(m, trs(sx * W, -1.5, 0, 0.3, tube * 1.5, 3, tube * 1.5)));
      const cp = new THREE.Vector3(sx * W, 0, 0).applyMatrix4(m);
      crystals(cp.x, cp.y, cp.z, 1.1 * sc, 7);
      // over the road the drift at the foot stays within the foot's own footprint (outside the barrier)
      const dr = tube * (over ? 1.5 : 2.4);
      matte.add(sh.dome(9, 4), C.snow, m4.multiplyMatrices(m, trs(sx * W, -0.4, 0, 0, dr, 1.2, dr)));
    }
    // snow on top of the arch and icicles below
    for (let k = 0; k < 7; k++) {
      const th = Math.PI * (0.3 + k * 0.066);
      matte.add(sh.sphere(8, 5), C.snow, m4.multiplyMatrices(m, trs(Math.cos(th) * W, Math.sin(th) * W * Hs + tube * Hs * 0.7, 0, 0, tube * 1.3, tube * 0.45, tube * 1.05)));
    }
    for (let k = 0; k < 16; k++) {
      const th = 0.3 + (k / 15) * (Math.PI - 0.6);
      const L = rng.range(0.7, 2.4) * sc;
      ice.add(sh.cone(5), '#dff5ff', m4.multiplyMatrices(m, trs(Math.cos(th) * W, Math.sin(th) * W * Hs - tube * Hs * 0.8, rng.range(-0.8, 0.8), 0, 0.26 * sc, L, 0.26 * sc, Math.PI)));
    }
    for (let k = 0; k < 3; k++) {
      const th = Math.PI * (0.35 + k * 0.15);
      const cp = new THREE.Vector3(Math.cos(th) * W, Math.sin(th) * W * Hs + tube * Hs, 0).applyMatrix4(m);
      crystals(cp.x, cp.y, cp.z, 0.8 * sc, 3);
    }
  }

  /** Lift tower cross-arm with sheave wheels at both cable lines (px, pz = unit perpendicular). */
  function liftHead(x: number, y: number, z: number, px: number, pz: number): void {
    const armYaw = Math.atan2(px, pz);
    satin.add(sh.box(), '#e63946', trs(x, y, z, armYaw, 0.5, 0.4, 6.2));
    satin.add(sh.box(), '#b42b36', trs(x, y + 0.45, z, armYaw, 0.3, 0.5, 1.2));
    for (const s of [-1, 1]) {
      const wx = x + px * 2.6 * s, wz = z + pz * 2.6 * s;
      // wheel axis along the arm → torus (axis Z) yawed onto the arm direction
      satin.add(sh.torus(1, 0.3, 5, 12), '#2b2f3a', trs(wx, y - 0.25, wz, armYaw, 0.42, 0.42, 0.42));
      satin.add(sh.box(), '#ffd23f', trs(wx, y - 0.1, wz, armYaw, 0.9, 0.2, 0.25));
    }
    glow.add(sh.sphere(6, 4), '#ffe9b0', trs(x, y + 0.85, z, 0, 0.2, 0.2, 0.2));
  }
  function liftTower(x: number, g: number, z: number, H: number, _yaw: number, px: number, pz: number): void {
    satin.add(sh.cyl(8, 0.75), C.steel, trs(x, g - 0.5, z, 0, 0.5, H + 0.5, 0.5));
    satin.add(sh.cyl(8), '#6d7688', trs(x, g - 0.3, z, 0, 0.8, 1.0, 0.8));
    // ladder rungs
    for (let yy = 1.5; yy < H - 1; yy += 1.1) satin.add(sh.box(), '#6d7688', trs(x + px * 0.55, g + yy, z + pz * 0.55, Math.atan2(px, pz), 0.08, 0.08, 0.6));
    liftHead(x, g + H, z, px, pz);
    matte.add(sh.dome(8, 4), C.snow, trs(x, g, z, 0, 1.6, 0.55, 1.6));
  }

  function skiLift(bx: number, bz: number, dirX: number, dirZ: number, len: number, crossing = false): boolean {
    // shorten until the line is clear of every corridor (a crossing lift spans the road instead)
    const px0 = -dirZ, pz0 = dirX;
    let L = len;
    if (crossing) {
      bx -= dirX * len / 2; bz -= dirZ * len / 2;
      // a crossing lift spans its own road (and neighbouring roads at a similar level) but ends before a section far
      // above or below it — hopping a cliff-ledge road from the valley floor took 50 m pylons
      const roadOn = (tt: number) => {
        let r = -Infinity;
        for (const off of [-3.8, 0, 3.8]) r = Math.max(r, guard.surfaceAt(bx + dirX * tt + px0 * off, bz + dirZ * tt + pz0 * off));
        return r;
      };
      let own = -Infinity;
      for (let u = -6; u <= 6 && own === -Infinity; u += 1) own = roadOn(len / 2 + u);
      let t0 = 0, t1 = len;
      if (own > -Infinity) {
        for (let tt = len / 2; tt <= len; tt += 1) { const r = roadOn(tt); if (r > -Infinity && Math.abs(r - own) > 6) { t1 = tt - 12; break; } }
        for (let tt = len / 2; tt >= 0; tt -= 1) { const r = roadOn(tt); if (r > -Infinity && Math.abs(r - own) > 6) { t0 = tt + 12; break; } }
      }
      bx += dirX * t0; bz += dirZ * t0;
      L = t1 - t0;
    } else {
      for (let t = 8; t <= len; t += 4) {
        if (terrain.inCorridor(bx + dirX * t, bz + dirZ * t, 6) || terrain.inCorridor(bx + dirX * t - dirZ * 3, bz + dirZ * t + dirX * 3, 6)) { L = t - 10; break; }
      }
    }
    if (L < 50) return false;
    const yaw = Math.atan2(dirX, dirZ);
    const px = -dirZ, pz = dirX; // perpendicular (cable offset)
    const towers = Math.max(3, Math.round(L / 26));
    // tower feet: evenly spaced; a crossing lift instead puts a tower just outside each road it spans (both sides)
    // and fills the gaps between, so no pole stands where karts drive and every span over a road is short
    const feet: Array<{ t: number; x: number; z: number; g: number; H: number; station: boolean }> = [];
    const addFoot = (t: number, station: boolean, k: number) => {
      const x = bx + dirX * t, z = bz + dirZ * t;
      feet.push({ t, x, z, g: ground(x, z), H: station ? 5.5 : 9 + (k % 2) * 1.5, station });
    };
    if (!crossing) {
      for (let k = 0; k <= towers; k++) addFoot((k / towers) * L, k === 0 || k === towers, k);
    } else {
      const clearAt = (tt: number) => !terrain.inCorridor(bx + dirX * tt, bz + dirZ * tt, 3.5);
      const flank: number[] = [];
      let prev = clearAt(0);
      for (let tt = 0.5; tt <= L; tt += 0.5) {
        const c = clearAt(tt);
        if (c !== prev) flank.push(c ? tt : tt - 0.5);   // last clear spot before / first clear spot after a road
        prev = c;
      }
      const ts = [0, ...flank.filter(tt => tt > 8 && tt < L - 8), L].sort((a, b) => a - b);
      const picked: number[] = [];
      for (const tt of ts) if (!picked.length || tt - picked[picked.length - 1]! >= 7 || tt === L) picked.push(tt);
      if (picked.length > 2 && picked[picked.length - 1]! - picked[picked.length - 2]! < 7) picked.splice(picked.length - 2, 1);
      let k = 0;
      for (let q = 0; q < picked.length; q++) {
        const a = picked[q]!;
        addFoot(a, q === 0 || q === picked.length - 1, k++);
        const b = picked[q + 1];
        if (b === undefined || !clearAt((a + b) / 2)) continue;
        const fill = Math.floor((b - a) / 30);
        for (let j = 1; j <= fill; j++) addFoot(a + ((b - a) * j) / (fill + 1), false, k++);
      }
    }
    if (crossing) {
      // Cable height from the ROAD surface below (the terrain is dragged down by lower switchbacks and falls away beside
      // the cliff-ledge pit, so it badly under-reads where karts drive): the chairs (≈3.5 m below the rope, rope sag
      // 0.9 m) and their riders keep more than 5 m of air above every road they pass over, across both rope lines.
      const CLEAR = 3.6 + 5.4;
      for (let pass = 0; pass < 6; pass++) {
        for (let k = 0; k + 1 < feet.length; k++) {
          const a = feet[k]!, b = feet[k + 1]!;
          const ya = a.g + a.H, yb = b.g + b.H;
          let deficit = 0, wAt = 0.5;
          const seg = b.t - a.t;
          for (let u = 0; u <= seg; u += 1) {
            const tt = u / seg;
            const cx = a.x + (b.x - a.x) * tt, cz = a.z + (b.z - a.z) * tt;
            let road = -Infinity;
            for (const off of [-3.8, 0, 3.8]) road = Math.max(road, guard.surfaceAt(cx + px * off, cz + pz * off));
            if (road === -Infinity) continue;
            const cable = ya + (yb - ya) * tt - Math.sin(tt * Math.PI) * 0.9;
            const need = road + CLEAR - cable;
            if (need > deficit) { deficit = need; wAt = tt; }
          }
          if (deficit <= 0) continue;
          // lift the tower ends in proportion to how close the low point is to each (least lift for the rope to
          // clear it); stations keep their height and the other end takes the whole correction
          const wa = 1 - wAt, wb = wAt, nrm = wa * wa + wb * wb;
          const la = a.station ? 0 : b.station ? deficit / Math.max(0.15, wa) : deficit * wa / nrm;
          const lb = b.station ? 0 : a.station ? deficit / Math.max(0.15, wb) : deficit * wb / nrm;
          a.H += la + 0.05; b.H += lb + 0.05;
        }
      }
    }
    const tops: THREE.Vector3[] = [];
    for (const ft of feet) {
      if (!ft.station) liftTower(ft.x, ft.g, ft.z, ft.H, yaw, px, pz);
      tops.push(new THREE.Vector3(ft.x, ft.g + ft.H, ft.z));
    }
    // stations with bull wheels
    for (const end of [0, tops.length - 1]) {
      const p = tops[end]!;
      cabin(p.x - dirX * (end ? -4 : 4), ground(p.x, p.z), p.z - dirZ * (end ? -4 : 4), yaw + (end ? 0 : Math.PI), 0.75, '#1f6feb');
      satin.add(sh.torus(1, 0.12, 6, 24), '#ffd23f', trs(p.x, p.y, p.z, 0, 2.6, 2.6, 2.6, Math.PI / 2));
      satin.add(sh.cyl(8), C.steel, trs(p.x, p.y - 5.5, p.z, 0, 0.35, 5.5, 0.35));
    }
    // cables (two lines) as tubes
    const lines: THREE.Vector3[][] = [[], []];
    for (const p of tops) {
      lines[0]!.push(new THREE.Vector3(p.x + px * 2.6, p.y, p.z + pz * 2.6));
      lines[1]!.push(new THREE.Vector3(p.x - px * 2.6, p.y, p.z - pz * 2.6));
    }
    for (const ln of lines) {
      // gentle catenary sag between towers
      const sagged: THREE.Vector3[] = [];
      for (let k = 0; k + 1 < ln.length; k++) {
        const a = ln[k]!, b = ln[k + 1]!;
        for (let t = 0; t < 1; t += 0.25) sagged.push(new THREE.Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * 0.9));
      }
      sagged.push(ln[ln.length - 1]!.clone());
      const tube = tubeAlong(sagged, 0.12, 5, 2);
      satin.add(tube, '#1f232c');
      tube.dispose();
    }
    // moving chairs
    const loop: THREE.Vector3[] = [...lines[0]!, ...[...lines[1]!].reverse()];
    const cum: number[] = [0];
    for (let k = 1; k <= loop.length; k++) cum.push(cum[k - 1]! + loop[k % loop.length]!.distanceTo(loop[k - 1]!));
    const total = cum[cum.length - 1]!;
    const nChairs = Math.max(6, Math.floor(total / 11));
    // chair (seat/back tinted per instance; dark frame parts stay dark)
    const chair = new GeoBatch();
    chair.add(sh.box(), '#2b2f3a', trs(0, 0.05, 0, 0, 0.35, 0.3, 0.5));
    chair.add(sh.cyl(4), '#3a3f4a', trs(0, -1.55, -0.35, 0, 0.06, 1.6, 0.06));
    chair.add(sh.box(), '#3a3f4a', trs(0, -1.55, -0.35, 0, 1.7, 0.1, 0.1));
    for (const sx of [-1, 1]) chair.add(sh.box(), '#3a3f4a', trs(sx * 0.82, -2.0, -0.05, 0, 0.08, 0.9, 0.08));
    chair.add(sh.box(), '#ffffff', trs(0, -2.25, 0.08, 0, 1.6, 0.18, 0.8));
    chair.add(sh.box(), '#ffffff', trs(0, -1.9, -0.32, 0, 1.6, 0.7, 0.14));
    chair.add(sh.box(), '#e8ecf2', trs(0, -1.6, 0.5, 0, 1.64, 0.08, 0.08));
    chair.add(sh.box(), '#3a3f4a', trs(0, -2.75, 0.62, 0, 1.3, 0.06, 0.25));
    const cg = chair.geometry()!;
    bin.add(cg);
    const chairs = new THREE.InstancedMesh(cg, mats.satin, nChairs);
    chairs.name = 'lift-chairs';
    chairs.castShadow = true;
    const tint = new THREE.Color();
    for (let k = 0; k < nChairs; k++) chairs.setColorAt(k, tint.set(C.chairs[k % C.chairs.length]!));
    chairs.frustumCulled = false;
    root.add(chairs);
    // penguin passengers on every third chair
    const pg = new GeoBatch();
    pg.add(sh.sphere(10, 7), '#23252e', trs(0, -1.72, 0.02, 0, 0.42, 0.52, 0.38));
    pg.add(sh.sphere(10, 7), '#f7f7f2', trs(0, -1.8, 0.2, 0, 0.3, 0.4, 0.24));
    pg.add(sh.sphere(10, 7), '#23252e', trs(0, -1.08, 0.04, 0, 0.3, 0.28, 0.3));
    pg.add(sh.cone(6), '#ff9f1c', trs(0, -1.12, 0.3, 0, 0.07, 0.2, 0.07, Math.PI / 2));
    for (const sx of [-1, 1]) pg.add(sh.sphere(6, 4), '#ffffff', trs(sx * 0.11, -1.02, 0.28, 0, 0.06, 0.07, 0.03));
    pg.add(sh.dome(10, 5), '#e63946', trs(0, -0.96, 0.03, 0, 0.3, 0.24, 0.3));
    pg.add(sh.sphere(6, 4), '#ffffff', trs(0, -0.72, 0.03, 0, 0.1, 0.1, 0.1));
    pg.add(sh.torus(1, 0.35, 5, 12), '#1f6feb', trs(0, -1.3, 0.04, 0, 0.3, 0.3, 0.3, Math.PI / 2));
    for (const sx of [-1, 1]) pg.add(sh.sphere(6, 4), '#ff9f1c', trs(sx * 0.16, -2.35, 0.6, 0, 0.12, 0.06, 0.18));
    const pgGeo = pg.geometry()!;
    bin.add(pgGeo);
    const riders = Math.ceil(nChairs / 3);
    const pens = new THREE.InstancedMesh(pgGeo, mats.satin, riders);
    pens.name = 'lift-penguins';
    pens.castShadow = true;
    pens.frustumCulled = false;
    root.add(pens);
    const pA = new THREE.Vector3(), mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), ss = new THREE.Vector3(1.25, 1.25, 1.25), yAxis = new THREE.Vector3(0, 1, 0);
    const place = (time: number) => {
      for (let k = 0; k < nChairs; k++) {
        const u = (time * 2.2 + (k / nChairs) * total) % total;
        let seg = 0;
        while (seg < loop.length - 1 && cum[seg + 1]! < u) seg++;
        const a = loop[seg]!, b = loop[(seg + 1) % loop.length]!;
        const t = (u - cum[seg]!) / Math.max(1e-3, cum[seg + 1]! - cum[seg]!);
        pA.lerpVectors(a, b, t);
        pA.y -= Math.sin(t * Math.PI) * 0.9;
        const hdg = Math.atan2(b.x - a.x, b.z - a.z);
        qq.setFromAxisAngle(yAxis, hdg + Math.sin(time * 1.3 + k) * 0.05);
        mm.compose(pA, qq, ss);
        chairs.setMatrixAt(k, mm);
        if (k % 3 === 0) pens.setMatrixAt(k / 3, mm);
      }
      chairs.instanceMatrix.needsUpdate = true;
      pens.instanceMatrix.needsUpdate = true;
    };
    place(0);
    updaters.push((_dt, time) => place(time));
    return true;
  }

  function landmark(l: LandmarkDef & { s: number }): void {
    if (SKIP.has(l.kind)) return;
    const p = landmarkPose(track, l);
    const f = p.frame;
    const sc = p.scale;
    const gy = p.over ? f.y : ground(f.x, f.z);
    const k = l.kind.toLowerCase();
    lmHandled.add(k);
    if (k === 'tunnel') { tunnel(l); return; }
    if (k.includes('ice') && k.includes('arch') || k === 'icearch' || k === 'ice-gate') {
      if (p.over) iceArch(f, f.y, overArchHalf(f.i, sc), sc, true);
      else iceArch(f, gy, 7 * sc, sc, false);
      return;
    }
    if (k.includes('lift') || k.includes('gondola')) {
      if (p.over) { skiLift(f.x, f.z, f.rx, f.rz, 190 * sc, true); return; }
      const sx = Math.sign(p.d) || 1;
      skiLift(f.x, f.z, sx * f.rx, sx * f.rz, 150 * sc);
      return;
    }
    if (k === 'cabin' || k === 'lodge' || k === 'chalet' || k === 'hut' || k === 'house') { cabin(f.x, gy - 0.2, f.z, p.yaw, 1.4 * sc); return; }
    if (k.includes('snowman')) { snowman(f.x, gy, f.z, p.yaw, 1.6 * sc, '#2b2b35'); return; }
    if (k === 'peak' || k === 'mountain' || k === 'summit' || k === 'volcano') { peak(f.x, gy - 8, f.z, 70 * sc, rng, matte); return; }
    if (k.includes('pine') || k.includes('forest') || k.includes('tree')) {
      for (let j = 0; j < 40 * sc; j++) {
        const a = rng.range(0, 6.28), r = rng.range(0, 26 * sc);
        const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r;
        if (terrain.inCorridor(x, z, 4) || !dryLand(x, z)) continue;
        (j % 3 ? pines : firs).push({ x, y: ground(x, z) - 0.2, z, ry: rng.range(0, 6.28), s: rng.range(0.8, 1.5), tint: jitterTint(rng, 0.1) });
      }
      return;
    }
    if (k === 'igloo') { igloo(f.x, gy, f.z, p.yaw, sc); return; }
    if (k.includes('crystal') || k.includes('icicle')) { crystals(f.x, gy, f.z, 2 * sc, 9); return; }
    // themed fallback
    if (p.over) { iceArch(f, f.y, overArchHalf(f.i, sc), sc, true); return; }
    igloo(f.x, gy, f.z, p.yaw, sc);
    crystals(f.x + 6 * sc, gy, f.z - 3 * sc, 1.3 * sc, 6);
    snowman(f.x - 6 * sc, gy, f.z + 3 * sc, p.yaw, 1.2 * sc, '#1f6feb');
  }

  function igloo(x: number, y: number, z: number, yaw: number, s: number): void {
    trsTo(m4b, x, y, z, yaw, s);
    const put = (b: GeoBatch, g: THREE.BufferGeometry, col: string | ColorFn, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) => {
      b.add(g, col, m4.multiplyMatrices(m4b, trs(lx, ly, lz, ry, sx, sy, sz, rx, rz)));
    };
    const blocks: ColorFn = (lx, ly, lz, out) => {
      const row = Math.floor(ly * 3.2);
      const a = Math.atan2(lz, lx) * 3 + row * 0.5;
      const line = Math.abs(Math.sin(ly * 3.2 * Math.PI)) < 0.12 || Math.abs(Math.sin(a * 2)) < 0.07;
      out.set(line ? '#bcd5ea' : '#f4faff');
    };
    put(matte, sh.dome(16, 8), blocks, 0, -0.1, 0, 3.4, 2.9, 3.4);
    put(matte, sh.cyl(10, 1, false), '#e8f2fb', 0, 1.0, 3.2, 1.3, 2.0, 1.1, 0, Math.PI / 2);
    put(glow, sh.box(), '#ffb85c', 0, 0.9, 4.25, 1.4, 1.3, 0.1);
  }

  for (const l of track.landmarks) landmark(l);

  return finish();

  // ───────── assembled in part 2 ─────────
  function finish(): SceneryHandle {
    return assemble({
      ctx, root, bin, sh, rng, mats, iceMat, terrain, stats, base, iceLevel,
      matte, satin, glow, ice, smokeAt, updaters, pines, firs, rocks, lmHandled,
      cabin, snowman, crystals, iceArch, skiLift, igloo, peak, dryLand, ground,
    });
  }
}

interface SnowParts {
  ctx: SceneryContext; root: THREE.Group; bin: Bin; sh: Shapes; rng: Rng;
  mats: ReturnType<typeof createBatchMaterials>; iceMat: THREE.MeshStandardMaterial;
  terrain: Terrain; stats: ReturnType<typeof trackStats>; base: number; iceLevel: number;
  matte: GeoBatch; satin: GeoBatch; glow: GeoBatch; ice: GeoBatch;
  smokeAt: Array<{ x: number; y: number; z: number }>;
  updaters: Array<(dt: number, time: number) => void>;
  pines: Placement[]; firs: Placement[]; rocks: Placement[];
  lmHandled: Set<string>;
  cabin(x: number, y: number, z: number, yaw: number, s: number, roof?: string): void;
  snowman(x: number, y: number, z: number, yaw: number, s: number, hat: string): void;
  crystals(x: number, y: number, z: number, s: number, count?: number): void;
  iceArch(f: TrackFrame, y: number, W: number, sc: number, over: boolean): void;
  skiLift(bx: number, bz: number, dirX: number, dirZ: number, len: number): boolean;
  igloo(x: number, y: number, z: number, yaw: number, s: number): void;
  peak(x: number, y: number, z: number, s: number, r: Rng, into: GeoBatch, haze?: THREE.Color): void;
  dryLand(x: number, z: number): boolean;
  ground(x: number, z: number): number;
}

function pineGeometry(sh: Shapes, tiers: number, slender: number, snowy: number): THREE.BufferGeometry {
  const b = new GeoBatch();
  b.add(sh.cyl(6), C.bark, trs(0, -0.4, 0, 0, 0.34, 2.0, 0.34));
  for (let k = 0; k < tiers; k++) {
    const r = (2.6 - k * (1.7 / tiers)) * slender;
    const h = 2.7 - k * 0.12;
    const y = 1.1 + k * 1.5;
    b.add(sh.cone(9), vGrad(C.pine, C.pineHi, 0, 1), trs(0, y, 0, k * 0.6, r, h, r));
    b.add(sh.cone(9), vGrad(C.snowShade, C.snow, 0, 1), trs(0, y + h * (0.46 - snowy * 0.1), 0, k * 0.6 + 0.35, r * (0.62 + snowy * 0.08), h * 0.58, r * (0.62 + snowy * 0.08)));
  }
  return b.geometry()!;
}

function assemble(P: SnowParts): SceneryHandle {
  const { ctx, root, bin, sh, rng, mats, terrain, stats, base } = P;
  const { track, quality } = ctx;
  const q = quality.scenery;
  const seed = track.def.scenerySeed;
  const facing = (x: number, z: number) => {
    const n = terrain.nearestTrack(x, z);
    return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z);
  };

  // ───────── auto features (independent of authored landmarks) ─────────
  const spots = scatter(terrain, Math.round(90 * Math.max(q, 0.5)), seed + 41, { minDist: 26, maxDist: 95, pad: 9 });
  let cabins = 0, men = 0, arches = 0, igloos = 0, crystalsN = 0;
  for (const p of spots) {
    if (!P.dryLand(p.x, p.z) || !clearOfRoad(terrain, p.x, p.z, 7)) continue;
    const yaw = facing(p.x, p.z);
    if (cabins < 5) { P.cabin(p.x, p.y - 0.2, p.z, yaw, rng.range(0.95, 1.2), rng.chance(0.3) ? '#1f6feb' : '#c8423b'); cabins++; continue; }
    if (igloos < 2) { P.igloo(p.x, p.y - 0.1, p.z, yaw, rng.range(0.9, 1.2)); igloos++; continue; }
    if (arches < 2) {
      P.iceArch({ x: p.x, y: p.y, z: p.z, i: 0, yaw, fx: Math.sin(yaw + Math.PI / 2), fz: Math.cos(yaw + Math.PI / 2), rx: -Math.cos(yaw + Math.PI / 2), rz: Math.sin(yaw + Math.PI / 2) }, p.y, rng.range(6, 9), 1, false);
      arches++; continue;
    }
    if (men < 3) { P.snowman(p.x, p.y, p.z, yaw, rng.range(1.4, 2), rng.pick(['#2b2b35', '#1f6feb', '#e63946'])); men++; continue; }
    if (crystalsN++ < 8) P.crystals(p.x, p.y, p.z, rng.range(1.6, 2.6), 8);
  }
  // roadside snowmen (small, close) — charm at racing speed
  for (const p of scatter(terrain, Math.round(16 * q), seed + 42, { minDist: 13, maxDist: 30, pad: 3 })) {
    if (!P.dryLand(p.x, p.z)) continue;
    P.snowman(p.x, p.y - 0.1, p.z, facing(p.x, p.z), rng.range(0.9, 1.3), rng.pick(['#2b2b35', '#1f6feb', '#e63946', '#2a9d8f']));
  }
  if (![...P.lmHandled].some(k => k.includes('lift'))) {
    for (const p of scatter(terrain, 30, seed + 43, { minDist: 34, maxDist: 70, pad: 10 })) {
      const n = terrain.nearestTrack(p.x, p.z);
      const dx = p.x - track.px[n.i]!, dz = p.z - track.pz[n.i]!;
      const l = Math.hypot(dx, dz) || 1;
      if (P.skiLift(p.x, p.z, dx / l, dz / l, 170)) break;
    }
  }

  // ───────── forests + rocks ─────────
  const nTrees = Math.round(2600 * q);
  for (const p of scatter(terrain, nTrees, seed + 44, { minDist: 0, maxDist: 330, pad: 4 })) {
    if (!P.dryLand(p.x, p.z)) continue;
    const forest = fbm(p.x / 150, p.z / 150, seed + 3, 3);
    if (forest < -0.12 && !rng.chance(0.12)) continue;
    const pl: Placement = { x: p.x, y: p.y - 0.25, z: p.z, ry: p.r, s: p.s * rng.range(0.85, 1.35), tint: jitterTint(rng, 0.12, 0.03) };
    (rng.chance(0.6) ? P.pines : P.firs).push(pl);
  }
  for (const p of scatter(terrain, Math.round(170 * q), seed + 45, { minDist: 0, maxDist: 250, pad: 4 })) {
    if (!P.dryLand(p.x, p.z) && !rng.chance(0.3)) continue;
    P.rocks.push({ x: p.x, y: p.y - 0.3, z: p.z, ry: p.r, s: p.s * rng.range(0.8, 2.6), sy: rng.range(0.6, 1.1), tint: jitterTint(rng, 0.08) });
  }
  // roadside marker stakes (red/white poles) + wind-blown drifts behind the snowbanks: speed readability
  const stakes: Placement[] = [], drifts: Placement[] = [];
  {
    const step = Math.max(4, Math.round(11 / track.spacing));
    for (let i = 0; i < track.n; i += step) {
      for (const side of [-1, 1] as const) {
        if ((side < 0 ? track.edgeL[i]! : track.edgeR[i]!) !== 0) continue;
        const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
        const f = frameAtIndex(track, i, side * (wall + 1.9));
        if (terrain.inCorridor(f.x, f.z, 0.8)) continue;
        const gy = P.ground(f.x, f.z);
        if (gy < f.y - 2.5) continue;
        stakes.push({ x: f.x, y: gy - 0.3, z: f.z, ry: f.yaw, rx: rng.range(-0.05, 0.05), rz: rng.range(-0.07, 0.07) });
        if (rng.chance(0.4)) {
          const f2 = frameAtIndex(track, i, side * (wall + rng.range(3.5, 6)));
          if (!terrain.inCorridor(f2.x, f2.z, 1.5)) drifts.push({ x: f2.x, y: P.ground(f2.x, f2.z) - 0.15, z: f2.z, ry: f.yaw + rng.range(-0.3, 0.3), s: rng.range(1.2, 2.4), sy: rng.range(0.6, 1) });
        }
      }
    }
  }
  const stakeB = new GeoBatch();
  stakeB.add(sh.cyl(6), (_x, y, _z, out) => { out.set(Math.floor(y * 6) % 2 ? '#f5f7fa' : '#e63946'); }, trs(0, 0, 0, 0, 0.07, 2.1, 0.07));
  stakeB.add(sh.box(), '#ffb000', trs(0, 1.75, 0.07, 0, 0.1, 0.22, 0.03));
  const stakeGeo = bin.add(stakeB.geometry()!);
  const driftB = new GeoBatch();
  driftB.add(sh.dome(10, 4), vGrad('#dbe8f4', '#ffffff', 0, 1), trs(0, 0, 0, 0, 1.6, 0.55, 1.0));
  driftB.add(sh.dome(8, 3), '#ffffff', trs(0.9, 0, 0.3, 0, 0.9, 0.4, 0.7));
  const driftGeo = bin.add(driftB.geometry()!);
  for (const im of [
    ...instancedChunks(stakeGeo, mats.satin, stakes, { cast: true, name: 'snow-stakes', grid: 2 }),
    ...instancedChunks(driftGeo, mats.matte, drifts, { cast: false, name: 'snow-drifts', grid: 2 }),
  ]) root.add(im);

  const pineA = bin.add(pineGeometry(sh, 3, 1, 1));
  const pineB = bin.add(pineGeometry(sh, 4, 0.8, 0.6));
  const rockGeo = new GeoBatch();
  {
    const g = lumpy(sh.dodeca(), rng, 0.35, true);
    const a = new THREE.Color(C.rockDark), b = new THREE.Color(C.rock), s = new THREE.Color(C.snow);
    rockGeo.add(g, (x, y, z, out) => { out.copy(a).lerp(b, clamp01(0.5 + y)); out.lerp(s, clamp01((y + Math.sin(x * 4 + z * 3) * 0.12 - 0.25) * 6)); }, trs(0, 0.25, 0, 0, 1.2, 1, 1.2));
    g.dispose();
  }
  const rockG = bin.add(rockGeo.geometry()!);
  for (const im of [
    ...instancedChunks(pineA, mats.satin, P.pines, { cast: true, name: 'pines', grid: 3 }),
    ...instancedChunks(pineB, mats.satin, P.firs, { cast: true, name: 'firs', grid: 3 }),
    ...instancedChunks(rockG, mats.matte, P.rocks, { cast: true, name: 'rocks', grid: 2 }),
  ]) root.add(im);

  // ───────── distant ring of peaks (no fog, pre-hazed) ─────────
  const far = new GeoBatch();
  const haze = new THREE.Color(SNOW_ENV.skyHorizon);
  const ringR = stats.radius + 420;
  const nPeaks = 20;
  for (let k = 0; k < nPeaks; k++) {
    const a = (k / nPeaks) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const r = ringR + rng.range(80, 380);
    const h = rng.range(120, 230) * (k % 3 === 0 ? 1.35 : 1);
    P.peak(stats.cx + Math.sin(a) * r, base - 12, stats.cz + Math.cos(a) * r, h, rng, far, haze);
    if (rng.chance(0.75)) {
      const a2 = a + rng.range(0.1, 0.2), r2 = ringR - rng.range(-20, 70);
      P.peak(stats.cx + Math.sin(a2) * r2, base - 8, stats.cz + Math.cos(a2) * r2, h * rng.range(0.35, 0.55), rng, far, haze.clone().lerp(new THREE.Color('#ffffff'), 0.25));
    }
  }
  const farMat = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, fog: false }));
  const farMesh = far.mesh(farMat, 'peak-ring', bin, { receive: false });
  if (farMesh) root.add(farMesh);

  // ───────── mid-distance snowy foothills (fogged, between the track and the far ring) ─────────
  {
    const snowA = new THREE.Color('#dfeaf5'), snowB = new THREE.Color('#ffffff'), rockC = new THREE.Color('#7b8ca6');
    let placed = 0;
    for (const p of scatter(terrain, 60, seed + 47, { minDist: 150, maxDist: 900, pad: 60 })) {
      if (placed >= Math.round(14 * Math.max(q, 0.5))) break;
      const r = rng.range(45, 100);
      if (terrain.nearestTrack(p.x, p.z).dist < r + 40) continue;
      const g = mountainGeometry(rng, 16, 5, 0.25);
      const ph = rng.range(0, 6);
      P.matte.add(g, (lx, ly, lz, out) => {
        const a = Math.atan2(lz, lx);
        out.copy(snowA).lerp(snowB, clamp01(ly * 1.5 + Math.cos(a - 0.9) * 0.3));
        out.lerp(rockC, clamp01((Math.sin(a * 9 + ph) - 0.55) * 3) * clamp01((ly - 0.25) * 4) * 0.8);
      }, trs(p.x, p.y - 4, p.z, rng.range(0, 6), r, rng.range(0.3, 0.55) * r, r * rng.range(0.7, 1.1)));
      g.dispose();
      placed++;
    }
  }

  // ───────── merged static batches ─────────
  const statics: Array<[GeoBatch, THREE.Material, string, boolean]> = [
    [P.matte, mats.matte, 'snow-matte', true],
    [P.satin, mats.satin, 'snow-satin', true],
    [P.glow, mats.glow, 'snow-glow', false],
    [P.ice, P.iceMat, 'snow-ice', true],
  ];
  for (const [b, m, name, cast] of statics) {
    const mesh = b.mesh(m, name, bin, { cast });
    if (mesh) root.add(mesh);
  }

  // ───────── sky extras: clouds ─────────
  const sky = new SkyLayer();
  root.add(sky.group);
  const cloudTex = cloudTexture(bin, seed + 5);
  const cards = [];
  for (let k = 0; k < 18; k++) {
    const w = rng.range(260, 460);
    cards.push({ dir: skyDir(rng, 3, 17), dist: 900, w, h: w * rng.range(0.32, 0.42), bottom: '#b9cfe8', top: '#ffffff' });
  }
  const clouds = buildCards(bin, cards, cloudTex, { opacity: 0.92, name: 'clouds' });
  if (clouds) sky.group.add(clouds);

  // ───────── particles ─────────
  const fields: PointField[] = [];
  const snowfall = createPrecip(bin, rng, {
    count: Math.round(2600 * quality.particles), box: [80, 44, 80], fall: 2.1, sway: 0.9, drift: [0.35, 0.15],
    size: 0.085, color: '#ffffff', opacity: 0.9,
  });
  root.add(snowfall.points);
  fields.push(snowfall);
  {
    const n = Math.round(4200 * quality.particles);
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    for (const p of scatter(terrain, n, seed + 46, { minDist: 0, maxDist: 110, pad: 1 })) {
      if (!P.dryLand(p.x, p.z)) continue;
      pts.push(p.x, p.y + 0.08, p.z);
      const c = new THREE.Color(rng.chance(0.3) ? '#bfe9ff' : '#ffffff');
      cols.push(c.r * 2, c.g * 2, c.b * 2);
      sizes.push(rng.range(0.6, 1.4));
    }
    const sparkles = createTwinkles(bin, rng, pts, cols, sizes, { size: 0.16, attenuate: true, twinkle: 1, speed: 3.5, fog: true });
    if (sparkles) { root.add(sparkles.points); fields.push(sparkles); }
  }
  const smoke = createPuffs(bin, rng, P.smokeAt, Math.max(6, Math.round(14 * quality.particles)), {
    life: 6.5, rise: 1.3, spread: 0.3, acc: [0.28, 0.04, 0.12], size0: 0.9, size1: 4.2,
    color0: '#ffffff', color1: '#cfdbe8', opacity: 0.6, texture: puffTexture(bin, seed + 9), fadeIn: 0.08, fadeOut: 0.55,
  });
  if (smoke) { root.add(smoke.points); fields.push(smoke); }

  sh.dispose();

  // ───────── movers ─────────
  const movers = new MoverAnimator();
  const moverGeo = new Map<string, THREE.BufferGeometry>();
  const mShapes = new Shapes();
  const mRng = new Rng(seed + 77);
  /** Largest distance of any vertex from the ball centre (unit geometry), per variant. */
  const moverExtent = new Map<string, number>();
  const snowballGeo = (rocky: boolean) => {
    const key = rocky ? 'rocky' : 'snowball';
    let g = moverGeo.get(key);
    if (!g) {
      const b = new GeoBatch();
      const core = lumpy(mShapes.ico(2), mRng, 0.1);
      b.add(core, rocky ? vGrad('#8796ab', '#e9f2fa', -1, 1) : vGrad('#e2edf8', '#ffffff', -1, 0.6));
      core.dispose();
      for (let k = 0; k < 9; k++) {
        const a = mRng.range(0, 6.28), e = mRng.range(-1.2, 1.2);
        const x = Math.cos(a) * Math.cos(e), y = Math.sin(e), z = Math.sin(a) * Math.cos(e);
        // twigs stay inside the clump envelope (at 0.9 long they reached 1.64 radii and speared ~1 m through the road)
        if (k < 3) b.add(mShapes.cyl(4), C.bark, trs(x * 0.95, y * 0.95, z * 0.95, a, 0.04, 0.5, 0.04, e + 1.2, 0.4));
        else if (rocky || k < 6) b.add(mShapes.dodeca(), rocky ? '#4f5d72' : '#8a98ae', trs(x * 0.97, y * 0.97, z * 0.97, a, 0.14, 0.11, 0.14));
      }
      b.add(mShapes.sphere(10, 6), '#ffffff', trs(0, 0.25, 0, 0, 0.85, 0.85, 0.85));
      // clumps of packed snow bulging out of the ball: big enough to break the silhouette (at 0.3 they sank into
      // the core and the mover read as a smooth pale-blue ice sphere rather than a rolled snowball)
      for (let k = 0; k < 11; k++) {
        const a = mRng.range(0, 6.28), e = mRng.range(-1.1, 1.1);
        const cs = mRng.range(0.36, 0.48);
        b.add(mShapes.ico(0), k % 3 ? '#ffffff' : '#eaf3fc', trs(Math.cos(a) * Math.cos(e) * 0.92, Math.sin(e) * 0.92, Math.sin(a) * Math.cos(e) * 0.92, a, cs, cs * 0.8, cs * 0.9, e));
      }
      g = b.geometry()!;
      moverGeo.set(key, g);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      let ext = 0;
      for (let k = 0; k < p.count; k++) ext = Math.max(ext, Math.hypot(p.getX(k), p.getY(k), p.getZ(k)));
      moverExtent.set(key, ext || 1);
    }
    return g;
  };

  // packed snow: soft sky-blue bounce keeps the shaded side bright and toy-like
  const snowballMat = bin.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, emissive: new THREE.Color('#c9dcef'), emissiveIntensity: 0.24 }));
  function createMover(look: string): THREE.Object3D {
    const k = look.toLowerCase();
    // Rolling radius = the ball's OUTER envelope (clump tips), so no clump sinks into the road as it rolls: scaled by
    // the core (1.7) the clumps reached 2.26 m about a 1.7 m pivot and cut ~0.55 m into the asphalt. The core now
    // comes out at ≈1.45 m — about the sim's 1.5 m hitbox — with the clumps as its soft outer layer.
    const r = 1.8;
    const rocky = !(k.includes('snow') || k.includes('ball'));
    const { root: mr, body } = movers.make('roll', r);
    const mesh = new THREE.Mesh(snowballGeo(rocky), snowballMat);
    mesh.scale.setScalar(r / moverExtent.get(rocky ? 'rocky' : 'snowball')!);
    mesh.castShadow = true;
    body.add(mesh);
    return mr;
  }

  return {
    environment: SNOW_ENV,
    update(dt, time, camera) {
      for (const u of P.updaters) u(dt, time);
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
      for (const g of moverGeo.values()) g.dispose();
      moverGeo.clear();
      moverExtent.clear();
      mShapes.dispose();
      bin.dispose();
    },
  };
}
