/**
 * Grand Prix bookkeeping: points, standings order, next-race grid, trophies.
 * Pure functions (unit tested in test/client/ui-gp.test.ts).
 */
import { GP_POINTS } from '../../sim/constants.js';
import type { CharacterId, RaceResult, RacerSetup } from '../../sim/types.js';

export type TrophyTier = 'gold' | 'silver' | 'bronze';

export interface GpEntry {
  charId: CharacterId;
  /** Human player index (0/1) or -1 for CPU. */
  human: number;
  points: number;
  /** Finishing position in the most recent race (tie-breaker), 0 before race 1. */
  lastPosition: number;
  /** Finishing position of every race so far. */
  history: number[];
}

export interface GpAward {
  charId: CharacterId;
  human: number;
  position: number;
  points: number;
}

export function pointsForPosition(position: number): number {
  return GP_POINTS[position - 1] ?? 0;
}

/** Fresh standings for the racers of GP race 1 (every entry at 0 points). */
export function initialStandings(racers: readonly RacerSetup[]): GpEntry[] {
  return racers.map((r, i) => ({
    charId: r.charId,
    human: r.human,
    points: 0,
    // Before any race the tie-breaker is the reverse grid order (the pole sitter "leads").
    lastPosition: i + 1,
    history: [],
  }));
}

/** Order by points (desc), then by the last race's position (asc), then by character id. */
export function sortStandings(entries: readonly GpEntry[]): GpEntry[] {
  return [...entries].sort((a, b) =>
    b.points - a.points
    || a.lastPosition - b.lastPosition
    || (a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0));
}

/**
 * Add the points of one race. Racers are matched by character id (GP casts are
 * always 8 distinct characters). Returns the new sorted standings and the award list
 * in finishing order.
 */
export function applyRaceResults(
  standings: readonly GpEntry[],
  results: readonly RaceResult[],
): { standings: GpEntry[]; awards: GpAward[] } {
  const byChar = new Map(results.map(r => [r.charId, r] as const));
  const next = standings.map(e => {
    const r = byChar.get(e.charId);
    if (!r) return { ...e, history: [...e.history, 0] };
    const pts = pointsForPosition(r.position);
    return {
      ...e,
      points: e.points + pts,
      lastPosition: r.position,
      history: [...e.history, r.position],
    };
  });
  const awards = [...results]
    .sort((a, b) => a.position - b.position)
    .map(r => ({ charId: r.charId, human: r.human, position: r.position, points: pointsForPosition(r.position) }));
  return { standings: sortStandings(next), awards };
}

/** Grid for the next race: reverse of the current standings (leader starts at the back). */
export function gridFromStandings(standings: readonly GpEntry[]): RacerSetup[] {
  return sortStandings(standings).reverse().map(e => ({ charId: e.charId, human: e.human }));
}

/** 1-based standing of a character (0 if absent). */
export function rankOf(standings: readonly GpEntry[], charId: CharacterId): number {
  return sortStandings(standings).findIndex(e => e.charId === charId) + 1;
}

export function trophyForRank(rank: number): TrophyTier | null {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return null;
}

const TIER_ORDER: Record<TrophyTier, number> = { gold: 3, silver: 2, bronze: 1 };

/** True if `candidate` beats `current` (null = no trophy yet). */
export function isBetterTrophy(candidate: TrophyTier | null, current: TrophyTier | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return TIER_ORDER[candidate] > TIER_ORDER[current];
}

export const TROPHY_LABEL: Record<TrophyTier, string> = {
  gold: '금 트로피',
  silver: '은 트로피',
  bronze: '동 트로피',
};
