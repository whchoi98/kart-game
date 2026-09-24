import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import type { SubmitRunRequest } from '../../src/shared/api.js';
import { buildApp, type BuildAppOptions, type TurboPalsApp } from '../../src/server/app.js';
import { MemoryRepository } from '../../src/server/memory-repository.js';
import type { VerifyFn, VerifyResult } from '../../src/server/verifier.js';

export const ORIGIN = 'https://play.turbo-pals.test';

/** Deterministic UUID v4 for player n. */
export function playerId(n: number): string {
  const hex = n.toString(16).padStart(12, '0').slice(-12);
  return `5f0c2a9e-7b1d-4c3e-8a2b-${hex}`;
}

/**
 * Stub logs understood by `stubVerifier`: "T<ticks>L<lap>_<lap>..." (optionally
 * suffixed with "_<nonce>" so different runs with equal times have different logs).
 * "BAD..." logs fail verification. Real logs are only used by the integration test.
 */
export function stubLog(ticks: number, lapTicks: number[], nonce = ''): string {
  return `T${ticks}L${lapTicks.join('_')}${nonce ? `N${nonce}` : ''}`;
}

export function splitLaps(ticks: number, laps = 3): number[] {
  const base = Math.floor(ticks / laps);
  return Array.from({ length: laps }, (_, i) => (i === laps - 1 ? ticks - base * (laps - 1) : base));
}

export const stubVerifier: VerifyFn = ({ log }): VerifyResult => {
  const match = /^T(\d+)L([\d_]+?)(?:N[A-Za-z0-9]+)?$/.exec(log);
  if (!match) return { ok: false, reason: 'run did not finish' };
  return { ok: true, ticks: Number(match[1]), lapTicks: match[2]!.split('_').map(Number) };
};

export function runBody(overrides: Partial<SubmitRunRequest> & { ticks?: number } = {}): SubmitRunRequest {
  const ticks = overrides.ticks ?? 6000;
  const lapTicks = overrides.lapTicks ?? splitLaps(ticks);
  return {
    trackId: 'sunny-meadow',
    cc: 150,
    charId: 'kiki',
    name: '레이서',
    playerId: playerId(1),
    ticks,
    lapTicks,
    log: overrides.log ?? stubLog(ticks, lapTicks),
    version: '1.0.0',
    ...overrides,
  };
}

export async function testApp(options: BuildAppOptions = {}): Promise<TurboPalsApp> {
  return buildApp({
    repository: new MemoryRepository(),
    verify: stubVerifier,
    staticDir: false,
    rateLimits: { submit: 10_000, read: 10_000, page: 10_000 },
    ...options,
    config: { allowedOrigins: [ORIGIN], ...options.config },
  });
}

export function submit(app: TurboPalsApp, body: unknown, extra: Partial<InjectOptions> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/runs',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(extra.headers ?? {}) },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

export interface ClientFixture { root: string; assetName: string; assetBody: string; cleanup(): void }

/** A minimal built client: index.html, one hashed asset and a root file. */
export function clientFixture(): ClientFixture {
  const root = mkdtempSync(join(tmpdir(), 'turbo-pals-client-'));
  mkdirSync(join(root, 'assets'));
  const assetName = 'index-3f9a1c2b.js';
  const assetBody = `console.log(${JSON.stringify('터보 '.repeat(2000))});\n`;
  writeFileSync(join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>TURBO PALS</title></head><body><div id="app"></div></body></html>');
  writeFileSync(join(root, 'assets', assetName), assetBody);
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, '.env'), 'SECRET=nope');
  return { root, assetName, assetBody, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
