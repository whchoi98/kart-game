import { availableParallelism } from 'node:os';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { CharacterId, SpeedClass } from '../sim/types.js';

/** Mirrors `verifyTimeTrial` in src/sim/replay.ts (docs/architecture.md). */
export interface VerifyInput { trackId: string; cc: SpeedClass; charId: CharacterId; log: string }
export type VerifyResult = { ok: true; ticks: number; lapTicks: number[] } | { ok: false; reason: string };
/** Injectable verification function (tests pass a stub; production uses the worker pool). */
export type VerifyFn = (input: VerifyInput) => VerifyResult | Promise<VerifyResult>;

/** Every worker is busy and the wait queue is full (or the wait timed out). */
export class VerifierBusyError extends Error {
  constructor() { super('Verifier queue is full.'); this.name = 'VerifierBusyError'; }
}
/** The worker could not run (failed to load, crashed, pool closing). Not the player's fault. */
export class VerifierUnavailableError extends Error {
  constructor(readonly reason: string) { super(`Verifier unavailable (${reason}).`); this.name = 'VerifierUnavailableError'; }
}

export interface WorkerVerifierOptions {
  /** Worker entry. Default: verify-worker.js next to the server bundle (or .ts from source). */
  workerUrl?: URL;
  /** Concurrent worker threads. Default: min(2, available CPUs). */
  size?: number;
  /** CPU budget per run; the worker is terminated and the run rejected after this. */
  timeoutMs?: number;
  /** Runs allowed to wait for a free worker. */
  maxQueue?: number;
  /** Longest a run may wait in the queue before VerifierBusyError. */
  queueTimeoutMs?: number;
  resourceLimits?: ResourceLimits;
}

interface Job {
  id: number;
  input: VerifyInput;
  resolve: (result: VerifyResult) => void;
  reject: (error: Error) => void;
  queueTimer?: NodeJS.Timeout;
}

interface Slot {
  worker?: Worker;
  job?: Job;
  timer?: NodeJS.Timeout;
}

const MAX_REASON = 200;
const TS_BOOTSTRAP = new URL('./ts-worker-bootstrap.mjs', import.meta.url);

export function defaultWorkerUrl(): URL {
  // From the esbuild bundle this is dist/server/verify-worker.js; from source (tsx) the .ts file.
  return new URL(import.meta.url.endsWith('.ts') ? './verify-worker.ts' : './verify-worker.js', import.meta.url);
}

function sanitizeResult(value: unknown): VerifyResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (result.ok === true) {
    const { ticks, lapTicks } = result;
    if (!Number.isSafeInteger(ticks) || (ticks as number) < 0 || !Array.isArray(lapTicks) ||
        !lapTicks.every(lap => Number.isSafeInteger(lap) && lap >= 0)) return undefined;
    return { ok: true, ticks: ticks as number, lapTicks: [...lapTicks] as number[] };
  }
  if (result.ok === false) {
    const reason = typeof result.reason === 'string' && result.reason ? result.reason : 'rejected';
    return { ok: false, reason: reason.slice(0, MAX_REASON) };
  }
  return undefined;
}

/**
 * Runs `verifyTimeTrial` on worker threads so a long re-simulation never blocks
 * the event loop (health checks, static files, other requests) and a
 * pathological log can be cut off by terminating its worker.
 */
export class WorkerVerifier {
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private readonly workerUrl: URL;
  /** TypeScript entries (development) start through a tsx bootstrap. */
  private readonly sourceEntry: boolean;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;
  private readonly resourceLimits: ResourceLimits;
  private nextId = 1;
  private closing?: Promise<void>;
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: WorkerVerifierOptions = {}) {
    const size = options.size ?? Math.max(1, Math.min(2, availableParallelism()));
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new Error('WorkerVerifier size must be 1..8.');
    this.slots = Array.from({ length: size }, () => ({}));
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.sourceEntry = this.workerUrl.pathname.endsWith('.ts');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxQueue = options.maxQueue ?? 32;
    // Browsers give up on a submission after 8 s (src/client/api.ts): fail fast with 503 before that.
    this.queueTimeoutMs = options.queueTimeoutMs ?? 6_000;
    this.resourceLimits = options.resourceLimits ?? { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };
  }

  /** Bound function so it can be handed around as a VerifyFn. */
  readonly verify = (input: VerifyInput): Promise<VerifyResult> => {
    if (this.closing) return Promise.reject(new VerifierUnavailableError('closing'));
    return new Promise<VerifyResult>((resolve, reject) => {
      const job: Job = { id: this.nextId++, input, resolve, reject };
      const slot = this.slots.find(candidate => !candidate.job);
      if (slot) {
        this.run(slot, job);
        return;
      }
      if (this.queue.length >= this.maxQueue) {
        reject(new VerifierBusyError());
        return;
      }
      job.queueTimer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new VerifierBusyError());
      }, this.queueTimeoutMs);
      job.queueTimer.unref();
      this.queue.push(job);
    });
  };

  /** Starts every worker ahead of the first submission (module load + track caches). */
  warm(): void {
    if (this.closing) return;
    for (const slot of this.slots) if (!slot.worker) this.spawn(slot);
  }

  get pending(): number {
    return this.queue.length + this.slots.filter(slot => slot.job).length;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        for (const job of this.queue.splice(0)) {
          clearTimeout(job.queueTimer);
          job.reject(new VerifierUnavailableError('closing'));
        }
        // Running jobs finish or hit their timeout; then every thread is terminated.
        while (this.slots.some(slot => slot.job)) {
          await new Promise<void>(resolve => this.idleWaiters.add(resolve));
        }
        await Promise.all(this.slots.map(slot => this.retire(slot)));
      })();
    }
    return this.closing;
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(this.sourceEntry ? TS_BOOTSTRAP : this.workerUrl, {
      execArgv: [],
      workerData: this.sourceEntry ? { entry: this.workerUrl.href } : undefined,
      resourceLimits: this.resourceLimits,
      stdout: false,
      stderr: false,
    });
    slot.worker = worker;
    worker.unref();
    worker.on('message', (message: unknown) => {
      if (slot.worker !== worker || !slot.job) return;
      const data = message as { id?: unknown; result?: unknown } | null;
      if (!data || data.id !== slot.job.id) return;
      const result = sanitizeResult(data.result);
      if (result) this.settle(slot, job => job.resolve(result));
      else {
        void this.retire(slot);
        this.settle(slot, job => job.reject(new VerifierUnavailableError('malformed worker reply')));
      }
    });
    const fail = (reason: string) => {
      if (slot.worker !== worker) return;
      slot.worker = undefined;
      void worker.terminate().catch(() => undefined);
      this.settle(slot, job => job.reject(new VerifierUnavailableError(reason)));
    };
    worker.on('error', error => fail(`worker error: ${error instanceof Error ? error.name : 'unknown'}`));
    worker.on('messageerror', () => fail('worker message error'));
    worker.on('exit', code => fail(`worker exited (${code})`));
    return worker;
  }

  private run(slot: Slot, job: Job): void {
    slot.job = job;
    let worker: Worker;
    try {
      worker = slot.worker ?? this.spawn(slot);
    } catch {
      this.settle(slot, pending => pending.reject(new VerifierUnavailableError('spawn failed')));
      return;
    }
    slot.timer = setTimeout(() => {
      // Cut off a run that exceeds its CPU budget: an honest log re-simulates in well under a second.
      void this.retire(slot);
      this.settle(slot, pending => pending.resolve({ ok: false, reason: 'verification timed out' }));
    }, this.timeoutMs);
    worker.ref();
    worker.postMessage({ id: job.id, input: job.input });
  }

  /** Completes the slot's job and hands the slot to the next queued run. */
  private settle(slot: Slot, complete: (job: Job) => void): void {
    const job = slot.job;
    if (!job) return;
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = undefined;
    slot.worker?.unref();
    complete(job);
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.queueTimer);
      this.run(slot, next);
    } else if (!this.slots.some(candidate => candidate.job)) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private async retire(slot: Slot): Promise<void> {
    const worker = slot.worker;
    if (!worker) return;
    slot.worker = undefined;
    await worker.terminate().catch(() => undefined);
  }
}
