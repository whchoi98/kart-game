import { afterEach, describe, expect, it } from 'vitest';
import {
  VerifierBusyError, VerifierUnavailableError, WorkerVerifier, defaultWorkerUrl,
  type VerifyInput, type WorkerVerifierOptions,
} from '../../src/server/verifier.js';

const scripted = new URL('./fixtures/scripted-worker.mjs', import.meta.url);
const broken = new URL('./fixtures/broken-worker.mjs', import.meta.url);
const input = (log: string): VerifyInput => ({ trackId: 'sunny-meadow', cc: 150, charId: 'kiki', log });

describe('WorkerVerifier', () => {
  let pool: WorkerVerifier | undefined;
  const open = (options: WorkerVerifierOptions = {}) => (pool = new WorkerVerifier({ workerUrl: scripted, ...options }));
  afterEach(async () => { await pool?.close(); pool = undefined; });

  it('returns worker results and reuses warm workers', async () => {
    const verifier = open({ size: 1 });
    verifier.warm();
    expect(await verifier.verify(input('ok:4321'))).toEqual({ ok: true, ticks: 4321, lapTicks: [4321] });
    expect(await verifier.verify(input('ok:99'))).toEqual({ ok: true, ticks: 99, lapTicks: [99] });
    expect(verifier.pending).toBe(0);
  });

  it('truncates long rejection reasons', async () => {
    const result = await open().verify(input('reject'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason.length).toBe(200);
  });

  it('rejects a run that exceeds its CPU budget and recovers with a fresh worker', async () => {
    const verifier = open({ size: 1, timeoutMs: 200 });
    const started = Date.now();
    expect(await verifier.verify(input('spin'))).toEqual({ ok: false, reason: 'verification timed out' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await verifier.verify(input('ok:7'))).toEqual({ ok: true, ticks: 7, lapTicks: [7] });
  });

  it('queues runs while every worker is busy and rejects when the queue is full', async () => {
    const verifier = open({ size: 1, maxQueue: 1 });
    const first = verifier.verify(input('slow:150'));
    const queued = verifier.verify(input('ok:2'));
    await expect(verifier.verify(input('ok:3'))).rejects.toBeInstanceOf(VerifierBusyError);
    expect(await first).toMatchObject({ ok: true });
    expect(await queued).toEqual({ ok: true, ticks: 2, lapTicks: [2] });
  });

  it('gives up on runs that wait too long in the queue', async () => {
    const verifier = open({ size: 1, maxQueue: 4, queueTimeoutMs: 50 });
    const running = verifier.verify(input('slow:300'));
    await expect(verifier.verify(input('ok:1'))).rejects.toBeInstanceOf(VerifierBusyError);
    await running;
  });

  it('treats crashes and malformed replies as unavailability, not as a player failure', async () => {
    const verifier = open({ size: 1 });
    await expect(verifier.verify(input('exit'))).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(verifier.verify(input('throw'))).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(verifier.verify(input('garbage'))).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(await verifier.verify(input('ok:5'))).toEqual({ ok: true, ticks: 5, lapTicks: [5] });
  });

  it('reports a worker that cannot load its simulation as unavailable', async () => {
    pool = new WorkerVerifier({ workerUrl: broken, size: 1 });
    const error = await pool.verify(input('ok:1')).catch(e => e);
    expect(error).toBeInstanceOf(VerifierUnavailableError);
  });

  it('drains running work on close, rejects queued work and refuses new runs', async () => {
    const verifier = open({ size: 1, maxQueue: 2 });
    const running = verifier.verify(input('slow:150'));
    const queued = verifier.verify(input('ok:1'));
    const closed = verifier.close();
    await expect(queued).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(await running).toMatchObject({ ok: true });
    await closed;
    await expect(verifier.verify(input('ok:1'))).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it('resolves the bundled worker next to the server bundle and the .ts worker from source', () => {
    expect(defaultWorkerUrl().pathname).toMatch(/src\/server\/verify-worker\.ts$/);
  });
});
