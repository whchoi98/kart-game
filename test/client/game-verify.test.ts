/**
 * Independent verification of the game-integration fixes with a different sampling than
 * game-session / game-view tests: other tracks, characters, drivers and pacing.
 * Real RaceWorld / GhostPlayer / camera rig; WebGL-dependent render modules are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterId, KartInput, RaceConfig, RaceEvent } from '../../src/sim/types.js';

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

import { COUNTDOWN_TICKS, DT } from '../../src/sim/constants.js';
import { computeAiInput, createAiState } from '../../src/sim/ai.js';
import { decodeLog, InputRecorder, NEUTRAL_INPUT } from '../../src/sim/input-log.js';
import { RaceWorld } from '../../src/sim/race.js';
import { createTimeTrialConfig, GhostPlayer, verifyTimeTrial } from '../../src/sim/replay.js';
import { Rng } from '../../src/sim/rng.js';
import type { GhostData, RaceSummary } from '../../src/client/contracts.js';
import { createGameView } from '../../src/client/game/index.js';
import { HudModel } from '../../src/client/game/hud-model.js';
import { RaceSession } from '../../src/client/game/race-session.js';
import { aiHands, created, fakeAudio, fakeInput, fakePipeline, resetCreated, settings, type FakeInput } from './game-harness.js';

const THROTTLE: KartInput = { ...NEUTRAL_INPUT, throttle: true };
/** Different irregular pacing than game-session.test.ts: 75/165/48 Hz, micro frames, a 0.2 s hitch. */
const DTS = [1 / 75, 1 / 165, 0.021, 0.0005, 1 / 48, 0.2, 1 / 165, 0.013, 1 / 75];

type Internals = { ghost: GhostPlayer | null };
const internals = (s: RaceSession) => s as unknown as Internals;

function makeSession(config: RaceConfig, o: { ghost?: GhostData | null; input?: FakeInput } = {}) {
  const deps = { pipeline: fakePipeline(), audio: fakeAudio(), input: o.input ?? fakeInput(), settings: settings() };
  const finishes: RaceSummary[] = [];
  const s = new RaceSession({ config, ghost: o.ghost ?? null, onFinish: x => finishes.push(x) }, deps);
  return { s, deps, finishes };
}

/** `stall`: the recorded driver sits on the brake for `ticks` ticks from the start of lap `lap` (a slower ghost). */
function recordTT(trackId: string, charId: CharacterId, rngSeed: number, stall: { lap: number; ticks: number } | null = null) {
  const w = new RaceWorld(createTimeTrialConfig(trackId, 150, charId));
  const k = w.karts[0]!;
  const ai = createAiState(new Rng(rngSeed), 'hard');
  const rec = new InputRecorder();
  let stallFrom = -1;
  while (!k.finished) {
    const scale = k.speedScale;
    let inp = computeAiInput(w, k, ai);
    k.speedScale = scale;
    if (stall && w.racing && k.lap === stall.lap && stallFrom < 0) stallFrom = w.tick;
    if (stallFrom >= 0 && w.tick < stallFrom + stall!.ticks) inp = { ...NEUTRAL_INPUT, brake: true };
    rec.push(inp);
    w.step([inp]);
    w.drainEvents();
  }
  return { log: rec.encode(), ticks: k.finishTick, lapTicks: [...k.lapTicks] };
}

beforeEach(() => resetCreated());

describe('verify: time trial', () => {
  it('records a verifiable log on another track/character with irregular pacing and pauses', () => {
    const cfg = createTimeTrialConfig('frost-peak', 100, 'bolt');
    const input = fakeInput();
    const { s, finishes } = makeSession(cfg, { input });
    input.next = aiHands(() => s); // CPU hands on the pad: an unassisted run
    // play part of the intro for real, pause during it, then skip
    for (let i = 0; i < 30; i++) s.frame(1 / 60, i % 4 === 0);
    s.skipIntro();
    let i = 0;
    while (finishes.length === 0 && s.world.tick < 30_000) { s.frame(DTS[i % DTS.length]!, i % 13 === 7); i++; }
    const tt = finishes[0]!.timeTrial!;
    expect(decodeLog(tt.log).length).toBe(tt.ticks + COUNTDOWN_TICKS);
    expect(verifyTimeTrial({ trackId: 'frost-peak', cc: 100, charId: 'bolt', log: tt.log })).toEqual({ ok: true, ticks: tt.ticks, lapTicks: tt.lapTicks });
  });

  it('shows the final ghost split at the finish even when the ghost is far behind (> celebration)', () => {
    const cfg = createTimeTrialConfig('palm-beach', 150, 'hana');
    // same driver as the debug bot, but it brakes for 5 s at the start of the final lap: the lap-2
    // split is 0 and the ghost crosses the line ~6 s after the player (longer than the celebration)
    const slow = recordTT('palm-beach', 'hana', 1234, { lap: 3, ticks: 300 });
    const { s, finishes } = makeSession(cfg, { ghost: { label: 'slow', charId: 'hana', log: slow.log, ticks: slow.ticks } });
    s.setDebugBots(true);
    s.skipIntro();
    let deltaAtFinishCall: number | null = null;
    let i = 0;
    while (finishes.length === 0 && s.world.tick < 30_000) {
      s.frame(DTS[i++ % DTS.length]!, false);
      if (finishes.length) deltaAtFinishCall = s.hudSnapshot(0)!.ghostDeltaMs;
    }
    const mine = s.world.karts[0]!.finishTick;
    expect(slow.ticks - mine).toBeGreaterThan(4 * 60);
    expect(internals(s).ghost!.kart.finished).toBe(false);
    // what the player sees at the line / during the celebration (the HUD is hidden once onFinish opens results)
    expect(deltaAtFinishCall).toBe(Math.round(((mine - slow.ticks) * 1000) / 60));
  });

  it('ghost stays in lockstep with a different-character ghost on a 3-mover track', () => {
    const cfg = createTimeTrialConfig('jungle-ruins', 150, 'taro');
    const g = recordTT('jungle-ruins', 'mochi', 77);
    const { s, finishes } = makeSession(cfg, { ghost: { label: 'g', charId: 'mochi', log: g.log, ticks: g.ticks } });
    s.setDebugBots(true);
    const ghost = internals(s).ghost!;
    expect(ghost.kart.charId).toBe('mochi');
    s.skipIntro();
    let i = 0;
    while (finishes.length === 0 && s.world.tick < 30_000) {
      s.frame(DTS[i % DTS.length]!, i % 9 === 4);
      i++;
      expect(ghost.world.tick).toBe(s.world.tick);
    }
    // the ghost reproduced its recorded run exactly
    expect(ghost.kart.finished ? ghost.kart.finishTick : -1).toBe(g.ticks);
  });
});

describe('verify: ghost split ordering (HudModel)', () => {
  it('a ghost more than a lap behind: the final split shows at the line and older late splits never replace it', () => {
    const w = new RaceWorld(createTimeTrialConfig('sunny-meadow', 150, 'kiki'));
    const k = w.karts[0]!;
    const hud = new HudModel(w, [0], 9000);
    const ghost: number[] = [];
    k.lapTicks = [2000];
    hud.onEvents([{ t: 'lap', kart: 0, lap: 2, lapTicks: 2000 }], ghost);
    expect(hud.snapshot(0, false)!.ghostDeltaMs).toBeNull(); // the ghost has not crossed yet
    k.lapTicks = [2000, 2000];
    hud.onEvents([{ t: 'lap', kart: 0, lap: 3, lapTicks: 2000 }], ghost);
    k.lapTicks = [2000, 2000, 2000];
    hud.onEvents([{ t: 'finish', kart: 0, position: 1, ticks: 6000 }], ghost);
    expect(hud.snapshot(0, false)!.ghostDeltaMs).toBe(-50_000);
    ghost.push(2500); // the ghost's lap 1 arrives during the celebration
    hud.onEvents([], ghost);
    expect(hud.snapshot(0, false)!.ghostDeltaMs).toBe(-50_000);
    ghost.push(2500, 4000);
    hud.onEvents([], ghost);
    expect(hud.snapshot(0, false)!.ghostDeltaMs).toBe(-50_000);
  });
});

describe('verify: fixed step, events, interpolation', () => {
  it('duo on frost-peak: every event reaches audio exactly once, identical to a tick-stepped reference', () => {
    const racers = (['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 1 ? 1 : i === 4 ? 0 : -1 }));
    const cfg: RaceConfig = { trackId: 'frost-peak', mode: 'duo', cc: 200, cpuLevel: 'normal', mirror: false, items: true, seed: 4242, racers };
    const P = (p: number): KartInput => (p === 0 ? THROTTLE : { ...NEUTRAL_INPUT, throttle: true, steer: 0.3 });
    const { s, deps } = makeSession(cfg, { input: fakeInput(P) });
    let unpaused = 0;
    for (let i = 0; i < 12; i++) { s.frame(1 / 60, false); unpaused++; }
    s.skipIntro();
    let i = 0;
    while (s.world.tick < 1500) {
      const paused = i % 7 === 2;
      s.frame(DTS[i % DTS.length]!, paused);
      if (!paused) unpaused++;
      i++;
    }
    expect(deps.audio.batches).toHaveLength(unpaused);
    const ref = new RaceWorld(cfg);
    const expected: RaceEvent[] = [...ref.drainEvents()];
    while (ref.tick < s.world.tick) { ref.step([P(0), P(1)]); expected.push(...ref.drainEvents()); }
    expect(deps.audio.batches.flat()).toEqual(expected);
  });

  it('real falls: a kart is never drawn part-way along its respawn teleport (starlight-road, off-line driving)', () => {
    // the human steers hard into the edge again and again: falls + respawns for real
    let t = 0;
    const input = fakeInput(() => ({ ...NEUTRAL_INPUT, throttle: true, steer: Math.floor(t++ / 90) % 2 === 0 ? 1 : -0.2 }));
    const cfg: RaceConfig = {
      trackId: 'starlight-road', mode: 'vs', cc: 150, cpuLevel: 'easy', mirror: true, items: true, seed: 17,
      racers: (['kiki', 'pip', 'bruno', 'mochi'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 0 ? 0 : -1 })),
    };
    const { s, deps } = makeSession(cfg, { input });
    s.skipIntro();
    let respawns = 0, i = 0;
    while (s.world.tick < 6000) {
      const before = deps.audio.batches.length;
      s.frame(DTS[i++ % DTS.length]!, false);
      const batch = deps.audio.batches.slice(before).flat();
      for (const e of batch) {
        if (e.t !== 'respawn') continue;
        respawns++;
        const k = s.world.karts[e.kart]!;
        const pose = created.karts[e.kart]!.poses.at(-1)!;
        // within one tick of travel at most (the respawned kart is standing still)
        expect(Math.hypot(pose.x - k.x, pose.z - k.z)).toBeLessThan(2);
      }
    }
    expect(respawns).toBeGreaterThan(0);
  });

  it('real projectiles are drawn between their previous and current tick positions', () => {
    const cfg: RaceConfig = {
      trackId: 'neon-city', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 5150,
      racers: (['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 0 ? 0 : -1 })),
    };
    const { s } = makeSession(cfg, { input: fakeInput(() => THROTTLE) });
    s.skipIntro();
    const w = s.world;
    const prevPos = new Map<number, { x: number; z: number }>();
    const orig = w.step.bind(w);
    w.step = (inp: readonly KartInput[]) => {
      prevPos.clear();
      for (const p of w.projectiles) prevPos.set(p.id, { x: p.x, z: p.z });
      orig(inp);
    };
    let checked = 0, i = 0;
    while (w.tick < 7000 && checked < 200) {
      s.frame(DTS[i++ % DTS.length]!, false);
      const drawn = created.projectiles[0]!.calls.at(-1)!;
      for (const d of drawn) {
        const cur = w.projectiles.find(p => p.id === d.id)!;
        const pr = prevPos.get(d.id);
        if (!pr) { expect([d.x, d.z]).toEqual([cur.x, cur.z]); continue; }
        const seg = Math.hypot(cur.x - pr.x, cur.z - pr.z);
        if (seg > 12) continue;
        // on the segment prev → cur
        const a = Math.hypot(d.x - pr.x, d.z - pr.z), b = Math.hypot(cur.x - d.x, cur.z - d.z);
        expect(a + b).toBeCloseTo(seg, 4);
        if (seg > 0.05) checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('verify: more interpolation cases', () => {
  it('travel movers (neon-city cars/buses) are drawn at tick − 2 + alpha, also at 144 Hz', () => {
    const cfg: RaceConfig = {
      trackId: 'neon-city', mode: 'vs', cc: 100, cpuLevel: 'easy', mirror: true, items: false, seed: 3,
      racers: (['kiki', 'pip'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 0 ? 0 : -1 })),
    };
    const { s } = makeSession(cfg, { input: fakeInput(() => THROTTLE) });
    s.skipIntro();
    s.frame(1 / 60, false);
    const movers = (s as unknown as { movers: Array<{ outer: import('three').Object3D }> }).movers;
    expect(movers.length).toBe(2);
    let checks = 0;
    for (let i = 0; i < 600; i++) {
      s.frame(1 / 144, false);
      const acc = (s as unknown as { acc: number }).acc;
      const t = Math.max(0, s.world.tick - 2 + Math.min(1, acc / DT));
      for (let m = 0; m < movers.length; m++) {
        const want = s.world.moverPositionAt(m, t);
        expect(movers[m]!.outer.position.x).toBeCloseTo(want.x, 6);
        expect(movers[m]!.outer.position.z).toBeCloseTo(want.z, 6);
        checks++;
      }
    }
    expect(checks).toBe(1200);
  });

  it('a real ghost fall + respawn (starlight-road) is never drawn part-way along the teleport', () => {
    // record a TT run whose driver keeps steering off the edge: it falls and respawns for real
    const w = new RaceWorld(createTimeTrialConfig('starlight-road', 150, 'rex'));
    const k = w.karts[0]!;
    const rec = new InputRecorder();
    let respawnsRecorded = 0;
    while (w.tick < COUNTDOWN_TICKS + 1500) {
      const inp = { ...NEUTRAL_INPUT, throttle: true, steer: Math.floor(w.tick / 70) % 3 === 0 ? 1 : 0 };
      rec.push(inp);
      w.step([inp]);
      for (const e of w.drainEvents()) if (e.t === 'respawn') respawnsRecorded++;
    }
    expect(respawnsRecorded).toBeGreaterThan(0);
    const cfg = createTimeTrialConfig('starlight-road', 150, 'rex');
    const { s } = makeSession(cfg, { ghost: { label: 'faller', charId: 'rex', log: rec.encode(), ticks: 99_999 } });
    s.skipIntro();
    const gk = internals(s).ghost!.kart;
    let seen = 0, i = 0, wasRespawning = false;
    while (s.world.tick < COUNTDOWN_TICKS + 1500) {
      s.frame(DTS[i++ % DTS.length]!, false);
      if (wasRespawning && gk.respawnTime <= 0) {
        const pose = created.karts.at(-1)!.poses.at(-1)!;
        expect(Math.hypot(pose.x - gk.x, pose.z - gk.z)).toBeLessThan(1.5);
        seen++;
      }
      wasRespawning = gk.respawnTime > 0;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('a corrupted (huge) yaw neither hangs the frame nor produces a non-finite pose', () => {
    const { s } = makeSession({
      trackId: 'sunny-meadow', mode: 'vs', cc: 150, cpuLevel: 'easy', mirror: false, items: false, seed: 2,
      racers: (['kiki', 'pip'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 0 ? 0 : -1 })),
    }, { input: fakeInput(() => THROTTLE) });
    s.skipIntro();
    s.frame(1 / 60, false);
    const prev = (s as unknown as { prev: Array<{ yaw: number }> }).prev;
    prev[1]!.yaw = 1e15;
    const t0 = performance.now();
    s.frame(DT * 0.5, false); // no step: interpolates prev (corrupted) → current
    expect(performance.now() - t0).toBeLessThan(200);
    const pose = created.karts[1]!.poses.at(-1)!;
    expect(Number.isFinite(pose.yaw)).toBe(true);
  });
});

describe('verify: continuous particle cadence', () => {
  it('emits wheel dust / drift sparks ~30 times per second at 30, 60 and 144 Hz', () => {
    for (const hz of [30, 60, 144]) {
      const cfg: RaceConfig = {
        trackId: 'sunny-meadow', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: false, seed: 1,
        racers: (['kiki', 'pip'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 0 ? 0 : -1 })),
      };
      const { s } = makeSession(cfg, { input: fakeInput(() => THROTTLE) });
      s.skipIntro();
      s.frame(1 / 60, false);
      const spy = vi.spyOn(s as unknown as { emitContinuous(): void }, 'emitContinuous');
      for (let i = 0; i < hz * 4; i++) s.frame(1 / hz, false);
      const perKartPerSecond = spy.mock.calls.length / 2 / 4;
      expect(perKartPerSecond).toBeGreaterThan(29);
      expect(perKartPerSecond).toBeLessThanOrEqual(30.5);
    }
  });
});

describe('verify: spectating (no human racer, debug/QA configs)', () => {
  it('an all-CPU race renders one view that follows the leader instead of throwing every frame', () => {
    const cfg: RaceConfig = {
      trackId: 'canyon-rally', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 8,
      racers: (['kiki', 'pip', 'bruno', 'mochi'] as CharacterId[]).map(charId => ({ charId, human: -1 })),
    };
    const { s, deps } = makeSession(cfg);
    expect(s.humanKarts).toEqual([]);
    expect(s.hudSnapshot(0)).toBeNull();
    for (let i = 0; i < 20; i++) s.frame(1 / 60, false);
    s.skipIntro();
    let i = 0;
    while (s.world.tick < COUNTDOWN_TICKS + 900) s.frame(DTS[i++ % DTS.length]!, i % 11 === 0);
    const views = vi.mocked(deps.pipeline.render).mock.calls.at(-1)![1];
    expect(views).toHaveLength(1);
    const leader = s.world.karts.find(k => k.position === 1)!;
    const cam = views[0]!.camera.position;
    expect(Math.hypot(cam.x - leader.x, cam.z - leader.z)).toBeLessThan(15);
  });
});

// ─────────────────────────────── GameView lifecycle ───────────────────────────────

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
let now = 0;
function stubFrame() {
  rafQueue = [];
  now = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push({ id: ++rafSeq, cb }); return rafSeq; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue = rafQueue.filter(r => r.id !== id); });
  vi.stubGlobal('document', { addEventListener() { /* no-op */ }, removeEventListener() { /* no-op */ } });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
}
async function frame(ms = 1000 / 60): Promise<void> {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const r of q) r.cb(now);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('verify: GameView lifecycle', () => {
  beforeEach(stubFrame);
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function mount() {
    const audio = fakeAudio();
    const input = fakeInput();
    const view = createGameView({ audio, input });
    view.mount({} as HTMLElement);
    const session = () => (view as unknown as { session: RaceSession | null }).session;
    return { view, audio, session, input };
  }
  const vs = (trackId: string, seed = 3): RaceConfig => ({
    trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed,
    racers: (['kiki', 'pip', 'bruno'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 2 ? 0 : -1 })),
  });

  it('restart spam (3× in one frame) builds exactly one new race and plays its music once', async () => {
    const { view, audio, session } = mount();
    await Promise.all([view.startRace({ config: vs('canyon-rally'), onFinish: () => undefined }), frame()]);
    const first = session()!;
    audio.log.length = 0;
    view.restartRace(); view.restartRace(); view.restartRace();
    await frame();
    await frame();
    expect(created.sceneries).toHaveLength(2);
    expect(created.sceneries[0]!.disposed).toBe(1);
    expect(session()).not.toBe(first);
    expect(audio.log.filter(x => x.startsWith('play:'))).toEqual(['play:canyon-rally']);
    expect(audio.log.filter(x => x === 'stopRace')).toHaveLength(1);
  });

  it('a time-trial restart mid-run starts a fresh recording (the log verifies)', async () => {
    const { view, session, input } = mount();
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'pip');
    const done: RaceSummary[] = [];
    input.next = aiHands(session); // CPU hands on the pad (debug bots would void the record)
    await Promise.all([view.startRace({ config: cfg, onFinish: x => done.push(x) }), frame()]);
    view.skipIntro();
    for (let i = 0; i < 400; i++) await frame();
    expect(session()!.world.tick).toBeGreaterThan(COUNTDOWN_TICKS);
    view.restartRace();
    await frame();
    view.skipIntro();
    let n = 0;
    while (done.length === 0 && n++ < 40_000) await frame(1000 / 30);
    expect(done).toHaveLength(1);
    const tt = done[0]!.timeTrial!;
    expect(decodeLog(tt.log).length).toBe(tt.ticks + COUNTDOWN_TICKS);
    expect(verifyTimeTrial({ trackId: cfg.trackId, cc: cfg.cc, charId: 'pip', log: tt.log }).ok).toBe(true);
  });

  it('a restart whose scene build throws ends the race cleanly (no unhandled rejection, backdrop back)', async () => {
    const { view } = mount();
    await Promise.all([view.startRace({ config: vs('palm-beach'), onFinish: () => undefined }), frame()]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internalsV = view as unknown as { lastOpts: { config: RaceConfig } };
    internalsV.lastOpts = { ...internalsV.lastOpts, config: { ...internalsV.lastOpts.config, trackId: 'no-such-track' } };
    const room = views.showroom!;
    room.show.mockClear();
    view.restartRace();
    await frame();
    await frame();
    expect(err).toHaveBeenCalled();
    expect(view.inRace).toBe(false);
    expect(room.show).toHaveBeenCalled();
    const pipe = views.pipeline!;
    vi.mocked(pipe.render).mockClear();
    await frame();
    expect(vi.mocked(pipe.render).mock.calls.at(-1)![0]).toBe(room.scene);
  });

  it('pause during the intro and the countdown freezes both; a long rAF gap is clamped', async () => {
    const { view, session } = mount();
    await Promise.all([view.startRace({ config: vs('starlight-road'), onFinish: () => undefined }), frame()]);
    for (let i = 0; i < 10; i++) await frame();
    view.pause();
    const s = session()!;
    const introT = (s as unknown as { introT: number }).introT;
    for (let i = 0; i < 60; i++) await frame();
    expect((s as unknown as { introT: number }).introT).toBe(introT);
    view.resume();
    view.skipIntro();
    await frame();
    await frame();
    const t0 = s.world.tick;
    view.pause();
    for (let i = 0; i < 60; i++) await frame(250);
    expect(s.world.tick).toBe(t0);
    view.resume();
    await frame(5000); // tab-switch sized gap: at most 0.1 s of simulation
    expect(s.world.tick - t0).toBeLessThanOrEqual(6);
  });
});
