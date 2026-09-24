/**
 * What the menus show for each service-worker state (ui/pwa-state.ts), the connectivity
 * classification behind "keep this run for later" (api.ts), and setup-memory restore after an
 * update reload (ui/memory.ts restoreMemory).
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError, isConnectivityError } from '../../src/client/api.js';
import type { PwaStatus } from '../../src/client/pwa.js';
import { installMode, offlineView, pendingSummary, updateVisible } from '../../src/client/ui/pwa-state.js';

const base: PwaStatus = {
  supported: true, installed: false, installable: false, iosManualInstall: false, offlineReady: false,
  progress: 0, updating: false, updateReady: false, inRace: false, online: true, error: '',
};
const st = (o: Partial<PwaStatus>): PwaStatus => ({ ...base, ...o });

describe('offline readiness', () => {
  it('counts up while caching, then reads "오프라인 플레이 가능"', () => {
    expect(offlineView(st({ updating: true, progress: 42.4 }), true)).toMatchObject({ tone: 'busy', label: '오프라인 준비 중 42%', retry: false });
    expect(offlineView(st({ progress: 140 }), true)!.label).toBe('오프라인 준비 중 100%');
    expect(offlineView(st({ offlineReady: true, progress: 100 }), true)).toMatchObject({ tone: 'good', label: '오프라인 플레이 가능' });
    expect(offlineView(st({ offlineReady: true, online: false }), true)).toMatchObject({ tone: 'off', label: '오프라인 플레이 중' });
  });
  it('shows the error with a retry until the cache is complete', () => {
    const err = '오프라인 파일을 준비하지 못했어요. 다시 시도할 수 있어요.';
    expect(offlineView(st({ error: err }), true)).toMatchObject({ tone: 'bad', detail: err, retry: true });
    // an update-related error must not turn a working offline cache into "failed"
    expect(offlineView(st({ offlineReady: true, error: '다른 창에서 레이스가 진행 중이에요.' }), true)!.tone).toBe('good');
  });
  it('shows nothing on the dev server, or before the worker reports, and explains unsupported browsers', () => {
    expect(offlineView(st({}), false)).toBeNull();
    expect(offlineView(st({}), true)).toBeNull(); // launch: no "준비 중 0%" flash before CACHE_READY arrives
    expect(offlineView(st({ updating: true }), true)!.label).toBe('오프라인 준비 중 0%');
    expect(offlineView(st({ supported: false }), true)).toMatchObject({ tone: 'off', retry: false });
  });
});

describe('install action', () => {
  it('prompt when the browser offered one, the iOS guide on iPhone Safari, nothing once installed', () => {
    expect(installMode(st({}))).toBeNull();
    expect(installMode(st({ installable: true }))).toBe('prompt');
    expect(installMode(st({ iosManualInstall: true }))).toBe('ios');
    expect(installMode(st({ installable: true, installed: true }))).toBeNull();
    expect(installMode(st({ iosManualInstall: true, installed: true }))).toBeNull();
  });
});

describe('update banner', () => {
  it('appears only when an update waits and no race is in progress', () => {
    expect(updateVisible(st({ updateReady: true }), false)).toBe(true);
    expect(updateVisible(st({ updateReady: true }), true)).toBe(false);
    expect(updateVisible(st({ updateReady: true, inRace: true }), false)).toBe(false);
    expect(updateVisible(st({ updateReady: false }), false)).toBe(false);
  });
});

describe('waiting runs notice', () => {
  it('offers 등록 online and reassures offline', () => {
    expect(pendingSummary(0, true)).toBeNull();
    expect(pendingSummary(2, true)).toMatchObject({ canSubmit: true });
    const off = pendingSummary(1, false)!;
    expect(off.canSubmit).toBe(false);
    expect(off.text).toContain('온라인이 되면 등록할 수 있어요');
  });
});

describe('connectivity errors (keep the run for later)', () => {
  it('offline / network / timeout / unreachable origin are connectivity problems', () => {
    expect(isConnectivityError(new ApiRequestError('offline', 'x'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError('network', 'x'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError('timeout', 'x'))).toBe(true);
    expect(isConnectivityError(new ApiRequestError('server', 'x', 502))).toBe(true);
    expect(isConnectivityError(new ApiRequestError('server', 'x', 504))).toBe(true);
  });
  it('answers from the server are not', () => {
    expect(isConnectivityError(new ApiRequestError('invalid', 'x', 422, 'VERSION_MISMATCH'))).toBe(false);
    expect(isConnectivityError(new ApiRequestError('rate-limited', 'x', 429))).toBe(false);
    expect(isConnectivityError(new ApiRequestError('server', 'x', 500))).toBe(false);
    expect(isConnectivityError(new Error('boom'))).toBe(false);
  });
});

describe('setup memory restored after an update reload', () => {
  const defaults = () => ({
    cc: 100 as const, ttCc: 150 as const, cpuLevel: 'normal' as const, mirror: false,
    charId: 'kiki' as const, p2CharId: 'pip' as const, trackId: 'sunny-meadow', cup: 'sprout' as const,
    items: true, cpuCount: 7, duoCpuCount: 6, ttGhost: 'best' as const, lbTrack: 'sunny-meadow', lbCc: 150 as const,
  });
  it('takes valid values and ignores unknown / hostile ones', async () => {
    const { restoreMemory } = await import('../../src/client/ui/memory.js');
    const m = { ...defaults() } as Parameters<typeof restoreMemory>[0];
    restoreMemory(m, { cc: 200, cpuLevel: 'hard', charId: 'bolt', trackId: 'neon-city', ttGhost: 'none', cpuCount: 3, mirror: true });
    expect(m).toMatchObject({ cc: 200, cpuLevel: 'hard', charId: 'bolt', trackId: 'neon-city', ttGhost: 'none', cpuCount: 3, mirror: true });
    const n = { ...defaults() } as Parameters<typeof restoreMemory>[0];
    restoreMemory(n, { cc: 999, cpuLevel: 'god', charId: 'mario', trackId: '../../etc', cpuCount: 42, cup: 'x', lbCc: '150' });
    expect(n).toEqual(defaults());
    restoreMemory(n, null);
    restoreMemory(n, 'garbage');
    expect(n).toEqual(defaults());
  });
});
