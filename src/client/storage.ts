/**
 * Versioned local persistence (localStorage with an in-memory fallback).
 * Every access is wrapped in try/catch: private mode, disabled storage, quota errors
 * and corrupted JSON all degrade gracefully to defaults.
 *
 * Keys (prefix `tpgp.v1.`):
 *   meta            { v: 1 }
 *   settings        Partial<Settings>
 *   playerId        UUID v4 string
 *   best.<track>.<cc>  PersonalBest (includes the input log for the local ghost)
 *   trophies        Record<`${cup}.${cc}`, TrophyTier>
 *   stats           PlayerStats
 *   pending         PendingRun[] — time trials recorded offline, waiting to be submitted
 */
import { isCharacterId } from '../sim/characters.js';
import type { CupId, SpeedClass } from '../sim/types.js';
import { API_LIMITS, type SubmitRunRequest } from '../shared/api.js';
import { DEFAULT_SETTINGS, type QualityLevel, type Settings, type TimeTrialRecord } from './contracts.js';
import { normalizePlayerName, validatePlayerName } from './ui/format.js';
import { isBetterTrophy, type TrophyTier } from './ui/gp.js';

export const STORAGE_VERSION = 1;
const PREFIX = `tpgp.v${STORAGE_VERSION}.`;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersonalBest extends TimeTrialRecord {
  /** ISO-8601 time the record was set. */
  date: string;
}

export interface Unlocks {
  /** 200cc: any gold trophy at 150cc. */
  cc200: boolean;
  /** Mirror mode: gold in both cups at 150cc. */
  mirror: boolean;
}
export type UnlockId = keyof Unlocks;

export interface PlayerStats {
  races: number;
  wins: number;
  podiums: number;
  grandPrix: number;
  timeTrials: number;
}

/**
 * A time-trial run the player could not submit (offline / network failure). The server only
 * verifies runs of its own simulation version, so the app version (and client build, for
 * diagnostics) the run was recorded with travels along; one run is kept per course and class
 * (the fastest — the leaderboard keeps one row per player anyway).
 */
export interface PendingRun {
  /** `${trackId}.${cc}` */
  id: string;
  request: SubmitRunRequest;
  /** Client version the run was recorded with (= request.version). */
  appVersion: string;
  /** Client build id (index.html `turbo-pals-build`), null in dev. */
  build: string | null;
  /** ISO-8601 time the run was recorded. */
  recordedAt: string;
}

export type QueueResult =
  | { stored: true; replaced: PendingRun | null }
  | { stored: false; reason: 'slower' | 'quota' | 'invalid'; existing: PendingRun | null };

/** Semver core ('1.2.3' of '1.2.3-rc.1+build'): what the server compares. */
export function versionCore(v: string): string {
  return v.trim().split(/[-+]/)[0] ?? '';
}

export function pendingRunId(trackId: string, cc: SpeedClass): string {
  return `${trackId}.${cc}`;
}

function isSubmitRequest(v: unknown): v is SubmitRunRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.trackId === 'string' && r.trackId.length > 0 && r.trackId.length <= 64
    && isSpeedClass(r.cc) && isCharacterId(r.charId)
    && typeof r.name === 'string' && r.name.length <= API_LIMITS.nameMax * 4
    && typeof r.playerId === 'string' && UUID_RE.test(r.playerId)
    && typeof r.ticks === 'number' && Number.isInteger(r.ticks) && r.ticks > 0
    && isTicksArray(r.lapTicks) && r.lapTicks.length > 0
    && typeof r.log === 'string' && r.log.length > 0 && r.log.length <= API_LIMITS.logMax
    && typeof r.version === 'string' && r.version.length > 0 && r.version.length <= 64;
}

function sanitizePending(raw: unknown): PendingRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isSubmitRequest(r.request)) return null;
  const q = r.request;
  const request: SubmitRunRequest = {
    trackId: q.trackId, cc: q.cc, charId: q.charId, name: q.name, playerId: q.playerId,
    ticks: q.ticks, lapTicks: [...q.lapTicks], log: q.log, version: q.version,
  };
  return {
    id: pendingRunId(request.trackId, request.cc),
    request,
    appVersion: typeof r.appVersion === 'string' && r.appVersion ? r.appVersion : request.version,
    build: typeof r.build === 'string' && /^[a-f0-9]{8,64}$/.test(r.build) ? r.build : null,
    recordedAt: typeof r.recordedAt === 'string' ? r.recordedAt : new Date(0).toISOString(),
  };
}

const EMPTY_STATS: PlayerStats = { races: 0, wins: 0, podiums: 0, grandPrix: 0, timeTrials: 0 };
const SPEED_CLASSES: readonly SpeedClass[] = [50, 100, 150, 200];
const CUP_IDS: readonly CupId[] = ['sprout', 'thunder'];
const QUALITY: readonly QualityLevel[] = ['auto', 'low', 'medium', 'high'];
const CAMERA: readonly Settings['cameraDistance'][] = ['near', 'normal', 'far'];

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

/** The page's localStorage if it is usable, else null. */
export function detectLocalStorage(): KeyValueStore | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = `${PREFIX}probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function isSpeedClass(v: unknown): v is SpeedClass {
  return typeof v === 'number' && (SPEED_CLASSES as readonly number[]).includes(v);
}

function isTier(v: unknown): v is TrophyTier {
  return v === 'gold' || v === 'silver' || v === 'bronze';
}

function unit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Merge persisted (possibly partial / stale / hostile) settings over the defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  s.master = unit(r.master, s.master);
  s.music = unit(r.music, s.music);
  s.sfx = unit(r.sfx, s.sfx);
  if (QUALITY.includes(r.quality as QualityLevel)) s.quality = r.quality as QualityLevel;
  if (typeof r.shake === 'boolean') s.shake = r.shake;
  if (CAMERA.includes(r.cameraDistance as Settings['cameraDistance'])) s.cameraDistance = r.cameraDistance as Settings['cameraDistance'];
  if (typeof r.showFps === 'boolean') s.showFps = r.showFps;
  if (typeof r.autoAccelerate === 'boolean') s.autoAccelerate = r.autoAccelerate;
  if (typeof r.showSpeed === 'boolean') s.showSpeed = r.showSpeed;
  if (typeof r.rumble === 'boolean') s.rumble = r.rumble;
  if (typeof r.playerName === 'string') {
    const n = normalizePlayerName(r.playerName);
    s.playerName = n === '' || validatePlayerName(n).ok ? n : '';
  }
  return s;
}

function isTicksArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isInteger(x) && x > 0);
}

function sanitizeBest(raw: unknown, trackId: string, cc: SpeedClass): PersonalBest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ticks !== 'number' || !Number.isInteger(r.ticks) || r.ticks <= 0) return null;
  if (!isCharacterId(r.charId)) return null;
  if (!isTicksArray(r.lapTicks)) return null;
  return {
    trackId, cc,
    charId: r.charId,
    ticks: r.ticks,
    lapTicks: [...r.lapTicks],
    log: typeof r.log === 'string' ? r.log : '',
    date: typeof r.date === 'string' ? r.date : new Date(0).toISOString(),
  };
}

function uuidV4(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      return formatUuid(b);
    }
  } catch { /* fall through */ }
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return formatUuid(b);
}

function formatUuid(b: Uint8Array): string {
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function unlocksFromTrophies(trophies: Readonly<Record<string, TrophyTier>>): Unlocks {
  const gold150 = (cup: CupId) => trophies[`${cup}.150`] === 'gold';
  return {
    cc200: CUP_IDS.some(gold150),
    mirror: CUP_IDS.every(gold150),
  };
}

export class GameStorage {
  private readonly store: KeyValueStore;
  /** False when data only lives in memory for this session. */
  readonly persistent: boolean;
  private cachedPlayerId: string | null = null;

  constructor(backend?: KeyValueStore | null) {
    const b = backend === undefined ? detectLocalStorage() : backend;
    this.store = b ?? new MemoryStore();
    this.persistent = !!b;
    this.migrate();
  }

  // ── low level ──

  private read(key: string): unknown {
    try {
      const raw = this.store.getItem(PREFIX + key);
      if (raw === null) return null;
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): boolean {
    try {
      this.store.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  private migrate(): void {
    const meta = this.read('meta') as { v?: unknown } | null;
    if (!meta || meta.v !== STORAGE_VERSION) this.write('meta', { v: STORAGE_VERSION });
  }

  // ── settings ──

  loadSettings(): Settings {
    return sanitizeSettings(this.read('settings'));
  }

  saveSettings(s: Settings): void {
    this.write('settings', sanitizeSettings(s));
  }

  // ── identity ──

  playerId(): string {
    if (this.cachedPlayerId) return this.cachedPlayerId;
    const stored = this.read('playerId');
    if (typeof stored === 'string' && UUID_RE.test(stored)) {
      this.cachedPlayerId = stored.toLowerCase();
      return this.cachedPlayerId;
    }
    const id = uuidV4();
    this.write('playerId', id);
    this.cachedPlayerId = id;
    return id;
  }

  // ── time-trial personal bests ──

  getBest(trackId: string, cc: SpeedClass): PersonalBest | null {
    return sanitizeBest(this.read(`best.${trackId}.${cc}`), trackId, cc);
  }

  /**
   * Store `rec` if it beats the saved best (or none exists).
   * Returns whether it was a new record and the previous best.
   */
  saveBestIfFaster(rec: TimeTrialRecord, now: Date = new Date()): { newRecord: boolean; previous: PersonalBest | null } {
    const previous = this.getBest(rec.trackId, rec.cc);
    if (previous && previous.ticks <= rec.ticks) return { newRecord: false, previous };
    const entry: PersonalBest = { ...rec, lapTicks: [...rec.lapTicks], date: now.toISOString() };
    const key = `best.${rec.trackId}.${rec.cc}`;
    if (!this.write(key, entry)) {
      // Quota: keep the time even if the ghost log does not fit.
      this.write(key, { ...entry, log: '' });
    }
    return { newRecord: true, previous };
  }

  // ── Grand Prix trophies & unlocks ──

  getTrophies(): Record<string, TrophyTier> {
    const raw = this.read('trophies');
    const out: Record<string, TrophyTier> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const [cup, cc] = k.split('.');
        if (CUP_IDS.includes(cup as CupId) && isSpeedClass(Number(cc)) && isTier(v)) out[k] = v;
      }
    }
    return out;
  }

  getTrophy(cup: CupId, cc: SpeedClass): TrophyTier | null {
    return this.getTrophies()[`${cup}.${cc}`] ?? null;
  }

  /** Record a GP result; keeps the best tier. Reports any unlocks this caused. */
  recordTrophy(cup: CupId, cc: SpeedClass, tier: TrophyTier | null): { improved: boolean; newUnlocks: UnlockId[] } {
    const trophies = this.getTrophies();
    const key = `${cup}.${cc}`;
    const before = unlocksFromTrophies(trophies);
    if (!isBetterTrophy(tier, trophies[key] ?? null) || !tier) return { improved: false, newUnlocks: [] };
    trophies[key] = tier;
    this.write('trophies', trophies);
    const after = unlocksFromTrophies(trophies);
    const newUnlocks = (Object.keys(after) as UnlockId[]).filter(k => after[k] && !before[k]);
    return { improved: true, newUnlocks };
  }

  getUnlocks(): Unlocks {
    return unlocksFromTrophies(this.getTrophies());
  }

  // ── stats ──

  getStats(): PlayerStats {
    const raw = this.read('stats');
    if (!raw || typeof raw !== 'object') return { ...EMPTY_STATS };
    const r = raw as Record<string, unknown>;
    return {
      races: count(r.races),
      wins: count(r.wins),
      podiums: count(r.podiums),
      grandPrix: count(r.grandPrix),
      timeTrials: count(r.timeTrials),
    };
  }

  /**
   * Count one finished race for the profile (player 1). `racers` = karts in the race (default: a
   * full grid): a win needs someone to beat, a podium needs more than three racers — otherwise a
   * solo run or a 2-player duel with no CPUs would count every race as a win / podium.
   */
  recordRace(result: { position: number | null; mode: 'gp' | 'vs' | 'tt' | 'duo'; racers?: number }): PlayerStats {
    const s = this.getStats();
    s.races += 1;
    if (result.mode === 'tt') s.timeTrials += 1;
    const racers = result.racers ?? 8;
    if (result.position !== null && result.mode !== 'tt') {
      if (result.position === 1 && racers > 1) s.wins += 1;
      if (result.position <= 3 && racers > 3) s.podiums += 1;
    }
    this.write('stats', s);
    return s;
  }

  recordGrandPrixCompleted(): void {
    const s = this.getStats();
    s.grandPrix += 1;
    this.write('stats', s);
  }

  // ── time trials waiting to be submitted (recorded offline) ──

  /** Valid pending runs, oldest first (corrupt entries are skipped). */
  pendingRuns(): PendingRun[] {
    const raw = this.read('pending');
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: PendingRun[] = [];
    for (const item of raw) {
      const run = sanitizePending(item);
      if (!run || seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
    }
    return out;
  }

  private writePending(runs: PendingRun[]): boolean {
    if (runs.length === 0) {
      try { this.store.removeItem(PREFIX + 'pending'); return true; } catch { return false; }
    }
    return this.write('pending', runs);
  }

  /**
   * Keep `request` for a later submission. One run per course and class: a faster run replaces
   * the waiting one, a slower one is not stored.
   */
  queuePendingRun(request: SubmitRunRequest, build: string | null, now: Date = new Date()): QueueResult {
    const candidate = sanitizePending({ request, appVersion: request.version, build, recordedAt: now.toISOString() });
    if (!candidate) return { stored: false, reason: 'invalid', existing: null };
    const runs = this.pendingRuns();
    const i = runs.findIndex(r => r.id === candidate.id);
    const existing = i >= 0 ? runs[i]! : null;
    const sameRun = !!existing && existing.request.log === candidate.request.log;
    if (existing && !sameRun && existing.request.ticks <= candidate.request.ticks
      && versionCore(existing.appVersion) === versionCore(candidate.appVersion)) {
      return { stored: false, reason: 'slower', existing };
    }
    if (i >= 0) runs.splice(i, 1);
    runs.push(candidate);
    if (!this.writePending(runs)) return { stored: false, reason: 'quota', existing };
    return { stored: true, replaced: existing };
  }

  /** Update the nickname of every waiting run (the player fixed it before submitting). */
  renamePendingRuns(name: string): void {
    const runs = this.pendingRuns();
    if (runs.length === 0) return;
    for (const r of runs) r.request.name = name;
    this.writePending(runs);
  }

  removePendingRun(id: string): void {
    const runs = this.pendingRuns();
    const next = runs.filter(r => r.id !== id);
    if (next.length !== runs.length) this.writePending(next);
  }

  clearPendingRuns(): void {
    this.writePending([]);
  }

  /**
   * Remove waiting runs recorded with a different app version: the server would refuse them
   * (VERSION_MISMATCH). Returns the removed runs so the UI can explain why they are gone.
   */
  dropStalePendingRuns(currentVersion: string): PendingRun[] {
    const runs = this.pendingRuns();
    const core = versionCore(currentVersion);
    const stale = runs.filter(r => versionCore(r.appVersion) !== core || versionCore(r.request.version) !== core);
    if (stale.length) this.writePending(runs.filter(r => !stale.includes(r)));
    // an unreadable (corrupt) list is dropped as well
    else if (runs.length === 0 && this.read('pending') !== null) this.writePending([]);
    return stale;
  }
}

export function createStorage(backend?: KeyValueStore | null): GameStorage {
  return new GameStorage(backend);
}
