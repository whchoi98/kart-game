import { createHash, randomBytes } from 'node:crypto';
import { API_LIMITS } from '../shared/api.js';
import { CHARACTER_IDS } from '../sim/characters.js';
import { decodeInputWord, decodeLog, encodeInputWord } from '../sim/input-log.js';
import { TRACK_CATALOG } from '../sim/tracks/catalog.js';
import type { SpeedClass } from '../sim/types.js';

/** Upper bound for any request body (the input log dominates: ≤ 200 000 base64 chars). */
export const BODY_LIMIT = 256 * 1024;
export const SPEED_CLASSES: readonly SpeedClass[] = [50, 100, 150, 200];
export const TRACK_IDS: readonly string[] = TRACK_CATALOG.map(t => t.id);
/** 30 minutes at 60 Hz — far beyond any honest time-trial run. */
export const MAX_RUN_TICKS = 60 * 60 * 30;
export const MAX_LAPS = 9;

const UUID_V4 = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
/** Time-ordered run id: 9 base36 chars of epoch ms + 16 hex random chars. */
export const RUN_ID_PATTERN = '^[0-9a-z]{9}[0-9a-f]{16}$';
const RUN_ID_REGEX = new RegExp(RUN_ID_PATTERN);

export interface SubmitRunBody {
  trackId: string;
  cc: SpeedClass;
  charId: (typeof CHARACTER_IDS)[number];
  name: string;
  playerId: string;
  ticks: number;
  lapTicks: number[];
  log: string;
  version: string;
}

export const submitRunSchema = {
  type: 'object',
  required: ['trackId', 'cc', 'charId', 'name', 'playerId', 'ticks', 'lapTicks', 'log', 'version'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', enum: TRACK_IDS },
    cc: { type: 'integer', enum: SPEED_CLASSES },
    charId: { type: 'string', enum: CHARACTER_IDS },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    playerId: { type: 'string', pattern: UUID_V4 },
    ticks: { type: 'integer', minimum: 1, maximum: MAX_RUN_TICKS },
    lapTicks: {
      type: 'array', minItems: 1, maxItems: MAX_LAPS,
      items: { type: 'integer', minimum: 1, maximum: MAX_RUN_TICKS },
    },
    log: { type: 'string', minLength: 1, maxLength: API_LIMITS.logMax, pattern: '^[A-Za-z0-9+/_=-]+$' },
    version: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' },
  },
} as const;

export interface LeaderboardQuery { track: string; cc: '50' | '100' | '150' | '200' }

export const leaderboardQuerySchema = {
  type: 'object',
  required: ['track', 'cc'],
  additionalProperties: false,
  properties: {
    track: { type: 'string', enum: TRACK_IDS },
    cc: { type: 'string', enum: SPEED_CLASSES.map(String) },
  },
} as const;

export const ghostParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: RUN_ID_PATTERN } },
} as const;

export const noQuerySchema = { type: 'object', properties: {}, additionalProperties: false } as const;

const entrySchema = {
  type: 'object',
  required: ['rank', 'id', 'name', 'charId', 'trackId', 'cc', 'ticks', 'lapTicks', 'createdAt'],
  additionalProperties: false,
  properties: {
    rank: { type: 'integer' },
    id: { type: 'string' },
    name: { type: 'string' },
    charId: { type: 'string' },
    trackId: { type: 'string' },
    cc: { type: 'integer' },
    ticks: { type: 'integer' },
    lapTicks: { type: 'array', items: { type: 'integer' } },
    createdAt: { type: 'string' },
  },
} as const;

/** Response schemas double as an allow-list: fields such as playerId can never leak. */
export const leaderboardResponseSchema = {
  type: 'object',
  required: ['trackId', 'cc', 'entries'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string' },
    cc: { type: 'integer' },
    entries: { type: 'array', items: entrySchema },
  },
} as const;

export const ghostResponseSchema = {
  type: 'object',
  required: ['id', 'trackId', 'cc', 'charId', 'name', 'ticks', 'log'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    trackId: { type: 'string' },
    cc: { type: 'integer' },
    charId: { type: 'string' },
    name: { type: 'string' },
    ticks: { type: 'integer' },
    log: { type: 'string' },
  },
} as const;

export const submitResponseSchema = {
  type: 'object',
  required: ['accepted', 'id', 'rank', 'personalBest'],
  additionalProperties: false,
  properties: {
    accepted: { type: 'boolean' },
    id: { type: 'string' },
    rank: { type: ['integer', 'null'] },
    personalBest: { type: 'boolean' },
    reason: { type: 'string' },
  },
} as const;

/**
 * Hangul syllables + modern compatibility jamo (ㄱ…ㅣ, U+3131–U+3163), ASCII
 * letters/digits, space, '_' and '-'. U+3164 HANGUL FILLER and the archaic
 * jamo after it are excluded: the filler renders as blank space and would
 * allow invisible leaderboard names.
 */
const NAME_ALLOWED = /^[0-9A-Za-z가-힣ㄱ-ㅣ _-]+$/u;
const NAME_HAS_WORD = /[0-9A-Za-z가-힣ㄱ-ㅣ]/u;

/**
 * NFC-normalises, collapses runs of whitespace and trims. Returns undefined
 * when the result is not 1–12 characters of the allowed alphabet.
 */
export function normalizeName(raw: string): string | undefined {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(name).length;
  if (length < API_LIMITS.nameMin || length > API_LIMITS.nameMax) return undefined;
  if (!NAME_ALLOWED.test(name) || !NAME_HAS_WORD.test(name)) return undefined;
  return name;
}

export function newRunId(now: number = Date.now()): string {
  return now.toString(36).padStart(9, '0').slice(-9) + randomBytes(8).toString('hex');
}

export function isRunId(value: string): boolean {
  return RUN_ID_REGEX.test(value);
}

/**
 * Identity of the input sequence a log encodes, not of its spelling. The same
 * run re-encoded (runs split or merged, different base64 padding bits, the
 * out-of-range steer value that decodes like full lock) digests identically,
 * so a downloaded ghost cannot be re-registered by another player simply by
 * re-encoding it. Logs that do not decode never pass verification; they fall
 * back to a digest of the raw text.
 */
export function logDigest(log: string): string {
  let words: Uint16Array;
  try {
    words = decodeLog(log);
  } catch {
    return createHash('sha256').update('raw\0').update(log).digest('base64url');
  }
  const canonical = Buffer.allocUnsafe(words.length * 2);
  for (let i = 0; i < words.length; i++) canonical.writeUInt16LE(encodeInputWord(decodeInputWord(words[i]!)), i * 2);
  return createHash('sha256').update('ticks\0').update(canonical).digest('base64url');
}

export function isSpeedClass(value: unknown): value is SpeedClass {
  return typeof value === 'number' && (SPEED_CLASSES as readonly number[]).includes(value);
}
