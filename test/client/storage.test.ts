import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/client/contracts.js';
import {
  GameStorage, STORAGE_VERSION, createStorage, sanitizeSettings, unlocksFromTrophies, type KeyValueStore,
} from '../../src/client/storage.js';

class FakeStorage implements KeyValueStore {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.writes++; this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
}

class ThrowingStorage implements KeyValueStore {
  getItem(): string | null { throw new Error('SecurityError'); }
  setItem(): void { throw new Error('QuotaExceededError'); }
  removeItem(): void { throw new Error('SecurityError'); }
}

/** Accepts small values but rejects anything large (simulates a nearly full quota). */
class TinyQuotaStorage extends FakeStorage {
  override setItem(k: string, v: string): void {
    if (v.length > 400) throw new Error('QuotaExceededError');
    super.setItem(k, v);
  }
}

const rec = (ticks: number, log = 'AAAA') => ({
  trackId: 'sunny-meadow', cc: 150 as const, charId: 'pip' as const,
  ticks, lapTicks: [ticks / 3, ticks / 3, ticks / 3].map(Math.round), log,
});

describe('settings', () => {
  it('returns defaults when nothing is stored and writes the version meta', () => {
    const fake = new FakeStorage();
    const s = new GameStorage(fake);
    expect(s.loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(fake.getItem(`tpgp.v${STORAGE_VERSION}.meta`)!)).toEqual({ v: STORAGE_VERSION });
    expect(s.persistent).toBe(true);
  });

  it('round-trips and merges partial data over defaults', () => {
    const fake = new FakeStorage();
    fake.setItem('tpgp.v1.settings', JSON.stringify({ music: 0.25, quality: 'high', playerName: '  터보   왕 ' }));
    const s = new GameStorage(fake);
    const loaded = s.loadSettings();
    expect(loaded.music).toBe(0.25);
    expect(loaded.quality).toBe('high');
    expect(loaded.playerName).toBe('터보 왕');
    expect(loaded.sfx).toBe(DEFAULT_SETTINGS.sfx);
    s.saveSettings({ ...loaded, shake: false });
    expect(new GameStorage(fake).loadSettings().shake).toBe(false);
  });

  it('rejects invalid values field by field', () => {
    const s = sanitizeSettings({
      master: 7, music: -1, sfx: 'loud', quality: 'ultra', shake: 'yes', cameraDistance: 'orbit',
      showFps: 1, autoAccelerate: true, showSpeed: false, playerName: '<script>',
    });
    expect(s.master).toBe(1);
    expect(s.music).toBe(0);
    expect(s.sfx).toBe(DEFAULT_SETTINGS.sfx);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.shake).toBe(DEFAULT_SETTINGS.shake);
    expect(s.cameraDistance).toBe(DEFAULT_SETTINGS.cameraDistance);
    expect(s.showFps).toBe(DEFAULT_SETTINGS.showFps);
    expect(s.autoAccelerate).toBe(true);
    expect(s.showSpeed).toBe(false);
    expect(s.playerName).toBe('');
  });

  it('survives corrupted JSON', () => {
    const fake = new FakeStorage();
    fake.setItem('tpgp.v1.settings', '{not json');
    fake.setItem('tpgp.v1.stats', 'null');
    const s = new GameStorage(fake);
    expect(s.loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(s.getStats().races).toBe(0);
  });
});

describe('storage unavailable', () => {
  it('works in memory when the backend throws on every call', () => {
    const s = new GameStorage(new ThrowingStorage());
    expect(s.loadSettings()).toEqual(DEFAULT_SETTINGS);
    s.saveSettings({ ...DEFAULT_SETTINGS, music: 0.1 });
    expect(() => s.saveBestIfFaster(rec(3000))).not.toThrow();
    expect(() => s.recordTrophy('sprout', 150, 'gold')).not.toThrow();
    expect(s.playerId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to an in-memory store when given null', () => {
    const s = createStorage(null);
    expect(s.persistent).toBe(false);
    s.saveSettings({ ...DEFAULT_SETTINGS, music: 0.1 });
    expect(s.loadSettings().music).toBe(0.1);
    expect(s.saveBestIfFaster(rec(3000)).newRecord).toBe(true);
    expect(s.getBest('sunny-meadow', 150)?.ticks).toBe(3000);
  });
});

describe('player id', () => {
  it('is a stable UUID v4', () => {
    const fake = new FakeStorage();
    const id = new GameStorage(fake).playerId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new GameStorage(fake).playerId()).toBe(id);
  });

  it('replaces a malformed stored id', () => {
    const fake = new FakeStorage();
    fake.setItem('tpgp.v1.playerId', JSON.stringify('hacker'));
    const id = new GameStorage(fake).playerId();
    expect(id).not.toBe('hacker');
    expect(id).toHaveLength(36);
  });
});

describe('time trial personal bests', () => {
  it('saves only faster runs, keyed by track and cc, with the ghost log', () => {
    const s = new GameStorage(new FakeStorage());
    const first = s.saveBestIfFaster(rec(3600, 'first-log'), new Date('2026-01-02T03:04:05Z'));
    expect(first).toEqual({ newRecord: true, previous: null });
    expect(s.saveBestIfFaster(rec(3700)).newRecord).toBe(false);
    expect(s.saveBestIfFaster(rec(3600)).newRecord).toBe(false);
    const better = s.saveBestIfFaster(rec(3500, 'second-log'));
    expect(better.newRecord).toBe(true);
    expect(better.previous?.ticks).toBe(3600);
    const best = s.getBest('sunny-meadow', 150)!;
    expect(best.ticks).toBe(3500);
    expect(best.log).toBe('second-log');
    expect(best.charId).toBe('pip');
    expect(s.getBest('sunny-meadow', 100)).toBeNull();
    expect(s.getBest('palm-beach', 150)).toBeNull();
  });

  it('keeps the time when the log does not fit in the quota', () => {
    const s = new GameStorage(new TinyQuotaStorage());
    expect(s.saveBestIfFaster(rec(3000, 'x'.repeat(2000))).newRecord).toBe(true);
    const best = s.getBest('sunny-meadow', 150)!;
    expect(best.ticks).toBe(3000);
    expect(best.log).toBe('');
  });

  it('ignores tampered records', () => {
    const fake = new FakeStorage();
    fake.setItem('tpgp.v1.best.sunny-meadow.150', JSON.stringify({ ticks: -5, charId: 'pip', lapTicks: [] }));
    expect(new GameStorage(fake).getBest('sunny-meadow', 150)).toBeNull();
    fake.setItem('tpgp.v1.best.sunny-meadow.150', JSON.stringify({ ticks: 100, charId: 'nobody', lapTicks: [100] }));
    expect(new GameStorage(fake).getBest('sunny-meadow', 150)).toBeNull();
  });
});

describe('trophies and unlocks', () => {
  it('keeps the best tier per cup and cc', () => {
    const s = new GameStorage(new FakeStorage());
    expect(s.recordTrophy('sprout', 100, 'bronze').improved).toBe(true);
    expect(s.recordTrophy('sprout', 100, 'silver').improved).toBe(true);
    expect(s.recordTrophy('sprout', 100, 'bronze').improved).toBe(false);
    expect(s.recordTrophy('sprout', 100, null).improved).toBe(false);
    expect(s.getTrophy('sprout', 100)).toBe('silver');
    expect(s.getTrophy('sprout', 150)).toBeNull();
  });

  it('unlocks 200cc after any 150cc gold and mirror after both cups', () => {
    const s = new GameStorage(new FakeStorage());
    expect(s.getUnlocks()).toEqual({ cc200: false, mirror: false });
    expect(s.recordTrophy('sprout', 100, 'gold').newUnlocks).toEqual([]);
    expect(s.recordTrophy('thunder', 150, 'silver').newUnlocks).toEqual([]);
    expect(s.recordTrophy('sprout', 150, 'gold').newUnlocks).toEqual(['cc200']);
    expect(s.getUnlocks()).toEqual({ cc200: true, mirror: false });
    expect(s.recordTrophy('thunder', 150, 'gold').newUnlocks).toEqual(['mirror']);
    expect(s.getUnlocks()).toEqual({ cc200: true, mirror: true });
    // Re-earning gold does not report the unlocks again.
    expect(s.recordTrophy('thunder', 150, 'gold').newUnlocks).toEqual([]);
  });

  it('derives unlocks purely from the trophy table', () => {
    expect(unlocksFromTrophies({ 'thunder.150': 'gold' })).toEqual({ cc200: true, mirror: false });
    expect(unlocksFromTrophies({ 'thunder.200': 'gold', 'sprout.200': 'gold' })).toEqual({ cc200: false, mirror: false });
  });

  it('drops malformed trophy entries', () => {
    const fake = new FakeStorage();
    fake.setItem('tpgp.v1.trophies', JSON.stringify({ 'sprout.150': 'platinum', 'moon.150': 'gold', 'thunder.150': 'gold' }));
    expect(new GameStorage(fake).getTrophies()).toEqual({ 'thunder.150': 'gold' });
  });
});

describe('stats', () => {
  it('counts races, wins and podiums', () => {
    const s = new GameStorage(new FakeStorage());
    s.recordRace({ position: 1, mode: 'vs' });
    s.recordRace({ position: 3, mode: 'gp' });
    s.recordRace({ position: 5, mode: 'gp' });
    s.recordRace({ position: 1, mode: 'tt' });
    s.recordGrandPrixCompleted();
    expect(s.getStats()).toEqual({ races: 4, wins: 1, podiums: 2, grandPrix: 1, timeTrials: 1 });
  });
});
