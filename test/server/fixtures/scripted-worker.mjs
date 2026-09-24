// Test double for src/server/verify-worker.ts: behaviour is scripted by the log value.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, input }) => {
  const [command, arg] = input.log.split(':');
  switch (command) {
    case 'ok': {
      const ticks = Number(arg);
      parentPort.postMessage({ id, result: { ok: true, ticks, lapTicks: [ticks] } });
      break;
    }
    case 'slow': {
      const until = Date.now() + Number(arg);
      while (Date.now() < until) { /* burn CPU */ }
      parentPort.postMessage({ id, result: { ok: true, ticks: 1, lapTicks: [1] } });
      break;
    }
    case 'spin':
      for (;;) { /* never returns: the pool must terminate this worker */ }
    case 'reject':
      parentPort.postMessage({ id, result: { ok: false, reason: 'x'.repeat(500) } });
      break;
    case 'garbage':
      parentPort.postMessage({ id, result: { ok: true, ticks: 'fast' } });
      break;
    case 'exit':
      process.exit(3);
    case 'throw':
      throw new Error('scripted failure');
    default:
      parentPort.postMessage({ id, result: { ok: false, reason: `unknown command ${command}` } });
  }
});
