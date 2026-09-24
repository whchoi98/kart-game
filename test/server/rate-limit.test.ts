import { afterEach, describe, expect, it } from 'vitest';
import type { TurboPalsApp } from '../../src/server/app.js';
import { clientFixture, playerId, runBody, splitLaps, stubLog, submit, testApp } from './helpers.js';

/** Distinct players need distinct logs: a log is owned by the first player who registers it. */
const runFor = (n: number) => runBody({ playerId: playerId(n), log: stubLog(6000, splitLaps(6000), `p${n}`) });

const EDGE_IP = 'x-turbo-client-ip';

describe('rate limits', () => {
  let app: TurboPalsApp;
  afterEach(() => app.close());

  it('allows 12 submissions per minute per client, then answers 429 with Retry-After', async () => {
    app = await testApp({ rateLimits: { submit: 12, read: 120, page: 600 } });
    for (let i = 0; i < 12; i++) {
      const res = await submit(app, runFor(i), { headers: { [EDGE_IP]: '203.0.113.7' } });
      expect(res.statusCode, `submission ${i + 1}`).toBe(200);
    }
    const limited = await submit(app, runFor(99), { headers: { [EDGE_IP]: '203.0.113.7' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'RATE_LIMITED', message: expect.stringContaining('잠시 후') });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['cache-control']).toBe('no-store');

    // Another viewer behind the same CloudFront edge has its own budget.
    const other = await submit(app, runFor(100), { headers: { [EDGE_IP]: '198.51.100.20' } });
    expect(other.statusCode).toBe(200);
  });

  it('counts before validation, so malformed floods are limited too', async () => {
    app = await testApp({ rateLimits: { submit: 2 } });
    const headers = { [EDGE_IP]: '203.0.113.8' };
    expect((await submit(app, '{}', { headers })).statusCode).toBe(400);
    expect((await submit(app, '{}', { headers })).statusCode).toBe(400);
    expect((await submit(app, '{}', { headers })).statusCode).toBe(429);
  });

  it('shares one GET budget across leaderboard and ghost reads', async () => {
    app = await testApp({ rateLimits: { read: 3 } });
    const headers = { [EDGE_IP]: '2001:db8:1:2:aaaa::1' };
    expect((await app.inject({ method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=150', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/ghost/000000000aaaaaaaaaaaaaaaa', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=100', headers })).statusCode).toBe(200);
    // Same /64 network, different interface id: same budget.
    const sameNetwork = { [EDGE_IP]: '2001:db8:1:2:bbbb::9' };
    const limited = await app.inject({ method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=150', headers: sameNetwork });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('RATE_LIMITED');
    // The submit budget is independent.
    expect((await submit(app, runBody(), { headers })).statusCode).toBe(200);
  });

  it('ignores an invalid client-IP header and falls back to the socket address', async () => {
    app = await testApp({ rateLimits: { read: 1 } });
    const spoof = (value: string) => app.inject({
      method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=150', headers: { [EDGE_IP]: value }, remoteAddress: '10.100.0.9',
    });
    expect((await spoof('not-an-ip')).statusCode).toBe(200);
    expect((await spoof('also; bogus')).statusCode).toBe(429);
  });

  it('charges unknown /api/* paths (any method) to the read budget', async () => {
    const client = clientFixture();
    try {
      app = await testApp({ staticDir: client.root, rateLimits: { read: 2, page: 100 } });
      const headers = { [EDGE_IP]: '192.0.2.61' };
      expect((await app.inject({ method: 'GET', url: '/api/unknown', headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/nope', headers: { ...headers, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
      const limited = await app.inject({ method: 'GET', url: '/api/other', headers });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toBe('RATE_LIMITED');
      // A percent-encoded path that still routes to an API handler is an API request.
      const encoded = await app.inject({ method: 'GET', url: '/%61pi/leaderboard?track=sunny-meadow&cc=150', headers: { [EDGE_IP]: '192.0.2.62' } });
      expect(encoded.statusCode).toBe(200);
      expect(encoded.headers['cache-control']).toBe('no-store');
    } finally {
      client.cleanup();
    }
  });

  it('never rate-limits /healthz (ALB and container health checks)', async () => {
    app = await testApp({ rateLimits: { read: 1, page: 1 } });
    for (let i = 0; i < 20; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });

  it('limits pages and static files with their own budget', async () => {
    const client = clientFixture();
    try {
      app = await testApp({ staticDir: client.root, rateLimits: { page: 2, read: 5 } });
      const headers = { [EDGE_IP]: '192.0.2.44' };
      expect((await app.inject({ method: 'GET', url: '/', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/assets/${client.assetName}`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/garage', headers })).statusCode).toBe(429);
      expect((await app.inject({ method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=150', headers })).statusCode).toBe(200);
    } finally {
      client.cleanup();
    }
  });
});
