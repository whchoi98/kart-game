/**
 * Offline time-trial runs waiting for submission (storage.ts) and the rumble setting.
 */
import { describe, expect, it } from 'vitest';
import type { SubmitRunRequest } from '../../src/shared/api.js';
import { DEFAULT_SETTINGS } from '../../src/client/contracts.js';
import { GameStorage, sanitizeSettings, versionCore, type KeyValueStore } from '../../src/client/storage.js';

class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  failWrites = false;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failWrites) throw new Error('QuotaExceededError'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const PLAYER = '3f0f5b8e-2c1d-4a8b-9e7f-0123456789ab';
const req = (o: Partial<SubmitRunRequest> = {}): SubmitRunRequest => ({
  trackId: 'sunny-meadow', cc: 150, charId: 'kiki', name: '달려라', playerId: PLAYER,
  ticks: 5400, lapTicks: [1800, 1800, 1800], log: 'AAAABBBB', version: '1.0.0', ...o,
});

describe('settings: rumble (진동)', () => {
  it('defaults to on and survives a save / load round trip when off', () => {
    expect(sanitizeSettings(undefined).rumble).toBe(true);
    const store = new MapStore();
    const s = new GameStorage(store);
    s.saveSettings({ ...DEFAULT_SETTINGS, rumble: false });
    expect(new GameStorage(store).loadSettings().rumble).toBe(false);
  });
  it('ignores non-boolean values', () => {
    expect(sanitizeSettings({ rumble: 'no' }).rumble).toBe(true);
    expect(sanitizeSettings({ rumble: 0 }).rumble).toBe(true);
  });
});

describe('pending (offline) time-trial runs', () => {
  it('keeps the request together with the client version and build it was recorded with', () => {
    const s = new GameStorage(new MapStore());
    const now = new Date('2026-09-24T10:00:00Z');
    expect(s.queuePendingRun(req(), '4bc74e2772d73763', now)).toEqual({ stored: true, replaced: null });
    const [run] = s.pendingRuns();
    expect(run).toMatchObject({ id: 'sunny-meadow.150', appVersion: '1.0.0', build: '4bc74e2772d73763', recordedAt: now.toISOString() });
    expect(run!.request).toEqual(req());
  });

  it('holds one run per course and class: faster replaces, slower is refused', () => {
    const s = new GameStorage(new MapStore());
    s.queuePendingRun(req({ ticks: 5400, log: 'A1' }), null);
    const slower = s.queuePendingRun(req({ ticks: 5500, log: 'A2' }), null);
    expect(slower).toMatchObject({ stored: false, reason: 'slower' });
    const faster = s.queuePendingRun(req({ ticks: 5300, log: 'A3' }), null);
    expect(faster.stored).toBe(true);
    s.queuePendingRun(req({ cc: 100, log: 'B1' }), null);
    expect(s.pendingRuns().map(r => [r.id, r.request.ticks])).toEqual([['sunny-meadow.150', 5300], ['sunny-meadow.100', 5400]]);
  });

  it('re-queuing the same run (same log) updates it, e.g. a corrected nickname', () => {
    const s = new GameStorage(new MapStore());
    s.queuePendingRun(req({ name: '' }), null);
    expect(s.queuePendingRun(req({ name: '새이름' }), null).stored).toBe(true);
    expect(s.pendingRuns()).toHaveLength(1);
    expect(s.pendingRuns()[0]!.request.name).toBe('새이름');
  });

  it('drops runs recorded by another app version (the server would answer VERSION_MISMATCH)', () => {
    const s = new GameStorage(new MapStore());
    s.queuePendingRun(req({ version: '0.9.0' }), null);
    s.queuePendingRun(req({ trackId: 'neon-city', version: '1.0.0' }), null);
    const dropped = s.dropStalePendingRuns('1.0.0');
    expect(dropped.map(r => r.appVersion)).toEqual(['0.9.0']);
    expect(s.pendingRuns().map(r => r.request.trackId)).toEqual(['neon-city']);
    // the server compares semver cores: pre-release / build suffixes do not matter
    expect(s.dropStalePendingRuns('1.0.0-rc.2+abc')).toEqual([]);
    expect(versionCore('1.2.3-beta.1')).toBe('1.2.3');
  });

  it('remove / clear, and corrupt or hostile entries are skipped', () => {
    const store = new MapStore();
    const s = new GameStorage(store);
    s.queuePendingRun(req(), null);
    s.queuePendingRun(req({ trackId: 'neon-city' }), null);
    s.removePendingRun('sunny-meadow.150');
    expect(s.pendingRuns().map(r => r.id)).toEqual(['neon-city.150']);
    s.clearPendingRuns();
    expect(s.pendingRuns()).toEqual([]);
    store.setItem('tpgp.v1.pending', JSON.stringify([
      { request: { ...req(), ticks: -1 } },
      { request: { ...req(), charId: 'mario' } },
      { request: { ...req(), log: '' } },
      { request: { ...req(), playerId: 'not-a-uuid' } },
      'garbage',
      { request: req({ trackId: 'ok-track' }), build: '<script>' },
    ]));
    const runs = s.pendingRuns();
    expect(runs.map(r => r.id)).toEqual(['ok-track.150']);
    expect(runs[0]!.build).toBeNull();
    store.setItem('tpgp.v1.pending', '{not json');
    expect(s.pendingRuns()).toEqual([]);
  });

  it('reports a full storage instead of pretending the run was kept', () => {
    const store = new MapStore();
    const s = new GameStorage(store);
    store.failWrites = true;
    expect(s.queuePendingRun(req(), null)).toMatchObject({ stored: false, reason: 'quota' });
    expect(s.queuePendingRun(req({ ticks: 0 }), null)).toMatchObject({ stored: false, reason: 'invalid' });
  });

  it('renames every waiting run', () => {
    const s = new GameStorage(new MapStore());
    s.queuePendingRun(req({ name: '' }), null);
    s.queuePendingRun(req({ cc: 200, name: 'old' }), null);
    s.renamePendingRuns('터보');
    expect(s.pendingRuns().map(r => r.request.name)).toEqual(['터보', '터보']);
  });
});
