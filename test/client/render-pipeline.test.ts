/**
 * Render pipeline (renderer.ts) behaviour with a recording stand-in for THREE.WebGLRenderer (no WebGL in
 * node; every other three.js class is real):
 *  - quality governor: mid-race only the pixel ratio adapts; tier changes wait for setRaceActive(false);
 *  - split screen: one shadow-map pass per frame while both views fit in one shadow box, two otherwise;
 *  - warmUp(): compiles for the HDR bloom target on high, and settles without the parallel-compile extension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('three', async importOriginal => {
  const T = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    outputColorSpace = T.SRGBColorSpace;
    toneMapping = T.NoToneMapping;
    toneMappingExposure = 1;
    autoClear = true;
    domElement = { style: {} as Record<string, string>, remove() { /* */ } };
    info = {
      autoReset: true, programs: [] as unknown[],
      render: { calls: 0, triangles: 0, points: 0, lines: 0 }, memory: { geometries: 0, textures: 0 },
      reset() { this.render.calls = 0; this.render.triangles = 0; },
    };
    extensions = { has: () => false, get: () => null };
    target: unknown = null;
    pixelRatio = 1;
    /** Sun position at each shadow pass (what the shadow map was rendered from). */
    shadowFrom: Array<[number, number, number]> = [];
    compileTargets: unknown[] = [];
    shadowMap = {
      enabled: false, autoUpdate: true, needsUpdate: false, type: 0,
      render: (lights: Array<{ position: { x: number; y: number; z: number } }>) => {
        const sm = this.shadowMap;
        if (!sm.enabled || (!sm.autoUpdate && !sm.needsUpdate) || lights.length === 0) return;
        sm.needsUpdate = false;
        const p = lights[0]!.position;
        this.shadowFrom.push([p.x, p.y, p.z]);
      },
    };
    setClearColor() { /* */ }
    getClearColor(c: InstanceType<typeof T.Color>) { return c; }
    getClearAlpha() { return 1; }
    setPixelRatio(p: number) { this.pixelRatio = p; }
    setSize() { /* */ }
    setRenderTarget(t: unknown) { this.target = t; }
    getRenderTarget() { return this.target; }
    setScissorTest() { /* */ }
    setViewport() { /* */ }
    setScissor() { /* */ }
    clear() { /* */ }
    getContext() { return {}; }
    render(scene: InstanceType<typeof T.Object3D>, camera: InstanceType<typeof T.Camera>) {
      this.info.render.calls++;
      if (!(scene as InstanceType<typeof T.Scene>).isScene) return;
      scene.updateMatrixWorld();
      const lights: Array<InstanceType<typeof T.DirectionalLight>> = [];
      scene.traverseVisible(o => { const l = o as InstanceType<typeof T.DirectionalLight>; if (l.isDirectionalLight && l.castShadow) lights.push(l); });
      this.shadowMap.render(lights);
      void camera;
    }
    compileAsync = vi.fn(function (this: FakeWebGLRenderer) { this.compileTargets.push(this.target); return Promise.resolve(); });
    compile = vi.fn(function (this: FakeWebGLRenderer) { this.compileTargets.push(this.target); return new Set(); });
    dispose() { /* */ }
    forceContextLoss() { /* */ }
  }
  return { ...T, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import type { EnvironmentSettings } from '../../src/client/render/contracts.js';
import { _buildLadder, createRenderPipeline, raceLockedPixelRatio, shadowBoxesFit, type RenderPipelineExt } from '../../src/client/render/renderer.js';

type Fake = THREE.WebGLRenderer & { shadowFrom: Array<[number, number, number]>; compileTargets: unknown[]; pixelRatio: number; compileAsync: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> };

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 960, innerHeight: 540, addEventListener() { /* */ }, removeEventListener() { /* */ } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const container = { appendChild() { /* */ }, clientWidth: 960, clientHeight: 540 } as unknown as HTMLElement;
const ENV: EnvironmentSettings = {
  skyTop: '#3a8dff', skyHorizon: '#cfe8ff', skyBottom: '#ffffff', fogColor: '#cfe8ff', fogNear: 100, fogFar: 600,
  sunColor: '#ffffff', sunIntensity: 2, sunDir: [0.4, 0.8, 0.3], hemiSky: '#cfe8ff', hemiGround: '#5fbf4a',
  hemiIntensity: 1, exposure: 1, night: false, bloomStrength: 0.3,
};

function setup(quality: 'auto' | 'low' | 'medium' | 'high') {
  const pipe = createRenderPipeline(container, quality) as RenderPipelineExt;
  const scene = new THREE.Scene();
  pipe.applyEnvironment(scene, ENV);
  const cam = (x: number, z: number, yaw = 0) => {
    const c = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 2400);
    c.position.set(x, 3, z);
    c.lookAt(x + Math.sin(yaw) * 10, 2, z + Math.cos(yaw) * 10);
    c.updateMatrixWorld();
    return c;
  };
  const one = (c: THREE.PerspectiveCamera) => [{ camera: c, viewport: { x: 0, y: 0, w: 960, h: 540 }, speedLines: 0, inkAmount: 0 }];
  const two = (a: THREE.PerspectiveCamera, b: THREE.PerspectiveCamera) => [
    { camera: a, viewport: { x: 0, y: 0, w: 960, h: 270 }, speedLines: 0, inkAmount: 0 },
    { camera: b, viewport: { x: 0, y: 270, w: 960, h: 270 }, speedLines: 0, inkAmount: 0 },
  ];
  return { pipe, scene, cam, one, two, gl: pipe.renderer as Fake };
}

/** Render `seconds` of frames at `fps` (performance.now advances with them). */
function run(pipe: RenderPipelineExt, scene: THREE.Scene, views: Parameters<RenderPipelineExt['render']>[1], fps: number, seconds: number): void {
  const ft = 1000 / fps;
  for (let t = 0; t < seconds * 1000; t += ft) { now += ft; pipe.render(scene, views, ft / 1000); }
}

describe('race-locked quality ladder (pure)', () => {
  it('keeps the tier: own rungs as is, an upgrade waits at the best ratio, a downgrade steps the ratio down', () => {
    const l1 = _buildLadder(1); // low .6 .75 .9 1 | medium 1 | high 1
    expect(l1.map(r => `${r.level}@${r.pr}`)).toEqual(['low@0.6', 'low@0.75', 'low@0.9', 'low@1', 'medium@1', 'high@1']);
    expect(raceLockedPixelRatio(l1, 5, 'high')).toBe(1);
    expect(raceLockedPixelRatio(l1, 4, 'high')).toBe(0.85);
    expect(raceLockedPixelRatio(l1, 3, 'high')).toBe(0.72);
    expect(raceLockedPixelRatio(l1, 0, 'high')).toBe(0.5);   // floor
    expect(raceLockedPixelRatio(l1, 5, 'low')).toBe(1);      // upgrade waits at low's best ratio
    const l2 = _buildLadder(2); // … medium 1 1.25 1.5 | high 1.25 1.5 1.75 2
    const hi0 = l2.findIndex(r => r.level === 'high');
    expect(raceLockedPixelRatio(l2, hi0 + 1, 'high')).toBe(1.5);
    expect(raceLockedPixelRatio(l2, hi0 - 1, 'high')).toBe(1.06); // below high's lowest rung (1.25)
    for (let i = 1; i < hi0; i++) expect(raceLockedPixelRatio(l2, i - 1, 'high')).toBeLessThanOrEqual(raceLockedPixelRatio(l2, i, 'high'));
  });

  it('shared shadow box: both centres within 2·(extent − keep) per light axis', () => {
    expect(shadowBoxesFit(0, 0, 39, -39, 70, 50)).toBe(true);
    expect(shadowBoxesFit(0, 0, 41, 0, 70, 50)).toBe(false);
    expect(shadowBoxesFit(0, 0, 0, 41, 70, 50)).toBe(false);
    expect(shadowBoxesFit(0, 0, 43, 0, 70, 50, 4)).toBe(true); // hysteresis once shared
  });
});

describe('auto quality governor with a race on screen', () => {
  it('adapts only the pixel ratio mid-race, then applies the tier it settled on once the race is off', () => {
    const { pipe, scene, cam, one } = setup('auto');
    const v = one(cam(0, 0));
    expect(pipe.quality.level).toBe('high');
    pipe.setRaceActive(true);
    run(pipe, scene, v, 25, 2.5); // far too slow
    expect(pipe.quality.level).toBe('high'); // no shadow / bloom / program change mid-race
    expect(pipe.pixelRatio).toBeLessThan(1);
    expect(pipe._gov!().pending).not.toBe('');
    const pr = pipe.pixelRatio;
    pipe.setRaceActive(false); // pause / results / menu
    expect(pipe.quality.level).not.toBe('high');
    expect(pipe.pixelRatio).toBeGreaterThan(pr); // the cheaper tier gets its own ratio back
    expect(pipe._gov!().pending).toBe('');
  });

  it('defers an upgrade mid-race as well; off-race the governor changes tiers directly', () => {
    const { pipe, scene, cam, one } = setup('auto');
    const v = one(cam(0, 0));
    run(pipe, scene, v, 20, 3); // menus: drops tiers right away
    expect(pipe.quality.level).toBe('low');
    pipe.setRaceActive(true);
    run(pipe, scene, v, 60, 40); // plenty of headroom for a long time
    expect(pipe.quality.level).toBe('low');
    expect(pipe._gov!().pending).not.toBe('');
    pipe.setRaceActive(false);
    expect(pipe.quality.level).not.toBe('low');
  });

  it('a user-chosen fixed tier applies at once, race or not', () => {
    const { pipe } = setup('auto');
    pipe.setRaceActive(true);
    pipe.setQuality('low');
    expect(pipe.quality.level).toBe('low');
    pipe.setQuality('high');
    expect(pipe.quality.level).toBe('high');
  });
});

describe('split-screen shadows', () => {
  it('one shadow pass for both views while the players are close, one per view when far apart', () => {
    const { pipe, scene, cam, two, one, gl } = setup('medium');
    // close together (typical duo pack): shared box, sun placed once between them
    gl.shadowFrom.length = 0;
    pipe.render(scene, two(cam(0, 0), cam(6, 4)), 1 / 60);
    expect(pipe.stats.shadowPasses).toBe(1);
    expect(gl.shadowFrom).toHaveLength(1);
    expect(gl.shadowMap.autoUpdate).toBe(true); // restored for everyone else
    const shared = gl.shadowFrom[0]!;
    // far apart: each view renders its own map from its own sun placement
    gl.shadowFrom.length = 0;
    pipe.render(scene, two(cam(0, 0), cam(260, 0)), 1 / 60);
    expect(pipe.stats.shadowPasses).toBe(2);
    expect(gl.shadowFrom).toHaveLength(2);
    expect(gl.shadowFrom[0]).not.toEqual(gl.shadowFrom[1]);
    // the shared placement sits between the two per-view ones of the close pair
    gl.shadowFrom.length = 0;
    pipe.render(scene, two(cam(0, 0), cam(6, 4)), 1 / 60); // shared again
    pipe.render(scene, one(cam(0, 0)), 1 / 60);
    pipe.render(scene, one(cam(6, 4)), 1 / 60);
    const [s, a, b] = gl.shadowFrom;
    for (let i = 0; i < 3; i++) {
      expect(s![i]).toBeCloseTo(shared[i]!, 6);
      expect(Math.abs(s![i]! - (a![i]! + b![i]!) / 2)).toBeLessThan(0.2); // (texel snapping)
    }
    // single view: one pass as before
    expect(pipe.stats.shadowPasses).toBe(1);
  });

  it('no shadows on low: no passes, nothing shared', () => {
    const { pipe, scene, cam, two, gl } = setup('low');
    pipe.render(scene, two(cam(0, 0), cam(6, 4)), 1 / 60);
    expect(pipe.stats.shadowPasses).toBe(0);
    expect(gl.shadowFrom).toHaveLength(0);
  });
});

describe('warmUp()', () => {
  it('compiles for the HDR bloom target on high and for the canvas otherwise; restores the target', async () => {
    const hi = setup('high');
    // with KHR_parallel_shader_compile: compileAsync
    (hi.gl as unknown as { extensions: { has: (n: string) => boolean } }).extensions.has = () => true;
    await hi.pipe.warmUp(hi.scene, hi.cam(0, 0));
    expect(hi.gl.compileAsync).toHaveBeenCalledTimes(1);
    expect(hi.gl.compile).not.toHaveBeenCalled();
    const t = hi.gl.compileTargets[0] as THREE.WebGLRenderTarget;
    expect(t).not.toBeNull();
    expect(t.texture.type).toBe(THREE.HalfFloatType);
    expect(hi.gl.getRenderTarget()).toBeNull();
    const med = setup('medium');
    // without the extension: synchronous compile (three.js would warn from compileAsync) + fence
    await med.pipe.warmUp(med.scene, med.cam(0, 0));
    expect(med.gl.compile).toHaveBeenCalledTimes(1);
    expect(med.gl.compileAsync).not.toHaveBeenCalled();
    expect(med.gl.compileTargets).toEqual([null]);
    // the environment (sun, fog) is bound to the compiled scene so light / fog variants match the race
    expect(med.scene.fog).not.toBeNull();
    expect(med.scene.getObjectByName('sun')).toBeDefined();
  });

  it('rejects when the renderer has no compileAsync (the caller then just starts the race)', async () => {
    const { pipe, scene, cam, gl } = setup('medium');
    (gl as unknown as { compileAsync?: unknown }).compileAsync = undefined;
    await expect(pipe.warmUp(scene, cam(0, 0))).rejects.toThrow();
  });
});
