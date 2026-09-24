/**
 * Production / development entry point.
 *   PORT (8080) HOST (0.0.0.0 in production) STATIC_DIR (dist/client)
 *   TABLE_NAME (empty → in-memory) AWS_REGION APP_VERSION
 *   PUBLIC_ORIGIN / ALLOWED_ORIGINS (comma separated exact origins allowed to POST)
 */
import { buildApp } from './app.js';
import { readConfig, type ServerConfig } from './config.js';

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  // Used before/after the Fastify logger exists. Never include env values that could be secrets.
  process.stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), event, ...fields })}\n`);
}

function loadConfig(): ServerConfig {
  try {
    return readConfig();
  } catch (error) {
    emit('error', 'config_invalid', { message: error instanceof Error ? error.message : 'invalid configuration' });
    process.exit(1);
  }
}

const config = loadConfig();

const app = await buildApp({
  config,
  warmVerifier: true,
  logger: {
    level: process.env.LOG_LEVEL?.trim() || 'info',
    base: { service: 'turbo-pals', version: config.version },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: label => ({ level: label }) },
  },
}).catch(error => {
  emit('error', 'startup_failed', { message: error instanceof Error ? error.message : 'startup failed' });
  process.exit(1);
});

if (config.production && app.repositoryKind === 'memory') {
  app.log.warn({ event: 'memory_repository' }, 'TABLE_NAME is empty: rankings are kept in memory and lost on restart');
}
if (config.production && config.allowedOrigins.length === 0) {
  app.log.warn({ event: 'no_public_origin' }, 'PUBLIC_ORIGIN is not set: only same-host browser origins may submit runs');
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ event: 'shutdown', signal }, 'draining connections');
  // ECS stopTimeout is 30 s; leave headroom so the process always exits on its own.
  const deadline = setTimeout(() => {
    emit('error', 'shutdown_timeout');
    process.exit(1);
  }, 25_000);
  deadline.unref();
  try {
    await app.close();
    clearTimeout(deadline);
    app.log.info({ event: 'stopped' }, 'server stopped');
  } catch {
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({
    event: 'listening', port: config.port, repository: app.repositoryKind,
    static: Boolean(app.staticRoot), allowedOrigins: config.allowedOrigins.length,
  }, 'TURBO PALS server ready');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'LISTEN_FAILED';
  emit('error', 'listen_failed', { code });
  await app.close().catch(() => undefined);
  process.exit(1);
}
