/**
 * Worker-thread entry: re-simulates a submitted time trial with the shared,
 * deterministic simulation. Bundled to dist/server/verify-worker.js.
 */
import { parentPort } from 'node:worker_threads';
import { verifyTimeTrial } from '../sim/replay.js';
import type { VerifyInput, VerifyResult } from './verifier.js';

if (!parentPort) throw new Error('verify-worker must run inside a worker thread.');
const port = parentPort;

port.on('message', (message: { id: number; input: VerifyInput }) => {
  let result: VerifyResult;
  try {
    result = verifyTimeTrial(message.input);
  } catch (error) {
    // decodeLog and the sim throw on malformed or impossible input: that is a rejected run.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    result = { ok: false, reason: `replay failed (${detail})` };
  }
  port.postMessage({ id: message.id, result });
});
