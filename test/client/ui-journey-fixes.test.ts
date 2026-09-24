/**
 * Pure logic behind fixes found by the end-to-end player-journey QA pass:
 *  - VS results: a racer with no completed lap shows the placeholder, not "00:00.000".
 *  - Leaderboard cache: an accepted time-trial submission invalidates cached boards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaderboardVersion, submitRun } from '../../src/client/api.js';
import { formatLapTicks } from '../../src/client/ui/format.js';
import type { SubmitRunRequest } from '../../src/shared/api.js';

describe('formatLapTicks', () => {
  it('formats completed laps like formatTicks', () => {
    expect(formatLapTicks(60 * 31 + 30)).toBe('00:31.500');
    expect(formatLapTicks(1)).toBe('00:00.017');
  });

  it('shows the placeholder when no lap was completed', () => {
    expect(formatLapTicks(0)).toBe('--:--.---');
    expect(formatLapTicks(-5)).toBe('--:--.---');
    expect(formatLapTicks(Number.NaN)).toBe('--:--.---');
  });
});

describe('leaderboardVersion', () => {
  const req: SubmitRunRequest = {
    trackId: 'sunny-meadow', cc: 150, charId: 'kiki', name: 'QA', playerId: '00000000-0000-4000-8000-000000000000',
    ticks: 5640, lapTicks: [1817, 1895, 1928], log: 'AAAA', version: '1.0.0',
  };
  const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  afterEach(() => { vi.unstubAllGlobals(); });

  it('is bumped by an accepted run', async () => {
    vi.stubGlobal('fetch', respond({ accepted: true, id: 'r1', rank: 1, personalBest: true }));
    const before = leaderboardVersion();
    const res = await submitRun(req);
    expect(res.accepted).toBe(true);
    expect(leaderboardVersion()).toBe(before + 1);
  });

  it('is unchanged by a rejected run or a failed request', async () => {
    vi.stubGlobal('fetch', respond({ accepted: false, id: '', rank: null, personalBest: false, reason: 'REPLAY_INVALID' }));
    const before = leaderboardVersion();
    await submitRun(req);
    expect(leaderboardVersion()).toBe(before);
    vi.stubGlobal('fetch', respond({ error: 'SERVICE_UNAVAILABLE', message: 'down' }, 503));
    await expect(submitRun(req)).rejects.toThrow();
    expect(leaderboardVersion()).toBe(before);
  });
});
