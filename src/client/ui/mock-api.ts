/** Preview-only fetch shim for /api/* so the leaderboard / submit / ghost flows can be exercised offline. */
import { CHARACTER_IDS } from '../../sim/characters.js';
import type { GhostResponse, LeaderboardEntry, LeaderboardResponse, SubmitRunRequest, SubmitRunResponse } from '../../shared/api.js';
import type { SpeedClass } from '../../sim/types.js';
import { seededRandom } from './grid.js';
import { hashString } from '../../sim/rng.js';

const NAMES = ['터보왕', '드리프트장인', 'KartMaster', '번개발', '핍사랑', 'Neo_Racer', '모찌모찌', '코너킹', 'speed-kid', '해변질주', '별빛레이서', '용암탈출'];

function board(trackId: string, cc: SpeedClass): LeaderboardEntry[] {
  const rand = seededRandom(hashString(`${trackId}|${cc}`));
  if (trackId === 'starlight-road') return [];
  const base = 60 * (70 + Math.floor(rand() * 30));
  const out: LeaderboardEntry[] = [];
  let t = base;
  for (let i = 0; i < 24; i++) {
    t += Math.floor(rand() * 90) + 6;
    const lap = Math.round(t / 3);
    out.push({
      rank: i + 1, id: `mock-${trackId}-${cc}-${i}`, name: NAMES[Math.floor(rand() * NAMES.length)]!,
      charId: CHARACTER_IDS[Math.floor(rand() * CHARACTER_IDS.length)]!, trackId, cc, ticks: t,
      lapTicks: [lap, lap, t - lap * 2], createdAt: new Date(Date.UTC(2026, 8, 1 + (i % 20), 12)).toISOString(),
    });
  }
  return out;
}

export function installMockApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    await new Promise(r => setTimeout(r, 350));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/leaderboard') {
      const trackId = url.searchParams.get('track') ?? '';
      const cc = Number(url.searchParams.get('cc')) as SpeedClass;
      const res: LeaderboardResponse = { trackId, cc, entries: board(trackId, cc) };
      return json(res);
    }
    if (url.pathname === '/api/runs' && init?.method === 'POST') {
      const req = JSON.parse(String(init.body)) as SubmitRunRequest;
      const entries = board(req.trackId, req.cc);
      const rank = entries.findIndex(e => e.ticks > req.ticks);
      const res: SubmitRunResponse = { accepted: true, id: 'mock-run', rank: rank < 0 ? (entries.length < 50 ? entries.length + 1 : null) : rank + 1, personalBest: true };
      return json(res);
    }
    const m = /^\/api\/ghost\/(.+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const res: GhostResponse = { id, trackId: 'sunny-meadow', cc: 150, charId: 'bolt', name: '터보왕', ticks: 5400, log: 'AAAA' };
      return json(res);
    }
    return json({ error: 'not_found', message: 'Not found' }, 404);
  };
}
