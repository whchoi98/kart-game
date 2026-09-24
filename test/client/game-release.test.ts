/**
 * 1.0 release fixes in the game glue:
 *  - rumble honours settings.rumble;
 *  - GameView.startRace compiles the new scene's shaders (pipeline.warmUp / renderer.compileAsync, capped)
 *    before the race is shown, keeping double-start safety and the restart hold-frame;
 *  - the pipeline is told when a race is on screen (quality tiers only change off-race);
 *  - karts right at a view's lens are dissolved for that view (scene.onBeforeRender, per view);
 *  - HudSnapshot.minimap.ghost follows the time-trial ghost;
 *  - a time trial the debug bots drove carries no record; the bots setting persists across races.
 * Real RaceWorld / GhostPlayer / camera rig; WebGL-dependent render modules are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { CharacterId, RaceConfig, RaceEvent } from '../../src/sim/types.js';

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
  const T = await import('three');
  return {
    createShowroom: () => {
      const room = {
        scene: new T.Scene(), camera: new T.PerspectiveCamera(),
        show: vi.fn(), update: vi.fn(), setAspect: vi.fn(), dispose: vi.fn(),
      };
      views.showroom = room;
      return room;
    },
  };
});

import { COUNTDOWN_TICKS } from '../../src/sim/constants.js';
import { NEUTRAL_INPUT } from '../../src/sim/input-log.js';
import { createTimeTrialConfig, verifyTimeTrial } from '../../src/sim/replay.js';
import type { GhostData, RaceSummary, Settings } from '../../src/client/contracts.js';
import { createGameView } from '../../src/client/game/index.js';
import { KART_LENS_GONE, KART_LENS_START, RaceSession } from '../../src/client/game/race-session.js';
import { aiHands, created, fakeAudio, fakeInput, fakePipeline, resetCreated, settings, type FakeInput } from './game-harness.js';

// ── rAF / document stubs (GameView) ──
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function frame(ms = 1000 / 60): Promise<void> {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const r of q) r.cb(now);
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function vs(trackId = 'sunny-meadow', seed = 99, racerIds: CharacterId[] = ['kiki', 'pip', 'bruno', 'mochi']): RaceConfig {
  return {
    trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed,
    racers: racerIds.map((charId, i) => ({ charId, human: i === racerIds.length - 1 ? 0 : -1 })),
  };
}

type PipeHooks = { warmUp?: ReturnType<typeof vi.fn>; setRaceActive?: ReturnType<typeof vi.fn> };
function mountView() {
  const audio = fakeAudio();
  const input = fakeInput();
  const view = createGameView({ audio, input });
  view.mount({} as HTMLElement);
  const session = () => (view as unknown as { session: RaceSession | null }).session;
  const pipe = views.pipeline! as unknown as ReturnType<typeof fakePipeline> & PipeHooks;
  return { view, audio, input, session, pipe };
}
const noFinish = (_s: RaceSummary) => undefined;
const raceScenesRendered = (pipe: ReturnType<typeof fakePipeline>) =>
  vi.mocked(pipe.render).mock.calls.filter(c => c[0] !== views.showroom!.scene).length;

// ───────────────────────────── shader warm-up ─────────────────────────────

describe('GameView.startRace — shader warm-up before the race is shown', () => {
  it('compiles the new scene with a race camera and only then shows the race', async () => {
    const { view, session, pipe } = mountView();
    const warm = deferred();
    pipe.warmUp = vi.fn(() => warm.promise);
    let resolved = false;
    const p = view.startRace({ config: vs(), onFinish: noFinish }).then(() => { resolved = true; });
    await frame(); // the build frame
    expect(pipe.warmUp).toHaveBeenCalledTimes(1);
    const [scene, cam] = pipe.warmUp.mock.calls[0]! as [THREE.Scene, THREE.Camera];
    expect(scene).toBeInstanceOf(THREE.Scene);
    expect((cam as THREE.PerspectiveCamera).isPerspectiveCamera).toBe(true);
    expect(created.sceneries).toHaveLength(1);
    // still compiling: not in the race yet, nothing of it drawn, startRace still pending
    for (let i = 0; i < 5; i++) await frame();
    expect(view.inRace).toBe(false);
    expect(view.hud(0)).toBeNull();
    expect(raceScenesRendered(pipe)).toBe(0);
    expect(resolved).toBe(false);
    warm.resolve();
    await p;
    expect(view.inRace).toBe(true);
    expect(session()!.scene).toBe(scene);
    await frame();
    expect(vi.mocked(pipe.render).mock.calls.at(-1)![0]).toBe(scene);
  });

  it('a newer startRace during the warm-up wins; the obsolete build is disposed at once and never shown', async () => {
    const { view, audio, session, pipe } = mountView();
    const warms = [deferred(), deferred()];
    let n = 0;
    pipe.warmUp = vi.fn(() => warms[n++]!.promise);
    const a = view.startRace({ config: vs('sunny-meadow'), onFinish: noFinish });
    await frame();
    expect(created.sceneries).toHaveLength(1);
    const b = view.startRace({ config: vs('neon-city'), onFinish: noFinish });
    expect(created.sceneries[0]!.disposed).toBe(1); // dropped immediately (its music / engines stop)
    expect(audio.log.filter(x => x === 'stopRace')).toHaveLength(1);
    await frame();
    warms[0]!.resolve(); // the stale warm-up finishing late changes nothing
    await a;
    expect(view.inRace).toBe(false);
    expect(created.sceneries).toHaveLength(2);
    expect(created.sceneries[1]!.disposed).toBe(0);
    warms[1]!.resolve();
    await b;
    expect(session()!.track.def.id).toBe('neon-city');
    expect(created.sceneries[0]!.disposed).toBe(1);
  });

  it('endRace during the warm-up drops the build and shows the backdrop', async () => {
    const { view, pipe } = mountView();
    const warm = deferred();
    pipe.warmUp = vi.fn(() => warm.promise);
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    await frame();
    view.endRace();
    expect(created.sceneries[0]!.disposed).toBe(1);
    warm.resolve();
    await p;
    expect(view.inRace).toBe(false);
    await frame();
    expect(vi.mocked(pipe.render).mock.calls.at(-1)![0]).toBe(views.showroom!.scene);
  });

  it('a pause during the warm-up is honoured by the race once it appears', async () => {
    const { view, session, pipe } = mountView();
    const warm = deferred();
    pipe.warmUp = vi.fn(() => warm.promise);
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    await frame();
    view.pause();
    warm.resolve();
    await p;
    expect(view.paused).toBe(true);
    view.skipIntro();
    for (let i = 0; i < 20; i++) await frame();
    expect(session()!.world.tick).toBe(0);
  });

  it('a restart keeps the last race frame on screen through build and warm-up (no showroom flash)', async () => {
    const { view, pipe } = mountView();
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    for (let i = 0; i < 3; i++) await frame();
    const warm = deferred();
    pipe.warmUp = vi.fn(() => warm.promise);
    views.showroom!.show.mockClear();
    vi.mocked(pipe.render).mockClear();
    view.restartRace();
    for (let i = 0; i < 6; i++) await frame();
    expect(pipe.warmUp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pipe.render)).not.toHaveBeenCalled(); // canvas holds the old race's last frame
    expect(views.showroom!.show).not.toHaveBeenCalled();
    warm.resolve();
    await settle();
    await frame();
    expect(view.inRace).toBe(true);
    expect(vi.mocked(pipe.render).mock.calls.at(-1)![0]).not.toBe(views.showroom!.scene);
  });

  it('a failing, throwing or missing compile never blocks the start; renderer.compileAsync is the fallback', async () => {
    const { view, session, pipe } = mountView();
    pipe.warmUp = vi.fn(() => Promise.reject(new Error('context lost')));
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    expect(view.inRace).toBe(true);

    pipe.warmUp = vi.fn(() => { throw new Error('sync failure'); });
    await Promise.all([view.startRace({ config: vs('palm-beach'), onFinish: noFinish }), frame()]);
    expect(session()!.track.def.id).toBe('palm-beach');

    delete pipe.warmUp;
    const compileAsync = vi.fn(() => Promise.resolve());
    (pipe.renderer as unknown as { compileAsync: unknown }).compileAsync = compileAsync;
    await Promise.all([view.startRace({ config: vs('canyon-rally'), onFinish: noFinish }), frame()]);
    expect(compileAsync).toHaveBeenCalledWith(session()!.scene, expect.objectContaining({ isPerspectiveCamera: true }));
    expect(session()!.track.def.id).toBe('canyon-rally');
  });

  it('caps the wait: a compile that never finishes shows the race after ~8 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { view, pipe } = mountView();
    pipe.warmUp = vi.fn(() => new Promise<void>(() => undefined));
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    await frame();
    await vi.advanceTimersByTimeAsync(7900);
    expect(view.inRace).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(view.inRace).toBe(true);
  });
});

// ───────────────────────────── quality governor hand-off ─────────────────────────────

describe('GameView → pipeline.setRaceActive', () => {
  it('is on while a race is on screen, off while building, paused, on the results and back in menus', async () => {
    const { view, session, pipe } = mountView();
    pipe.setRaceActive = vi.fn();
    const calls = () => pipe.setRaceActive!.mock.calls.map(c => c[0] as boolean);
    const p = view.startRace({ config: vs(), onFinish: noFinish });
    await frame();
    await p;
    expect(calls()).toEqual([]); // never switched on yet (starts off)
    await frame();
    expect(calls()).toEqual([true]);
    view.pause();
    expect(calls()).toEqual([true, false]);
    await frame();
    expect(calls()).toEqual([true, false]);
    view.resume();
    await frame();
    expect(calls()).toEqual([true, false, true]);
    (session() as unknown as { finishedNotified: boolean }).finishedNotified = true; // results are up
    await frame();
    expect(calls()).toEqual([true, false, true, false]);
    (session() as unknown as { finishedNotified: boolean }).finishedNotified = false;
    await frame();
    view.endRace();
    expect(calls()).toEqual([true, false, true, false, true, false]);
    // a restart applies deferred tiers before building the next scene
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    await frame();
    view.restartRace();
    expect(calls().at(-1)).toBe(false);
  });
});

// ───────────────────────────── debug bots ─────────────────────────────

describe('debug bots: persistent, and a time trial they drove is no record', () => {
  it('GameView keeps the setting across restarts and new races; the bot-driven time trial reports timeTrial null', async () => {
    const { view, session } = mountView();
    view.debugSetBots(true);
    await Promise.all([view.startRace({ config: vs(), onFinish: noFinish }), frame()]);
    view.restartRace();
    await frame();
    const done: RaceSummary[] = [];
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    await Promise.all([view.startRace({ config: cfg, onFinish: x => done.push(x) }), frame()]);
    view.skipIntro();
    let n = 0;
    while (done.length === 0 && n++ < 40_000) await frame(1000 / 30);
    expect(done).toHaveLength(1);
    expect(session()!.world.karts[0]!.finished).toBe(true); // the bots really drove it round
    expect(done[0]!.timeTrial).toBeNull();
    expect(session()!.assistedRun).toBe(true);
  });

  it('bots for only the countdown void the record; switched on only after the finish they do not', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const mk = () => {
      const input = fakeInput();
      const finishes: RaceSummary[] = [];
      const s = new RaceSession({ config: cfg, ghost: null, onFinish: x => finishes.push(x) },
        { pipeline: fakePipeline(), audio: fakeAudio(), input, settings: settings() });
      input.next = aiHands(() => s);
      return { s, finishes };
    };
    const a = mk();
    a.s.setDebugBots(true);
    a.s.skipIntro();
    while (a.s.world.tick < COUNTDOWN_TICKS - 10) a.s.frame(1 / 60, false);
    a.s.setDebugBots(false);
    while (a.finishes.length === 0 && a.s.world.tick < 20_000) a.s.frame(1 / 60, false);
    expect(a.s.world.karts[0]!.finished).toBe(true);
    expect(a.s.assistedRun).toBe(true);
    expect(a.finishes[0]!.timeTrial).toBeNull();

    const b = mk();
    b.s.skipIntro();
    while (!b.s.world.karts[0]!.finished && b.s.world.tick < 20_000) b.s.frame(1 / 60, false);
    b.s.setDebugBots(true); // during the celebration: the recorded run was all the player's
    while (b.finishes.length === 0 && b.s.world.tick < 20_000) b.s.frame(1 / 60, false);
    expect(b.s.assistedRun).toBe(false);
    const tt = b.finishes[0]!.timeTrial!;
    expect(tt).not.toBeNull();
    expect(verifyTimeTrial({ trackId: cfg.trackId, cc: cfg.cc, charId: 'kiki', log: tt.log }).ok).toBe(true);
  });
});

// ───────────────────────────── RaceSession details ─────────────────────────────

function makeSession(config: RaceConfig, o: { ghost?: GhostData | null; input?: FakeInput; settings?: Settings } = {}) {
  const deps = { pipeline: fakePipeline(), audio: fakeAudio(), input: o.input ?? fakeInput(), settings: o.settings ?? settings() };
  const s = new RaceSession({ config, ghost: o.ghost ?? null, onFinish: () => undefined }, deps);
  return { s, deps };
}
type Internals = { handleEvents(e: RaceEvent[]): void; cameras: Array<{ camera: THREE.PerspectiveCamera }> };
const internals = (s: RaceSession) => s as unknown as Internals;

describe('RaceSession — rumble follows settings.rumble', () => {
  it('no vibration with rumble off (live), vibration again once it is back on', () => {
    const live = settings({ rumble: false });
    const input = fakeInput();
    const { s } = makeSession(vs(), { settings: live, input });
    s.skipIntro();
    s.frame(1 / 60, false);
    const me = s.humanKarts[0]!;
    const burst: RaceEvent[] = [
      { t: 'wall', kart: me, impact: 10, x: 0, y: 0, z: 0 },
      { t: 'kartBump', a: me, b: 0, x: 0, y: 0, z: 0 },
      { t: 'hit', kart: me, kind: 'tumble', by: 1, source: 'rocket' },
      { t: 'boost', kart: me, kind: 'mini3' },
    ] as RaceEvent[];
    internals(s).handleEvents(burst);
    expect(input.rumbles).toEqual([]);
    live.rumble = true;
    internals(s).handleEvents(burst);
    expect(input.rumbles.map(r => r.player)).toEqual([0, 0, 0, 0]);
    // settings saved before the option existed (field missing) keep the default: on
    delete (live as Partial<Settings>).rumble;
    internals(s).handleEvents(burst.slice(0, 1));
    expect(input.rumbles).toHaveLength(5);
  });
});

describe('RaceSession — HudSnapshot.minimap.ghost', () => {
  it('tracks the ghost kart (x, z, charId) in a time trial with a ghost, null otherwise', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    // a ghost log: a simple run with the throttle held from GO
    const plain = makeSession(cfg, { input: fakeInput(() => ({ ...NEUTRAL_INPUT, throttle: true })) });
    expect(plain.s.hudSnapshot(0)!.minimap.ghost).toBeNull();
    const recorder = (plain.s as unknown as { recorder: { encode(): string } }).recorder;
    plain.s.skipIntro();
    for (let i = 0; i < COUNTDOWN_TICKS + 240; i++) plain.s.frame(1 / 60, false);
    const log = recorder.encode();

    const { s } = makeSession(cfg, { ghost: { label: 'g', charId: 'pip', log, ticks: 9999 } });
    const ghost = (s as unknown as { ghost: { kart: { x: number; z: number; charId: CharacterId } } }).ghost.kart;
    s.skipIntro();
    for (let i = 0; i < COUNTDOWN_TICKS + 120; i++) s.frame(1 / 60, false);
    const g = s.hudSnapshot(0)!.minimap.ghost!;
    expect(g).toEqual({ x: ghost.x, z: ghost.z, charId: 'pip' });
    const x0 = g.x, z0 = g.z;
    for (let i = 0; i < 60; i++) s.frame(1 / 60, false);
    const g2 = s.hudSnapshot(0)!.minimap.ghost!;
    expect(Math.hypot(g2.x - x0, g2.z - z0)).toBeGreaterThan(3); // it moves with the replay

    expect(makeSession(vs()).s.hudSnapshot(0)!.minimap.ghost).toBeNull();
  });
});

describe('RaceSession — karts at the lens are dissolved per view', () => {
  const at = (x: number, y: number, z: number) => { const c = new THREE.PerspectiveCamera(); c.position.set(x, y, z); return c; };
  // what three.js does at the start of every renderer.render(scene, camera) — once per view
  const renderView = (s: RaceSession, cam: THREE.Camera) =>
    (s.scene.onBeforeRender as unknown as (r: unknown, sc: THREE.Scene, c: THREE.Camera) => void)({}, s.scene, cam);

  it('enables the near fade on every kart, the ghost included', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const { s } = makeSession(vs());
    expect(created.karts.every(v => v.nearFade)).toBe(true);
    s.dispose();
    resetCreated();
    const plain = makeSession(cfg, { input: fakeInput(() => ({ ...NEUTRAL_INPUT, throttle: true })) });
    plain.s.skipIntro();
    for (let i = 0; i < COUNTDOWN_TICKS + 30; i++) plain.s.frame(1 / 60, false);
    const log = (plain.s as unknown as { recorder: { encode(): string } }).recorder.encode();
    resetCreated();
    makeSession(cfg, { ghost: { label: 'g', charId: 'pip', log, ticks: 100 } });
    expect(created.karts).toHaveLength(2);
    expect(created.karts[1]!.nearFade).toBe(true);
  });

  it('fades by the distance to the camera of the view being drawn (split screen: each view on its own)', () => {
    const { s } = makeSession(vs());
    s.skipIntro();
    for (let i = 0; i < 5; i++) s.frame(1 / 60, false);
    const k = created.karts[1]!.root.position;
    const hull = (d: number) => at(k.x + d, k.y + 0.55, k.z);
    // view A has its lens right at kart 1, view B is 10 m away: the same kart gets 1 then 0 in one frame
    renderView(s, hull(1.0));
    renderView(s, hull(10));
    expect(created.karts[1]!.lens.slice(-2)).toEqual([1, 0]);
    renderView(s, hull(KART_LENS_GONE));
    expect(created.karts[1]!.lens.at(-1)).toBe(1);
    renderView(s, hull(KART_LENS_START));
    expect(created.karts[1]!.lens.at(-1)).toBeCloseTo(0, 9);
    renderView(s, hull(KART_LENS_START + 0.5));
    expect(created.karts[1]!.lens.at(-1)).toBe(0);
    renderView(s, hull((KART_LENS_GONE + KART_LENS_START) / 2));
    expect(created.karts[1]!.lens.at(-1)).toBeCloseTo(0.5, 5);
    // the race's own chase camera never fades the player's kart
    const own = s.humanKarts[0]!;
    renderView(s, internals(s).cameras[0]!.camera);
    expect(created.karts[own]!.lens.at(-1)).toBe(0);
  });

  it("never touches a player's own kart from its own chase camera (every camera distance, boosting or not)", () => {
    for (const cameraDistance of ['near', 'normal', 'far'] as const) {
      resetCreated();
      const { s } = makeSession(vs('canyon-rally', 5), { settings: settings({ cameraDistance }), input: fakeInput(() => ({ ...NEUTRAL_INPUT, throttle: true })) });
      s.skipIntro();
      const own = s.humanKarts[0]!;
      for (let i = 0; i < COUNTDOWN_TICKS + 600; i++) {
        s.frame(1 / 60, false);
        if (i % 10 === 0) renderView(s, internals(s).cameras[0]!.camera);
      }
      const lens = created.karts[own]!.lens;
      expect(lens.length).toBeGreaterThan(50);
      expect(Math.max(...lens)).toBe(0);
    }
  });

  it('a continuous approach gives a continuous fade (no pop)', () => {
    const { s } = makeSession(vs());
    s.skipIntro();
    s.frame(1 / 60, false);
    const k = created.karts[2]!.root.position;
    let last = 0;
    for (let d = 4; d >= 1; d -= 0.05) {
      renderView(s, at(k.x, k.y + 0.55, k.z + d));
      const a = created.karts[2]!.lens.at(-1)!;
      expect(a).toBeGreaterThanOrEqual(last);
      expect(a - last).toBeLessThan(0.09);
      last = a;
    }
    expect(last).toBe(1);
  });
});
