/**
 * Dev preview for the render pipeline, camera rig and particle system.
 * Served at /dev/fx.html. Driven by window.__fx (see test-results/fx/shoot.mjs), or free-running
 * when opened with ?live (keys: B boost, L look-back, I ink, S split, N night, D drift, P particles).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { getBuiltTrack } from '../../sim/track-builder.js';
import { pointAt, wrapS } from '../../sim/track-query.js';
import type { BuiltTrack } from '../../sim/types.js';
import type { EnvironmentSettings, KartPose, ParticleKind, ResolvedQuality } from '../render/contracts.js';
import { createRenderPipeline } from '../render/renderer.js';
import { createCameraRig, type CameraRigExt } from '../render/camera.js';
import { createParticleSystem, PARTICLE_KINDS } from '../render/particles.js';
import { buildTerrain } from '../render/terrain.js';
import { THEME_PALETTES } from '../render/theme-palette.js';

const params = new URLSearchParams(location.search);
const initialQuality = (params.get('quality') ?? 'high') as ResolvedQuality | 'auto';

const DAY: EnvironmentSettings = {
  skyTop: '#3a8ef0', skyHorizon: '#c4e8ff', skyBottom: '#8fcf6e',
  fogColor: '#cbe7fb', fogNear: 160, fogFar: 1050,
  sunColor: '#fff2d9', sunIntensity: 2.7, sunDir: [0.42, 0.78, 0.46],
  hemiSky: '#d2ecff', hemiGround: '#6aa84a', hemiIntensity: 1.05,
  exposure: 1.0, night: false, bloomStrength: 0.22,
};
const NIGHT: EnvironmentSettings = {
  skyTop: '#070b26', skyHorizon: '#3b2e7e', skyBottom: '#141833',
  fogColor: '#221f4c', fogNear: 80, fogFar: 650,
  sunColor: '#b4c2ff', sunIntensity: 0.75, sunDir: [-0.35, 0.62, 0.55],
  hemiSky: '#5a64b8', hemiGround: '#1a1630', hemiIntensity: 0.6,
  exposure: 1.1, night: true, bloomStrength: 0.9,
};

const track: BuiltTrack = getBuiltTrack(params.get('track') ?? 'sunny-meadow');
const pal = THEME_PALETTES[track.def.theme];
/** ?scenery → use the real theme scenery + track mesh (dynamic import so the default preview never depends on them). */
const useScenery = params.has('scenery');

// ───────────────────────────── scene ─────────────────────────────

const container = document.getElementById('view')!;
const hud = document.getElementById('hud')!;
const labels = document.getElementById('labels')!;
const pipeline = createRenderPipeline(container, initialQuality);
const scene = new THREE.Scene();

const terrain = buildTerrain(track, { ground: pal.ground, groundAlt: pal.groundAlt, hills: 12, margin: 260 });
terrain.mesh.receiveShadow = true;
const defaultWorld = new THREE.Group();
defaultWorld.name = 'fx-default-world';
if (!useScenery) scene.add(defaultWorld);
defaultWorld.add(terrain.mesh);

function buildRoad(t: BuiltTrack): THREE.Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const cRoad = new THREE.Color(pal.road), cRoadAlt = new THREE.Color(pal.roadAlt), cLine = new THREE.Color(pal.roadLine);
  const cA = new THREE.Color(pal.curbA), cB = new THREE.Color(pal.curbB);
  const cShoulder = new THREE.Color(pal.groundAlt).multiplyScalar(0.85);
  const at = (i: number, d: number, lift: number): [number, number, number] => {
    const k = i % t.n;
    return [t.px[k]! + t.rx[k]! * d, t.py[k]! + t.ry[k]! * d + t.rampH[k]! + lift, t.pz[k]! + t.rz[k]! * d];
  };
  for (let i = 0; i < t.n; i++) {
    const j = i + 1;
    const hw0 = t.hw[i % t.n]!, hw1 = t.hw[j % t.n]!;
    const bands: Array<[number, number, number, number, THREE.Color]> = [
      [-hw0 - 3.2, -hw1 - 3.2, -hw0 - 1.1, -hw1 - 1.1, cShoulder],
      [-hw0 - 1.1, -hw1 - 1.1, -hw0, -hw1, Math.floor(i / 2) % 2 ? cA : cB],
      [-hw0, -hw1, -hw0 + 0.35, -hw1 + 0.35, cLine],
      [-hw0 + 0.35, -hw1 + 0.35, hw0 - 0.35, hw1 - 0.35, Math.floor(i / 7) % 3 === 0 ? cRoadAlt : cRoad],
      [hw0 - 0.35, hw1 - 0.35, hw0, hw1, cLine],
      [hw0, hw1, hw0 + 1.1, hw1 + 1.1, Math.floor(i / 2) % 2 ? cB : cA],
      [hw0 + 1.1, hw1 + 1.1, hw0 + 3.2, hw1 + 3.2, cShoulder],
    ];
    for (const [a0, a1, b0, b1, c] of bands) {
      const lift = c === cShoulder ? 0.03 : c === cLine ? 0.07 : 0.06;
      const p00 = at(i, a0, lift), p01 = at(j, a1, lift), p10 = at(i, b0, lift), p11 = at(j, b1, lift);
      pos.push(...p00, ...p10, ...p01, ...p10, ...p11, ...p01);
      for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  return m;
}
defaultWorld.add(buildRoad(track));

function colorGeo(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const out = g.index ? g.toNonIndexed() : g;
  const n = out.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return out;
}

// toy trees + lamp posts (instanced) so shadows and night bloom have something to show
const treeGeo = mergeGeometries([
  colorGeo(new THREE.CylinderGeometry(0.28, 0.4, 2.2, 8).translate(0, 1.1, 0), '#8a5a3b'),
  colorGeo(new THREE.IcosahedronGeometry(1.9, 1).translate(0, 3.4, 0), '#3f9a35'),
  colorGeo(new THREE.IcosahedronGeometry(1.3, 1).translate(0.6, 4.6, 0.3), '#5fbf4a'),
])!;
const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 5, 8).translate(0, 2.5, 0);
const bulbGeo = new THREE.SphereGeometry(0.42, 14, 10).translate(0, 5.2, 0);
const poleMat = new THREE.MeshStandardMaterial({ color: '#3a3f55', roughness: 0.5, metalness: 0.2 });
const bulbMat = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffcf6a', emissiveIntensity: 3, roughness: 0.4 });
{
  const trees: THREE.Matrix4[] = [];
  const lamps: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let s = 0; s < track.length; s += 9) {
    for (const side of [-1, 1]) {
      const i = Math.floor(s / track.spacing) % track.n;
      const wall = side < 0 ? track.wallL[i]! : track.wallR[i]!;
      const d = side * (Math.max(wall, track.hw[i]!) + 6 + rnd() * 16);
      const p = pointAt(track, s + rnd() * 4, d);
      if (terrain.inCorridor(p.x, p.z, 3)) continue;
      if (rnd() < 0.55) {
        const sc = 0.75 + rnd() * 0.6;
        m.compose(new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) - 0.1, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28), new THREE.Vector3(sc, sc, sc));
        trees.push(m.clone());
      }
    }
    if (Math.floor(s / 9) % 4 === 0) {
      for (const side of [-1, 1]) {
        const i = Math.floor(s / track.spacing) % track.n;
        const p = pointAt(track, s, side * (track.hw[i]! + 2.4));
        m.makeTranslation(p.x, p.y - 0.1, p.z);
        lamps.push(m.clone());
      }
    }
  }
  const tm = new THREE.InstancedMesh(treeGeo, treeMat, trees.length);
  trees.forEach((mm, k) => tm.setMatrixAt(k, mm));
  tm.castShadow = true; tm.receiveShadow = true;
  defaultWorld.add(tm);
  const pm = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
  const bm = new THREE.InstancedMesh(bulbGeo, bulbMat, lamps.length);
  lamps.forEach((mm, k) => { pm.setMatrixAt(k, mm); bm.setMatrixAt(k, mm); });
  pm.castShadow = true;
  defaultWorld.add(pm, bm);
}

function makeKart(body: string, accent: string): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: body, roughness: 0.45 });
  const accMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
  const tyre = new THREE.MeshStandardMaterial({ color: '#23232b', roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: '#ffd9b3', roughness: 0.7 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  add(new RoundedBoxGeometry(1.5, 0.5, 2.3, 3, 0.2), bodyMat, 0, 0.5, 0);
  add(new RoundedBoxGeometry(1.1, 0.35, 0.8, 3, 0.15), accMat, 0, 0.62, 1.05);
  add(new RoundedBoxGeometry(1.6, 0.12, 0.4, 2, 0.05), accMat, 0, 1.05, -1.05);
  const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.34, 16).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.82, 0.78], [0.82, 0.78], [-0.85, -0.78], [0.85, -0.78]] as const) add(wheel, tyre, x, 0.36, z);
  add(new THREE.SphereGeometry(0.34, 20, 14), skin, 0, 1.12, -0.1);
  add(new THREE.SphereGeometry(0.37, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), accMat, 0, 1.17, -0.1);
  return g;
}

const karts = [makeKart('#e63946', '#ffd23f'), makeKart('#1f6feb', '#f1f1f1')];
karts.forEach(k => scene.add(k));
const particles = createParticleSystem(pipeline.quality);
scene.add(particles.object);
const rigs: CameraRigExt[] = [createCameraRig(), createCameraRig()];

// ───────────────────────────── state ─────────────────────────────

interface State {
  env: 'day' | 'night';
  mode: 'chase' | 'intro' | 'split' | 'orbit' | 'gallery' | 'still';
  split: 'horizontal' | 'vertical';
  speed: number; boost: boolean; lookBack: boolean; ink: number; drift: number; airborne: boolean;
  distance: 'near' | 'normal' | 'far';
  introT: number;
  speedLines: number | null;
  lift: number;
  /** Drift-spark emission per wheel per frame (the race session uses 1) and tint. */
  sparkCount: number;
  sparkColor: string;
}
const st: State = {
  env: 'day', mode: 'chase', split: 'horizontal', speed: 24, boost: false, lookBack: false, ink: 0, drift: 0, airborne: false,
  distance: 'normal', introT: 0, speedLines: null, lift: 0, sparkCount: 3, sparkColor: '#7ecbff',
};
const kartS = [track.grid[0]!.s, track.grid[1]!.s];
const kartD = [track.grid[0]!.d, track.grid[1]!.d];
const poses: KartPose[] = [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 0 }];
const focus = [new THREE.Vector3(), new THREE.Vector3()];
let simTime = 0;

function placeKart(k: number): void {
  const p = pointAt(track, kartS[k]!, kartD[k]!);
  const pose = poses[k]!;
  pose.x = p.x; pose.y = p.y + (k === 0 ? st.lift : 0); pose.z = p.z; pose.yaw = p.yaw;
  const g = karts[k]!;
  g.position.set(p.x, pose.y, p.z);
  g.rotation.set(0, p.yaw + (k === 0 ? st.drift : 0), 0, 'YXZ');
  focus[k]!.set(p.x, pose.y + 1.1, p.z);
}

let sceneryEnv: EnvironmentSettings | null = null;
let sceneryUpdate: ((dt: number, time: number) => void) | null = null;
function applyEnv(): void {
  pipeline.applyEnvironment(scene, sceneryEnv ?? (st.env === 'day' ? DAY : NIGHT));
  bulbMat.emissiveIntensity = st.env === 'day' ? 0.6 : 4;
}

function emitKartFx(k: number, dt: number): void {
  const pose = poses[k]!;
  const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
  const rx = -cy, rz = sy;
  const rearX = pose.x - sy * 1.25, rearZ = pose.z - cy * 1.25;
  if (st.boost) {
    particles.emit('boostFlame', rearX, pose.y + 0.55, rearZ, { dirX: -sy, dirY: 0.15, dirZ: -cy });
  }
  if (st.drift !== 0 && k === 0) {
    for (const side of [-1, 1]) {
      particles.emit('driftSpark', rearX + rx * side * 0.85, pose.y + 0.12, rearZ + rz * side * 0.85,
        { dirX: -sy * 0.6 - rx * side * 0.4, dirY: 1, dirZ: -cy * 0.6 - rz * side * 0.4, color: st.sparkColor, count: st.sparkCount });
    }
  }
  if (st.speed > 5 && Math.random() < dt * 4) {
    particles.emit('dust', rearX + rx * 0.8, pose.y + 0.15, rearZ + rz * 0.8, { dirX: -sy, dirY: 0.8, dirZ: -cy, count: 1 });
  }
}

function tick(dt: number): void {
  simTime += dt;
  const moving = st.mode === 'chase' || st.mode === 'split' || st.mode === 'orbit';
  for (let k = 0; k < 2; k++) {
    if (moving && st.mode !== 'orbit') kartS[k] = wrapS(track, kartS[k]! + (st.speed + (st.boost ? 8 : 0)) * dt * (k === 0 ? 1 : 0.97));
    placeKart(k);
  }
  const maxSpeed = 30;
  if (st.mode === 'chase' || st.mode === 'split') {
    const n = st.mode === 'split' ? 2 : 1;
    for (let k = 0; k < n; k++) {
      rigs[k]!.follow({
        pose: poses[k]!, focus: focus[k]!, speed: st.speed + (st.boost ? 8 : 0), maxSpeed,
        boosting: st.boost && k === 0, driftAngle: k === 0 ? st.drift : 0, airborne: st.airborne,
        lookBack: st.lookBack && k === 0, distance: st.distance,
      }, dt, track);
      emitKartFx(k, dt);
    }
  } else if (st.mode === 'orbit') {
    rigs[0]!.orbit(focus[0]!, dt);
  }
  particles.update(dt, rigs[0]!.camera);
  sceneryUpdate?.(dt, simTime);
  pipeline.setShadowFocus(poses[0]!.x, poses[0]!.y, poses[0]!.z);
}

let lastStats = pipeline.stats;
function renderFrame(dt: number): void {
  const size = pipeline.resize();
  const W = size.width, H = size.height;
  const sl = st.speedLines ?? (st.boost ? 1 : Math.max(0, (st.speed - 20) / 25));
  if (st.mode === 'split') {
    const views = st.split === 'horizontal'
      ? [{ camera: rigs[0]!.camera, viewport: { x: 0, y: 0, w: W, h: Math.floor(H / 2) }, speedLines: sl, inkAmount: st.ink },
        { camera: rigs[1]!.camera, viewport: { x: 0, y: Math.floor(H / 2), w: W, h: H - Math.floor(H / 2) }, speedLines: 0, inkAmount: 0 }]
      : [{ camera: rigs[0]!.camera, viewport: { x: 0, y: 0, w: Math.floor(W / 2), h: H }, speedLines: sl, inkAmount: st.ink },
        { camera: rigs[1]!.camera, viewport: { x: Math.floor(W / 2), y: 0, w: W - Math.floor(W / 2), h: H }, speedLines: 0, inkAmount: 0 }];
    views.forEach((v, k) => rigs[k]!.setAspect(v.viewport.w / v.viewport.h));
    pipeline.render(scene, views, dt);
  } else {
    rigs[0]!.setAspect(W / H);
    pipeline.render(scene, [{ camera: rigs[0]!.camera, viewport: { x: 0, y: 0, w: W, h: H }, speedLines: st.mode === 'chase' ? sl : 0, inkAmount: st.ink }], dt);
  }
  lastStats = pipeline.stats;
  hud.textContent = `mode ${st.mode}  env ${st.env}  quality ${lastStats.level}${lastStats.auto ? ' (auto)' : ''}  pr ${lastStats.pixelRatio}\n`
    + `calls ${lastStats.calls}  tris ${lastStats.triangles}  points ${lastStats.points}  fps ${lastStats.fps.toFixed(1)}  bloom ${lastStats.bloom}`;
  updateLabels();
}

// ───────────────────────────── particle gallery ─────────────────────────────

const galleryKinds: ParticleKind[] = PARTICLE_KINDS;
const galleryPts: THREE.Vector3[] = [];
const continuous = new Set<ParticleKind>(['driftSpark', 'boostFlame', 'dust', 'grassBits', 'snowPuff', 'smoke', 'starTrail', 'lavaEmber']);

let galleryRow = -1; // -1 = all rows
/** Age (s) at which each burst looks best; bursts fire so they reach it at the end of advance(). */
const SHOW_AGE: Partial<Record<ParticleKind, number>> = {
  splash: 0.3, wallSpark: 0.12, explosion: 0.28, itemBoxBurst: 0.22, coinSparkle: 0.18, confetti: 1.1,
  shrinkPoof: 0.2, inkSplat: 0.3, landingDust: 0.3,
};
const galleryShown = (i: number) => galleryRow < 0 || Math.floor(i / 6) === galleryRow;

function setupGallery(): void {
  galleryPts.length = 0;
  const s0 = kartS[0]! + 20;
  const cols = 6;
  galleryKinds.forEach((_, idx) => {
    const row = Math.floor(idx / cols), col = idx % cols;
    const rs = galleryRow < 0 ? row * 7.5 : 0;
    const p = pointAt(track, s0 + 6 + rs, (col - (cols - 1) / 2) * 3.2);
    galleryPts.push(new THREE.Vector3(p.x, p.y + 0.5, p.z));
  });
  const cam = rigs[0]!.camera;
  if (galleryRow < 0) {
    const c = pointAt(track, s0 - 6, 0), t = pointAt(track, s0 + 12, 0);
    cam.position.set(c.x, c.y + 7.5, c.z);
    cam.lookAt(t.x, t.y + 0.5, t.z);
    cam.fov = 62;
  } else {
    const c = pointAt(track, s0 - 2.5, 0), t = pointAt(track, s0 + 6, 0);
    cam.position.set(c.x, c.y + 2.6, c.z);
    cam.lookAt(t.x, t.y + 1.4, t.z);
    cam.fov = 70;
  }
  cam.updateProjectionMatrix();
}

let galleryStep = 0, galleryTotal = 1;
function galleryEmit(): void {
  const tNow = galleryStep / 60, tEnd = galleryTotal / 60;
  galleryKinds.forEach((kind, i) => {
    if (!galleryShown(i)) return;
    const p = galleryPts[i]!;
    if (continuous.has(kind)) {
      if (tEnd - tNow > 1.2) return;
      if (kind === 'boostFlame') particles.emit(kind, p.x, p.y, p.z, { dirX: 0.35, dirY: 0.2, dirZ: -1 });
      else if (kind === 'driftSpark') particles.emit(kind, p.x, p.y - 0.4, p.z, { dirX: 0.3, dirY: 1, dirZ: -0.6, color: '#7ecbff' });
      else particles.emit(kind, p.x, p.y - (kind === 'lavaEmber' ? 0.4 : 0), p.z);
    } else {
      const fireStep = Math.max(0, galleryTotal - Math.round((SHOW_AGE[kind] ?? 0.3) * 60));
      if (galleryStep === fireStep) {
        const y = kind === 'confetti' ? p.y - 0.4 : p.y;
        particles.emit(kind, p.x, y, p.z, kind === 'explosion' ? { scale: 0.6 } : undefined);
      }
    }
  });
  galleryStep++;
}

const labelEls: HTMLDivElement[] = [];
const proj = new THREE.Vector3();
function updateLabels(): void {
  const show = st.mode === 'gallery';
  labels.hidden = !show;
  if (!show) return;
  const cam = rigs[0]!.camera;
  const W = container.clientWidth, H = container.clientHeight;
  galleryKinds.forEach((kind, i) => {
    let el = labelEls[i];
    if (!el) { el = document.createElement('div'); el.textContent = kind; labels.appendChild(el); labelEls[i] = el; }
    el.hidden = !galleryShown(i);
    proj.copy(galleryPts[i]!).project(cam);
    el.style.left = `${((proj.x + 1) / 2) * W}px`;
    el.style.top = `${((1 - proj.y) / 2) * H + 14}px`;
  });
}

// ───────────────────────────── driver API ─────────────────────────────

function stepN(seconds: number, perStep?: () => void): void {
  const n = Math.max(1, Math.round(seconds * 60));
  galleryStep = 0; galleryTotal = n;
  for (let i = 0; i < n; i++) {
    perStep?.();
    tick(1 / 60);
  }
}

const api = {
  setup(o: Partial<State> & { s?: number; u?: number; d?: number; quality?: ResolvedQuality | 'auto'; reset?: boolean; row?: number; keep?: boolean }) {
    Object.assign(st, o);
    if (o.row !== undefined) galleryRow = o.row;
    if (o.quality) pipeline.setQuality(o.quality);
    if (o.s !== undefined) { kartS[0] = wrapS(track, o.s); kartS[1] = wrapS(track, o.s - 9); kartD[1] = 3; }
    if (o.u !== undefined) { kartS[0] = wrapS(track, track.uToS(o.u)); kartS[1] = wrapS(track, kartS[0]! - 9); }
    if (o.d !== undefined) kartD[0] = o.d;
    applyEnv();
    if (!o.keep) {
      particles.clear();
      rigs.forEach(r => r.reset());
    }
    if (st.mode === 'gallery') { placeKart(0); placeKart(1); setupGallery(); }
    return true;
  },
  advance(seconds: number) {
    if (st.mode === 'gallery') stepN(seconds, galleryEmit);
    else stepN(seconds);
    return true;
  },
  intro(t: number) {
    st.mode = 'intro';
    placeKart(0);
    rigs[0]!.intro(track, poses[0]!, t);
    return true;
  },
  shake(v: number) { rigs[0]!.shake(v); return true; },
  frame() { renderFrame(1 / 60); return { ...lastStats }; },
  burst(kind: ParticleKind, n = 1) {
    const p = poses[0]!;
    for (let i = 0; i < n; i++) particles.emit(kind, p.x, p.y + 0.8, p.z);
    return true;
  },
  /** Time N rendered frames (headless numbers are software-rendered: only relative). */
  bench(frames: number) {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { tick(1 / 60); renderFrame(1 / 60); }
    return { msPerFrame: (performance.now() - t0) / frames, ...lastStats };
  },
  heapCheck(frames: number) {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const before = perf.memory?.usedJSHeapSize ?? 0;
    for (let i = 0; i < frames; i++) { tick(1 / 60); }
    const after = perf.memory?.usedJSHeapSize ?? 0;
    return { before, after, deltaPerTick: (after - before) / frames };
  },
  kinds: galleryKinds,
  shapes() {
    const out: Record<string, Record<number, number>> = {};
    for (const p of particles.object.children as THREE.Points[]) {
      const par = p.geometry.getAttribute('aParams').array as Float32Array;
      const h: Record<number, number> = {};
      for (let i = 0; i < p.geometry.drawRange.count; i++) h[par[i * 4 + 2]!] = (h[par[i * 4 + 2]!] ?? 0) + 1;
      out[p.name] = h;
    }
    return out;
  },
  /** Heap growth per call of the hot paths (Chrome --enable-precise-memory-info). */
  allocProbe() {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const heap = () => perf.memory?.usedJSHeapSize ?? 0;
    const res: Record<string, number> = {};
    // particles.update with a full-ish pool
    particles.clear();
    const p = poses[0]!;
    for (let i = 0; i < 40; i++) particles.emit('confetti', p.x, p.y + 2, p.z);
    for (let i = 0; i < 20; i++) particles.emit('explosion', p.x, p.y + 1, p.z);
    const live = (particles.object.children as THREE.Points[]).reduce((a, q) => a + q.geometry.drawRange.count, 0);
    for (let i = 0; i < 200; i++) particles.update(1 / 2000, rigs[0]!.camera); // warm
    let h0 = heap();
    for (let i = 0; i < 3000; i++) particles.update(1 / 20000, rigs[0]!.camera);
    res['particles.update bytes/call'] = (heap() - h0) / 3000;
    res['particles live'] = live;
    // camera follow (fixed input object)
    const input = { pose: p, focus: focus[0]!, speed: 25, maxSpeed: 30, boosting: true, driftAngle: -0.3, airborne: false, lookBack: false, distance: 'normal' as const };
    for (let i = 0; i < 200; i++) rigs[0]!.follow(input, 1 / 60, track);
    h0 = heap();
    for (let i = 0; i < 5000; i++) rigs[0]!.follow(input, 1 / 60, track);
    res['camera.follow bytes/call'] = (heap() - h0) / 5000;
    // pipeline.render
    const view = [{ camera: rigs[0]!.camera, viewport: { x: 0, y: 0, w: container.clientWidth, h: container.clientHeight }, speedLines: 0.8, inkAmount: 0.6 }];
    for (let i = 0; i < 10; i++) pipeline.render(scene, view, 1 / 60);
    h0 = heap();
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) pipeline.render(scene, view, 1 / 60);
    res['pipeline.render ms/frame (swiftshader)'] = (performance.now() - t0) / 60;
    res['pipeline.render bytes/frame'] = (heap() - h0) / 60;
    // emit cost
    h0 = heap();
    const o = { dirX: 0, dirY: 1, dirZ: -1, color: '#7ecbff' };
    for (let i = 0; i < 5000; i++) particles.emit('driftSpark', p.x, p.y, p.z, o);
    res['particles.emit bytes/call'] = (heap() - h0) / 5000;
    particles.clear();
    return res;
  },
  /** Free-run with rAF for `seconds` in auto quality and record governor decisions. */
  autoRun(seconds: number, spinMs = 0, spinUntil = Infinity) {
    pipeline.setQuality('auto');
    st.mode = 'chase';
    return new Promise(resolve => {
      const log: string[] = [];
      let last = performance.now();
      const t0 = last;
      let prev = '';
      let lastLog = 0;
      const loop = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        tick(dt);
        renderFrame(dt);
        if (spinMs > 0 && now - t0 < spinUntil * 1000) { const e = performance.now() + spinMs; while (performance.now() < e) { /* simulate a slow GPU */ } }
        const sgn = `${lastStats.level}@${lastStats.pixelRatio}`;
        if (sgn !== prev || now - lastLog > 2000) {
          log.push(`${((now - t0) / 1000).toFixed(1)}s ${sgn} fps=${lastStats.fps.toFixed(1)} auto=${lastStats.auto} gov=${JSON.stringify((pipeline as unknown as { _gov?: () => unknown })._gov?.())}`);
          prev = sgn; lastLog = now;
        }
        if (now - t0 < seconds * 1000) requestAnimationFrame(loop);
        else resolve(log);
      };
      requestAnimationFrame(loop);
    });
  },
  counts() {
    return (particles.object.children as THREE.Points[]).map(p => ({ name: p.name, n: p.geometry.drawRange.count, visible: p.visible,
      firstPos: Array.from((p.geometry.getAttribute('position').array as Float32Array).slice(0, 3)),
      firstCol: Array.from((p.geometry.getAttribute('aColor').array as Float32Array).slice(0, 4)),
      firstPar: Array.from((p.geometry.getAttribute('aParams').array as Float32Array).slice(0, 4)) }));
  },
};
(window as unknown as { __fx: typeof api }).__fx = api;

if (useScenery) {
  try {
    const [{ getSceneryBuilder }, { buildTrackMesh }] = await Promise.all([
      import('../render/themes/index.js'), import('../render/track-mesh.js'),
    ]);
    const theme = track.def.theme;
    const scenery = getSceneryBuilder(theme)({ scene, track, quality: pipeline.quality, renderer: pipeline.renderer });
    const tmesh = buildTrackMesh(track, theme, pipeline.quality);
    scene.add(tmesh.group);
    sceneryEnv = scenery.environment;
    sceneryUpdate = (dt, time) => { scenery.update(dt, time, rigs[0]!.camera); tmesh.update(dt, time); };
  } catch (err) {
    // theme modules are owned elsewhere and may be mid-rework: fall back to the plain preview world
    console.warn('[fx] real scenery unavailable, using the default preview world:', err);
    scene.add(defaultWorld);
  }
}
applyEnv();
placeKart(0);
placeKart(1);
stepN(0.5);
renderFrame(1 / 60);
(window as unknown as { __ready: boolean }).__ready = true;

if (params.has('live')) {
  let last = performance.now();
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (k === 'b') st.boost = !st.boost;
    if (k === 'l') st.lookBack = !st.lookBack;
    if (k === 'i') st.ink = st.ink > 0 ? 0 : 1;
    if (k === 's') st.mode = st.mode === 'split' ? 'chase' : 'split';
    if (k === 'n') { st.env = st.env === 'day' ? 'night' : 'day'; applyEnv(); }
    if (k === 'd') st.drift = st.drift !== 0 ? 0 : -0.45;
    if (k === 'p') api.burst('explosion');
  });
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (st.ink > 0) st.ink = Math.max(0, st.ink - dt * 0.12);
    tick(dt);
    renderFrame(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
