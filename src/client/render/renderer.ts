/**
 * Render pipeline: WebGLRenderer setup, per-scene environment (sky dome, fog, sun + hemisphere
 * light), stable shadow box, single/split-screen rendering with optional bloom, screen overlays
 * (speed lines, ink) and an auto-quality governor.
 *
 * Environment objects (sky dome, sun, hemisphere light) are shared by all scenes: one group
 * named 'pipeline-environment' is re-parented into whichever registered scene is rendered, so
 * there is exactly one shadow map no matter how many scenes (race, showroom) come and go.
 * Per-scene settings are kept in a WeakMap, so discarded scenes are garbage collected.
 */
import * as THREE from 'three';
import {
  QUALITY_PRESETS,
  type EnvironmentSettings, type RenderPipeline, type RenderQuality, type ResolvedQuality, type Viewport,
} from './contracts.js';
import { createSkyDome } from './sky.js';
import { BloomChain, OverlayPass, ViewOverlay } from './post.js';
import { instanceCullingOf } from './instance-culling.js';

export const ENV_GROUP_NAME = 'pipeline-environment';
const SHADOW_EXTENT = 70;       // ± metres around the focus
const SHADOW_DIST = 160;        // light distance from the focus
const SHADOW_AHEAD = 18;        // shift the box toward where the camera looks
const CAMERA_FAR_MIN = 2400;    // metres

interface SceneEnv { env: EnvironmentSettings; fog: THREE.Fog; version: number }
export interface Rung { level: ResolvedQuality; pr: number }

const BASE_RUNGS: Rung[] = [
  { level: 'low', pr: 0.6 }, { level: 'low', pr: 0.75 }, { level: 'low', pr: 0.9 }, { level: 'low', pr: 1.0 },
  { level: 'medium', pr: 1.0 }, { level: 'medium', pr: 1.25 }, { level: 'medium', pr: 1.5 },
  { level: 'high', pr: 1.25 }, { level: 'high', pr: 1.5 }, { level: 'high', pr: 1.75 }, { level: 'high', pr: 2.0 },
];

export interface RenderStats {
  calls: number; triangles: number; points: number; lines: number;
  level: ResolvedQuality; pixelRatio: number; fps: number; auto: boolean; bloom: boolean;
  geometries: number; textures: number; programs: number;
  /** Shadow-map renders in the last frame (split screen: 1 when both views shared one shadow box). */
  shadowPasses: number;
}

export interface RenderPipelineExt extends RenderPipeline {
  /** Stats of the last render() call (whole frame, all views and passes). */
  readonly stats: RenderStats;
  /** Current pixel ratio in use. */
  readonly pixelRatio: number;
  /**
   * A race is on screen: the auto governor then only adapts the pixel ratio; tier changes (shadows, bloom,
   * i.e. shader programs) it asks for are deferred and applied when this goes false again (pause, results,
   * menus, the next race build).
   */
  setRaceActive(on: boolean): void;
  /**
   * Compile `scene`'s programs for the current quality before it is first drawn (bloom renders into an HDR
   * target, so programs are compiled for that target). Resolves once the GPU has them — through
   * KHR_parallel_shader_compile, or a fence where that extension is missing — or rejects if compileAsync is
   * unavailable. The caller caps the wait.
   */
  warmUp(scene: THREE.Scene, camera: THREE.Camera): Promise<void>;
  /** Debug snapshot of the auto-quality governor (preview/QA only). */
  readonly _gov?: () => Record<string, number | string | boolean>;
}

function deviceRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

function buildLadder(dpr: number): Rung[] {
  const out: Rung[] = [];
  for (const r of BASE_RUNGS) {
    const pr = Math.round(Math.min(r.pr, dpr, QUALITY_PRESETS[r.level].maxPixelRatio) * 100) / 100;
    const last = out[out.length - 1];
    if (!last || last.level !== r.level || Math.abs(last.pr - pr) > 1e-3) out.push({ level: r.level, pr });
  }
  return out;
}

const TIER_ORDER: Record<ResolvedQuality, number> = { low: 0, medium: 1, high: 2 };
/** Race-locked tier: each rung the governor wants below the tier's lowest rung costs this much pixel ratio. */
const RACE_PR_STEP = 0.85;
const MIN_PIXEL_RATIO = 0.5;

/**
 * Pixel ratio to use for ladder rung `i` while a race locks the tier at `level`: the rung's own ratio when it
 * is on that tier; the tier's best ratio when the governor wants a higher tier (the upgrade waits); and, when
 * it wants a lower tier, the tier's lowest ratio stepped down once more per rung below it (the downgrade's
 * saving comes from resolution until the tier can change).
 */
export function raceLockedPixelRatio(ladder: readonly Rung[], i: number, level: ResolvedQuality): number {
  const r = ladder[i]!;
  if (r.level === level) return r.pr;
  let lo = -1, hi = -1;
  for (let j = 0; j < ladder.length; j++) {
    if (ladder[j]!.level !== level) continue;
    if (lo < 0) lo = j;
    hi = j;
  }
  if (lo < 0) return r.pr;
  if (TIER_ORDER[r.level] > TIER_ORDER[level]) return ladder[hi]!.pr;
  return Math.max(MIN_PIXEL_RATIO, Math.round(ladder[lo]!.pr * Math.pow(RACE_PR_STEP, lo - i) * 100) / 100);
}
export { buildLadder as _buildLadder };

/** Minimum shadow coverage (light-space metres around its own centre) a split-screen view keeps when both
 *  views share one shadow box; the two centres may differ by 2·(SHADOW_EXTENT − SHARED_SHADOW_KEEP) per axis. */
const SHARED_SHADOW_KEEP = 50;
/** Extra separation tolerated before a shared box splits again (no flip-flopping at the threshold). */
const SHARED_SHADOW_HYST = 4;

/** Both views' shadow centres (light-space a/b coordinates) fit in one ±extent box with `keep` m to spare each. */
export function shadowBoxesFit(a0: number, b0: number, a1: number, b1: number, extent: number, keep: number, slack = 0): boolean {
  const lim = 2 * (extent - keep) + slack;
  return Math.abs(a0 - a1) <= lim && Math.abs(b0 - b1) <= lim;
}

/** Resolve once the GPU passed a fence issued now (WebGL2; polls without blocking). WebGL1: next tick. */
function waitFence(gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
  const g2 = gl as WebGL2RenderingContext;
  if (typeof g2.fenceSync !== 'function') return new Promise(r => setTimeout(r, 0));
  const sync = g2.fenceSync(g2.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return Promise.resolve();
  g2.flush();
  return new Promise(resolve => {
    const poll = () => {
      const res = g2.clientWaitSync(sync, 0, 0);
      if (res === g2.TIMEOUT_EXPIRED) { setTimeout(poll, 16); return; }
      g2.deleteSync(sync);
      resolve();
    };
    setTimeout(poll, 16);
  });
}

export function createRenderPipeline(container: HTMLElement, quality: 'auto' | ResolvedQuality): RenderPipelineExt {
  let mode: 'auto' | ResolvedQuality = quality;
  let level: ResolvedQuality = quality === 'auto' ? 'high' : quality;
  let dpr = deviceRatio();
  let ladder = buildLadder(dpr);
  let rung = 0;
  let pixelRatio = 1;

  const renderer = new THREE.WebGLRenderer({
    antialias: quality === 'auto' ? true : QUALITY_PRESETS[quality].antialias,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    depth: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  // r186 removed PCFSoftShadowMap; PCFShadowMap now does soft Vogel-disk filtering driven by shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.enabled = QUALITY_PRESETS[level].shadows;
  renderer.info.autoReset = false;
  // Per-instance shadow culling (instance-culling.ts): the shadow twins exist only inside the shadow
  // pass — three.js builds the main render list before it renders shadows, so they are shown just for
  // this call and hidden again.
  const shadowMapRender = renderer.shadowMap.render.bind(renderer.shadowMap);
  let shadowPasses = 0;
  renderer.shadowMap.render = (lights, scene, camera) => {
    const sm = renderer.shadowMap;
    // split screen reusing the first view's shadow map: three.js skips the pass, so skip the culling too
    if (!sm.enabled || (!sm.autoUpdate && !sm.needsUpdate) || lights.length === 0) { shadowMapRender(lights, scene, camera); return; }
    shadowPasses++;
    const ic = instanceCullingOf(scene);
    if (!ic) { shadowMapRender(lights, scene, camera); return; }
    if (lights.length === 1) ic.prepareShadow(lights[0]!); else ic.prepareShadowAll();
    try { shadowMapRender(lights, scene, camera); } finally { ic.restoreShadow(); }
  };
  renderer.setClearColor('#cfe8ff', 1);
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  // ── shared environment objects ──
  const envGroup = new THREE.Group();
  envGroup.name = ENV_GROUP_NAME;
  const sky = createSkyDome();
  envGroup.add(sky.mesh);
  const sun = new THREE.DirectionalLight('#fff4e0', 2.5);
  sun.name = 'sun';
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
  sc.near = 1; sc.far = SHADOW_DIST * 2;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.2;
  sun.shadow.intensity = 0.82;
  sun.shadow.mapSize.set(QUALITY_PRESETS[level].shadowMapSize, QUALITY_PRESETS[level].shadowMapSize);
  sun.target.name = 'sun-target';
  envGroup.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#cfe8ff', '#5fbf4a', 1);
  hemi.name = 'hemi';
  envGroup.add(hemi);
  const sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

  const sceneEnvs = new WeakMap<THREE.Scene, SceneEnv>();
  let boundScene: THREE.Scene | null = null;
  let boundVersion = -1;
  let boundLevel: ResolvedQuality | null = null;

  // ── post ──
  const overlayPass = new OverlayPass();
  const overlays: ViewOverlay[] = [];
  const chains: BloomChain[] = [];

  // ── sizing ──
  let cssW = 1, cssH = 1;
  let sized = false;
  let resizePending = true;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resizePending = true; }) : null;
  ro?.observe(container);
  const onWinResize = () => { resizePending = true; };
  window.addEventListener('resize', onWinResize);

  // ── governor ──
  /** A race is on screen: tier changes wait (see setRaceActive). */
  let raceActive = false;
  let lastT = 0;
  let emaFt = 1000 / 60;
  let winSum = 0, winN = 0;
  let goodMs = 0;
  let settleUntil = 0;
  let upBackoff = 4000;
  let lastUpAt = -1e9;
  let time = 0;
  let dbgTicks = 0, dbgLastFt = 0;

  const stats: RenderStats = {
    calls: 0, triangles: 0, points: 0, lines: 0, level, pixelRatio: 1, fps: 60, auto: mode === 'auto', bloom: false,
    geometries: 0, textures: 0, programs: 0, shadowPasses: 0,
  };

  const tmpDir = new THREE.Vector3();
  const bloomParams = { strength: 0.3, threshold: 0.86, radius: 0.55, exposure: 1 };
  const tmpColor = new THREE.Color();

  function preset(): RenderQuality { return QUALITY_PRESETS[level]; }

  function setPixelRatio(pr: number): void {
    pr = Math.max(0.5, pr);
    if (Math.abs(pr - pixelRatio) < 1e-3) return;
    pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, false);
  }

  function applyLevel(l: ResolvedQuality): void {
    if (l === level && boundLevel !== null) return;
    level = l;
    const q = QUALITY_PRESETS[l];
    renderer.shadowMap.enabled = q.shadows;
    sun.castShadow = q.shadows;
    if (sun.shadow.mapSize.x !== q.shadowMapSize) {
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    if (!q.bloom) disposeChains(0);
    boundVersion = -1; // re-apply fog distances etc.
  }

  function setRung(i: number): void {
    rung = Math.max(0, Math.min(ladder.length - 1, i));
    const r = ladder[rung]!;
    // mid-race only the resolution moves: a tier change recompiles shaders (a visible hitch) — it waits
    if (raceActive && r.level !== level) { setPixelRatio(raceLockedPixelRatio(ladder, rung, level)); return; }
    applyLevel(r.level);
    setPixelRatio(r.pr);
  }

  function nearestRung(l: ResolvedQuality, pr: number): number {
    let best = 0, bestD = Infinity;
    const order = { low: 0, medium: 1, high: 2 } as const;
    for (let i = 0; i < ladder.length; i++) {
      const r = ladder[i]!;
      const d = Math.abs(order[r.level] - order[l]) * 10 + Math.abs(r.pr - pr);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function disposeChains(keep: number): void {
    while (chains.length > keep) chains.pop()!.dispose();
  }

  function doResize(): { width: number; height: number } {
    const w = Math.max(1, Math.floor(container.clientWidth || window.innerWidth || 1));
    const h = Math.max(1, Math.floor(container.clientHeight || window.innerHeight || 1));
    const nd = deviceRatio();
    if (Math.abs(nd - dpr) > 1e-3) {
      dpr = nd;
      const cur = ladder[rung] ?? { level, pr: pixelRatio };
      ladder = buildLadder(dpr);
      rung = nearestRung(cur.level, cur.pr);
      if (mode === 'auto') setRung(rung);
      else setPixelRatio(Math.min(dpr, preset().maxPixelRatio));
    }
    if (w !== cssW || h !== cssH || !sized) {
      cssW = w; cssH = h;
      sized = true;
      renderer.setSize(w, h, false);   // only on change: assigning canvas.width resets the drawing buffer
    }
    resizePending = false;
    return { width: w, height: h };
  }

  function applyShared(st: SceneEnv): void {
    const env = st.env;
    const q = preset();
    sky.setEnvironment(env);
    sun.color.set(env.sunColor);
    sun.intensity = env.sunIntensity;
    sunDir.set(env.sunDir[0], env.sunDir[1], env.sunDir[2]);
    if (sunDir.lengthSq() < 1e-8) sunDir.set(0.4, 0.8, 0.3);
    sunDir.normalize();
    // keep shadows readable when the sun/moon is very low
    if (sunDir.y < 0.25) { sunDir.y = 0.25; sunDir.normalize(); }
    hemi.color.set(env.hemiSky);
    hemi.groundColor.set(env.hemiGround);
    hemi.intensity = env.hemiIntensity;
    st.fog.color.set(env.fogColor);
    st.fog.near = env.fogNear * q.drawDistance;
    st.fog.far = Math.max(st.fog.near + 1, env.fogFar * q.drawDistance);
    sun.castShadow = q.shadows;
    renderer.setClearColor(tmpColor.set(env.fogColor), 1);
  }

  function bind(scene: THREE.Scene): SceneEnv | null {
    const st = sceneEnvs.get(scene);
    if (!st) return null;
    if (envGroup.parent !== scene) scene.add(envGroup);
    if (scene.fog !== st.fog) scene.fog = st.fog;
    if (boundScene !== scene || boundVersion !== st.version || boundLevel !== level) {
      applyShared(st);
      boundScene = scene;
      boundVersion = st.version;
      boundLevel = level;
    }
    return st;
  }

  // Texel-snapped placement of the sun around a focus point (prevents shadow shimmering).
  function placeSun(fx: number, fy: number, fz: number): void {
    const L = sunDir;
    // basis identical to Matrix4.lookAt(eye, target, up=+Y): z = L, x = up × z, y = z × x
    let xx = L.z, xy = 0, xz = -L.x;
    let xl = Math.hypot(xx, xz);
    if (xl < 1e-5) { xx = 1; xz = 0; xl = 1; }
    xx /= xl; xz /= xl;
    const yx = L.y * xz - L.z * xy, yy = L.z * xx - L.x * xz, yz = L.x * xy - L.y * xx;
    const texel = (2 * SHADOW_EXTENT) / sun.shadow.mapSize.x;
    const a = Math.round((fx * xx + fy * xy + fz * xz) / texel) * texel;
    const b = Math.round((fx * yx + fy * yy + fz * yz) / texel) * texel;
    const c = fx * L.x + fy * L.y + fz * L.z;
    const tx = xx * a + yx * b + L.x * c;
    const ty = xy * a + yy * b + L.y * c;
    const tz = xz * a + yz * b + L.z * c;
    sun.target.position.set(tx, ty, tz);
    sun.position.set(tx + L.x * SHADOW_DIST, ty + L.y * SHADOW_DIST, tz + L.z * SHADOW_DIST);
  }

  let hasFocus = false;
  const focus = new THREE.Vector3();

  /** Light-space (a, b) of a world point in placeSun()'s basis (texel-snapping axes). */
  function lightAB(fx: number, fy: number, fz: number, out: { a: number; b: number }): void {
    const L = sunDir;
    let xx = L.z, xz = -L.x;
    let xl = Math.hypot(xx, xz);
    if (xl < 1e-5) { xx = 1; xz = 0; xl = 1; }
    xx /= xl; xz /= xl;
    const yx = L.y * xz, yy = L.z * xx - L.x * xz, yz = -L.y * xx;
    out.a = fx * xx + fz * xz;
    out.b = fx * yx + fy * yy + fz * yz;
  }
  /** Split screen: both views currently render from one shared shadow box. */
  let sharedShadow = false;
  const shadowC = [new THREE.Vector3(), new THREE.Vector3()];
  const ab0 = { a: 0, b: 0 }, ab1 = { a: 0, b: 0 };

  /** Per-view shadow-box centre: a little ahead of (and below) the view's camera. */
  function viewShadowCentre(cam: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    cam.getWorldDirection(tmpDir);
    tmpDir.y = 0;
    if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, 0, 1);
    tmpDir.normalize();
    const p = cam.position;
    return out.set(p.x + tmpDir.x * (SHADOW_AHEAD + 8), p.y - 2, p.z + tmpDir.z * (SHADOW_AHEAD + 8));
  }

  function tickGovernor(now: number): void {
    if (lastT > 0) {
      const ft = now - lastT;
      // gaps > 1 s are tab switches / loads; clamp the rest so one hitch can't dominate a window
      if (ft > 0 && ft < 1000) {
        const c = ft < 100 ? ft : 100;
        emaFt += (c - emaFt) * 0.08;
        if (mode === 'auto' && now >= settleUntil) { winSum += c; winN++; }
      }
      dbgLastFt = ft;
    }
    dbgTicks++;
    lastT = now;
    if (mode !== 'auto' || winSum < 1000) return;
    const avg = (1000 * winN) / winSum;
    winSum = 0; winN = 0;
    if (avg < 55 && rung > 0) {
      // an up-step that failed within 6 s doubles the wait before the next one — once per failed step,
      // not once per drop (a 2-rung fall right after an up-step used to quadruple it)
      if (now - lastUpAt < 6000) { upBackoff = Math.min(upBackoff * 2, 64000); lastUpAt = -1e9; }
      setRung(rung - (avg < 38 && rung > 1 ? 2 : 1));
      goodMs = 0;
      settleUntil = now + 1500;
    } else if (avg >= 58.5) {
      goodMs += 1000;
      if (goodMs >= upBackoff && rung < ladder.length - 1) {
        setRung(rung + 1);
        lastUpAt = now;
        goodMs = 0;
        settleUntil = now + 1500;
      }
    } else {
      goodMs = 0;
    }
  }

  // initial quality
  if (mode === 'auto') {
    rung = nearestRung('high', Math.min(1.5, dpr));
    const r = ladder[rung]!;
    level = r.level;
    boundLevel = null;
    applyLevel(r.level);
    setPixelRatio(r.pr);
  } else {
    boundLevel = null;
    applyLevel(level);
    setPixelRatio(Math.min(dpr, preset().maxPixelRatio));
  }
  doResize();

  const pipeline: RenderPipelineExt = {
    renderer,
    canvas,
    get quality() { return preset(); },
    get fps() { return 1000 / emaFt; },
    get stats() { return stats; },
    get pixelRatio() { return pixelRatio; },
    // debug hook for the preview/QA driver
    _gov: () => ({
      ticks: dbgTicks, lastFt: Math.round(dbgLastFt), mode, rung, rungs: ladder.length, winSum: Math.round(winSum), winN, goodMs, upBackoff,
      settle: Math.round(settleUntil - performance.now()), raceActive, level, pr: pixelRatio,
      pending: ladder[rung] && ladder[rung]!.level !== level ? ladder[rung]!.level : '', sharedShadow,
    }),

    setQuality(q) {
      if (q === 'auto') {
        if (mode !== 'auto') {
          mode = 'auto';
          rung = nearestRung(level, pixelRatio);
          setRung(rung);
        }
      } else {
        mode = q;
        applyLevel(q);
        setPixelRatio(Math.min(dpr, QUALITY_PRESETS[q].maxPixelRatio));
      }
      winSum = 0; winN = 0; goodMs = 0; upBackoff = 4000;
      settleUntil = performance.now() + 1000;
      stats.auto = mode === 'auto';
    },

    applyEnvironment(scene, env) {
      const copy: EnvironmentSettings = { ...env, sunDir: [env.sunDir[0], env.sunDir[1], env.sunDir[2]] };
      let st = sceneEnvs.get(scene);
      if (!st) {
        st = { env: copy, fog: new THREE.Fog(env.fogColor, env.fogNear, env.fogFar), version: 0 };
        sceneEnvs.set(scene, st);
      } else {
        st.env = copy;
        st.version++;
      }
      // drop stale environment groups (e.g. from a previous pipeline instance)
      for (let i = scene.children.length - 1; i >= 0; i--) {
        const c = scene.children[i]!;
        if (c.name === ENV_GROUP_NAME && c !== envGroup) scene.remove(c);
      }
      scene.background = null;
      boundVersion = -1;
      bind(scene);
    },

    setShadowFocus(x, y, z) {
      focus.set(x, y, z);
      hasFocus = true;
    },

    resize() {
      return doResize();
    },

    render(scene, views, dt) {
      const now = performance.now();
      tickGovernor(now);
      if (resizePending) doResize();
      if (!(dt > 0)) dt = 0;
      if (dt > 0.25) dt = 0.25;
      time += dt;
      if (time > 3600) time -= 3600;

      renderer.info.reset();
      const st = bind(scene);
      const q = preset();
      const useBloom = q.bloom;
      const exposure = st ? st.env.exposure : 1;
      renderer.toneMappingExposure = exposure;
      if (st) sky.update(time);
      const bloomStrength = st ? st.env.bloomStrength : 0.3;
      const bloomThreshold = st && st.env.night ? 0.62 : 0.86;
      const samples = q.antialias ? (pixelRatio >= 1.75 ? 2 : 4) : 0;

      const W = cssW, H = cssH;
      const single = views.length === 1;
      const v0 = views[0]?.viewport;
      const full = single && v0 !== undefined && v0.x <= 0 && v0.y <= 0 && v0.w >= W && v0.h >= H;
      renderer.setRenderTarget(null);
      if (!full) {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
        renderer.clear(true, true, false);
      }
      if (useBloom) disposeChains(Math.max(views.length, 1));
      const ic = instanceCullingOf(scene);
      shadowPasses = 0;

      // Split screen: when both views' shadow boxes fit in one (players close together), the sun is placed
      // once between them and the shadow map rendered by the first view is reused by the second.
      let shareShadow = false;
      if (st && views.length === 2 && q.shadows && renderer.shadowMap.enabled) {
        const c0 = viewShadowCentre(views[0]!.camera, shadowC[0]!), c1 = viewShadowCentre(views[1]!.camera, shadowC[1]!);
        lightAB(c0.x, c0.y, c0.z, ab0);
        lightAB(c1.x, c1.y, c1.z, ab1);
        shareShadow = shadowBoxesFit(ab0.a, ab0.b, ab1.a, ab1.b, SHADOW_EXTENT, SHARED_SHADOW_KEEP, sharedShadow ? SHARED_SHADOW_HYST : 0);
        if (shareShadow) placeSun((c0.x + c1.x) / 2, (c0.y + c1.y) / 2, (c0.z + c1.z) / 2);
      }
      sharedShadow = shareShadow;
      let shadowDrawn = false;

      try {
        for (let k = 0; k < views.length; k++) {
          const view = views[k]!;
          const vp: Viewport = view.viewport;
          const cam = view.camera;
          if (vp.w <= 0 || vp.h <= 0) continue;
          // the shared shadow map is already current: later views skip the shadow pass
          if (shareShadow && shadowDrawn) renderer.shadowMap.autoUpdate = false;
          shadowDrawn = true;
          const aspect = vp.w / vp.h;
          let projDirty = false;
          if (Math.abs(cam.aspect - aspect) > 1e-4) { cam.aspect = aspect; projDirty = true; }
          if (st) {
            // generous far plane: themes place unfogged backdrops (peak rings, clouds) well beyond the fog
            const far = Math.max(CAMERA_FAR_MIN, st.fog.far * 1.15);
            if (cam.far < far - 1) { cam.far = far; projDirty = true; }
          }
          if (projDirty) cam.updateProjectionMatrix();

          if (st && !shareShadow) {
            if (single && hasFocus) {
              cam.getWorldDirection(tmpDir);
              tmpDir.y = 0;
              if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, 0, 1);
              tmpDir.normalize();
              placeSun(focus.x + tmpDir.x * SHADOW_AHEAD, focus.y, focus.z + tmpDir.z * SHADOW_AHEAD);
            } else {
              const c = viewShadowCentre(cam, shadowC[0]!);
              placeSun(c.x, c.y, c.z);
            }
          }

          const wPx = Math.max(1, Math.round(vp.w * pixelRatio));
          const hPx = Math.max(1, Math.round(vp.h * pixelRatio));
          let ov = overlays[k];
          if (!ov) { ov = new ViewOverlay(); overlays[k] = ov; }
          ov.lineGain = st && st.env.night ? 0.62 : 1;
          ov.advance(dt, view.speedLines, view.inkAmount, wPx, hPx);
          const glY = H - vp.y - vp.h;

          if (useBloom) {
            let chain = chains[k];
            if (!chain) { chain = new BloomChain(wPx, hPx, samples); chains[k] = chain; }
            chain.ensure(wPx, hPx, samples);
            bloomParams.strength = bloomStrength;
            bloomParams.threshold = bloomThreshold;
            bloomParams.exposure = exposure;
            ic?.prepareView(cam);
            chain.renderScene(renderer, scene, cam, bloomParams);
            renderer.setViewport(vp.x, glY, vp.w, vp.h);
            renderer.setScissor(vp.x, glY, vp.w, vp.h);
            renderer.setScissorTest(true);
            chain.compositeTo(renderer, ov, exposure);
          } else {
            renderer.setViewport(vp.x, glY, vp.w, vp.h);
            renderer.setScissor(vp.x, glY, vp.w, vp.h);
            renderer.setScissorTest(true);
            ic?.prepareView(cam);
            renderer.render(scene, cam);
            if (ov.active) overlayPass.render(renderer, ov);
          }
        }

      } finally {
        renderer.shadowMap.autoUpdate = true;
      }

      // thin divider between split-screen views
      if (views.length === 2) {
        const a = views[0]!.viewport, b = views[1]!.viewport;
        renderer.getClearColor(tmpColor);
        const alpha = renderer.getClearAlpha();
        renderer.setClearColor(0x12101c, 1);
        renderer.setScissorTest(true);
        if (Math.abs(a.y + a.h - b.y) < 2 || Math.abs(b.y + b.h - a.y) < 2) {
          const yy = Math.abs(a.y + a.h - b.y) < 2 ? b.y : a.y;
          renderer.setScissor(0, H - yy - 1.5, W, 3);
          renderer.clear(true, false, false);
        } else if (Math.abs(a.x + a.w - b.x) < 2 || Math.abs(b.x + b.w - a.x) < 2) {
          const xx = Math.abs(a.x + a.w - b.x) < 2 ? b.x : a.x;
          renderer.setScissor(xx - 1.5, 0, 3, H);
          renderer.clear(true, false, false);
        }
        renderer.setClearColor(tmpColor, alpha);
      }
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, W, H);

      const info = renderer.info;
      stats.calls = info.render.calls;
      stats.triangles = info.render.triangles;
      stats.points = info.render.points;
      stats.lines = info.render.lines;
      stats.geometries = info.memory.geometries;
      stats.textures = info.memory.textures;
      stats.programs = info.programs?.length ?? 0;
      stats.level = level;
      stats.pixelRatio = pixelRatio;
      stats.fps = 1000 / emaFt;
      stats.bloom = useBloom;
      stats.auto = mode === 'auto';
      stats.shadowPasses = shadowPasses;
    },

    setRaceActive(on) {
      if (on === raceActive) return;
      raceActive = on;
      if (on || mode !== 'auto') return;
      // race over / paused / menus: apply the tier the governor settled on while it was locked
      const r = ladder[rung];
      if (!r || (r.level === level && Math.abs(r.pr - pixelRatio) < 1e-3)) return;
      const tierChange = r.level !== level;
      applyLevel(r.level);
      setPixelRatio(r.pr);
      if (tierChange) {
        // the next frames compile the new tier's programs: don't let that hitch count against it
        winSum = 0; winN = 0; goodMs = 0;
        settleUntil = performance.now() + 1500;
      }
    },

    warmUp(scene, camera) {
      const r = renderer as THREE.WebGLRenderer & { compileAsync?: THREE.WebGLRenderer['compileAsync'] };
      if (typeof r.compileAsync !== 'function') return Promise.reject(new Error('compileAsync unavailable'));
      bind(scene); // environment group, fog and shadow flags as this scene will be drawn
      const prev = renderer.getRenderTarget();
      // bloom draws the scene into an HDR target (no tone mapping, linear output): other program variants
      const rt = preset().bloom ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
      let p: Promise<unknown>;
      const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
      try {
        if (rt) renderer.setRenderTarget(rt);
        // compileAsync warns and resolves immediately without the extension: compile directly instead
        if (parallel) p = r.compileAsync(scene, camera);
        else { renderer.compile(scene, camera); p = Promise.resolve(); }
      } finally {
        if (rt) { renderer.setRenderTarget(prev); rt.dispose(); }
      }
      // Without KHR_parallel_shader_compile compileAsync resolves at once and the first draw would block on
      // every link: wait on a fence behind the compile commands instead (the GPU process compiles meanwhile).
      const gl = renderer.getContext();
      return p.then(() => (parallel ? undefined : waitFence(gl)));
    },

    dispose() {
      ro?.disconnect();
      window.removeEventListener('resize', onWinResize);
      disposeChains(0);
      overlayPass.dispose();
      envGroup.removeFromParent();
      sky.dispose();
      sun.dispose();
      hemi.dispose();
      renderer.dispose();
      // release the GL context now instead of waiting for GC (browsers cap live contexts at ~16)
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  return pipeline;
}
