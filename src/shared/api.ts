/** HTTP API contract shared by the browser client and the Fastify server. */
import type { CharacterId, SpeedClass } from '../sim/types.js';

export const API_LIMITS = {
  nameMin: 1,
  nameMax: 12,
  /** Base64 input log upper bound (bytes). */
  logMax: 200_000,
  leaderboardSize: 50,
} as const;

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  charId: CharacterId;
  trackId: string;
  cc: SpeedClass;
  /** Total race time in 60 Hz ticks (server-verified). */
  ticks: number;
  lapTicks: number[];
  createdAt: string;   // ISO-8601
}

export interface LeaderboardResponse {
  trackId: string;
  cc: SpeedClass;
  entries: LeaderboardEntry[];
}

export interface SubmitRunRequest {
  trackId: string;
  cc: SpeedClass;
  charId: CharacterId;
  name: string;
  /** Random client id (UUID v4) kept in localStorage; one leaderboard row per player. */
  playerId: string;
  /** Claimed result — must equal the server re-simulation exactly. */
  ticks: number;
  lapTicks: number[];
  /** Encoded input log (see src/sim/input-log.ts). */
  log: string;
  version: string;
}

export interface SubmitRunResponse {
  accepted: boolean;
  id: string;
  /** Rank on the board after insertion (null if outside top list). */
  rank: number | null;
  personalBest: boolean;
  /** Present when rejected. */
  reason?: string;
}

export interface GhostResponse {
  id: string;
  trackId: string;
  cc: SpeedClass;
  charId: CharacterId;
  name: string;
  ticks: number;
  log: string;
}

export interface ApiError { error: string; message: string }

/** Machine codes the server uses when it refuses a run (422 / 409). */
export type RunRejectionCode =
  | 'REPLAY_INVALID'     // the log does not re-simulate to a finished run
  | 'VERSION_MISMATCH'   // client build's simulation differs from the server's
  | 'TIME_MISMATCH'      // re-simulated finish ticks differ from the claim
  | 'LAP_MISMATCH'       // re-simulated lap splits differ from the claim
  | 'DUPLICATE_RUN';     // someone else already owns this exact input log
