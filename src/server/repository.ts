import type { GhostResponse, LeaderboardEntry } from '../shared/api.js';
import type { CharacterId, SpeedClass } from '../sim/types.js';

/** A server-verified time-trial run, as persisted. */
export interface VerifiedRun {
  id: string;
  /** Client-generated UUID v4. Stored for de-duplication only; never returned by the API. */
  playerId: string;
  name: string;
  charId: CharacterId;
  trackId: string;
  cc: SpeedClass;
  ticks: number;
  lapTicks: number[];
  /** Encoded input log (kept as the run's ghost). */
  log: string;
  /** logDigest(log): identity of the input sequence (idempotent retries, log ownership claims). */
  logHash: string;
  /** Client build that produced the run. */
  version: string;
  createdAt: string;
}

export interface SubmitOutcome {
  /** True when this run became (or already is, for an identical retry) the player's best. */
  personalBest: boolean;
  /** Id of the player's current best run on this board (the new run when personalBest). */
  id: string;
  /** Board rank of the player's current best, or null when outside the top list. */
  rank: number | null;
}

/**
 * The submitted log is already registered by another player — typically a
 * downloaded ghost re-submitted under a different name. Logs are claimed
 * forever by the first player who registered them.
 */
export class DuplicateRunError extends Error {
  constructor() {
    super('This input log was already registered by another player.');
    this.name = 'DuplicateRunError';
  }
}

export interface Repository {
  readonly kind: 'memory' | 'dynamodb';
  /**
   * Stores the run if it beats the player's previous best on its track+cc board.
   * Throws DuplicateRunError when another player already registered this log.
   */
  submit(run: VerifiedRun, topSize: number): Promise<SubmitOutcome>;
  /** Top `limit` rows (one per player), fastest first; ties keep the earlier run first. */
  leaderboard(trackId: string, cc: SpeedClass, limit: number): Promise<LeaderboardEntry[]>;
  ghost(id: string): Promise<GhostResponse | undefined>;
  close(): Promise<void>;
}

/** Ranking rows sort by zero-padded ticks, then by the time-ordered run id. */
export const TICKS_WIDTH = 9;
export const boardKey = (trackId: string, cc: SpeedClass) => `LB#${trackId}#${cc}`;
export const rankKey = (ticks: number, id: string) => `${String(ticks).padStart(TICKS_WIDTH, '0')}#${id}`;
export const bestKey = (trackId: string, cc: SpeedClass, playerId: string) => `PB#${trackId}#${cc}#${playerId}`;
export const ghostKey = (id: string) => `GHOST#${id}`;
export const logClaimKey = (logHash: string) => `LOG#${logHash}`;
export const BEST_SORT_KEY = 'PB';
export const GHOST_SORT_KEY = 'GHOST';
export const LOG_CLAIM_SORT_KEY = 'LOG';

export function toEntry(run: Pick<VerifiedRun, 'id' | 'name' | 'charId' | 'trackId' | 'cc' | 'ticks' | 'lapTicks' | 'createdAt'>, rank: number): LeaderboardEntry {
  return {
    rank, id: run.id, name: run.name, charId: run.charId, trackId: run.trackId, cc: run.cc,
    ticks: run.ticks, lapTicks: [...run.lapTicks], createdAt: run.createdAt,
  };
}

export function toGhost(run: Pick<VerifiedRun, 'id' | 'trackId' | 'cc' | 'charId' | 'name' | 'ticks' | 'log'>): GhostResponse {
  return { id: run.id, trackId: run.trackId, cc: run.cc, charId: run.charId, name: run.name, ticks: run.ticks, log: run.log };
}
