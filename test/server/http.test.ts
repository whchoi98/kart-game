import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../src/shared/csp.js';
import { buildApp, type TurboPalsApp } from '../../src/server/app.js';
import { clientFixture, stubVerifier, testApp, type ClientFixture } from './helpers.js';

describe('health and security headers', () => {
  let app: TurboPalsApp;
  beforeAll(async () => { app = await testApp({ config: { version: '1.0.0+abc123def456' } }); });
  afterAll(() => app.close());

  it('GET /healthz reports ok with the build version and is never cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '1.0.0+abc123def456' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends the shared CSP and the hardening headers on every response', async () => {
    for (const url of ['/healthz', '/api/leaderboard?track=sunny-meadow&cc=150', '/missing']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy']).toBe(contentSecurityPolicy());
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const permissions = String(res.headers['permissions-policy']);
      expect(permissions).toContain('gamepad=(self)');
      expect(permissions).toContain('fullscreen=(self)');
      expect(permissions).toContain('camera=()');
    }
  });

  it('the origin CSP is self-only and never forces HTTPS (the edge adds that)', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' blob:");
    // Inline styles only (index.html splash CSS); scripts stay strictly external.
    expect(csp).toMatch(/(?:^|; )script-src 'self' blob:(?:;|$)/);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:|'unsafe-eval'|\*/);
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy({ upgradeInsecureRequests: true })).toMatch(/; upgrade-insecure-requests$/);
  });

  it('answers unknown API routes and methods with a JSON 404', async () => {
    for (const [method, url] of [['GET', '/api/nope'], ['POST', '/api/leaderboard'], ['DELETE', '/api/runs']] as const) {
      const res = await app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: method === 'GET' ? undefined : '{}' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'NOT_FOUND', message: expect.any(String) });
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('static client', () => {
  let app: TurboPalsApp;
  let client: ClientFixture;
  beforeAll(async () => {
    client = clientFixture();
    app = await testApp({ staticDir: client.root });
  });
  afterAll(async () => {
    await app.close();
    client.cleanup();
  });

  it('serves index.html with no-cache so a deploy is picked up immediately', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('TURBO PALS');
    const head = await app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('serves hashed assets as immutable for one year, compressed when accepted', async () => {
    const plain = await app.inject({ method: 'GET', url: `/assets/${client.assetName}` });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(plain.headers['content-type']).toMatch(/javascript/);
    expect(plain.body).toBe(client.assetBody);
    expect(plain.headers.etag).toBeTruthy();

    const br = await app.inject({ method: 'GET', url: `/assets/${client.assetName}`, headers: { 'accept-encoding': 'br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const gzip = await app.inject({ method: 'GET', url: `/assets/${client.assetName}`, headers: { 'accept-encoding': 'gzip' } });
    expect(gzip.headers['content-encoding']).toBe('gzip');
  });

  it('revalidates other root files', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for client-side navigations without an extension', async () => {
    for (const url of ['/time-trial', '/time-trial/sunny-meadow', '/ranking?track=sunny-meadow']) {
      const res = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('TURBO PALS');
    }
  });

  it('never answers a missing file, asset, API route or dotfile with HTML', async () => {
    for (const url of ['/assets/missing-1234.js', '/assets/sub/dir', '/logo.png', '/api/unknown', '/.env']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('SECRET');
    }
  });

  it('answers junk static paths as 4xx client errors in the API error shape, never as 5xx', async () => {
    const cases: Array<[string, Record<string, string>, number, string]> = [
      ['/assets/', {}, 404, 'NOT_FOUND'],
      ['/assets/%00', {}, 404, 'NOT_FOUND'],
      [`/${'a'.repeat(5000)}.js`, {}, 404, 'NOT_FOUND'],
      [`/assets/${client.assetName}`, { range: 'bytes=999999-' }, 416, 'RANGE_NOT_SATISFIABLE'],
      ['/a%ZZ', {}, 400, 'INVALID_REQUEST'],
      ['/api/ghost/%E0%A4%A', {}, 400, 'INVALID_REQUEST'],
    ];
    for (const [url, headers, status, code] of cases) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url.slice(0, 40)).toBe(status);
      expect(res.json(), url.slice(0, 40)).toEqual({ error: code, message: expect.any(String) });
      expect(res.headers['content-security-policy']).toBe(contentSecurityPolicy());
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('%ZZ');
    }
    const partial = await app.inject({ method: 'GET', url: `/assets/${client.assetName}`, headers: { range: 'bytes=0-6' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe('console');
  });

  it('rejects path traversal', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/..%2f..%2f..%2fetc%2fpasswd' });
    expect([400, 403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('root:');
  });
});

describe('startup guards', () => {
  it('refuses to start in production without a built client', async () => {
    await expect(buildApp({ config: { production: true }, staticDir: '/nonexistent/turbo-pals', verify: stubVerifier }))
      .rejects.toThrow(/client/);
  });

  it('works without a client in development (API only)', async () => {
    const app = await buildApp({ staticDir: '/nonexistent/turbo-pals', verify: stubVerifier });
    try {
      expect(app.staticRoot).toBeUndefined();
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
