/**
 * RaceConfig builders for the app flows (GP / VS / Duo). Pure apart from
 * `randomSeed()`, which uses the Web Crypto API. Time-trial configs come from
 * `createTimeTrialConfig` in src/sim/replay.ts.
 */
import { CHARACTER_IDS } from '../../sim/characters.js';
import type { CharacterId, RaceConfig, RacerSetup } from '../../sim/types.js';
import type { DuoSetup, GrandPrixSetup, VersusSetup } from '../contracts.js';

export type RandomFn = () => number;

/** Uniform 32-bit seed from crypto.getRandomValues (Math.random only as a last resort). */
export function randomSeed(): number {
  try {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0]! >>> 0;
  } catch {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
}

/** Seeded mulberry32 for reproducible UI-side shuffles. */
export function seededRandom(seed: number): RandomFn {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: RandomFn): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Distinct CPU characters not used by the humans. */
export function pickCpuCharacters(exclude: readonly CharacterId[], count: number, rand: RandomFn): CharacterId[] {
  const pool = CHARACTER_IDS.filter(id => !exclude.includes(id));
  return shuffle(pool, rand).slice(0, Math.max(0, Math.min(count, pool.length)));
}

/**
 * Grid with the CPUs in front and the humans at the back.
 * `humans[0]` (player 1) takes the very last slot, player 2 the one ahead of it.
 */
export function buildGrid(humans: readonly CharacterId[], cpuCount: number, rand: RandomFn): RacerSetup[] {
  const maxCpu = Math.max(0, 8 - humans.length);
  const cpus = pickCpuCharacters(humans, Math.min(cpuCount, maxCpu), rand);
  const grid: RacerSetup[] = cpus.map(charId => ({ charId, human: -1 }));
  for (let p = humans.length - 1; p >= 0; p--) grid.push({ charId: humans[p]!, human: p });
  return grid;
}

export function makeGrandPrixConfig(setup: GrandPrixSetup, trackId: string, racers: RacerSetup[], seed: number): RaceConfig {
  return {
    trackId, mode: 'gp', cc: setup.cc, cpuLevel: setup.cpuLevel, mirror: setup.mirror,
    racers, items: true, seed,
  };
}

export function makeVersusConfig(setup: VersusSetup, racers: RacerSetup[], seed: number): RaceConfig {
  return {
    trackId: setup.trackId, mode: 'vs', cc: setup.cc, cpuLevel: setup.cpuLevel, mirror: setup.mirror,
    racers, items: setup.items, seed,
  };
}

export function makeDuoConfig(setup: DuoSetup, racers: RacerSetup[], seed: number): RaceConfig {
  return {
    trackId: setup.trackId, mode: 'duo', cc: setup.cc, cpuLevel: setup.cpuLevel, mirror: false,
    racers, items: setup.items, seed,
  };
}
