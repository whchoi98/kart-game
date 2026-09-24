/**
 * Dev preview for the snow / jungle / volcano / galaxy scenery modules.
 *   /dev/scenery-b.html?theme=snow|jungle|volcano|galaxy[&track=<id>][&q=low|medium|high][&pipe=0][&mesh=0][&looks=a,b][&auto=1]
 *   pipe=1 (default) renders through the real render pipeline (sky dome, fog, lights, shadows, bloom);
 *   mesh=1 (default) draws the real track mesh (falls back to a quick ribbon).
 *   split=1 renders two stacked views (split-screen QA: sky layer + camera-following particles per view);
 *   the second camera looks from 500 m further along the course.
 * Movers are driven exactly like race-session.ts: an outer wrapper gets the sim pose (yaw = travel direction),
 * and for HARD_LOOKS the game adds roll to the returned object's rotation.x.
 * Exposes window.__ready, window.__shot(view, s, time), __sceneryStats(), __tris(), __hide(name), __dispose().
 * (__sceneryStats, not __stats: other dev pages declare a global __stats of a different type.)
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { getBuiltTrack } from '../../sim/track-builder.js';
import { pointAt } from '../../sim/track-query.js';
import type { BuiltTrack, ThemeId } from '../../sim/types.js';
import { QUALITY_PRESETS, type EnvironmentSettings, type ResolvedQuality, type SceneryHandle } from '../render/contracts.js';
import { THEME_PALETTES } from '../render/theme-palette.js';
import { createRenderPipeline, type RenderPipelineExt } from '../render/renderer.js';
import { buildScenery as snow } from '../render/themes/snow.js';
import { buildScenery as jungle } from '../render/themes/jungle.js';
import { buildScenery as volcano } from '../render/themes/volcano.js';
import { buildScenery as galaxy } from '../render/themes/galaxy.js';

const params = new URLSearchParams(location.search);
const theme = (params.get('theme') ?? 'snow') as ThemeId;
const TRACK_OF: Partial<Record<ThemeId, string>> = { snow: 'frost-peak', jungle: 'jungle-ruins', volcano: 'lava-fortress', galaxy: 'starlight-road' };
const BUILDERS = { snow, jungle, volcano, galaxy } as const;
const trackId = params.get('track') ?? TRACK_OF[theme] ?? 'frost-peak';
const qLevel = (params.get('q') ?? 'high') as ResolvedQuality;
const quality = QUALITY_PRESETS[qLevel];
const usePipe = params.get('pipe') !== '0';
const useMesh = params.get('mesh') !== '0';
const hud = document.getElementById('hud')!;
const W = 1280, H = 720;
/** Same set as race-session.ts: the game rolls these looks by adding to the returned object's rotation.x. */
const HARD_LOOKS = new Set(['boulder', 'snowball', 'log', 'meteor', 'rock', 'lava']);

const container = document.getElementById('app')!;
container.style.width = `${W}px`;
container.style.height = `${H}px`;

let pipeline: RenderPipelineExt | null = null;
let renderer: THREE.WebGLRenderer;
if (usePipe) {
  pipeline = createRenderPipeline(container, qLevel);
  renderer = pipeline.renderer;
  pipeline.resize();
} else {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, W / H, 0.2, 2600);
const split = params.get('split') === '1';
const camera2 = new THREE.PerspectiveCamera(62, W / H, 0.2, 2600);
scene.add(camera2);
scene.add(camera);

// ───────── quick road ribbon (fallback when the track-mesh module is unavailable) ─────────
function buildRoad(track: BuiltTrack): THREE.Group {
  const pal = THEME_PALETTES[track.def.theme];
  const g = new THREE.Group();
  const n = track.n;
  const cols = 8; // -hw .. hw with curb bands
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const road = new THREE.Color(pal.road), alt = new THREE.Color(pal.roadAlt), line = new THREE.Color(pal.roadLine);
  const curbA = new THREE.Color(pal.curbA), curbB = new THREE.Color(pal.curbB);
  const ds = [-1.08, -1, -0.97, -0.02, 0.02, 0.97, 1, 1.08];
  const c = new THREE.Color();
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    for (let j = 0; j < cols; j++) {
      const d = ds[j]! * track.hw[k]!;
      pos.push(track.px[k]! + track.rx[k]! * d, track.py[k]! + track.ry[k]! * d + track.rampH[k]! + 0.02, track.pz[k]! + track.rz[k]! * d);
      const stripe = Math.floor(i / 3) % 2 === 0;
      if (j === 0 || j === cols - 1) c.copy(stripe ? curbA : curbB);
      else if (j === 1 || j === cols - 2) c.copy(line);
      else if ((j === 3 || j === 4) && Math.floor(i / 4) % 3 === 0) c.copy(line);
      else c.copy(road).lerp(alt, 0.15 + 0.1 * Math.sin(i * 0.37 + j));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  g.add(mesh);
  return g;
}

// ───────── stand-in sky + lights (pipe=0 only) ─────────
function applyStandIn(env: EnvironmentSettings): { sun: THREE.DirectionalLight; dome: THREE.Mesh; composer: EffectComposer } {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(2000, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: { top: { value: new THREE.Color(env.skyTop) }, hor: { value: new THREE.Color(env.skyHorizon) }, bot: { value: new THREE.Color(env.skyBottom) } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'uniform vec3 top,hor,bot; varying vec3 vD; void main(){ float h=vD.y; vec3 c = h>0. ? mix(hor, top, pow(smoothstep(0.,0.6,h),0.8)) : mix(hor, bot, smoothstep(0.,-0.25,h)); gl_FragColor=vec4(c,1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
      side: THREE.BackSide, depthWrite: false, fog: false,
    }),
  );
  dome.renderOrder = -100;
  dome.frustumCulled = false;
  scene.add(dome);
  scene.fog = new THREE.Fog(env.fogColor, env.fogNear * quality.drawDistance, env.fogFar * quality.drawDistance);
  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 600 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity));
  renderer.toneMappingExposure = env.exposure;
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (quality.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), env.bloomStrength, 0.45, env.night ? 0.62 : 0.86));
  composer.addPass(new OutputPass());
  return { sun, dome, composer };
}

const track = getBuiltTrack(trackId);
const t0 = performance.now();
const handle: SceneryHandle = BUILDERS[theme as keyof typeof BUILDERS]({ scene, track, quality, renderer });
const buildMs = performance.now() - t0;

let road: THREE.Object3D = new THREE.Group();
let roadUpdate: ((dt: number, time: number) => void) | null = null;
let meshKind = 'ribbon';
async function makeRoad(): Promise<void> {
  if (useMesh) {
    try {
      const mod = await import('../render/track-mesh.js');
      const tm = mod.buildTrackMesh(track, theme, quality);
      road = tm.group;
      roadUpdate = (dt, time) => tm.update(dt, time);
      scene.add(road);
      meshKind = 'track-mesh';
      return;
    } catch (e) {
      console.warn('track-mesh unavailable, using ribbon', e);
    }
  }
  road = buildRoad(track);
  scene.add(road);
}

let standIn: ReturnType<typeof applyStandIn> | null = null;
if (pipeline) pipeline.applyEnvironment(scene, handle.environment);
else standIn = applyStandIn(handle.environment);

// ───────── movers: game-faithful wrapping (see race-session.ts) ─────────
interface MoverVis { outer: THREE.Group; inner: THREE.Object3D; rolls: boolean; radius: number; lastX: number; lastZ: number; s: number; d: number; amp: number; period: number; phase: number; kind: 'sweep' | 'travel' }
const movers: MoverVis[] = [];
function addMover(look: string, m: { s: number; d: number; amp: number; period: number; phase: number; kind: 'sweep' | 'travel'; radius: number }): void {
  const inner = handle.createMover(look);
  const outer = new THREE.Group();
  outer.add(inner);
  scene.add(outer);
  movers.push({ outer, inner, rolls: HARD_LOOKS.has(look), lastX: 0, lastZ: 0, ...m });
}
for (const m of track.movers) addMover(m.look, { s: m.s, d: m.d, amp: m.amplitude ?? 0, period: m.period, phase: m.phase ?? 0, kind: m.kind, radius: m.radius });
const showcase = (params.get('looks') ?? '').split(',').filter(Boolean);
showcase.forEach((look, k) => addMover(look, { s: track.startS + 24 + k * 7, d: k % 2 ? 3 : -3, amp: 3, period: 5, phase: k, kind: 'sweep', radius: 1.5 }));

function moverPose(m: MoverVis, time: number): { x: number; y: number; z: number; yaw: number } {
  const TAU = Math.PI * 2;
  if (m.kind === 'sweep') {
    const d = m.d + m.amp * Math.sin(TAU * time / m.period + m.phase);
    const p = pointAt(track, m.s, d);
    const vd = m.amp * Math.cos(TAU * time / m.period + m.phase);
    return { x: p.x, y: p.y, z: p.z, yaw: p.yaw + (vd >= 0 ? -Math.PI / 2 : Math.PI / 2) };
  }
  const frac = time / m.period + m.phase;
  const p = pointAt(track, m.s + track.length * (frac - Math.floor(frac)), m.d);
  return { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
}
let moversInit = false;
function placeMovers(time: number): void {
  for (const m of movers) {
    const pos = moverPose(m, time);
    m.outer.position.set(pos.x, pos.y, pos.z);
    m.outer.rotation.y = pos.yaw;
    if (m.rolls && moversInit) {
      const dist = Math.hypot(pos.x - m.lastX, pos.z - m.lastZ);
      m.inner.rotation.x += dist / Math.max(0.5, m.radius);
    }
    m.lastX = pos.x; m.lastZ = pos.z;
  }
  moversInit = true;
}

function framePos(s: number, d: number, out: THREE.Vector3): number {
  const L = track.length;
  const ss = ((s % L) + L) % L;
  const i = Math.floor(ss / track.spacing) % track.n;
  out.set(track.px[i]! + track.rx[i]! * d, track.py[i]! + track.ry[i]! * d + track.rampH[i]!, track.pz[i]! + track.rz[i]! * d);
  return i;
}

// ───────── views ─────────
let view = 'kart';
let viewS = track.startS + 5;
let viewD = 0;
const look = new THREE.Vector3();
const tmp = new THREE.Vector3();
function setCamera(): void {
  camera.fov = 62;
  if (view === 'aerial' || view === 'aerial2') {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
    for (let i = 0; i < track.n; i++) { minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!); minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!); sumY += track.py[i]!; }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, r = Math.max(maxX - minX, maxZ - minZ);
    const a = view === 'aerial' ? 0.6 : 2.6;
    camera.position.set(cx + Math.sin(a) * r * 0.75, sumY / track.n + r * 0.55, cz + Math.cos(a) * r * 0.75);
    look.set(cx, sumY / track.n, cz);
  } else if (view === 'top') {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) { minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!); minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!); }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, r = Math.max(maxX - minX, maxZ - minZ);
    camera.position.set(cx, r * 1.25, cz + 1);
    look.set(cx, 0, cz);
  } else if (view === 'intro' || view === 'intro-r') {
    // matches the race intro flyover's highest point (30 m up, 24 m to the side, looking ahead)
    const side = view === 'intro' ? 24 : -24;
    framePos(viewS, side, tmp);
    camera.position.set(tmp.x, tmp.y + 30, tmp.z);
    framePos(viewS + 60, side * 0.25, look);
    look.y += 10;
  } else if (view === 'close') {
    // close-up of a point (s, d) from 14 m back along the road, a little above
    framePos(viewS, viewD, look);
    framePos(viewS - 14, viewD * 0.4, tmp);
    camera.position.set(tmp.x, tmp.y + 3.5, tmp.z);
    look.y += 1.2;
    camera.fov = 50;
  } else {
    // kart eye: behind and above a kart at s, looking down the road
    const i = framePos(viewS, viewD, tmp);
    const fx = track.tx[i]!, fz = track.tz[i]!;
    const back = view === 'chase-high' ? 14 : 7.5, up = view === 'chase-high' ? 7 : 3.2;
    camera.position.set(tmp.x - fx * back, tmp.y + up, tmp.z - fz * back);
    framePos(viewS + 22, viewD, look);
    look.y += 1.2;
    if (view === 'side') {
      const rx = track.rx[i]!, rz = track.rz[i]!;
      camera.position.set(tmp.x + rx * 26, tmp.y + 6, tmp.z + rz * 26);
      look.set(tmp.x - rx * 30, tmp.y + 8, tmp.z - rz * 30);
    }
  }
  camera.updateProjectionMatrix();
  camera.lookAt(look);
  camera.updateMatrixWorld();
  if (standIn) {
    const e = handle.environment.sunDir;
    standIn.sun.position.set(look.x + e[0] * 250, look.y + e[1] * 250, look.z + e[2] * 250);
    standIn.sun.target.position.copy(look);
    standIn.sun.target.updateMatrixWorld();
    standIn.dome.position.copy(camera.position);
  }
}

let last = { calls: 0, triangles: 0, points: 0 };
/** One game-ordered frame: movers (game) → scenery.update → render. */
function renderAt(time: number, dt = 1 / 60): typeof last {
  setCamera();
  placeMovers(time);
  roadUpdate?.(dt, time);
  handle.update(dt, time, camera);
  if (pipeline) {
    pipeline.setShadowFocus(look.x, look.y, look.z);
    if (split) {
      // second player 500 m further along; setCamera() drives the shared `camera`, so copy it out
      const s0 = viewS, lookX = look.x, lookY = look.y, lookZ = look.z;
      viewS = s0 + 500; setCamera(); camera2.copy(camera); camera2.updateMatrixWorld();
      viewS = s0; setCamera(); look.set(lookX, lookY, lookZ);
      pipeline.render(scene, [
        { camera, viewport: { x: 0, y: 0, w: W, h: H / 2 }, speedLines: 0, inkAmount: 0 },
        { camera: camera2, viewport: { x: 0, y: H / 2, w: W, h: H / 2 }, speedLines: 0, inkAmount: 0 },
      ], dt);
    } else pipeline.render(scene, [{ camera, viewport: { x: 0, y: 0, w: W, h: H }, speedLines: 0, inkAmount: 0 }], dt);
    last = { calls: pipeline.stats.calls, triangles: pipeline.stats.triangles, points: pipeline.stats.points };
  } else {
    renderer.info.reset();
    standIn!.composer.render(dt);
    last = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points };
  }
  hud.textContent = `${theme} · ${trackId} · q=${qLevel}${pipeline ? ' · pipe' : ''} · ${meshKind}\nview=${view} s=${viewS.toFixed(0)} t=${time.toFixed(2)}\ncalls=${last.calls} tris=${last.triangles} pts=${last.points}\nbuild=${buildMs.toFixed(0)}ms`;
  return last;
}

declare global {
  interface Window {
    __ready?: boolean;
    __shot?: (v: string, s: number, time: number, d?: number) => { calls: number; triangles: number; points: number };
    __info?: () => unknown;
    __tris?: () => unknown;
    __sceneryStats?: () => unknown;
    __dispose?: () => unknown;
    __hide?: (name: string) => number;
    __movers?: () => unknown;
  }
}
window.__shot = (v, s, time, d = 0) => {
  view = v;
  viewS = s;
  viewD = d;
  // warm-up frames so movers have motion history (same order as the game)
  for (let k = 8; k >= 1; k--) { setCamera(); placeMovers(time - k / 60); handle.update(1 / 60, time - k / 60, camera); }
  return renderAt(time);
};
window.__info = () => ({
  length: track.length, n: track.n, startS: track.startS, buildMs, meshKind,
  landmarks: track.landmarks.map(l => ({ kind: l.kind, s: l.s, side: l.side, dist: l.dist })),
  movers: track.movers.map(m => ({ look: m.look, s: m.s, d: m.d })),
  geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
  hasPit: Array.from(track.edgeL).some(e => e === 2) || Array.from(track.edgeR).some(e => e === 2),
});
/** Scenery-only cost: plain renders with / without the shadow pass (road, movers and pipeline sky hidden). */
window.__sceneryStats = () => {
  const hidden: THREE.Object3D[] = [road, ...movers.map(m => m.outer)];
  scene.traverse(o => { if (o.name === 'pipeline-environment') hidden.push(...o.children.filter(c => !(c as THREE.Light).isLight)); });
  if (standIn) hidden.push(standIn.dome);
  const vis = hidden.map(o => o.visible);
  hidden.forEach(o => (o.visible = false));
  renderer.setRenderTarget(null);
  renderer.info.reset();
  renderer.render(scene, camera);
  const withShadow = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  const sh = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const main = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  renderer.shadowMap.enabled = sh;
  hidden.forEach((o, k) => (o.visible = vis[k]!));
  return { callsMain: main.calls, trisMain: main.triangles, callsWithShadow: withShadow.calls, trisWithShadow: withShadow.triangles, buildMs: Math.round(buildMs) };
};
window.__tris = () => {
  const rows: Array<[string, number, number, boolean]> = [];
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const inst = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
    rows.push([m.name || m.type, Math.round(t), inst, m.castShadow]);
  });
  const byName = new Map<string, { total: number; cast: boolean; calls: number }>();
  let all = 0, cast = 0;
  for (const [name, t, inst, c] of rows) {
    const key = name.replace(/-\d+$/, '');
    const e = byName.get(key) ?? { total: 0, cast: c, calls: 0 };
    e.total += t * inst; e.calls++;
    byName.set(key, e);
    all += t * inst; if (c) cast += t * inst;
  }
  return { all, cast, groups: [...byName.entries()].map(([name, e]) => ({ name, ...e })).sort((a, b) => b.total - a.total).slice(0, 30) };
};
window.__hide = (name) => {
  let n = 0;
  scene.traverse(o => { if (o.name === name || o.name.startsWith(name + '-')) { o.visible = false; n++; } });
  return n;
};
/** World pose of each mover's first mesh (QA: rolling pivots / heading). */
window.__movers = () => movers.map(m => {
  const p = new THREE.Vector3();
  let mesh: THREE.Object3D | null = null;
  m.inner.traverse(o => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o; });
  (mesh ?? m.inner).getWorldPosition(p);
  return { root: m.outer.position.toArray().map(v => +v.toFixed(2)), mesh: p.toArray().map(v => +v.toFixed(2)), innerRotX: +m.inner.rotation.x.toFixed(3) };
});
window.__dispose = () => {
  const before = renderer.info.memory.geometries;
  handle.dispose();
  for (const m of movers) m.outer.removeFromParent();
  road.visible = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  let left = 0;
  scene.traverse(o => { if (o !== scene) left++; });
  return { geometriesBefore: before, geometriesAfter: renderer.info.memory.geometries, textures: renderer.info.memory.textures, sceneObjectsLeft: left };
};

makeRoad().then(() => {
  renderAt(0);
  window.__ready = true;
  if (params.get('auto') === '1') {
    let t = 0, prev = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now; t += dt;
      viewS += dt * 25;
      renderAt(t, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}).catch(e => { hud.textContent = `ERROR ${String(e)}`; });
