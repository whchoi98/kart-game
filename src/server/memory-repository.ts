import type { GhostResponse, LeaderboardEntry } from '../shared/api.js';
import type { SpeedClass } from '../sim/types.js';
import { unavailable } from './errors.js';
import {
  DuplicateRunError, bestKey, boardKey, rankKey, toEntry, toGhost,
  type Repository, type SubmitOutcome, type VerifiedRun,
} from './repository.js';

interface Row { sk: string; run: VerifiedRun }
interface Best { id: string; sk: string; ticks: number; logHash: string }

/** Index of the first row whose key is >= sk (rows are sorted ascending). */
function lowerBound(rows: readonly Row[], sk: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.sk < sk) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Process-local repository for development, tests and single-task demos.
 * Each mutation runs synchronously (no await between read and write), so
 * concurrent requests observe the same consistency rules as DynamoDB.
 */
export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;
  private readonly boards = new Map<string, Row[]>();
  private readonly bests = new Map<string, Best>();
  private readonly ghosts = new Map<string, VerifiedRun>();
  /** logHash → playerId of the first player who registered the log (insertion ordered). */
  private readonly logClaims = new Map<string, string>();
  /** Claims outlive replaced runs; cap them too so a long-running demo cannot grow without bound. */
  private readonly claimCapacity: number;

  /** @param capacity maximum stored runs (each carries a ghost log of up to ~200 KB). */
  constructor(private readonly capacity = 5_000) {
    this.claimCapacity = capacity * 10;
  }

  async submit(run: VerifiedRun, topSize: number): Promise<SubmitOutcome> {
    const owner = this.logClaims.get(run.logHash);
    if (owner !== undefined && owner !== run.playerId) throw new DuplicateRunError();
    const board = boardKey(run.trackId, run.cc);
    const rows = this.boards.get(board) ?? [];
    const key = bestKey(run.trackId, run.cc, run.playerId);
    const current = this.bests.get(key);

    if (current && (current.logHash === run.logHash || current.ticks <= run.ticks)) {
      return {
        personalBest: current.logHash === run.logHash,
        id: current.id,
        rank: this.rankOf(rows, current.sk, topSize),
      };
    }
    if (!current && this.ghosts.size >= this.capacity) throw unavailable();

    if (current) {
      const index = lowerBound(rows, current.sk);
      if (rows[index]?.sk === current.sk) rows.splice(index, 1);
      this.ghosts.delete(current.id);
    }
    const sk = rankKey(run.ticks, run.id);
    const stored = structuredClone(run);
    rows.splice(lowerBound(rows, sk), 0, { sk, run: stored });
    this.boards.set(board, rows);
    this.bests.set(key, { id: run.id, sk, ticks: run.ticks, logHash: run.logHash });
    this.ghosts.set(run.id, stored);
    this.logClaims.set(run.logHash, run.playerId);
    if (this.logClaims.size > this.claimCapacity) {
      // Forget the oldest claim (in-memory mode only — DynamoDB keeps claims permanently).
      const oldest = this.logClaims.keys().next().value;
      if (oldest !== undefined) this.logClaims.delete(oldest);
    }
    return { personalBest: true, id: run.id, rank: this.rankOf(rows, sk, topSize) };
  }

  async leaderboard(trackId: string, cc: SpeedClass, limit: number): Promise<LeaderboardEntry[]> {
    const rows = this.boards.get(boardKey(trackId, cc)) ?? [];
    return rows.slice(0, limit).map((row, index) => toEntry(row.run, index + 1));
  }

  async ghost(id: string): Promise<GhostResponse | undefined> {
    const run = this.ghosts.get(id);
    return run ? toGhost(run) : undefined;
  }

  async close(): Promise<void> {
    // No sockets or timers to release.
  }

  /** Rows are one per player and the player's own row is never before `sk`, so this counts other players. */
  private rankOf(rows: readonly Row[], sk: string, topSize: number): number | null {
    const index = lowerBound(rows, sk);
    return index < topSize ? index + 1 : null;
  }
}
