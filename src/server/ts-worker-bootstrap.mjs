// Development only: runs a TypeScript worker entry (src/server/verify-worker.ts)
// through tsx. `--import tsx` in Worker execArgv does not apply loader hooks to
// worker threads on every supported Node version; tsImport does. Production
// uses the esbuild bundle (dist/server/verify-worker.js) and never loads this.
import { workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

await tsImport(workerData.entry, import.meta.url);
