/**
 * GameView lifecycle tests: start / restart / end races around the async scene build.
 * requestAnimationFrame and document are stubbed; render modules are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterId, RaceConfig } from '../../src/sim/types.js';

const views = vi.hoisted(() => ({
  pipeline: null as null | ReturnType<typeof import('./game-harness.js').fakePipeline>,
  showroom: null as null | { scene: import('three').Scene; show: ReturnType<typeof vi.fn> },
}));

vi.mock('../../src/client/render/kart-model.js', async () => {
  const h = await import('./game-harness.js');
  return { createKartVisual: (id: CharacterId) => h.fakeKartVisual(id) };
});
vi.mock('../../src/client/render/item-models.js', async () => {
  const h = await import('./game-harness.js');
  return { createPickupVisuals: () => h.fakePickups(), createProjectileVisuals: () => h.fakeProjectiles() };
});
vi.mock('../../src/client/render/particles.js', async () => {
  const h = await import('./game-harness.js');
  return { createParticleSystem: () => h.fakeParticles() };
});
vi.mock('../../src/client/render/themes/index.js', async () => {
  const h = await import('./game-harness.js');
  return { getSceneryBuilder: () => (ctx: { scene: import('three').Scene }) => h.fakeScenery(ctx) };
});
vi.mock('../../src/client/render/track-mesh.js', async () => {
  const h = await import('./game-harness.js');
  return { buildTrackMesh: () => h.fakeTrackMesh() };
});
vi.mock('../../src/client/render/renderer.js', async () => {
  const h = await import('./game-harness.js');
  return { createRenderPipeline: () => { const p = h.fakePipeline(); views.pipeline = p; return p; } };
});
vi.mock('../../src/client/render/showroom.js', async () => {
  const THREE = await import('three');
  return {
    createShowroom: () => {
      const room = {
        scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
        show: vi.fn(), update: vi.fn(), setAspect: vi.fn(), dispose: vi.fn(),
      };
      views.showroom = room;
      return room;
    },
  };
});


import { createTimeTrialConfig } from '../../src/sim/replay.js';
import type { RaceSummary } from '../../src/client/contracts.js';
import type { CameraRigExt } from '../../src/client/render/camera.js';
import { createGameView } from '../../src/client/game/index.js';
import type { RaceSession } from '../../src/client/game/race-session.js';
import { created, fakeAudio, fakeInput, resetCreated, settings } from './game-harness.js';

// ── rAF / document stubs ──
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
let now = 0;
beforeEach(() => {
  resetCreated();
  rafQueue = [];
  now = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push({ id: ++rafSeq, cb }); return rafSeq; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue = rafQueue.filter(r => r.id !== id); });
  vi.stubGlobal('document', { addEventListener() { /* no-op */ }, removeEventListener() { /* no-op */ } });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Run one animation frame (all queued callbacks) and let promise continuations settle. */
async function frame(ms = 1000 / 60): Promise<void> {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const r of q) r.cb(now);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function vs(trackId = 'sunny-meadow', seed = 99): RaceConfig {
  return {
    trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed,
    racers: (['kiki', 'pip', 'bruno', 'mochi'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 3 ? 0 : -1 })),
  };
}

function mountView() {
  const audio = fakeAudio();
  const view = createGameView({ audio, input: fakeInput() });
  view.mount({} as HTMLElement);
  const session = () => (view as unknown as { session: RaceSession | null }).session;
  return { view, audio, session };
}

const noFinish = (_s: RaceSummary) => undefined;

describe('GameView race lifecycle', () => {
  it('a second startRace while the first is still building wins; the first never builds (no leaked scene)', async () => {
    const { view, session } = mountView();
    const a = view.startRace({ config: vs('sunny-meadow'), onFinish: noFinish });
    const b = view.startRace({ config: vs('neon-city'), onFinish: noFinish });
    await frame();
    await Promise.all([a, b]);
    expect(created.sceneries).toHaveLength(1);
    expect(view.track?.def.id).toBe('neon-city');
    expect(session()!.track.def.id).toBe('neon-city');
  });

  it('endRace during the build cancels it', async () => {
    const { view } = mountView();
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    view.endRace();
    await frame();
    await p;
    expect(created.sceneries).toHaveLength(0);
    expect(view.inRace).toBe(false);
    expect(view.hud(0)).toBeNull();
  });

  it('restart keeps the time-trial seed and re-rolls it for other modes; each restart gets a fresh session', async () => {
    const { view, session } = mountView();
    await Promise.all([view.startRace({ config: createTimeTrialConfig('sunny-meadow', 150, 'kiki'), onFinish: noFinish }), frame()]);
    const first = session()!;
    view.restartRace();
    await frame();
    const second = session()!;
    expect(second).not.toBe(first);
    expect(second.world.config.seed).toBe(first.world.config.seed);
    expect(second.world.tick).toBe(0);

    await Promise.all([view.startRace({ config: vs('sunny-meadow', 1234), onFinish: noFinish }), frame()]);
    const seeds = new Set<number>();
    for (let i = 0; i < 4; i++) {
      view.restartRace();
      await frame();
      seeds.add(session()!.world.config.seed);
    }
    expect(seeds.size).toBeGreaterThan(1);
    expect(seeds.has(1234)).toBe(false);
  });

  it('a pause requested while the race is still building is honoured by the new session', async () => {
    const { view, session } = mountView();
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    view.pause(); // e.g. the tab was hidden or Esc pressed during the build
    await frame();
    await p;
    expect(view.paused).toBe(true);
    view.skipIntro();
    for (let i = 0; i < 30; i++) await frame();
    expect(session()!.world.tick).toBe(0);
    view.resume();
    for (let i = 0; i < 30; i++) await frame();
    expect(session()!.world.tick).toBeGreaterThan(0);
  });

  it('restarting does not flash the menu showroom between the two races', async () => {
    const { view } = mountView();
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    for (let i = 0; i < 3; i++) await frame();
    const room = views.showroom!, pipe = views.pipeline!;
    room.show.mockClear();
    vi.mocked(pipe.render).mockClear();
    view.restartRace();
    await frame(); // the frame in which the new scene is built
    await frame();
    expect(room.show).not.toHaveBeenCalled();
    const scenes = vi.mocked(pipe.render).mock.calls.map(c => c[0]);
    expect(scenes).not.toContain(room.scene);
    expect(view.inRace).toBe(true);
    // leaving the race shows the backdrop again
    view.endRace();
    expect(room.show).toHaveBeenCalledTimes(1);
    await frame();
    expect(vi.mocked(pipe.render).mock.calls.at(-1)![0]).toBe(room.scene);
  });

  it('settings changed during a race reach the running session', async () => {
    const { view, session } = mountView();
    view.applySettings(settings({ shake: true }));
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    view.skipIntro();
    await frame();
    view.applySettings(settings({ shake: false, cameraDistance: 'far' }));
    const s = session()! as unknown as { cameras: CameraRigExt[]; handleEvents(e: unknown[]): void; humanKarts: number[] };
    s.handleEvents([{ t: 'wall', kart: s.humanKarts[0], impact: 10, x: 0, y: 0, z: 0 }]);
    expect(s.cameras[0]!.trauma).toBe(0);
  });
});
