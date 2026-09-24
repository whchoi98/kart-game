import { describe, expect, it } from 'vitest';
import type { BoostKind, HitKind, ItemId, KartState, RaceEvent } from '../../src/sim/types.js';
import { ITEM_IDS } from '../../src/sim/item-defs.js';
import {
  BOOST_SOUND, EVENT_TYPES, HIT_SOUND, ITEM_USE_SOUND, SFX_IDS, planEvent, type PlanEnv,
} from '../../src/client/audio/event-map.js';
import { SOUNDS, UI_SOUNDS } from '../../src/client/audio/sounds.js';
import { distanceGain, MAX_DISTANCE, newSpatial, REF_DISTANCE, spatialize } from '../../src/client/audio/spatial.js';
import { engineBaseHz, engineTone, GEAR_BOUNDS, loopTargets, newLoopTargets, rouletteInterval } from '../../src/client/audio/engine-model.js';
import { CHARACTERS } from '../../src/sim/characters.js';

/** One representative event per variant — `satisfies` forces this table to stay complete. */
const SAMPLES = {
  countdown: { t: 'countdown', n: 3 },
  lap: { t: 'lap', kart: 0, lap: 2, lapTicks: 3000 },
  finalLap: { t: 'finalLap', kart: 0 },
  finish: { t: 'finish', kart: 0, position: 1, ticks: 9000 },
  itemBox: { t: 'itemBox', kart: 0, x: 1, y: 0, z: 2, box: 3 },
  itemGet: { t: 'itemGet', kart: 0, item: 'orb' },
  itemUse: { t: 'itemUse', kart: 0, item: 'rocket' },
  hit: { t: 'hit', kart: 0, kind: 'spin', by: 2, source: 'banana' },
  blocked: { t: 'blocked', kart: 0, source: 'orb' },
  boost: { t: 'boost', kart: 0, kind: 'mini2' },
  driftLevel: { t: 'driftLevel', kart: 0, level: 2 },
  driftStart: { t: 'driftStart', kart: 0, dir: 1 },
  driftEnd: { t: 'driftEnd', kart: 0 },
  hop: { t: 'hop', kart: 0 },
  trick: { t: 'trick', kart: 0 },
  land: { t: 'land', kart: 0, hard: true },
  wall: { t: 'wall', kart: 0, impact: 9, x: 0, y: 0, z: 0 },
  kartBump: { t: 'kartBump', a: 0, b: 1, impact: 4, x: 0, y: 0, z: 0 },
  coin: { t: 'coin', kart: 0, x: 0, y: 0, z: 0, coins: 4 },
  coinLoss: { t: 'coinLoss', kart: 0, count: 2 },
  explosion: { t: 'explosion', x: 3, y: 0, z: 3, radius: 4, source: 'rocket' },
  projectileBounce: { t: 'projectileBounce', id: 7, x: 0, y: 0, z: 5 },
  projectileGone: { t: 'projectileGone', id: 7, x: 0, y: 0, z: 5, kind: 'orb' },
  thunder: { t: 'thunder', by: 4 },
  ink: { t: 'ink', by: 3, targets: [0, 1] },
  fall: { t: 'fall', kart: 0 },
  respawn: { t: 'respawn', kart: 0 },
  wrongWay: { t: 'wrongWay', kart: 0, on: true },
  position: { t: 'position', kart: 0, from: 4, to: 3 },
  startBoost: { t: 'startBoost', kart: 0, good: true },
  stall: { t: 'stall', kart: 0 },
  raceDone: { t: 'raceDone' },
} as const satisfies { [K in RaceEvent['t']]: Extract<RaceEvent, { t: K }> };

const humanEnv = (humans: number[], finalLap: number[] = []): PlanEnv => ({
  isHuman: k => humans.includes(k),
  finalLapKarts: new Set(finalLap),
});

describe('event → sound coverage', () => {
  it('lists every RaceEvent variant', () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(Object.values(SAMPLES).map(e => [e.t, e] as const))('%s produces a sound for a human kart', (_t, e) => {
    const calls = planEvent(e as RaceEvent, humanEnv([0]));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(SFX_IDS).toContain(c.id);
      expect(typeof SOUNDS[c.id]).toBe('function');
      expect(c.priority).toBeGreaterThanOrEqual(0);
      expect(c.priority).toBeLessThanOrEqual(10);
      expect(c.delay).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.param)).toBe(true);
    }
  });

  it('has a synthesis function for every sound id and UI sound', () => {
    for (const id of SFX_IDS) expect(typeof SOUNDS[id], id).toBe('function');
    expect(Object.keys(SOUNDS).sort()).toEqual([...SFX_IDS].sort());
    for (const u of ['move', 'select', 'back', 'start', 'error', 'toggle', 'unlock'] as const) expect(typeof UI_SOUNDS[u]).toBe('function');
  });

  it('gives every item, hit kind and boost kind its own sound family', () => {
    expect(Object.keys(ITEM_USE_SOUND).sort()).toEqual([...ITEM_IDS].sort());
    const families = new Set(ITEM_IDS.map(i => ITEM_USE_SOUND[i]));
    expect(families.size).toBe(10); // singles and triples share a family
    for (const item of ITEM_IDS) {
      const calls = planEvent({ t: 'itemUse', kart: 5, item: item as ItemId }, humanEnv([0]));
      expect(calls[0]!.id).toBe(ITEM_USE_SOUND[item]);
    }
    const hits: HitKind[] = ['spin', 'tumble', 'squash', 'bump'];
    expect(new Set(hits.map(h => HIT_SOUND[h])).size).toBe(4);
    const boosts: BoostKind[] = ['mini1', 'mini2', 'mini3', 'pad', 'nitro', 'trick', 'start', 'coin', 'ramp'];
    expect(new Set(boosts.map(b => BOOST_SOUND[b])).size).toBe(boosts.length);
  });

  it('countdown beeps low for 3/2/1 and high for GO', () => {
    for (const n of [3, 2, 1] as const) expect(planEvent({ t: 'countdown', n }, humanEnv([0]))[0]!.id).toBe('countBeep');
    expect(planEvent({ t: 'countdown', n: 0 }, humanEnv([0]))[0]!.id).toBe('countGo');
  });

  it('keeps human-only feedback away from CPU karts', () => {
    const env = humanEnv([0]);
    expect(planEvent({ t: 'lap', kart: 3, lap: 2, lapTicks: 1 }, env)).toEqual([]);
    expect(planEvent({ t: 'itemGet', kart: 3, item: 'star' }, env)).toEqual([]);
    expect(planEvent({ t: 'position', kart: 3, from: 2, to: 1 }, env)).toEqual([]);
    expect(planEvent({ t: 'wrongWay', kart: 3, on: true }, env)).toEqual([]);
    expect(planEvent({ t: 'startBoost', kart: 3, good: true }, env)).toEqual([]);
    expect(planEvent({ t: 'finalLap', kart: 3 }, env)).toEqual([]);
    expect(planEvent({ t: 'finish', kart: 3, position: 1, ticks: 1 }, env)[0]!.id).toBe('finishCpu');
  });

  it('lets the final-lap sting replace the lap chime and skips lap 1', () => {
    expect(planEvent({ t: 'lap', kart: 0, lap: 1, lapTicks: 0 }, humanEnv([0]))).toEqual([]);
    expect(planEvent({ t: 'lap', kart: 0, lap: 3, lapTicks: 1 }, humanEnv([0], [0]))).toEqual([]);
    expect(planEvent({ t: 'lap', kart: 0, lap: 2, lapTicks: 1 }, humanEnv([0]))[0]!.id).toBe('lapChime');
  });

  it('prioritises human sounds over CPU sounds', () => {
    const e: RaceEvent = { t: 'hit', kart: 0, kind: 'tumble', by: 1, source: 'rocket' };
    const human = planEvent(e, humanEnv([0]))[0]!;
    const cpu = planEvent(e, humanEnv([5]))[0]!;
    expect(human.priority).toBeGreaterThan(cpu.priority);
  });

  it('distinguishes position gained vs lost, and wrong-way on vs off', () => {
    expect(planEvent({ t: 'position', kart: 0, from: 4, to: 2 }, humanEnv([0]))[0]!.id).toBe('posUp');
    expect(planEvent({ t: 'position', kart: 0, from: 2, to: 4 }, humanEnv([0]))[0]!.id).toBe('posDown');
    expect(planEvent({ t: 'wrongWay', kart: 0, on: false }, humanEnv([0]))[0]!.id).toBe('wrongWayOff');
    expect(planEvent({ t: 'startBoost', kart: 0, good: false }, humanEnv([0]))[0]!.id).toBe('startGood');
  });
});

describe('spatialisation', () => {
  it('attenuates with distance and goes silent far away', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(REF_DISTANCE)).toBe(1);
    let prev = 1;
    for (let d = REF_DISTANCE + 1; d < MAX_DISTANCE; d += 5) {
      const g = distanceGain(d);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(distanceGain(MAX_DISTANCE)).toBe(0);
    expect(distanceGain(Number.NaN)).toBe(0);
  });

  it('pans to the correct side using the sim coordinate convention', () => {
    const sp = newSpatial();
    // listener faces +Z (yaw 0) → right is −X
    spatialize(-20, 0, [{ x: 0, y: 0, z: 0, yaw: 0 }], sp);
    expect(sp.pan).toBeGreaterThan(0.5);
    spatialize(20, 0, [{ x: 0, y: 0, z: 0, yaw: 0 }], sp);
    expect(sp.pan).toBeLessThan(-0.5);
    spatialize(0, 20, [{ x: 0, y: 0, z: 0, yaw: 0 }], sp);
    expect(Math.abs(sp.pan)).toBeLessThan(0.01);
  });

  it('uses the nearest of several listeners', () => {
    const sp = newSpatial();
    spatialize(100, 100, [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 98, y: 0, z: 100, yaw: 0 }], sp);
    expect(sp.listener).toBe(1);
    expect(sp.gain).toBe(1);
  });
});

describe('engine model', () => {
  it('climbs within a gear and drops at each shift', () => {
    const t = { gear: 0, rpm: 0, freq: 0, cutoff: 0 };
    let last = engineTone(0, 1, 40, t).freq;
    for (const b of GEAR_BOUNDS) {
      const before = engineTone(b - 0.005, 1, 40, t).freq;
      expect(before).toBeGreaterThan(last);
      const after = engineTone(b + 0.005, 1, 40, t).freq;
      expect(after).toBeLessThan(before);
      last = after;
    }
    expect(engineTone(1, 1, 40, t).freq).toBeGreaterThan(engineTone(0, 1, 40, t).freq);
    expect(engineTone(0.5, 1, 40, t).cutoff).toBeGreaterThan(engineTone(0.5, 0, 40, t).cutoff);
    expect(Number.isFinite(engineTone(Number.NaN, Number.NaN, 40, t).freq)).toBe(true);
  });

  it('gives heavier drivers a lower engine', () => {
    const light = CHARACTERS.find(c => c.weightClass === 'light')!;
    const heavy = CHARACTERS.find(c => c.weightClass === 'heavy' && c.species !== 'robot')!;
    expect(engineBaseHz(heavy)).toBeLessThan(engineBaseHz(light));
  });

  it('slows the roulette ticks as it winds down', () => {
    expect(rouletteInterval(1.9, 1.9)).toBeLessThan(rouletteInterval(0.2, 1.9));
  });

  it('derives drift/surface/boost layers from kart state', () => {
    const k = {
      speed: 20, maxSpeed: 29, grounded: true, respawnTime: 0, driftDir: 1, driftLevel: 2,
      boostTime: 0.5, autopilotTime: 0, surface: 'dirt',
    } as unknown as KartState;
    const L = loopTargets(k, newLoopTargets());
    expect(L.drift).toBeGreaterThan(0);
    expect(L.driftTint).toBe(2);
    expect(L.boost).toBeGreaterThan(0);
    expect(L.offroad).toBeGreaterThan(0);
    expect(L.ice).toBe(0);
    const air = loopTargets({ ...k, grounded: false, surface: 'ice' } as KartState, newLoopTargets());
    expect(air.drift).toBe(0);
    expect(air.ice).toBe(0);
    const ice = loopTargets({ ...k, surface: 'ice', driftDir: 0 } as KartState, newLoopTargets());
    expect(ice.ice).toBeGreaterThan(0);
    expect(ice.drift).toBe(0);
  });
});
