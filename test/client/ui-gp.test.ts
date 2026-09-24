import { describe, expect, it } from 'vitest';
import { GP_POINTS } from '../../src/sim/constants.js';
import type { CharacterId, RaceResult } from '../../src/sim/types.js';
import {
  applyRaceResults, gridFromStandings, initialStandings, isBetterTrophy, pointsForPosition, rankOf,
  sortStandings, trophyForRank,
} from '../../src/client/ui/gp.js';
import { buildGrid, pickCpuCharacters, seededRandom, shuffle } from '../../src/client/ui/grid.js';

const CAST: CharacterId[] = ['bruno', 'mochi', 'rex', 'kiki', 'taro', 'hana', 'bolt', 'pip'];

function results(order: CharacterId[]): RaceResult[] {
  return order.map((charId, i) => ({
    kart: i, charId, human: charId === 'pip' ? 0 : -1, position: i + 1,
    ticks: 6000 + i * 60, estimated: false, lapTicks: [2000, 2000, 2000 + i * 60], bestLapTicks: 2000,
  }));
}

describe('points', () => {
  it('follows GP_POINTS and gives 0 outside the table', () => {
    expect(pointsForPosition(1)).toBe(GP_POINTS[0]);
    expect(pointsForPosition(8)).toBe(GP_POINTS[7]);
    expect(pointsForPosition(9)).toBe(0);
    expect(pointsForPosition(0)).toBe(0);
  });
});

describe('standings', () => {
  const racers = CAST.map(charId => ({ charId, human: charId === 'pip' ? 0 : -1 }));

  it('accumulates points over races and sorts by total', () => {
    let st = initialStandings(racers);
    expect(st.every(e => e.points === 0)).toBe(true);
    const r1 = applyRaceResults(st, results(['pip', 'bruno', 'mochi', 'rex', 'kiki', 'taro', 'hana', 'bolt']));
    st = r1.standings;
    expect(st[0]!.charId).toBe('pip');
    expect(st[0]!.points).toBe(15);
    expect(r1.awards.map(a => a.points)).toEqual([...GP_POINTS]);
    const r2 = applyRaceResults(st, results(['bruno', 'pip', 'mochi', 'rex', 'kiki', 'taro', 'hana', 'bolt']));
    st = r2.standings;
    expect(st.find(e => e.charId === 'pip')!.points).toBe(27);
    expect(st.find(e => e.charId === 'bruno')!.points).toBe(27);
    // Tie on 27: bruno won the most recent race, so he ranks first.
    expect(st[0]!.charId).toBe('bruno');
    expect(st[1]!.charId).toBe('pip');
    expect(rankOf(st, 'pip')).toBe(2);
    expect(st.find(e => e.charId === 'pip')!.history).toEqual([1, 2]);
  });

  it('builds the next grid as the reverse of the standings', () => {
    const st = applyRaceResults(initialStandings(racers),
      results(['pip', 'bruno', 'mochi', 'rex', 'kiki', 'taro', 'hana', 'bolt'])).standings;
    const grid = gridFromStandings(st);
    expect(grid[0]!.charId).toBe('bolt');
    expect(grid[7]!.charId).toBe('pip');
    expect(grid[7]!.human).toBe(0);
    expect(grid).toHaveLength(8);
  });

  it('sort is deterministic for complete ties', () => {
    const tied = CAST.map(charId => ({ charId, human: -1, points: 10, lastPosition: 1, history: [] }));
    expect(sortStandings(tied).map(e => e.charId)).toEqual([...CAST].sort());
  });

  it('awards trophies to the top three only', () => {
    expect(trophyForRank(1)).toBe('gold');
    expect(trophyForRank(2)).toBe('silver');
    expect(trophyForRank(3)).toBe('bronze');
    expect(trophyForRank(4)).toBeNull();
    expect(isBetterTrophy('gold', 'silver')).toBe(true);
    expect(isBetterTrophy('bronze', 'silver')).toBe(false);
    expect(isBetterTrophy('bronze', null)).toBe(true);
    expect(isBetterTrophy(null, null)).toBe(false);
  });
});

describe('grids', () => {
  it('shuffles deterministically with a seed and keeps every item', () => {
    const a = shuffle(CAST, seededRandom(42));
    const b = shuffle(CAST, seededRandom(42));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...CAST].sort());
  });

  it('GP race 1: seven distinct CPUs ahead, the human last', () => {
    const grid = buildGrid(['kiki'], 7, seededRandom(7));
    expect(grid).toHaveLength(8);
    expect(grid[7]).toEqual({ charId: 'kiki', human: 0 });
    const cpus = grid.slice(0, 7);
    expect(cpus.every(r => r.human === -1)).toBe(true);
    expect(new Set(grid.map(r => r.charId)).size).toBe(8);
  });

  it('duo: both humans at the back (P1 last) and the CPU count is capped', () => {
    const grid = buildGrid(['pip', 'rex'], 9, seededRandom(3));
    expect(grid).toHaveLength(8);
    expect(grid[7]).toEqual({ charId: 'pip', human: 0 });
    expect(grid[6]).toEqual({ charId: 'rex', human: 1 });
    expect(new Set(grid.map(r => r.charId)).size).toBe(8);
  });

  it('VS with no CPUs is a solo race', () => {
    expect(buildGrid(['hana'], 0, seededRandom(1))).toEqual([{ charId: 'hana', human: 0 }]);
    expect(pickCpuCharacters(['hana'], 3, seededRandom(1))).not.toContain('hana');
  });
});
