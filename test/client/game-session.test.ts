/**
 * RaceSession integration tests: real RaceWorld / GhostPlayer / camera rig, fake render modules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterId, KartInput, RaceConfig, RaceEvent } from '../../src/sim/types.js';

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

import { COUNTDOWN_TICKS, DT } from '../../src/sim/constants.js';
import { computeAiInput, createAiState } from '../../src/sim/ai.js';
import { decodeLog, InputRecorder, NEUTRAL_INPUT } from '../../src/sim/input-log.js';
import { RaceWorld } from '../../src/sim/race.js';
import { createTimeTrialConfig, GhostPlayer, verifyTimeTrial } from '../../src/sim/replay.js';
import { Rng } from '../../src/sim/rng.js';
import type { GhostData, RaceSummary, Settings } from '../../src/client/contracts.js';
import type { CameraRigExt } from '../../src/client/render/camera.js';
import { RaceSession } from '../../src/client/game/race-session.js';
import { aiHands, created, fakeAudio, fakeInput, fakePipeline, resetCreated, settings, type FakeInput } from './game-harness.js';

const THROTTLE: KartInput = { ...NEUTRAL_INPUT, throttle: true };
/** Irregular frame times: 60/144/30 Hz, zero-length frames, a tab-switch hitch (> 5 steps). */
const DTS = [1 / 60, 1 / 144, 0.05, 0, 1 / 30, 0.1, 1 / 120, 0.034, 0.25, 1 / 60];

function vsConfig(seed = 99, patch: Partial<RaceConfig> = {}): RaceConfig {
  return {
    trackId: 'sunny-meadow', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed,
    racers: (['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'] as CharacterId[]).map((charId, i) => ({ charId, human: i === 7 ? 0 : -1 })),
    ...patch,
  };
}

function makeSession(config: RaceConfig, o: { ghost?: GhostData | null; input?: FakeInput; settings?: Settings; aiHands?: boolean } = {}) {
  const deps = { pipeline: fakePipeline(), audio: fakeAudio(), input: o.input ?? fakeInput(), settings: o.settings ?? settings() };
  const finishes: RaceSummary[] = [];
  const s = new RaceSession({ config, ghost: o.ghost ?? null, onFinish: x => finishes.push(x) }, deps);
  // the CPU driver on the player's pad (an unassisted run the recorder keeps; debug bots would void it)
  if (o.aiHands) deps.input.next = aiHands(() => s);
  return { s, deps, finishes };
}

type SessionInternals = { cameras: CameraRigExt[]; ghost: GhostPlayer | null; handleEvents(e: RaceEvent[]): void; movers: Array<{ outer: import('three').Object3D }> };
const internals = (s: RaceSession) => s as unknown as SessionInternals;

/** Run frames (cycling DTS) until `done()` or a tick budget runs out. */
function runUntil(s: RaceSession, done: () => boolean, maxTicks = 12_000, each?: () => void): number {
  let i = 0;
  while (!done() && s.world.tick < maxTicks) {
    s.frame(DTS[i++ % DTS.length]!, false);
    each?.();
  }
  return i;
}

/** A complete time-trial log driven by the hard CPU, optionally lifting off the throttle for a while after GO. */
function recordTimeTrial(trackId: string, charId: CharacterId, liftTicks = 0): { log: string; ticks: number; lapTicks: number[] } {
  const w = new RaceWorld(createTimeTrialConfig(trackId, 150, charId));
  const k = w.karts[0]!;
  const ai = createAiState(new Rng(4321), 'hard');
  const rec = new InputRecorder();
  while (!k.finished) {
    const scale = k.speedScale;
    let inp = computeAiInput(w, k, ai);
    k.speedScale = scale;
    if (w.tick >= COUNTDOWN_TICKS && w.tick < COUNTDOWN_TICKS + liftTicks) inp = { ...inp, throttle: false };
    rec.push(inp);
    w.step([inp]);
    w.drainEvents();
  }
  return { log: rec.encode(), ticks: k.finishTick, lapTicks: [...k.lapTicks] };
}

beforeEach(() => resetCreated());

describe('RaceSession — time trial recording', () => {
  it('records one word per tick from countdown tick 0 through the finish tick, verifiable by the server', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const { s, finishes } = makeSession(cfg, { aiHands: true });
    s.skipIntro();
    runUntil(s, () => finishes.length > 0, 20_000);
    // keep the session running after the finish: nothing may be appended or fired again
    for (let i = 0; i < 400; i++) s.frame(DTS[i % DTS.length]!, false);
    expect(finishes).toHaveLength(1);
    const tt = finishes[0]!.timeTrial!;
    expect(tt).not.toBeNull();
    expect(tt.ticks).toBe(s.world.karts[0]!.finishTick);
    expect(decodeLog(tt.log).length).toBe(tt.ticks + COUNTDOWN_TICKS);
    expect(verifyTimeTrial({ trackId: cfg.trackId, cc: cfg.cc, charId: 'kiki', log: tt.log })).toEqual({ ok: true, ticks: tt.ticks, lapTicks: tt.lapTicks });
    // a later summary() (e.g. results re-read) reports the same record
    expect(s.summary().timeTrial).toEqual(tt);
  });

  it('keeps the ghost in lockstep with the world: exactly one ghost step per world tick, also across pauses', () => {
    const cfg = createTimeTrialConfig('canyon-rally', 150, 'rex');
    // first run records the log...
    const a = makeSession(cfg, { aiHands: true });
    a.s.skipIntro();
    runUntil(a.s, () => a.finishes.length > 0, 20_000);
    const tt = a.finishes[0]!.timeTrial!;
    a.s.dispose();
    resetCreated();
    // ...then the same deterministic driver races its own ghost: both karts must coincide on every frame.
    const b = makeSession(cfg, { ghost: { label: 'me', charId: 'rex', log: tt.log, ticks: tt.ticks }, aiHands: true });
    const ghost = internals(b.s).ghost!;
    expect(ghost).not.toBeNull();
    const player = created.karts[0]!, ghostVisual = created.karts[created.karts.length - 1]!;
    let frames = 0;
    b.s.skipIntro();
    while (b.finishes.length === 0 && b.s.world.tick < 20_000) {
      const paused = frames % 17 === 5;
      b.s.frame(DTS[frames % DTS.length]!, paused);
      frames++;
      expect(ghost.world.tick).toBe(b.s.world.tick);
      const k = b.s.world.karts[0]!, g = ghost.kart;
      expect([g.x, g.y, g.z, g.yaw]).toEqual([k.x, k.y, k.z, k.yaw]);
      expect(ghostVisual.poses.at(-1)).toEqual(player.poses.at(-1));
    }
    expect(b.finishes).toHaveLength(1);
    expect(ghost.kart.finishTick).toBe(tt.ticks);
    // the HUD ghost split at the finish is exactly zero
    expect(b.s.hudSnapshot(0)!.ghostDeltaMs).toBe(0);
  });

  it('shows the final ghost split when the player finishes before the ghost', () => {
    const cfg = createTimeTrialConfig('neon-city', 150, 'pip');
    const slow = recordTimeTrial('neon-city', 'pip', 150); // lifts off for 2.5 s after GO
    const { s, finishes } = makeSession(cfg, { ghost: { label: 'slow', charId: 'pip', log: slow.log, ticks: slow.ticks } });
    s.setDebugBots(true);
    s.skipIntro();
    runUntil(s, () => finishes.length > 0, 20_000);
    const mine = s.world.karts[0]!.finishTick;
    expect(mine).toBeLessThan(slow.ticks);
    // the ghost crosses the line during the celebration: its split resolves the pending final delta
    expect(internals(s).ghost!.kart.finished).toBe(true);
    expect(s.hudSnapshot(0)!.ghostDeltaMs).toBe(Math.round(((mine - slow.ticks) * 1000) / 60));
  });
});

describe('RaceSession — fixed step and events', () => {
  it('hands every sim event to audio exactly once, in order, whatever the frame pacing (pauses, hitches, >5 steps)', () => {
    const cfg = vsConfig(7);
    const { s, deps } = makeSession(cfg, { input: fakeInput(() => THROTTLE) });
    let unpaused = 0;
    for (let i = 0; i < 40; i++) { s.frame(1 / 60, false); unpaused++; } // intro plays for real
    s.skipIntro();
    let i = 0;
    while (s.world.tick < 900) {
      const paused = i % 11 === 3;
      s.frame(DTS[i % DTS.length]!, paused);
      if (!paused) unpaused++;
      i++;
    }
    expect(deps.audio.batches).toHaveLength(unpaused); // one hand-off per unpaused frame
    const ref = new RaceWorld(cfg);
    const expected: RaceEvent[] = [...ref.drainEvents()];
    while (ref.tick < s.world.tick) { ref.step([THROTTLE]); expected.push(...ref.drainEvents()); }
    expect(deps.audio.batches.flat()).toEqual(expected);
    // and the world is bit-identical to a reference stepped tick by tick
    expect(s.world.karts.map(k => [k.x, k.z, k.yaw])).toEqual(ref.karts.map(k => [k.x, k.z, k.yaw]));
  });

  it('never steps or times out while paused (intro, countdown, race)', () => {
    const { s, deps } = makeSession(vsConfig());
    for (let i = 0; i < 600; i++) s.frame(1 / 60, true);
    expect(s.inIntro).toBe(true);
    expect(s.world.tick).toBe(0);
    s.skipIntro();
    for (let i = 0; i < 3; i++) s.frame(1 / 60, false);
    const t = s.world.tick;
    for (let i = 0; i < 600; i++) s.frame(0.1, true);
    expect(s.world.tick).toBe(t);
    expect(deps.pipeline.renders).toBeGreaterThan(1200); // paused frames still render
  });

  it('fires onFinish exactly once after the celebration, and never after dispose', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const a = makeSession(cfg);
    a.s.setDebugBots(true);
    a.s.skipIntro();
    runUntil(a.s, () => a.s.world.phase === 'done', 20_000);
    expect(a.finishes).toHaveLength(0); // celebration first
    for (let i = 0; i < 60 * 3; i++) a.s.frame(1 / 60, false);
    expect(a.finishes).toHaveLength(0);
    for (let i = 0; i < 60 * 6; i++) a.s.frame(1 / 60, i % 2 === 0);
    expect(a.finishes).toHaveLength(1);
    for (let i = 0; i < 600; i++) a.s.frame(1 / 30, false);
    expect(a.finishes).toHaveLength(1);

    const b = makeSession(cfg);
    b.s.setDebugBots(true);
    b.s.skipIntro();
    runUntil(b.s, () => b.s.world.phase === 'done', 20_000);
    b.s.frame(1 / 60, false);
    b.s.dispose(); // restart / quit during the celebration
    for (let i = 0; i < 600; i++) b.s.frame(1 / 60, false);
    expect(b.finishes).toHaveLength(0);
  });
});

describe('RaceSession — interpolation', () => {
  it('never draws a kart part-way along a respawn teleport', () => {
    const { s } = makeSession(vsConfig(3), { input: fakeInput(() => THROTTLE) });
    s.skipIntro();
    for (let i = 0; i < 20; i++) s.frame(1 / 60, false);
    const w = s.world as unknown as { step(i: KartInput[]): void; events: RaceEvent[]; tick: number; karts: RaceWorld['karts'] };
    const orig = w.step.bind(w);
    const victim = 2;
    let teleportAt = -1;
    w.step = (inp: KartInput[]) => {
      orig(inp);
      if (teleportAt < 0 && w.tick >= COUNTDOWN_TICKS + 30) {
        // what finishRespawn does: jump back to the last safe point (here: 9 m sideways, below the 12 m heuristic)
        const k = w.karts[victim]!;
        k.x += 6; k.z += 5;
        w.events.push({ t: 'respawn', kart: victim });
        teleportAt = w.tick;
      }
    };
    const vis = created.karts[victim]!;
    // multi-step frames leaving alpha ≈ 0.5: the teleport lands inside one of them
    while (teleportAt < 0) s.frame(DT * 2.5, false);
    const k = w.karts[victim]!;
    const pose = vis.poses.at(-1)!;
    // must lie on the post-teleport segment, i.e. within one tick of travel from the kart
    expect(Math.hypot(pose.x - k.x, pose.z - k.z)).toBeLessThan(1.5);
  });

  it('does not interpolate the ghost across its respawn teleport either (its events never reach the session)', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const run = recordTimeTrial('sunny-meadow', 'kiki');
    const { s } = makeSession(cfg, { ghost: { label: 'g', charId: 'kiki', log: run.log, ticks: run.ticks } });
    s.skipIntro();
    for (let i = 0; i < COUNTDOWN_TICKS + 60; i++) s.frame(DT, false);
    const gk = internals(s).ghost!.kart;
    // make the next ghost tick finish a respawn 9 samples (≈ 9 m) up the road — the real finishRespawn path
    gk.respawnTime = 0.001;
    gk.lastSafe = { ...gk.lastSafe, i: (gk.ti + 9) % s.track.n };
    s.frame(DT * 1.5, false); // one step, alpha 0.5
    expect(gk.respawnTime).toBe(0);
    const pose = created.karts.at(-1)!.poses.at(-1)!;
    expect(Math.hypot(pose.x - gk.x, pose.z - gk.z)).toBeLessThan(0.01);
  });

  it('feeds kart visuals the throttle the sim applied (CPU karts idle on the grid during the intro)', () => {
    const { s } = makeSession(vsConfig(), { input: fakeInput(() => THROTTLE) });
    for (let i = 0; i < 10; i++) s.frame(1 / 60, false);
    expect(created.karts.every(v => v.opts.at(-1)!.throttle === false)).toBe(true);
    s.skipIntro();
    for (let i = 0; i < 10; i++) s.frame(DT, false);
    const human = s.humanKarts[0]!;
    created.karts.forEach((v, i) => expect(v.opts.at(-1)!.throttle).toBe(s.world.karts[i]!.throttle));
    expect(created.karts[human]!.opts.at(-1)!.throttle).toBe(true);
  });

  it('interpolates projectiles between ticks like the karts (no 60 Hz stepping at high refresh rates)', () => {
    const { s } = makeSession(vsConfig(5), { input: fakeInput(() => THROTTLE) });
    s.skipIntro();
    s.frame(1 / 60, false);
    const w = s.world;
    const orig = w.step.bind(w);
    w.projectiles.push({
      id: 999, kind: 'orb', owner: 0, x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 30, i: 0, life: 99, bounces: 0,
      target: -1, ownerGrace: 0, state: 'fly', prog: 0,
    });
    w.step = (inp: KartInput[]) => {
      orig(inp);
      const p = w.projectiles.find(q => q.id === 999);
      if (p) { p.x = 0; p.z = w.tick * 0.5; } // scripted: 0.5 m per tick
      else w.projectiles.push({ id: 999, kind: 'orb', owner: 0, x: 0, y: 1, z: w.tick * 0.5, vx: 0, vy: 0, vz: 30, i: 0, life: 99, bounces: 0, target: -1, ownerGrace: 0, state: 'fly', prog: 0 });
    };
    s.frame(DT, false);
    s.frame(DT * 1.5, false); // 1 step, alpha 0.5
    const proj = created.projectiles[0]!;
    const drawn = proj.calls.at(-1)!.find(q => q.id === 999)!;
    const cur = w.projectiles.find(q => q.id === 999)!;
    expect(drawn.z).toBeCloseTo(cur.z - 0.25, 5);
  });

  it('interpolates movers on the same timeline as the karts', () => {
    const { s } = makeSession(vsConfig(5), { input: fakeInput(() => THROTTLE) });
    expect(s.track.movers.length).toBeGreaterThan(0);
    s.skipIntro();
    s.frame(1 / 60, false);
    for (let i = 0; i < 300; i++) s.frame(DT, false);
    s.frame(DT * 1.5, false); // alpha 0.5
    const m = internals(s).movers[0]!;
    // karts are drawn between the states after ticks N-1 and N; state N was resolved against the mover at N-1
    const want = s.world.moverPositionAt(0, s.world.tick - 1.5);
    expect(m.outer.position.x).toBeCloseTo(want.x, 5);
    expect(m.outer.position.z).toBeCloseTo(want.z, 5);
  });
});

describe('RaceSession — settings, duo and disposal', () => {
  it('reads settings live (GameView mutates the shared object from the in-race settings screen)', () => {
    const live = settings({ shake: true });
    const { s } = makeSession(vsConfig(), { settings: live });
    s.skipIntro();
    s.frame(1 / 60, false);
    const cam = internals(s).cameras[0]!;
    const human = s.humanKarts[0]!;
    internals(s).handleEvents([{ t: 'wall', kart: human, impact: 10, x: 0, y: 0, z: 0 }]);
    expect(cam.trauma).toBeGreaterThan(0);
    cam.reset();
    live.shake = false;
    internals(s).handleEvents([
      { t: 'wall', kart: human, impact: 10, x: 0, y: 0, z: 0 },
      { t: 'hit', kart: human, kind: 'tumble', by: 1, source: 'rocket' },
      { t: 'thunder', by: 1 },
    ]);
    expect(cam.trauma).toBe(0);
  });

  it('maps duo players to their own karts, inputs, HUD, cameras, viewports and rumble', () => {
    const racers = (['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'] as CharacterId[]).map((charId, i) => ({
      charId, human: i === 3 ? 1 : i === 5 ? 0 : -1,
    }));
    const input = fakeInput(p => (p === 0 ? THROTTLE : { ...NEUTRAL_INPUT, back: true }));
    const { s, deps } = makeSession(vsConfig(11, { mode: 'duo', racers }), { input });
    expect(s.humanKarts).toEqual([5, 3]);
    expect(input.modes.at(-1)).toBe('duo');
    s.skipIntro();
    for (let i = 0; i < COUNTDOWN_TICKS + 120; i++) s.frame(DT, false);
    expect(s.world.karts[5]!.throttle).toBe(true);  // P1's input drives kart 5
    expect(s.world.karts[3]!.throttle).toBe(false); // P2's input drives kart 3
    expect(s.hudSnapshot(0)!.kart).toBe(5);
    expect(s.hudSnapshot(1)!.kart).toBe(3);
    expect(created.karts[3]!.opts.at(-1)!.lookBack).toBe(true);
    expect(created.karts[5]!.opts.at(-1)!.lookBack).toBe(false);
    const call = vi.mocked(deps.pipeline.render).mock.calls.at(-1)!;
    const views = call[1];
    expect(views).toHaveLength(2);
    expect(views[0]!.viewport).toEqual({ x: 0, y: 0, w: 960, h: 270 });
    expect(views[1]!.viewport).toEqual({ x: 0, y: 270, w: 960, h: 270 });
    expect(views[0]!.camera).not.toBe(views[1]!.camera);
    // P2's camera looks at P2's kart
    const k3 = s.world.karts[3]!;
    expect(Math.hypot(views[1]!.camera.position.x - k3.x, views[1]!.camera.position.z - k3.z)).toBeLessThan(12);
    internals(s).handleEvents([{ t: 'wall', kart: 3, impact: 10, x: 0, y: 0, z: 0 }]);
    expect(input.rumbles.at(-1)!.player).toBe(1);
  });

  it('disposes every visual it created exactly once, empties the scene and resets race audio', () => {
    const cfg = createTimeTrialConfig('sunny-meadow', 150, 'kiki');
    const slow = recordTimeTrial('sunny-meadow', 'kiki', 0);
    const { s, deps } = makeSession(cfg, { ghost: { label: 'g', charId: 'kiki', log: slow.log, ticks: slow.ticks } });
    s.setDebugBots(true);
    s.skipIntro();
    runUntil(s, () => s.world.karts[0]!.lap >= 3, 20_000); // into the final lap
    expect(deps.audio.finalLap).toBe(true);
    s.dispose();
    s.dispose();
    expect(created.karts).toHaveLength(2); // player + ghost
    for (const v of created.karts) expect(v.disposed).toBe(1);
    for (const list of [created.pickups, created.projectiles, created.particles, created.trackMeshes, created.sceneries]) {
      expect(list).toHaveLength(1);
      expect(list[0]!.disposed).toBe(1);
    }
    expect(s.scene.children).toHaveLength(0);
    expect(deps.audio.log.filter(x => x === 'stopRace')).toHaveLength(1);
    expect(deps.audio.finalLap).toBe(false);
    const renders = deps.pipeline.renders;
    s.frame(1 / 60, false);
    expect(deps.pipeline.renders).toBe(renders);
  });

  it('survives non-finite frame times', () => {
    const { s } = makeSession(vsConfig());
    s.skipIntro();
    s.frame(Number.NaN, false);
    s.frame(Number.POSITIVE_INFINITY, false);
    s.frame(-1, false);
    for (let i = 0; i < 10; i++) s.frame(1 / 60, false);
    expect(Number.isFinite(s.world.karts[0]!.x)).toBe(true);
    expect(s.world.tick).toBeGreaterThan(0);
    expect(s.world.tick).toBeLessThan(20);
  });
});
