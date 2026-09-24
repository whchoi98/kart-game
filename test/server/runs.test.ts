import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaderboardResponse, SubmitRunResponse } from '../../src/shared/api.js';
import type { TurboPalsApp } from '../../src/server/app.js';
import { VerifierBusyError, VerifierUnavailableError, type VerifyFn } from '../../src/server/verifier.js';
import { playerId, runBody, splitLaps, stubLog, stubVerifier, submit, testApp } from './helpers.js';

const RUN_ID = /^[0-9a-z]{9}[0-9a-f]{16}$/;

async function board(app: TurboPalsApp, track = 'sunny-meadow', cc = 150): Promise<LeaderboardResponse> {
  const res = await app.inject({ method: 'GET', url: `/api/leaderboard?track=${track}&cc=${cc}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('POST /api/runs — acceptance', () => {
  let app: TurboPalsApp;
  beforeEach(async () => { app = await testApp(); });
  afterEach(() => app.close());

  it('accepts a verified run as a personal best at rank 1', async () => {
    const res = await submit(app, runBody());
    expect(res.statusCode).toBe(200);
    const body: SubmitRunResponse = res.json();
    expect(body).toEqual({ accepted: true, id: expect.stringMatching(RUN_ID), rank: 1, personalBest: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('stores the NFC-normalised, whitespace-collapsed name', async () => {
    const decomposed = '레이서'.normalize('NFD');
    const res = await submit(app, runBody({ name: `  ${decomposed}   Pro  ` }));
    expect(res.statusCode).toBe(200);
    const { entries } = await board(app);
    expect(entries[0]!.name).toBe('레이서 Pro');
    expect(entries[0]!.name).toBe(entries[0]!.name.normalize('NFC'));
  });

  it('accepts requests without an Origin header (non-browser clients rely on verification)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(runBody()),
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts application/json with a UTF-8 charset parameter', async () => {
    const res = await submit(app, runBody(), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/runs — validation', () => {
  let app: TurboPalsApp;
  beforeEach(async () => { app = await testApp(); });
  afterEach(() => app.close());

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['unknown track', { trackId: 'rainbow-road' }],
    ['unknown character', { charId: 'mario' }],
    ['speed class 75', { cc: 75 }],
    ['speed class as string', { cc: '150' }],
    ['UUID v1 player id', { playerId: 'a8098c1a-f86e-11da-bd1a-00112444be1e' }],
    ['non-UUID player id', { playerId: 'player-1' }],
    ['zero ticks', { ticks: 0 }],
    ['fractional ticks', { ticks: 6000.5 }],
    ['empty lap list', { lapTicks: [] }],
    ['too many laps', { lapTicks: Array(10).fill(600) }],
    ['non-base64 log', { log: 'not base64!' }],
    ['empty log', { log: '' }],
    ['bad version', { version: '1.0.0 beta<script>' }],
    ['extra field', { admin: true }],
  ];

  for (const [label, patch] of invalid) {
    it(`rejects ${label} with 400 INVALID_REQUEST`, async () => {
      const res = await submit(app, { ...runBody(), ...patch });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'INVALID_REQUEST', message: expect.stringContaining('요청 형식') });
    });
  }

  it('rejects a missing field and names it', async () => {
    const { log: _log, ...partial } = runBody();
    const res = await submit(app, partial);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('body.log');
  });

  const badNames = ['', '   ', '가나다라마바사아자차카타파', '<script>', 'a​b', '😀racer', 'DROP;TABLE', '___'];
  for (const name of badNames) {
    it(`rejects the name ${JSON.stringify(name)}`, async () => {
      const res = await submit(app, runBody({ name }));
      expect(res.statusCode).toBe(400);
      expect(['INVALID_NAME', 'INVALID_REQUEST']).toContain(res.json().error);
    });
  }

  it('accepts names of exactly 12 characters mixing Hangul, Latin, digits, _ and -', async () => {
    const res = await submit(app, runBody({ name: '터보팔_Pal-12 가' }));
    expect(res.statusCode).toBe(200);
  });

  it('rejects an input log over the contract limit', async () => {
    const res = await submit(app, runBody({ log: 'A'.repeat(200_004) }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects bodies above the body limit with 413', async () => {
    const res = await submit(app, runBody({ log: 'A'.repeat(300_000) }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects non-JSON content types with 415', async () => {
    const res = await submit(app, JSON.stringify(runBody()), { headers: { 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects malformed JSON and prototype pollution attempts with 400', async () => {
    expect((await submit(app, '{"trackId":')).statusCode).toBe(400);
    const polluted = await submit(app, `{"__proto__":{"admin":true},${JSON.stringify(runBody()).slice(1)}`);
    expect(polluted.statusCode).toBe(400);
  });

  it('rejects a cross-site Origin with 403 before touching the body', async () => {
    const res = await submit(app, runBody(), { headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN_ORIGIN');
    expect((await board(app)).entries).toHaveLength(0);
  });

  it('without configured origins accepts only same-host browser origins', async () => {
    const local = await testApp({ config: { allowedOrigins: [] } });
    try {
      const same = await submit(local, runBody(), { headers: { origin: 'http://localhost:8200', host: 'localhost:8200' } });
      expect(same.statusCode).toBe(200);
      const other = await submit(local, runBody({ playerId: playerId(2) }), { headers: { origin: 'http://attacker.test', host: 'localhost:8200' } });
      expect(other.statusCode).toBe(403);
    } finally {
      await local.close();
    }
  });
});

describe('POST /api/runs — server re-simulation', () => {
  let app: TurboPalsApp;
  afterEach(() => app.close());

  it('rejects a log the verifier cannot finish with 422 and a Korean reason', async () => {
    app = await testApp();
    const res = await submit(app, runBody({ log: 'BADLOG' }));
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toMatchObject({ accepted: false, rank: null, personalBest: false, error: 'REPLAY_INVALID' });
    expect(body.reason).toMatch(/재시뮬레이션/);
    expect(body.message).toBe(body.reason);
    expect((await board(app)).entries).toHaveLength(0);
  });

  it('hints at a stale client when the build version differs', async () => {
    app = await testApp({ config: { version: '2.0.0+abcdef' } });
    const res = await submit(app, runBody({ log: 'BADLOG', version: '1.0.0' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('VERSION_MISMATCH');
    expect(res.json().reason).toContain('새로고침');
    // A matching core version with different build metadata is not stale.
    const same = await submit(app, runBody({ log: 'BADLOG', version: '2.0.0+ffffff' }));
    expect(same.json().error).toBe('REPLAY_INVALID');
  });

  it('rejects a claimed time that differs from the re-simulation', async () => {
    app = await testApp();
    const res = await submit(app, runBody({ ticks: 5999, lapTicks: splitLaps(6000), log: stubLog(6000, splitLaps(6000)) }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('TIME_MISMATCH');
  });

  it('rejects claimed lap splits that differ from the re-simulation', async () => {
    app = await testApp();
    const res = await submit(app, runBody({ ticks: 6000, lapTicks: [1000, 2000, 3000], log: stubLog(6000, [2000, 2000, 2000]) }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('LAP_MISMATCH');
    const fewer = await submit(app, runBody({ ticks: 6000, lapTicks: [3000, 3000], log: stubLog(6000, [2000, 2000, 2000]) }));
    expect(fewer.json().error).toBe('LAP_MISMATCH');
  });

  it('passes exactly the run inputs to the verifier', async () => {
    const calls: unknown[] = [];
    app = await testApp({ verify: input => { calls.push(input); return stubVerifier(input); } });
    const body = runBody({ trackId: 'frost-peak', cc: 200, charId: 'bolt' });
    expect((await submit(app, body)).statusCode).toBe(200);
    expect(calls).toEqual([{ trackId: 'frost-peak', cc: 200, charId: 'bolt', log: body.log }]);
  });

  it('answers 503 with Retry-After when the verifier queue is full', async () => {
    app = await testApp({ verify: () => { throw new VerifierBusyError(); } });
    const res = await submit(app, runBody());
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json().error).toBe('VERIFIER_BUSY');
  });

  it('answers 503 SERVICE_UNAVAILABLE when the verifier is down, without leaking internals', async () => {
    const failing: VerifyFn = async () => { throw new VerifierUnavailableError('worker exited (1)'); };
    app = await testApp({ verify: failing });
    const res = await submit(app, runBody());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'SERVICE_UNAVAILABLE', message: expect.any(String) });
    expect(res.body).not.toContain('worker');
  });

  it('maps an unexpected verifier exception to 503', async () => {
    app = await testApp({ verify: () => { throw new TypeError('boom at /srv/secret/path'); } });
    const res = await submit(app, runBody());
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('secret');
  });
});

describe('leaderboard, personal bests and ghosts', () => {
  let app: TurboPalsApp;
  beforeEach(async () => { app = await testApp(); });
  afterEach(() => app.close());

  it('orders by time, one row per player, ties keep the earlier run first', async () => {
    const times = [6200, 5800, 6000, 5800, 7000];
    for (const [i, ticks] of times.entries()) {
      const res = await submit(app, runBody({ ticks, playerId: playerId(i + 1), name: `P${i + 1}`, log: stubLog(ticks, splitLaps(ticks), `p${i}`) }));
      expect(res.statusCode).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 2)); // distinct creation times for the tie
    }
    const { entries, trackId, cc } = await board(app);
    expect(trackId).toBe('sunny-meadow');
    expect(cc).toBe(150);
    expect(entries.map(e => [e.rank, e.name, e.ticks])).toEqual([
      [1, 'P2', 5800], [2, 'P4', 5800], [3, 'P3', 6000], [4, 'P1', 6200], [5, 'P5', 7000],
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['cc', 'charId', 'createdAt', 'id', 'lapTicks', 'name', 'rank', 'ticks', 'trackId']);
      expect(entry.lapTicks.reduce((a, b) => a + b, 0)).toBe(entry.ticks);
      expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
    }
    expect(JSON.stringify(entries)).not.toContain(playerId(1));
  });

  it('keeps boards separate per track and speed class', async () => {
    await submit(app, runBody({ cc: 100 }));
    await submit(app, runBody({ trackId: 'palm-beach' }));
    expect((await board(app)).entries).toHaveLength(0);
    expect((await board(app, 'sunny-meadow', 100)).entries).toHaveLength(1);
    expect((await board(app, 'palm-beach', 150)).entries).toHaveLength(1);
  });

  it('replaces a personal best, deletes the old ghost and ignores slower runs', async () => {
    const first = (await submit(app, runBody({ ticks: 6000, name: '첫기록' }))).json() as SubmitRunResponse;
    const faster = (await submit(app, runBody({ ticks: 5500, name: '새기록' }))).json() as SubmitRunResponse;
    expect(faster).toMatchObject({ accepted: true, personalBest: true, rank: 1 });
    expect(faster.id).not.toBe(first.id);

    const { entries } = await board(app);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: faster.id, ticks: 5500, name: '새기록' });
    expect((await app.inject({ method: 'GET', url: `/api/ghost/${first.id}` })).statusCode).toBe(404);

    const slower = await submit(app, runBody({ ticks: 5700, name: '느린기록' }));
    expect(slower.statusCode).toBe(200);
    expect(slower.json()).toEqual({ accepted: true, id: faster.id, rank: 1, personalBest: false });
    const equal = await submit(app, runBody({ ticks: 5500, log: stubLog(5500, splitLaps(5500), 'again') }));
    expect(equal.json()).toMatchObject({ personalBest: false, id: faster.id });
    expect((await board(app)).entries).toEqual(entries);
  });

  it('rejects a downloaded ghost re-submitted by another player with 409', async () => {
    const original = runBody({ ticks: 5600, playerId: playerId(1), name: '원조' });
    const { id } = (await submit(app, original)).json() as SubmitRunResponse;
    const ghost = (await app.inject({ method: 'GET', url: `/api/ghost/${id}` })).json();
    const copy = await submit(app, runBody({ ticks: 5600, playerId: playerId(2), name: '복사', log: ghost.log }));
    expect(copy.statusCode).toBe(409);
    expect(copy.json()).toMatchObject({ accepted: false, personalBest: false, rank: null, error: 'DUPLICATE_RUN' });
    expect(copy.json().reason).toContain('다른 플레이어');
    expect((await board(app)).entries.map(e => e.name)).toEqual(['원조']);
  });

  it('treats an identical re-submission (network retry) as the same personal best', async () => {
    const body = runBody();
    const first = (await submit(app, body)).json() as SubmitRunResponse;
    const retry = (await submit(app, body)).json() as SubmitRunResponse;
    expect(retry).toEqual(first);
    expect((await board(app)).entries).toHaveLength(1);
  });

  it('treats player ids case-insensitively', async () => {
    await submit(app, runBody({ ticks: 6000, playerId: playerId(0xabc).toUpperCase() }));
    await submit(app, runBody({ ticks: 5900, playerId: playerId(0xabc) }));
    expect((await board(app)).entries).toHaveLength(1);
  });

  it('returns the top 50 and a null rank outside it', async () => {
    for (let i = 0; i < 51; i++) {
      const ticks = 5000 + i * 10;
      expect((await submit(app, runBody({ ticks, playerId: playerId(100 + i), name: `R${i}` }))).statusCode).toBe(200);
    }
    const { entries } = await board(app);
    expect(entries).toHaveLength(50);
    expect(entries.at(-1)).toMatchObject({ rank: 50, ticks: 5490 });
    const outside = (await submit(app, runBody({ ticks: 9000, playerId: playerId(999) }))).json();
    expect(outside).toMatchObject({ accepted: true, personalBest: true, rank: null });
    const inside = (await submit(app, runBody({ ticks: 5005, playerId: playerId(998) }))).json();
    expect(inside).toMatchObject({ personalBest: true, rank: 2 });
  });

  it('serves the stored ghost log for a board entry', async () => {
    const body = runBody({ ticks: 6100, charId: 'mochi', name: '고스트' });
    const { id } = (await submit(app, body)).json() as SubmitRunResponse;
    const res = await app.inject({ method: 'GET', url: `/api/ghost/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id, trackId: 'sunny-meadow', cc: 150, charId: 'mochi', name: '고스트', ticks: 6100, log: body.log,
    });
    expect(res.headers['cache-control']).toContain('max-age=3600');
  });

  it('validates ghost ids and reports unknown ghosts as 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ghost/not-an-id' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/ghost/000000000aaaaaaaaaaaaaaaa' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('NOT_FOUND');
  });

  it('validates leaderboard queries strictly', async () => {
    for (const query of ['track=sunny-meadow', 'cc=150', 'track=nope&cc=150', 'track=sunny-meadow&cc=75', 'track=sunny-meadow&cc=150&x=1']) {
      const res = await app.inject({ method: 'GET', url: `/api/leaderboard?${query}` });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe('INVALID_REQUEST');
    }
  });

  it('allows GET API calls from any origin but still sends no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard?track=sunny-meadow&cc=50', headers: { origin: 'https://elsewhere.test' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
