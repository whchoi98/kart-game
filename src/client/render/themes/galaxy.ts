/**
 * Starlight Road — galaxy theme scenery.
 * Deep space: camera-following starfield with a milky-way band, additive nebula clouds, a spiral galaxy in the void
 * below the road, ringed planets, rotating asteroid belts, a spinning space station, glowing ring gates over the road
 * ('ring-gate'), floating crystal islands, comets streaking across the sky, aurora ribbons and star-dust sparkles
 * beneath the road edges. There is no ground plane: below the road is the void.
 */
import * as THREE from 'three';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain } from '../terrain.js';
import {
  Bin, GeoBatch, MoverAnimator, Rng, Shapes, SkyLayer,
  auroraMaterial, buildCards, clamp01, corridorHalf, createBatchMaterials, createPrecip, createTwinkles, disposeObjects, frameAtIndex,
  glowTexture, indexAtS, instanced, jitterTint, landmarkPose, lavaMaterial, lumpy, mixHex, nebulaTexture, skyDir, trackStats, trs,
  vGrad, viewHeight, wrapIndex,
  type ColorFn, type PointField, type Placement, withCorridorGuard,
} from './props-b.js';

const SKIP = new Set(['grandstand', 'arch', 'banner']);

export const GALAXY_ENV: EnvironmentSettings = {
  skyTop: '#04021a', skyHorizon: '#2a1060', skyBottom: '#08031e',
  fogColor: '#170c40', fogNear: 260, fogFar: 1400,
  sunColor: '#dcd8ff', sunIntensity: 1.7, sunDir: [0.35, 0.72, 0.25],
  hemiSky: '#8a7cff', hemiGround: '#24104a', hemiIntensity: 0.95,
  exposure: 1.1, night: true, bloomStrength: 1.1,
};

const C = {
  pink: '#ff4fd8', cyan: '#5ce1ff', gold: '#ffe600', violet: '#9b5cff', mint: '#5cffc8', white: '#ffffff',
  hull: '#c9d2e8', hullDark: '#6a7390', panel: '#2a6bff', rock: '#3a3350', rockHi: '#5a5078',
};

function canvasTex(bin: Bin, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return bin.add(t);
}

/** Banded gas-giant texture (equirect-ish, 512×256). */
function planetTexture(bin: Bin, rng: Rng, colors: string[]): THREE.CanvasTexture {
  return canvasTex(bin, 512, 256, g => {
    let y = 0;
    while (y < 256) {
      const h = rng.range(6, 30);
      g.fillStyle = rng.pick(colors);
      g.fillRect(0, y, 512, h + 1);
      y += h;
    }
    // soft turbulence swirls
    for (let k = 0; k < 60; k++) {
      const x = rng.range(0, 512), yy = rng.range(0, 256), r = rng.range(6, 30);
      const grd = g.createRadialGradient(x, yy, 0, x, yy, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.18)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, yy - r, r * 2, r * 2);
    }
    if (rng.chance(0.6)) {
      g.fillStyle = 'rgba(255,120,80,0.55)';
      g.beginPath(); g.ellipse(rng.range(80, 430), rng.range(90, 170), 34, 14, 0, 0, Math.PI * 2); g.fill();
    }
  });
}

/** Planet ring texture: radial bands along U (inner → outer). */
function ringTexture(bin: Bin, rng: Rng, tint: string): THREE.CanvasTexture {
  return canvasTex(bin, 512, 8, g => {
    const col = new THREE.Color(tint);
    for (let x = 0; x < 512; x++) {
      const t = x / 511;
      const a = clamp01(Math.sin(t * Math.PI)) * (0.35 + 0.65 * Math.abs(Math.sin(t * 40 + rng.range(0, 0.3)))) * (t > 0.46 && t < 0.5 ? 0.1 : 1);
      g.fillStyle = `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a.toFixed(3)})`;
      g.fillRect(x, 0, 1, 8);
    }
  });
}

/** Spiral galaxy card (additive, white-on-transparent — tinted by vertex colours). */
function spiralTexture(bin: Bin, rng: Rng): THREE.CanvasTexture {
  return canvasTex(bin, 512, 512, g => {
    g.clearRect(0, 0, 512, 512);
    const cx = 256, cy = 256;
    for (let k = 0; k < 2600; k++) {
      const arm = k % 2;
      const t = rng.next();
      const ang = t * 7.5 + arm * Math.PI + rng.range(-0.35, 0.35) * (1 - t * 0.5);
      const r = 14 + t * 220 + rng.range(-10, 10);
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r * 0.92;
      const s = rng.range(2, 9) * (1 - t * 0.6);
      const grd = g.createRadialGradient(x, y, 0, x, y, s);
      grd.addColorStop(0, `rgba(255,255,255,${(0.35 * (1 - t * 0.7)).toFixed(3)})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - s, y - s, s * 2, s * 2);
    }
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, 60);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, 512, 512);
  });
}

/**
 * Comet tail card: bright head on the left fading to the right (UV x along the tail). Feathered across its width
 * (gaussian profile that widens along the tail) so tails read as glowing plumes, never as hard-edged bars.
 */
function tailTexture(bin: Bin): THREE.CanvasTexture {
  const W = 256, H = 64;
  return canvasTex(bin, W, H, g => {
    const img = g.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const along = Math.pow(1 - u, 1.35) * Math.min(1, u * 40 + 0.35);
      const wid = 0.16 + 0.84 * Math.pow(u, 0.65);
      for (let y = 0; y < H; y++) {
        const v = ((y + 0.5) / H) * 2 - 1;
        const a = along * Math.exp(-3.2 * (v / wid) * (v / wid)) * (1 - Math.pow(Math.abs(v), 6));
        const o = (y * W + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildGalaxyScenery(ctx));
}

function buildGalaxyScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const pal = THEME_PALETTES.galaxy;
  const q = quality.scenery;
  const seed = track.def.scenerySeed;
  const root = new THREE.Group();
  root.name = 'scenery-galaxy';
  scene.add(root);
  const bin = new Bin();
  const sh = new Shapes();
  const rng = new Rng((seed ^ 0x6a1a) >>> 0);
  const mats = createBatchMaterials(bin, 1.7);
  const stats = trackStats(track);
  // corridor queries only (the void has no visible ground)
  const terrain = buildTerrain(track, { ground: pal.ground, groundAlt: pal.groundAlt, cell: 24, margin: 200, hills: 0 });
  terrain.mesh.geometry.dispose();
  (terrain.mesh.material as THREE.Material).dispose();
  const clear = (x: number, z: number, r: number) => !terrain.inCorridor(x, z, r + 3) && terrain.nearestTrack(x, z).dist > r + 6;

  const glowB = new GeoBatch();
  const hull = new GeoBatch();
  const rockB = new GeoBatch();
  const updaters: Array<(dt: number, time: number) => void> = [];
  const glowTex = glowTexture(bin);
  const spinners: Array<{ obj: THREE.Object3D; axis: THREE.Vector3; speed: number }> = [];
  const m4 = new THREE.Matrix4();

  // ───────── planets ─────────
  const planetMats: THREE.Material[] = [];
  function planet(x: number, y: number, z: number, r: number, colors: string[], ring: string | null, tilt: number, glow: string): void {
    const tex = planetTexture(bin, rng, colors);
    const mat = bin.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, emissive: new THREE.Color(glow), emissiveIntensity: 0.18, emissiveMap: tex, fog: false }));
    planetMats.push(mat);
    const geo = bin.add(new THREE.SphereGeometry(r, 48, 28));
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.set(tilt, rng.range(0, 6), tilt * 0.4);
    const m = new THREE.Mesh(geo, mat);
    m.name = 'planet';
    g.add(m);
    spinners.push({ obj: m, axis: new THREE.Vector3(0, 1, 0), speed: rng.range(0.01, 0.03) });
    if (ring) {
      const rg = bin.add(new THREE.RingGeometry(r * 1.35, r * 2.3, 96, 1));
      // map U along the radius
      const pos = rg.getAttribute('position') as THREE.BufferAttribute, uv = rg.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        const d = Math.hypot(pos.getX(k), pos.getY(k));
        uv.setXY(k, (d - r * 1.35) / (r * 0.95), 0.5);
      }
      const rm = bin.add(new THREE.MeshBasicMaterial({ map: ringTexture(bin, rng, ring), transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
      // additive + near-white tints: at 1.3 the rings crossed the night bloom threshold and flared into plain white
      // halos that hid their band structure; 0.72 keeps them luminous but readable
      rm.color.setScalar(0.72);
      const ringMesh = new THREE.Mesh(rg, rm);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.name = 'planet-ring';
      g.add(ringMesh);
    }
    const halo = new THREE.Sprite(bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(glow).multiplyScalar(0.9), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, opacity: 0.55 })));
    halo.scale.setScalar(r * 3.4);
    halo.renderOrder = -2;
    g.add(halo);
    root.add(g);
  }

  // ───────── ring gates ─────────
  const gateCount = { n: 0 };
  function ringGate(i: number, sc: number): void {
    const f = frameAtIndex(track, i, 0);
    const R = corridorHalf(track, i) + 2.5;
    const tx = track.tx[i]!, ty = track.ty[i]!, tz = track.tz[i]!;
    const g = new THREE.Group();
    g.position.set(f.x, f.y + R * 0.18, f.z);
    // orient +Z along the tangent (the ring lies in the local XY plane)
    const zAxis = new THREE.Vector3(tx, ty, tz).normalize();
    const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    g.quaternion.setFromRotationMatrix(m4.makeBasis(xAxis, yAxis, zAxis));
    g.scale.setScalar(sc);
    const cA = gateCount.n % 2 ? C.cyan : C.pink, cB = gateCount.n % 2 ? C.violet : C.gold;
    const tor = new THREE.TorusGeometry(R, 0.55, 10, 72);
    m4.compose(g.position, g.quaternion, g.scale);
    const cBc = new THREE.Color(cB);
    // 0.6: the glow material boosts ×1.7 — full-strength hues bloomed to plain white and lost the gate's colours
    glowB.add(tor, (x, y, _z, out) => { out.set(cA).lerp(cBc, clamp01((Math.atan2(y, x) / Math.PI + 1) / 2)).multiplyScalar(0.6); }, m4);
    tor.dispose();
    const tor2 = new THREE.TorusGeometry(R + 1.4, 0.35, 6, 72);
    hull.add(tor2, C.hullDark, m4);
    tor2.dispose();
    // spinning segment ring
    const seg = new GeoBatch();
    const n = 12;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      seg.add(sh.box(), k % 2 ? cA : C.white, trs(Math.cos(a) * (R + 2.4), Math.sin(a) * (R + 2.4), 0, 0, 1.6, 0.5, 0.9, 0, a));
    }
    const sg = seg.geometry()!;
    bin.add(sg);
    const spin = new THREE.Mesh(sg, mats.glow);
    spin.name = 'gate-spinner';
    g.add(spin);
    spinners.push({ obj: spin, axis: new THREE.Vector3(0, 0, 1), speed: (gateCount.n % 2 ? -1 : 1) * 0.6 });
    // four nodes
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const p = new THREE.Vector3(Math.cos(a) * (R + 1.4), Math.sin(a) * (R + 1.4), 0).applyMatrix4(m4);
      hull.add(sh.ico(1), C.hull, trs(p.x, p.y, p.z, 0, 1.3 * sc));
      glowB.add(sh.ico(0), cB, trs(p.x, p.y, p.z, 0, 0.7 * sc));
    }
    root.add(g);
    gateCount.n++;
  }

  // ───────── space station ─────────
  function station(x: number, y: number, z: number, s: number): void {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.set(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3));
    const b = new GeoBatch(), gl = new GeoBatch();
    const R = 40 * s;
    const tor = new THREE.TorusGeometry(R, 3.2 * s, 10, 64);
    b.add(tor, vGrad(C.hullDark, C.hull, -1, 1), trs(0, 0, 0, 0, 1, 1, 1, Math.PI / 2));
    tor.dispose();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      b.add(sh.cyl(6), C.hullDark, trs(0, 0, 0, a, 0.9 * s, R, 0.9 * s, Math.PI / 2));
      gl.add(sh.box(), k % 2 ? C.cyan : C.gold, trs(Math.sin(a) * R, 2.4 * s, Math.cos(a) * R, a, 5 * s, 0.6 * s, 1.2 * s));
    }
    b.add(sh.sphere(16, 10), vGrad(C.hullDark, C.hull, -1, 1), trs(0, 0, 0, 0, 9 * s, 7 * s, 9 * s));
    b.add(sh.cyl(12), C.hull, trs(0, -24 * s, 0, 0, 3 * s, 48 * s, 3 * s));
    gl.add(sh.sphere(10, 6), C.pink, trs(0, 24 * s, 0, 0, 1.6 * s));
    for (const sy of [-1, 1]) for (let k = 0; k < 3; k++) {
      gl.add(sh.box(), C.panel, trs(0, sy * (12 + k * 5) * s, 0, 0, 34 * s, 3.4 * s, 0.4 * s));
      b.add(sh.box(), C.hullDark, trs(0, sy * (12 + k * 5) * s, 0, 0, 35 * s, 0.4 * s, 0.6 * s));
    }
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      gl.add(sh.box(), '#fff2c0', trs(Math.sin(a) * (R + 3.2 * s), 0, Math.cos(a) * (R + 3.2 * s), a, 1.6 * s, 1.1 * s, 0.3 * s));
    }
    const bm = b.mesh(mats.satin, 'station-hull', bin, { cast: false });
    const gm = gl.mesh(mats.glow, 'station-lights', bin);
    if (bm) { bm.matrixAutoUpdate = true; g.add(bm); }
    if (gm) { gm.matrixAutoUpdate = true; g.add(gm); }
    spinners.push({ obj: g, axis: new THREE.Vector3(0, 1, 0), speed: 0.05 });
    root.add(g);
  }

  // ───────── floating crystal islands ─────────
  function island(x: number, y: number, z: number, s: number): void {
    const g = lumpy(sh.ico(1), rng, 0.35);
    const rc: ColorFn = (_x, ly, _z, out) => { out.set(C.rock).lerp(new THREE.Color(C.rockHi), clamp01(ly + 0.5)); if (ly > 0.2) out.lerp(new THREE.Color('#6a4ca8'), 0.5); };
    rockB.add(g, rc, trs(x, y, z, rng.range(0, 6), 6 * s, 3.2 * s, 5 * s));
    g.dispose();
    const g2 = lumpy(sh.cone(7), rng, 0.2);
    rockB.add(g2, vGrad(C.rockHi, '#1e1830', 0, 1), trs(x, y - 1 * s, z, rng.range(0, 6), 4.5 * s, 9 * s, 4 * s, Math.PI));
    g2.dispose();
    const cols = [C.cyan, C.pink, C.violet, C.mint];
    for (let k = 0; k < 6; k++) {
      const a = rng.range(0, 6.28), r = rng.range(0, 3.2) * s;
      const h = rng.range(2.5, 7) * s;
      glowB.add(sh.cone(5), vGrad(mixHex(cols[k % 4]!, '#000000', 0.4), cols[k % 4]!, 0, 1), trs(x + Math.cos(a) * r, y + 2 * s, z + Math.sin(a) * r, rng.range(0, 6), 0.7 * s, h, 0.7 * s, rng.range(-0.35, 0.35), rng.range(-0.35, 0.35)));
    }
  }

  return assembleGalaxy({
    ctx, root, bin, sh, rng, mats, stats, terrain, clear, glowB, hull, rockB, updaters, glowTex, spinners, planetMats,
    planet, ringGate, station, island, gateCount,
  });
}

interface GalaxyParts {
  ctx: SceneryContext; root: THREE.Group; bin: Bin; sh: Shapes; rng: Rng;
  mats: ReturnType<typeof createBatchMaterials>; stats: ReturnType<typeof trackStats>;
  terrain: ReturnType<typeof buildTerrain>;
  clear(x: number, z: number, r: number): boolean;
  glowB: GeoBatch; hull: GeoBatch; rockB: GeoBatch;
  updaters: Array<(dt: number, time: number) => void>;
  glowTex: THREE.Texture;
  spinners: Array<{ obj: THREE.Object3D; axis: THREE.Vector3; speed: number }>;
  planetMats: THREE.Material[];
  planet(x: number, y: number, z: number, r: number, colors: string[], ring: string | null, tilt: number, glow: string): void;
  ringGate(i: number, sc: number): void;
  station(x: number, y: number, z: number, s: number): void;
  island(x: number, y: number, z: number, s: number): void;
  gateCount: { n: number };
}

function assembleGalaxy(P: GalaxyParts): SceneryHandle {
  const { ctx, root, bin, sh, rng, mats, stats, glowTex } = P;
  const { track, quality } = ctx;
  const q = quality.scenery;
  const seed = track.def.scenerySeed;
  const around = (dist: number, elev: number, az: number) => [stats.cx + Math.sin(az) * dist, stats.minY + elev, stats.cz + Math.cos(az) * dist] as const;
  const tailTex = tailTexture(bin);
  const tailGeo = bin.add(new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0));
  const fields: PointField[] = [];

  // ───────── big comet (landmark): icy nucleus, glowing coma, dust + ion tails with sparkles ─────────
  const bigComets: Array<{ g: THREE.Group; base: THREE.Vector3; ph: number; tails: THREE.Object3D[] }> = [];
  const tailCards: Array<{ axis: THREE.Object3D; card: THREE.Object3D }> = [];
  const camLocal = new THREE.Vector3();
  /** Roll a tail card about its axis group's local X so the card face (local +Z) points at the camera. */
  const rollToCamera = (axis: THREE.Object3D, card: THREE.Object3D, camera: THREE.Camera) => {
    camLocal.setFromMatrixPosition(camera.matrixWorld);
    axis.worldToLocal(camLocal);
    card.rotation.x = Math.atan2(-camLocal.y, camLocal.z);
  };
  function bigComet(x: number, y: number, z: number, sc: number): void {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.name = 'comet-landmark';
    const R = 6 * sc;
    const nuc = lumpy(sh.ico(1), rng, 0.3);
    const b = new GeoBatch();
    b.add(nuc, (_x, ly, _z, out) => { out.set('#9aa8d8').lerp(new THREE.Color('#e8f4ff'), clamp01(ly * 0.5 + 0.5)); }, trs(0, 0, 0, rng.range(0, 6), R, R * 0.85, R));
    nuc.dispose();
    const nm = b.mesh(mats.satin, 'comet-nucleus', bin, { cast: false });
    if (nm) { nm.matrixAutoUpdate = true; g.add(nm); }
    const coreMat = bin.add(new THREE.MeshBasicMaterial({ color: new THREE.Color(C.cyan).multiplyScalar(1.2), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    const core = new THREE.Mesh(bin.add(new THREE.IcosahedronGeometry(R * 1.25, 2)), coreMat);
    core.name = 'comet-core';
    g.add(core);
    const coma = new THREE.Sprite(bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color('#9ff2ff'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7, fog: false })));
    coma.scale.setScalar(R * 6);
    g.add(coma);
    // tails stream away from the light
    const sd = new THREE.Vector3(...GALAXY_ENV.sunDir);
    // tails sweep up and away (not flat across the course, where they read as laser beams from kart height)
    const dust = new THREE.Vector3(-sd.x, 0, -sd.z).normalize().setY(0.42).normalize();
    // the ion tail runs almost along the dust tail as its brighter, narrower core: two tails fanned 0.25 rad apart
    // read as two separate beams leaving the nucleus
    const ion = new THREE.Vector3(-sd.x, 0, -sd.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.05).setY(0.47).normalize();
    const tails: THREE.Object3D[] = [];
    const mkTail = (dir: THREE.Vector3, len: number, wid: number, col: string, op: number) => {
      const t = new THREE.Group();
      t.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      const m = bin.add(new THREE.MeshBasicMaterial({ map: tailTex, color: new THREE.Color(col).multiplyScalar(0.75), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: op, side: THREE.DoubleSide, fog: false }));
      // ONE card per tail, rolled about the tail axis every frame to face the camera (axis-aligned billboard).
      // Three fixed crossed cards always had one near edge-on, where the additive feathered card collapsed into a
      // hard bright line — the "laser beams" people saw.
      const pl = new THREE.Mesh(tailGeo, m);
      pl.scale.set(len, wid, 1);
      pl.name = 'comet-tail';
      // roll per RENDERED camera (not just the one update() sees): in split screen the second player's view would
      // otherwise get the first player's roll and could catch the card edge-on
      pl.onBeforeRender = (_r, _s, camera) => {
        rollToCamera(t, pl, camera);
        pl.updateMatrix();
        pl.matrixWorld.multiplyMatrices(t.matrixWorld, pl.matrix);
      };
      t.add(pl);
      g.add(t);
      tails.push(t);
      tailCards.push({ axis: t, card: pl });
    };
    // short, fat, soft plumes: long thin tails (11:1) read as laser beams across the course
    mkTail(dust, 105 * sc, 42 * sc, '#bfe8ff', 0.6);
    mkTail(ion, 118 * sc, 16 * sc, C.pink, 0.32);
    // sparkles trailing in the dust tail
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    const side = new THREE.Vector3().crossVectors(dust, new THREE.Vector3(0, 1, 0)).normalize();
    for (let k = 0; k < Math.round(260 * Math.max(0.5, quality.particles)); k++) {
      const t = Math.pow(rng.next(), 0.7) * 105 * sc;
      const spread = (2 + t * 0.16) * (rng.next() - 0.5) * 2;
      const up = (1 + t * 0.08) * (rng.next() - 0.5) * 2;
      pts.push(dust.x * t + side.x * spread, dust.y * t + up, dust.z * t + side.z * spread);
      const c = new THREE.Color(rng.chance(0.5) ? '#bff6ff' : '#ffd6f6').multiplyScalar(1.6);
      cols.push(c.r, c.g, c.b);
      sizes.push(rng.range(0.6, 1.6));
    }
    const sp = createTwinkles(bin, rng, pts, cols, sizes, { size: 0.9, attenuate: true, twinkle: 0.8, speed: 3 });
    if (sp) { g.add(sp.points); fields.push(sp); }
    root.add(g);
    bigComets.push({ g, base: g.position.clone(), ph: rng.range(0, 6), tails });
  }

  // ───────── landmarks ─────────
  let stationPlaced = false;
  for (const l of track.landmarks) {
    if (SKIP.has(l.kind)) continue;
    const p = landmarkPose(track, l);
    const f = p.frame, sc = p.scale;
    const k = l.kind.toLowerCase();
    if (p.over || k.includes('gate') || k.includes('ring')) { P.ringGate(f.i, sc); continue; }
    if (k.includes('planet') || k.includes('moon')) {
      const r = 38 * sc;
      P.planet(f.x + Math.sign(p.d) * f.rx * r, f.y + r * 0.6, f.z + Math.sign(p.d) * f.rz * r, r, ['#ff9ad5', '#ffd1f0', '#b07cff', '#ffc2e8'], k.includes('moon') ? null : '#ffe0f6', 0.4, C.pink);
      continue;
    }
    if (k.includes('station') || k.includes('satellite')) {
      // ring radius is 40·s: lift + push it out so the ring never hangs right over the lanes
      const R = 40 * 0.8 * sc, out = (Math.sign(p.d) || 1) * R * 0.3;
      P.station(f.x + f.rx * out, f.y + 30 * sc + R * 0.35, f.z + f.rz * out, 0.8 * sc);
      stationPlaced = true;
      continue;
    }
    if (k.includes('comet')) { bigComet(f.x, f.y + 42 * sc, f.z, sc); continue; }
    if (k.includes('asteroid') || k.includes('rock')) {
      for (let j = 0; j < 5; j++) P.island(f.x + rng.range(-14, 14) * sc, f.y + rng.range(-12, 8) * sc, f.z + rng.range(-14, 14) * sc, rng.range(0.5, 1.1) * sc);
      continue;
    }
    // themed fallback: crystal island hovering beside the road
    P.island(f.x, f.y - 2 + 4 * sc, f.z, 1.2 * sc);
  }
  // auto ring gates on calm sections (if the track authored fewer than two)
  if (P.gateCount.n < 2) {
    const want = 3;
    for (let k = 0; k < want; k++) {
      let best = -1, bestK = Infinity;
      const s0 = track.startS + 90 + (k / want) * (track.length - 180);
      for (let ds = -60; ds <= 60; ds += 4) {
        const i = indexAtS(track, s0 + ds);
        const c = Math.abs(track.curvature[i]!);
        if (c < bestK) { bestK = c; best = i; }
      }
      if (best >= 0) P.ringGate(best, 1);
    }
  }
  // planets + station + islands (auto)
  P.planet(...around(stats.radius + 520, 170, 0.9), 120, ['#5ce1ff', '#2a6bff', '#9be8ff', '#3a8cff', '#c9f4ff'], '#a8e8ff', 0.35, C.cyan);
  P.planet(...around(stats.radius + 700, -240, 3.6), 170, ['#ff9a3a', '#ffcf6a', '#e2653a', '#ffd9a0', '#c24a2a'], null, 0.15, '#ff8a3a');
  P.planet(...around(stats.radius + 420, 60, 2.2), 46, ['#b07cff', '#7a4cff', '#e0c8ff', '#9b5cff'], '#ffd6ff', 0.6, C.violet);
  P.planet(...around(stats.radius + 380, 240, 5.1), 28, ['#5cffc8', '#2ab99a', '#b8ffe8'], null, 0.2, C.mint);
  if (!stationPlaced) P.station(...around(stats.radius + 220, 90, 4.3), 1);
  let islands = 0;
  for (let k = 0; k < 60 && islands < Math.round(12 * Math.max(q, 0.5)); k++) {
    const i = rng.int(0, track.n);
    const side = rng.chance(0.5) ? -1 : 1;
    const d = side * (corridorHalf(track, i) + rng.range(18, 70));
    const f = frameAtIndex(track, i, d);
    const s = rng.range(0.6, 1.4);
    if (!P.clear(f.x, f.z, 9 * s)) continue;
    P.island(f.x, f.y + rng.range(-18, 10), f.z, s);
    islands++;
  }

  // ───────── asteroid belt around the course (below the road), slowly rotating ─────────
  const belt = new THREE.Group();
  belt.name = 'asteroid-belt';
  belt.position.set(stats.cx, stats.minY - 45, stats.cz);
  belt.rotation.x = 0.06;
  root.add(belt);
  const astGeo: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 2; v++) {
    const b = new GeoBatch();
    const g = lumpy(sh.ico(1), rng, 0.4);
    b.add(g, (_x, y, _z, out) => { out.set(C.rock).lerp(new THREE.Color(v ? '#7a6a9a' : C.rockHi), clamp01(y * 0.5 + 0.5)); });
    g.dispose();
    astGeo.push(bin.add(b.geometry()!));
  }
  const lists: Placement[][] = [[], []];
  const nAst = Math.round(700 * q);
  for (let k = 0; k < nAst; k++) {
    const a = rng.range(0, Math.PI * 2);
    const r = stats.radius + rng.range(120, 260);
    lists[k % 2]!.push({ x: Math.sin(a) * r, y: rng.range(-28, 28) * (0.3 + rng.next()), z: Math.cos(a) * r, ry: rng.range(0, 6), rx: rng.range(0, 6), s: rng.range(0.8, 5) * (rng.chance(0.08) ? 2.5 : 1), tint: jitterTint(rng, 0.2, 0.08) });
  }
  for (let v = 0; v < 2; v++) {
    const im = instanced(astGeo[v]!, mats.matte, lists[v]!, { name: `asteroids-${v}`, receive: false });
    if (im) belt.add(im);
  }
  P.spinners.push({ obj: belt, axis: new THREE.Vector3(0, 1, 0), speed: 0.012 });

  // ───────── merged statics ─────────
  for (const [b, m, name] of [[P.glowB, mats.glow, 'galaxy-glow'], [P.hull, mats.satin, 'galaxy-hull'], [P.rockB, mats.matte, 'crystal-islands']] as const) {
    const mesh = b.mesh(m, name, bin, { cast: name !== 'galaxy-glow' });
    if (mesh) root.add(mesh);
  }

  // ───────── sky layer: stars, milky way, nebulae, spiral galaxy, aurora, comets ─────────
  const sky = new SkyLayer();
  root.add(sky.group);
  {
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    const palette = ['#ffffff', '#ffffff', '#cfe0ff', '#ffd6f4', '#fff1c0', '#a8e8ff'];
    const nStars = Math.round(5200 * Math.max(0.5, quality.particles));
    for (let k = 0; k < nStars; k++) {
      const d = skyDir(rng, -89, 89);
      pts.push(d[0] * 950, d[1] * 950, d[2] * 950);
      const c = new THREE.Color(rng.pick(palette)).multiplyScalar(rng.range(0.5, 1.5));
      cols.push(c.r, c.g, c.b);
      sizes.push(rng.chance(0.03) ? rng.range(3, 4.5) : rng.range(0.9, 2.2));
    }
    // milky-way band along a tilted great circle
    const n = new THREE.Vector3(0.3, 0.85, 0.42).normalize();
    const u = new THREE.Vector3().crossVectors(n, new THREE.Vector3(1, 0, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const v3 = new THREE.Vector3();
    for (let k = 0; k < Math.round(4200 * Math.max(0.5, quality.particles)); k++) {
      const a = rng.range(0, Math.PI * 2);
      const off = (rng.next() + rng.next() + rng.next() - 1.5) * 0.22;
      v3.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a)).addScaledVector(n, off).normalize().multiplyScalar(950);
      pts.push(v3.x, v3.y, v3.z);
      const c = new THREE.Color(rng.chance(0.5) ? '#d9c8ff' : '#ffd6ee').multiplyScalar(rng.range(0.35, 0.9));
      cols.push(c.r, c.g, c.b);
      sizes.push(rng.range(0.8, 1.6));
    }
    const stars = createTwinkles(bin, rng, pts, cols, sizes, { size: 1.6, attenuate: false, twinkle: 0.55, speed: 1.6 });
    if (stars) { stars.points.frustumCulled = false; stars.points.renderOrder = -8; sky.group.add(stars.points); fields.push(stars); }
  }
  const nebTex = nebulaTexture(bin, seed + 3);
  const nebCols: Array<[string, string]> = [['#ff4fd8', '#9b5cff'], ['#5ce1ff', '#2a6bff'], ['#9b5cff', '#ff4fd8'], ['#ff8ad8', '#5ce1ff']];
  const neb = [];
  for (let k = 0; k < 14; k++) {
    const [a, b] = rng.pick(nebCols);
    const w = rng.range(420, 900);
    neb.push({ dir: skyDir(rng, -40, 70), dist: 900, w, h: w * rng.range(0.55, 0.9), bottom: mixHex(a, '#000000', 0.45).getStyle(), top: mixHex(b, '#000000', 0.35).getStyle(), roll: rng.range(0, 6) });
  }
  const nebMesh = buildCards(bin, neb, nebTex, { additive: true, opacity: 0.6, name: 'nebulae' });
  if (nebMesh) sky.group.add(nebMesh);
  const spiral = buildCards(bin, [{ dir: [0.25, -0.93, 0.2], dist: 880, w: 900, h: 900, bottom: '#9b7cff', top: '#ffb8ec', roll: 0.4 }], spiralTexture(bin, rng), { additive: true, opacity: 0.8, name: 'spiral-galaxy' });
  if (spiral) sky.group.add(spiral);
  const auroraMat = auroraMaterial(bin, { a: '#39ffb0', b: '#ff4fd8', intensity: 0.8, speed: 0.8 });
  const auroraGeo = new GeoBatch();
  for (let k = 0; k < 2; k++) {
    const a0 = rng.range(0, Math.PI * 2), span = rng.range(1.2, 1.9);
    const R = 720 - k * 60, y0 = 110 + k * 60, H = 140;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const N = 60;
    for (let j = 0; j <= N; j++) {
      const t = j / N, a = a0 + t * span;
      const r = R + Math.sin(t * 9) * 30;
      pos.push(Math.sin(a) * r, y0, Math.cos(a) * r, Math.sin(a) * r * 0.97, y0 + H, Math.cos(a) * r * 0.97);
      uv.push(t, 0, t, 1);
      if (j < N) { const b0 = j * 2; idx.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    auroraGeo.add(g, '#ffffff');
    g.dispose();
  }
  const aurora = auroraGeo.mesh(auroraMat, 'aurora', bin, { receive: false });
  if (aurora) { aurora.frustumCulled = false; aurora.renderOrder = -4; sky.group.add(aurora); }
  // comets
  const comets: Array<{ head: THREE.Sprite; tail: THREE.Mesh; u: THREE.Vector3; v: THREE.Vector3; w: number; ph: number; len: number }> = [];
  for (let k = 0; k < 3; k++) {
    const col = [C.cyan, C.pink, '#fff1c0'][k]!;
    const head = new THREE.Sprite(bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(col).multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })));
    head.scale.setScalar(26);
    const tm = bin.add(new THREE.MeshBasicMaterial({ map: tailTex, color: new THREE.Color(col).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, side: THREE.DoubleSide }));
    const tail = new THREE.Mesh(tailGeo, tm);
    tail.frustumCulled = false;
    head.name = 'comet'; tail.name = 'comet-tail';
    sky.group.add(head, tail);
    const nrm = new THREE.Vector3(rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5)).normalize();
    const u = new THREE.Vector3().crossVectors(nrm, new THREE.Vector3(0, 0, 1)).normalize();
    const v = new THREE.Vector3().crossVectors(nrm, u).normalize();
    // tilt the orbit so the comet stays mostly above the horizon
    u.y += 0.35; u.normalize(); v.y += 0.25; v.normalize();
    comets.push({ head, tail, u, v, w: rng.range(0.035, 0.06) * (k % 2 ? -1 : 1), ph: rng.range(0, 6), len: rng.range(120, 200) });
  }
  const cP = new THREE.Vector3(), cV = new THREE.Vector3(), bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), cm = new THREE.Matrix4();
  const updateComets = (time: number) => {
    for (const c of comets) {
      const a = time * c.w + c.ph;
      cP.copy(c.u).multiplyScalar(Math.cos(a)).addScaledVector(c.v, Math.sin(a)).normalize();
      cV.copy(c.u).multiplyScalar(-Math.sin(a)).addScaledVector(c.v, Math.cos(a)).multiplyScalar(Math.sign(c.w));
      // fade out near/below the horizon: a comet streaking under the (glass) road read as a laser beam below the deck
      const vis = clamp01((cP.y - 0.04) / 0.14);
      c.head.material.opacity = vis;
      (c.tail.material as THREE.MeshBasicMaterial).opacity = vis;
      c.head.visible = c.tail.visible = vis > 0.01;
      cP.multiplyScalar(820);
      c.head.position.copy(cP);
      bx.copy(cV).normalize().multiplyScalar(-1);
      bz.copy(cP).normalize().multiplyScalar(-1);
      by.crossVectors(bz, bx).normalize();
      bx.crossVectors(by, bz).normalize();
      cm.makeBasis(bx, by, bz);
      c.tail.quaternion.setFromRotationMatrix(cm);
      c.tail.position.copy(cP);
      c.tail.scale.set(c.len, c.len * 0.14, 1);
    }
  };
  updateComets(0);

  // ───────── star dust under the road edges + drifting space dust ─────────
  {
    const pts: number[] = [], cols: number[] = [], sizes: number[] = [];
    const palette = [C.cyan, C.pink, C.gold, C.violet, '#ffffff'];
    const step = Math.max(2, Math.round(2.5 / track.spacing / Math.max(0.4, quality.particles)));
    for (let i = 0; i < track.n; i += step) {
      for (const side of [-1, 1]) {
        const d = side * (track.hw[i]! + rng.range(0.4, 2.5));
        const f = frameAtIndex(track, i, d);
        pts.push(f.x, f.y - rng.range(0.8, 6), f.z);
        const c = new THREE.Color(rng.pick(palette)).multiplyScalar(1.8);
        cols.push(c.r, c.g, c.b);
        sizes.push(rng.range(0.6, 1.4));
      }
    }
    const dust = createTwinkles(bin, rng, pts, cols, sizes, { size: 0.35, attenuate: true, twinkle: 0.8, speed: 2.4, wander: 0.8, fog: true });
    if (dust) { root.add(dust.points); fields.push(dust); }
  }
  const spaceDust = createPrecip(bin, rng, { count: Math.round(900 * quality.particles), box: [80, 40, 80], fall: 0.05, sway: 2, drift: [0.2, 0.1], size: 0.08, color: '#cfc8ff', opacity: 0.8, additive: true });
  root.add(spaceDust.points);
  fields.push(spaceDust);

  sh.dispose();

  // ───────── movers ─────────
  const movers = new MoverAnimator();
  const mShapes = new Shapes();
  const mRng = new Rng(seed + 55);
  const meteorRock = (() => {
    const b = new GeoBatch();
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2 + mRng.range(-0.25, 0.25), e = mRng.range(-1.1, 1.1);
      const g = lumpy(mShapes.dodeca(), mRng, 0.3);
      b.add(g, (_x, y, _z, out) => { out.set('#241c2e').lerp(new THREE.Color('#5a4a70'), clamp01(y * 0.6 + 0.5)); },
        trs(Math.cos(a) * Math.cos(e) * 0.9, Math.sin(e) * 0.9, Math.sin(a) * Math.cos(e) * 0.9, a, 0.42, 0.26, 0.42, e + Math.PI / 2));
      g.dispose();
    }
    return bin.add(b.geometry()!);
  })();
  const coreGeo = bin.add(new THREE.IcosahedronGeometry(0.93, 2));
  // molten surface: dark violet crust plates over glowing magma (animated), rock chunks on top
  const coreMat = lavaMaterial(bin, { crust: '#2a1030', mid: '#ff4a10', hot: '#ffb347', intensity: 1.15, useUv: true, uvScale: [4, 3], flow: 0.8, flowDir: [0.4, 1] });
  const crystalGeo = bin.add(new THREE.OctahedronGeometry(1, 0));
  const crystalMat = bin.add(new THREE.MeshBasicMaterial({ color: new THREE.Color(C.cyan).multiplyScalar(0.95) }));
  const ringGeoM = bin.add(new THREE.TorusGeometry(1.5, 0.08, 6, 32));
  const trailMat = bin.add(new THREE.MeshBasicMaterial({ map: tailTex, color: new THREE.Color('#ff9a4a').multiplyScalar(1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
  function createMover(look: string): THREE.Object3D {
    const k = look.toLowerCase();
    if (k.includes('meteor') || k.includes('comet') || k.includes('rock') || k.includes('asteroid')) {
      const r = 1.6;
      const halo = new THREE.Sprite(bin.add(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color('#ff6a2a').multiplyScalar(1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
      const ph = Math.random() * 6;
      const trail = new THREE.Group();
      const { root: mr, heading, body } = movers.make('tumble', r, (_dt, time, speed) => {
        const fl = 0.8 + 0.2 * Math.sin(time * 17 + ph);
        halo.scale.setScalar(r * 4.5 * fl);
        trail.scale.set(1, 1, 0.5 + Math.min(0.8, speed * 0.15));
      });
      body.position.y = r + 0.5;
      const rock = new THREE.Mesh(meteorRock, mats.matte);
      rock.scale.setScalar(r);
      rock.castShadow = true;
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.scale.setScalar(r);
      body.add(rock, core);
      halo.position.y = r + 0.5;
      // ONE tail card pointing backwards (−Z), attached to the heading (not tumbling), rolled about its own axis to
      // face each rendering camera. Two fixed crossed planes left one edge-on to the chase camera (meteors sweep across
      // the road, so it sees their tails side-on), where it collapsed into a hard orange laser line.
      const t = new THREE.Mesh(tailGeo, trailMat);
      t.scale.set(7, 1.5, 1);
      t.rotation.set(0, Math.PI / 2, 0, 'ZYX'); // roll (x) first, then turn the +X tail to point backwards (−Z)
      t.onBeforeRender = (_r, _s, camera) => {
        camLocal.setFromMatrixPosition(camera.matrixWorld);
        trail.worldToLocal(camLocal);
        // after Ry(π/2) the card normal is (cos x, −sin x, 0) in trail space: aim it at the camera across the axis
        t.rotation.x = Math.atan2(-camLocal.y, camLocal.x);
        t.updateMatrix();
        t.matrixWorld.multiplyMatrices(trail.matrixWorld, t.matrix);
      };
      trail.add(t);
      trail.position.y = r + 0.5;
      heading.add(trail, halo);
      return mr;
    }
    const { root: mr, body } = movers.make('wobble', 1.4, (_dt, time) => { body.rotation.y = time * 1.5; });
    const cr = new THREE.Mesh(crystalGeo, crystalMat);
    cr.scale.set(1.1, 1.6, 1.1);
    cr.position.y = 2;
    const ring = new THREE.Mesh(ringGeoM, mats.glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2;
    body.add(cr, ring);
    return mr;
  }

  const axisQ = new THREE.Quaternion();
  return {
    environment: GALAXY_ENV,
    update(dt, time, camera) {
      for (const sp of P.spinners) {
        axisQ.setFromAxisAngle(sp.axis, sp.speed * dt);
        sp.obj.quaternion.multiply(axisQ);
      }
      auroraMat.uniforms.uTime!.value = time;
      coreMat.uniforms.uTime!.value = time;
      updateComets(time);
      for (const c of bigComets) {
        c.g.position.set(c.base.x, c.base.y + Math.sin(time * 0.35 + c.ph) * 2.5, c.base.z);
        const fl = 1 + 0.05 * Math.sin(time * 3.1 + c.ph) + 0.03 * Math.sin(time * 7.7);
        for (const t of c.tails) t.scale.set(fl, 1 + 0.08 * Math.sin(time * 1.7 + c.ph), 1);
        c.g.updateMatrixWorld(true);
      }
      // roll each tail card about its own axis so its face (local +Z) points at the camera (onBeforeRender re-rolls
      // it for every other camera that renders it)
      for (let k = 0; k < tailCards.length; k++) {
        const tc = tailCards[k]!;
        rollToCamera(tc.axis, tc.card, camera);
      }
      const vh = viewHeight(ctx.renderer);
      for (const f of fields) f.update(time, camera, vh);
      sky.follow(camera);
      movers.update(dt, time);
      for (const u of P.updaters) u(dt, time);
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
