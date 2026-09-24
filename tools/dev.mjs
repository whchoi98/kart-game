#!/usr/bin/env node
/**
 * Local development:
 *   http://localhost:8200  Vite dev server (HMR); proxies /api and /healthz → 8201 (vite.config.ts)
 *   http://127.0.0.1:8201  Fastify API via `tsx watch`, in-memory rankings, real replay verification
 * Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

// Vite listens on 0.0.0.0 and its proxy rewrites Host, so the API only sees the page's Origin:
// allow this machine's LAN addresses too, so a phone or tablet on the same network can submit runs.
const lanOrigins = Object.values(networkInterfaces())
  .flat()
  .filter(address => address && address.family === 'IPv4' && !address.internal)
  .map(address => `http://${address.address}:8200`)
  .slice(0, 14); // the server accepts at most 16 origins

const serverEnv = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '8201',
  TABLE_NAME: '',
  STATIC_DIR: 'dist/client',
  PUBLIC_ORIGIN: 'http://localhost:8200',
  ALLOWED_ORIGINS: ['http://127.0.0.1:8200', ...lanOrigins].join(','),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

const children = [
  spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'src/server/index.ts'], {
    cwd: root, stdio: 'inherit', env: serverEnv,
  }),
  spawn(process.execPath, [viteBin], { cwd: root, stdio: 'inherit', env: process.env }),
];

let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
for (const child of children) {
  child.on('exit', code => {
    // One side died (port in use, syntax error at startup…): stop the other too.
    if (!shuttingDown) shutdown('SIGTERM', code ?? 1);
  });
}

console.log('TURBO PALS dev → http://localhost:8200  (API http://127.0.0.1:8201, in-memory rankings)');
if (lanOrigins.length) console.log(`  LAN: ${lanOrigins.join('  ')}`);
