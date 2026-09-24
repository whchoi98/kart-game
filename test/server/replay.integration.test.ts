/**
 * End-to-end verification with the real simulation: a CPU driver produces a
 * genuine time-trial input log, the server re-simulates it on its worker pool
 * and must accept exactly the true result and nothing else.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GhostResponse, SubmitRunResponse } from '../../src/shared/api.js';
import type { TurboPalsApp } from '../../src/server/app.js';
import { WorkerVerifier } from '../../src/server/verifier.js';
import { playerId, runBody, submit, testApp } from './helpers.js';

const simReady = existsSync(new URL('../../src/sim/replay.ts', import.meta.url));

interface RecordedRun { trackId: string; log: string; ticks: number; lapTicks: number[]; tickCount: number }

/** Drives kart 0 with the CPU AI (on a private RNG, without touching world state) and records its inputs. */
async function recordAiRun(): Promise<RecordedRun> {
  const [{ RaceWorld }, { createTimeTrialConfig, MAX_TT_TICKS }, { computeAiInput, createAiState }, { InputRecorder, quantizeInput }, { Rng }, { TRACK_DEFS }] =
    await Promise.all([
      import('../../src/sim/race.js'), import('../../src/sim/replay.js'), import('../../src/sim/ai.js'),
      import('../../src/sim/input-log.js'), import('../../src/sim/rng.js'), import('../../src/sim/tracks/index.js'),
    ]);
  const trackId = TRACK_DEFS[0]!.id;
  const world = new RaceWorld(createTimeTrialConfig(trackId, 150, 'kiki'));
  const kart = world.karts[0]!;
  const brainRng = new Rng(0x5eed);
  const brain = createAiState(brainRng, 'hard');
  const view = {
    get track() { return world.track; },
    get karts() { return world.karts; },
    get projectiles() { return world.projectiles; },
    rng: brainRng,
    get tick() { return world.tick; },
    get racing() { return world.racing; },
    moverAt: (index: number) => world.moverAt(index),
    get moverCount() { return world.moverCount; },
    humanLeadProgress: null,
  };
  const recorder = new InputRecorder();
  while (!kart.finished && recorder.length < MAX_TT_TICKS) {
    const speedScale = kart.speedScale;
    const input = quantizeInput(computeAiInput(view, kart, brain));
    kart.speedScale = speedScale; // the AI tunes CPU speed; a human kart must stay untouched
    recorder.push(input);
    world.step([input]);
    world.drainEvents();
  }
  return { trackId, log: recorder.encode(), ticks: kart.finishTick, lapTicks: [...kart.lapTicks], tickCount: recorder.length };
}

describe.skipIf(!simReady)('real replay verification (worker pool + src/sim)', () => {
  let app: TurboPalsApp;
  let pool: WorkerVerifier;
  let recorded: RecordedRun;

  beforeAll(async () => {
    recorded = await recordAiRun();
    // The source worker runs under tsx exactly as in `npm run dev`.
    pool = new WorkerVerifier({ workerUrl: new URL('../../src/server/verify-worker.ts', import.meta.url), size: 1, timeoutMs: 20_000 });
    app = await testApp({ verify: pool.verify });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await pool?.close();
  });

  it('the recorded CPU run finishes the race', () => {
    expect(recorded.ticks).toBeGreaterThan(0);
    expect(recorded.lapTicks.length).toBeGreaterThan(0);
  });

  it('re-simulates to exactly the recorded result', async () => {
    const { verifyTimeTrial } = await import('../../src/sim/replay.js');
    expect(verifyTimeTrial({ trackId: recorded.trackId, cc: 150, charId: 'kiki', log: recorded.log }))
      .toEqual({ ok: true, ticks: recorded.ticks, lapTicks: recorded.lapTicks });
  });

  it('accepts the genuine run and serves it back as a ghost', async () => {
    const body = runBody({
      trackId: recorded.trackId, charId: 'kiki', cc: 150, playerId: playerId(0x7777), name: '검증봇',
      ticks: recorded.ticks, lapTicks: recorded.lapTicks, log: recorded.log,
    });
    const res = await submit(app, body);
    expect(res.statusCode, res.body).toBe(200);
    const accepted = res.json() as SubmitRunResponse;
    expect(accepted).toMatchObject({ accepted: true, personalBest: true, rank: 1 });
    const ghost = (await app.inject({ method: 'GET', url: `/api/ghost/${accepted.id}` })).json() as GhostResponse;
    expect(ghost).toMatchObject({ ticks: recorded.ticks, log: recorded.log, charId: 'kiki' });
  }, 30_000);

  it('refuses the ghost to another player even when it is re-encoded', async () => {
    const bytes = Buffer.from(recorded.log, 'base64');
    // Split every run longer than one tick: identical inputs per tick, different log text.
    const runs: number[] = [];
    for (let p = 2; p < bytes.length; p += 4) {
      const word = bytes.readUInt16LE(p);
      const count = bytes.readUInt16LE(p + 2);
      if (count > 1) runs.push(word, 1, word, count - 1);
      else runs.push(word, count);
    }
    const respelled = Buffer.alloc(2 + runs.length * 2);
    respelled[0] = 1;
    runs.forEach((value, i) => respelled.writeUInt16LE(value, 2 + i * 2));
    const log = respelled.toString('base64');
    expect(log).not.toBe(recorded.log);
    const copy = await submit(app, runBody({
      trackId: recorded.trackId, charId: 'kiki', cc: 150, playerId: playerId(0x7778), name: '복사봇',
      ticks: recorded.ticks, lapTicks: recorded.lapTicks, log,
    }));
    expect(copy.statusCode, copy.body).toBe(409);
    expect(copy.json().error).toBe('DUPLICATE_RUN');
  }, 30_000);

  it('rejects a faster claimed time, a different character and a truncated log', async () => {
    const base = {
      trackId: recorded.trackId, cc: 150 as const, playerId: playerId(0x8888),
      ticks: recorded.ticks, lapTicks: recorded.lapTicks, log: recorded.log,
    };
    const faster = await submit(app, runBody({ ...base, charId: 'kiki', ticks: recorded.ticks - 60 }));
    expect(faster.statusCode).toBe(422);
    expect(faster.json().error).toBe('TIME_MISMATCH');

    const { InputRecorder, decodeLog, decodeInputWord } = await import('../../src/sim/input-log.js');
    const words = decodeLog(recorded.log, recorded.tickCount);
    const truncated = new InputRecorder();
    for (const word of words.subarray(0, words.length - 120)) truncated.push(decodeInputWord(word));
    const cut = await submit(app, runBody({ ...base, charId: 'kiki', log: truncated.encode() }));
    expect(cut.statusCode).toBe(422);
    expect(cut.json().error).toBe('REPLAY_INVALID');

    const swapped = await submit(app, runBody({ ...base, charId: 'bruno' }));
    expect(swapped.statusCode).toBe(422);
  }, 60_000);

  it('rejects garbage logs without crashing the worker', async () => {
    const garbage = await submit(app, runBody({ playerId: playerId(0x9999), log: 'AQA=' }));
    expect(garbage.statusCode).toBe(422);
    const malformed = await submit(app, runBody({ playerId: playerId(0x9999), log: 'Zm9vYmFy' }));
    expect(malformed.statusCode).toBe(422);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });
});
