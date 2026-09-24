/**
 * Dev preview for the meadow / beach / canyon / city scenery.
 *   /dev/scenery-a.html?theme=meadow&quality=high&pit=1&mirror=0&animate=1&pipe=1&mesh=0
 *   pipe=1 (default) renders through the real render pipeline (sky dome, fog, sun/hemi, HDR bloom);
 *   pipe=0 uses a local stand-in. mesh=1 draws the real track mesh instead of the quick grey ribbon.
 *   track=<id> builds the theme around another catalog track (robustness).
 *   Movers are posed like game/race-session.ts (outer group + sim yaw + HARD_LOOKS roll on the
 *   returned object); movers=direct places the returned object itself.
 * window.__saSetView(name) renders one view and returns render stats; window.__saViews lists them.
 * window.__saLook(px,py,pz, tx,ty,tz, fov?, t?, frames?) renders a free camera (QA close-ups);
 * __saScene / __saTrack / __saCamera / __saTHREE are exposed for probes.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildTrack, getBuiltTrack } from '../../sim/track-builder.js';
import { getTrackDef } from '../../sim/tracks/index.js';
import { TRACK_CATALOG } from '../../sim/tracks/catalog.js';
import { pointAt } from '../../sim/track-query.js';
import type { BuiltTrack, ThemeId, TrackDef } from '../../sim/types.js';
import { QUALITY_PRESETS, type RenderPipeline, type ResolvedQuality, type SceneryHandle } from '../render/contracts.js';
import { THEME_PALETTES } from '../render/theme-palette.js';
import { getSceneryBuilder } from '../render/themes/index.js';
import { createSkyDome } from '../render/sky.js';
import { createRenderPipeline } from '../render/renderer.js';

declare global {
  interface Window {
    __saReady?: boolean;
    __saError?: string;
    __saViews?: string[];
    __saSetView?: (name: string, time?: number) => Record<string, number | string>;
    __saStats?: () => Record<string, number>;
  }
}

const qs = new URLSearchParams(location.search);
const theme = (qs.get('theme') ?? 'meadow') as ThemeId;
const qLevel = (qs.get('quality') ?? 'high') as ResolvedQuality;
const quality = QUALITY_PRESETS[qLevel];
const mirror = qs.get('mirror') === '1';
const wantPit = qs.get('pit') === '1';
const usePipe = qs.get('pipe') !== '0';
const useMesh = qs.get('mesh') === '1';
const hud = document.getElementById('hud')!;
const W = 1280, H = 720;

window.addEventListener('error', e => { window.__saError = String(e.message); hud.textContent = `ERROR ${e.message}`; });
window.addEventListener('unhandledrejection', e => { window.__saError = String(e.reason); hud.textContent = `ERROR ${e.reason}`; });

function trackFor(th: ThemeId): BuiltTrack {
  // ?track=<id> builds this theme's scenery around any other track (robustness checks)
  const meta = TRACK_CATALOG.find(t => t.id === qs.get('track')) ?? TRACK_CATALOG.find(t => t.theme === th)!;
  if (!wantPit) return getBuiltTrack(meta.id, mirror);
  const def = getTrackDef(meta.id);
  const m = def.points.length;
  const pitDef: TrackDef = {
    ...def,
    edges: [
      ...(def.edges ?? []),
      { from: m * 0.16, to: m * 0.26, side: 'right', kind: 'pit' },
      { from: m * 0.58, to: m * 0.66, side: 'both', kind: 'pit' },
    ],
  };
  return buildTrack(pitDef, { mirror });
}

const track = trackFor(theme);
const pal = THEME_PALETTES[theme];

const container = document.getElementById('app')!;
container.style.width = `${W}px`;
container.style.height = `${H}px`;

let pipeline: (RenderPipeline & { stats?: { calls: number; triangles: number } }) | null = null;
let renderer: THREE.WebGLRenderer;
if (usePipe) {
  pipeline = createRenderPipeline(container, qLevel);
  renderer = pipeline.renderer;
  pipeline.resize();
} else {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, W / H, 0.3, 2400);

// ── quick road ribbon (so the corridor is visible) ──
function roadMesh(t: BuiltTrack): THREE.Group {
  const g = new THREE.Group();
  const strip = (d0: (i: number) => number, d1: (i: number) => number, lift: number, color: string) => {
    const pos: number[] = [], ind: number[] = [];
    for (let k = 0; k <= t.n; k++) {
      const i = k % t.n;
      for (const d of [d0(i), d1(i)]) pos.push(t.px[i]! + t.rx[i]! * d, t.py[i]! + t.ry[i]! * d + lift, t.pz[i]! + t.rz[i]! * d);
      if (k > 0) { const a = (k - 1) * 2; ind.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(ind);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    g.add(mesh);
  };
  strip(i => -t.hw[i]!, i => t.hw[i]!, 0.05, pal.road);
  strip(i => -t.hw[i]! + 0.3, i => -t.hw[i]! + 0.7, 0.07, pal.roadLine);
  strip(i => t.hw[i]! - 0.7, i => t.hw[i]! - 0.3, 0.07, pal.roadLine);
  strip(i => -t.wallL[i]!, i => -t.hw[i]!, 0.0, pal.groundAlt);
  strip(i => t.hw[i]!, i => t.wallR[i]!, 0.0, pal.groundAlt);
  // barrier posts
  const post = new THREE.BoxGeometry(0.5, 1, 0.5);
  const mat = new THREE.MeshStandardMaterial({ color: pal.barrierB, roughness: 0.6 });
  const count = Math.floor(t.n / 3) * 2 + 2;
  const inst = new THREE.InstancedMesh(post, mat, count);
  const m = new THREE.Matrix4();
  let c = 0;
  for (let i = 0; i < t.n && c < count - 1; i += 3) {
    for (const side of [-1, 1]) {
      const edge = side < 0 ? t.edgeL[i]! : t.edgeR[i]!;
      if (edge === 2) continue;
      const d = side < 0 ? -t.wallL[i]! : t.wallR[i]!;
      m.makeTranslation(t.px[i]! + t.rx[i]! * d, t.py[i]! + t.ry[i]! * d + 0.5, t.pz[i]! + t.rz[i]! * d);
      inst.setMatrixAt(c++, m);
    }
  }
  inst.count = c;
  inst.castShadow = true;
  g.add(inst);
  return g;
}

let road: THREE.Object3D = new THREE.Group();
let roadUpdate: ((dt: number, time: number) => void) | null = null;
async function makeRoad(): Promise<void> {
  if (useMesh) {
    try {
      const mod = await import('../render/track-mesh.js');
      const tm = mod.buildTrackMesh(track, theme, quality);
      road = tm.group;
      roadUpdate = (dt, time) => tm.update(dt, time);
      scene.add(road);
      return;
    } catch (e) {
      console.warn('track-mesh unavailable, using ribbon', e);
    }
  }
  road = roadMesh(track);
  scene.add(road);
}

const tBuild0 = performance.now();
const handle: SceneryHandle = getSceneryBuilder(theme)({ scene, track, quality, renderer });
const buildMs = performance.now() - tBuild0;
const env = handle.environment;

// ── environment ──
let composer: EffectComposer | null = null;
let standinSky: ReturnType<typeof createSkyDome> | null = null;
const sunDir = new THREE.Vector3(...env.sunDir).normalize();
let sun: THREE.DirectionalLight | null = null;
if (pipeline) {
  pipeline.applyEnvironment(scene, env);
} else {
  standinSky = createSkyDome();
  standinSky.setEnvironment(env);
  scene.add(standinSky.mesh);
  scene.fog = new THREE.Fog(env.fogColor, env.fogNear * quality.drawDistance, env.fogFar * quality.drawDistance);
  scene.add(new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity));
  sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 600 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  renderer.toneMappingExposure = env.exposure;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (quality.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), env.bloomStrength, 0.55, env.night ? 0.62 : 0.86));
  composer.addPass(new OutputPass());
}

// ── movers on the track + a lineup of every look ──
const looks: Record<string, string[]> = {
  meadow: ['sheep', 'mystery'], beach: ['crab', 'mystery'], canyon: ['boulder', 'mystery'], city: ['car', 'bus', 'mystery'],
  snow: [], jungle: [], volcano: [], galaxy: [],
};
// Movers are driven exactly like game/race-session.ts: the scenery object sits inside an `outer`
// group that gets the sim pose (sweep yaw faces the lateral travel direction), and HARD_LOOKS get
// their returned object rolled about local X by distance / radius. ?movers=direct places the
// returned object itself (the old preview behaviour).
const HARD_LOOKS = new Set(['boulder', 'snowball', 'log', 'meteor', 'rock', 'lava']);
const directMovers = qs.get('movers') === 'direct';
const movers: Array<{ obj: THREE.Object3D; inner: THREE.Object3D; s: number; d: number; amp: number; period: number; phase: number; kind: string; rolls: boolean; radius: number; lastX: number; lastZ: number }> = [];
const addMover = (look: string, s: number, d: number, amp: number, period: number, phase: number, kind: string, radius: number) => {
  const inner = handle.createMover(look);
  const obj = directMovers ? inner : new THREE.Group().add(inner);
  scene.add(obj);
  movers.push({ obj, inner, s, d, amp, period, phase, kind, rolls: !directMovers && HARD_LOOKS.has(look), radius, lastX: NaN, lastZ: NaN });
};
for (const mv of track.movers) addMover(mv.look, mv.s, mv.d, mv.amplitude ?? 0, mv.period, mv.phase ?? 0, mv.kind, mv.radius);
const lineupS = track.grid[0]!.s + 16;
(looks[theme] ?? []).forEach((look, k, arr) => addMover(look, lineupS, (k - (arr.length - 1) / 2) * 4.5, 0, 1, 0, 'static', 1.5));
function placeMovers(time: number): void {
  for (const m of movers) {
    let s = m.s, d = m.d, yawOff = 0;
    if (m.kind === 'sweep') {
      const a = (time / m.period) * Math.PI * 2 + m.phase;
      d = m.d + m.amp * Math.sin(a);
      yawOff = m.amp * Math.cos(a) >= 0 ? -Math.PI / 2 : Math.PI / 2;
    } else if (m.kind === 'travel') s = m.s + ((time / m.period + m.phase) % 1) * track.length;
    const p = pointAt(track, s, d);
    m.obj.position.set(p.x, p.y, p.z);
    m.obj.rotation.y = m.kind === 'static' ? p.yaw + Math.PI : p.yaw + (directMovers ? 0 : yawOff);
    if (m.rolls && Number.isFinite(m.lastX)) m.inner.rotation.x += Math.hypot(p.x - m.lastX, p.z - m.lastZ) / Math.max(0.5, m.radius);
    m.lastX = p.x; m.lastZ = p.z;
  }
}

// ── views ──
const views: Record<string, () => void> = {};
function trackCam(s: number, back: number, up: number, ahead: number, lateral = 0): void {
  const a = pointAt(track, s - back, lateral);
  const b = pointAt(track, s + ahead, lateral * 0.5);
  camera.position.set(a.x, a.y + up, a.z);
  camera.lookAt(b.x, b.y + 1.2, b.z);
}
let cx = 0, cz = 0, r = 0;
{
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) { minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!); minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!); }
  cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2; r = Math.hypot(maxX - minX, maxZ - minZ) / 2;
}
views.kart = () => { camera.fov = 70; trackCam(track.grid[0]!.s, 6, 2.6, 14); };
views.kart2 = () => { camera.fov = 70; trackCam(track.length * 0.3, 6, 2.6, 14); };
views.kart3 = () => { camera.fov = 70; trackCam(track.length * 0.55, 6, 2.6, 14); };
views.kart4 = () => { camera.fov = 70; trackCam(track.length * 0.8, 6, 2.6, 14); };
views.back = () => { camera.fov = 70; const a = pointAt(track, track.grid[0]!.s + 8, 0), b = pointAt(track, track.grid[0]!.s - 20, 0); camera.position.set(a.x, a.y + 2.6, a.z); camera.lookAt(b.x, b.y + 1.2, b.z); };
// intro-flyover style: ~30 m above the road, looking ahead with the horizon in frame
views.intro = () => { camera.fov = 60; const a = pointAt(track, track.startS + track.length * 0.12, 0), b = pointAt(track, track.startS + track.length * 0.12 + 90, 0); camera.position.set(a.x, a.y + 30, a.z); camera.lookAt(b.x, b.y + 6, b.z); };
views.intro2 = () => { camera.fov = 60; const a = pointAt(track, track.length * 0.62, 0), b = pointAt(track, track.length * 0.62 + 90, 0); camera.position.set(a.x, a.y + 30, a.z); camera.lookAt(b.x, b.y + 6, b.z); };
views.aerial = () => { camera.fov = 55; camera.position.set(cx + r * 0.2, r * 1.25 + 60, cz + r * 1.35); camera.lookAt(cx, 0, cz); };
views.aerial2 = () => { camera.fov = 55; camera.position.set(cx - r * 1.1, 70, cz - r * 0.9); camera.lookAt(cx, 0, cz); };
views.top = () => { camera.fov = 60; camera.position.set(cx, r * 2.2, cz + 1); camera.lookAt(cx, 0, cz); };
views.movers = () => { camera.fov = 45; trackCam(lineupS, 12, 3.2, 0); };
track.landmarks.forEach((l, k) => {
  views[`lm${k}-${l.kind}`] = () => {
    camera.fov = 60;
    const d = l.side === 'left' ? -l.dist : l.side === 'right' ? l.dist : 0;
    const p = pointAt(track, l.s, d);
    const e = pointAt(track, l.s - 45, -d * 0.2);
    camera.position.set(e.x, Math.max(e.y, p.y) + 7, e.z);
    camera.lookAt(p.x, p.y + 8, p.z);
  };
});
for (let i = 0; i < track.n; i++) {
  if (track.edgeR[i] === 2 || track.edgeL[i] === 2) {
    const s = (i + 12) * track.spacing;
    views.pitTop = () => { camera.fov = 60; const a = pointAt(track, s - 40, 0), b = pointAt(track, s, 0); camera.position.set(a.x, a.y + 45, a.z); camera.lookAt(b.x, b.y - 10, b.z); };
    views.pit = () => { camera.fov = 65; const side = track.edgeR[i] === 2 ? 1 : -1; const a = pointAt(track, s - 16, -side * 4); const b = pointAt(track, s + 10, side * (track.hw[i]! + 18)); camera.position.set(a.x, a.y + 5, a.z); camera.lookAt(b.x, b.y - 14, b.z); };
    break;
  }
}
window.__saViews = Object.keys(views);
Object.assign(window, { __saScene: scene, __saTrack: track, __saCamera: camera, __saTHREE: THREE });

let time = Number(qs.get('t') ?? 3);
const tmpV = new THREE.Vector3();
function renderFrame(dt: number): void {
  // game order: movers (glue) → scenery.update → render
  placeMovers(time);
  handle.update(dt, time, camera);
  roadUpdate?.(dt, time);
  camera.updateProjectionMatrix();
  camera.getWorldDirection(tmpV).multiplyScalar(40).add(camera.position);
  if (pipeline) {
    pipeline.setShadowFocus(tmpV.x, tmpV.y, tmpV.z);
    pipeline.render(scene, [{ camera, viewport: { x: 0, y: 0, w: W, h: H }, speedLines: 0, inkAmount: 0 }], dt);
  } else {
    standinSky!.update(time);
    sun!.target.position.copy(tmpV);
    sun!.position.copy(tmpV).addScaledVector(sunDir, 250);
    renderer.info.reset();
    composer!.render(dt);
  }
}

function frameStats(): { calls: number; triangles: number } {
  const st = pipeline?.stats;
  if (st) return { calls: st.calls, triangles: st.triangles };
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}

/** Scenery-only cost: plain renders (with / without the shadow pass), road/movers/sky hidden. */
window.__saStats = () => {
  const hidden: THREE.Object3D[] = [road, ...movers.map(m => m.obj)];
  scene.traverse(o => { if (o.name === 'pipeline-environment') hidden.push(...o.children.filter(c => !(c as THREE.Light).isLight)); });
  if (standinSky) hidden.push(standinSky.mesh);
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
  hidden.forEach(o => (o.visible = true));
  return { callsMain: main.calls, trisMain: main.triangles, callsWithShadow: withShadow.calls, trisWithShadow: withShadow.triangles, buildMs: Math.round(buildMs) };
};

/** Leak probe: dispose the scenery and report GPU memory before/after. */
(window as unknown as { __saDispose: () => Record<string, number> }).__saDispose = () => {
  const before = { g: renderer.info.memory.geometries, t: renderer.info.memory.textures };
  handle.dispose();
  for (const m of movers) m.obj.removeFromParent();
  renderer.info.reset();
  renderer.render(scene, camera);
  let left = 0;
  scene.traverse(o => { if (o !== scene) left++; });
  return { geoBefore: before.g, texBefore: before.t, geoAfter: renderer.info.memory.geometries, texAfter: renderer.info.memory.textures, sceneObjectsLeft: left };
};

window.__saSetView = (name: string, t?: number) => {
  (views[name] ?? views.kart!)();
  if (t !== undefined) time = t;
  // step the animation a little so animated props settle
  for (let k = 0; k < 3; k++) { time += 1 / 60; renderFrame(1 / 60); }
  const fs = frameStats();
  const stats = { view: name, calls: fs.calls, triangles: fs.triangles, programs: renderer.info.programs?.length ?? 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  hud.textContent = `${theme} · ${qLevel} · ${name}${pipeline ? ' · pipe' : ''}\ncalls ${stats.calls} · tris ${(stats.triangles / 1000).toFixed(0)}k`;
  return stats;
};

/** Free camera: world position → target, optional fov / time / frames to step (QA close-ups). */
(window as unknown as { __saLook: (...a: number[]) => Record<string, number> }).__saLook = (px, py, pz, tx, ty, tz, fov = 60, t?: number, frames = 3) => {
  camera.fov = fov;
  camera.position.set(px!, py!, pz!);
  camera.lookAt(tx!, ty!, tz!);
  if (t !== undefined && !Number.isNaN(t)) time = t;
  for (let k = 0; k < frames; k++) { time += 1 / 60; renderFrame(1 / 60); }
  const fs = frameStats();
  hud.textContent = `${theme} · ${qLevel} · look${pipeline ? ' · pipe' : ''}\ncalls ${fs.calls} · tris ${(fs.triangles / 1000).toFixed(0)}k`;
  return { calls: fs.calls, triangles: fs.triangles };
};

void makeRoad().then(() => {
  window.__saSetView!('kart');
  window.__saReady = true;
  if (qs.get('animate') === '1') {
    let last = performance.now();
    const loop = () => { const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now; time += dt; renderFrame(dt); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
});
