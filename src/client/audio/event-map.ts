/**
 * Pure mapping from simulation `RaceEvent`s to sound requests. No WebAudio here, so the
 * mapping is unit-tested for coverage of every event variant.
 */
import type { BoostKind, HitKind, ItemId, ProjectileKind, RaceEvent } from '../../sim/types.js';

export const SFX_IDS = [
  'countBeep', 'countGo', 'lapChime', 'finalLap', 'finishFanfare', 'finishCpu',
  'itemBox', 'itemGet', 'rouletteTick',
  'useBanana', 'useOrb', 'useRocket', 'useNitro', 'useStar', 'useThunder', 'useInk', 'useAutopilot', 'useSkybomb', 'useCoins',
  'hitSpin', 'hitTumble', 'hitSquash', 'hitBump', 'shieldClang',
  'boostMini1', 'boostMini2', 'boostMini3', 'boostPad', 'boostNitro', 'boostTrick', 'boostStart', 'boostCoin', 'boostRamp',
  'driftPing', 'driftStart', 'driftEnd', 'hop', 'trick', 'land', 'landHard', 'wall', 'kartBump',
  'coin', 'coinLoss', 'explosion', 'bounce', 'poof', 'thunderCrack', 'inkSplat',
  'fallWhistle', 'respawn', 'wrongWay', 'wrongWayOff', 'posUp', 'posDown',
  'startPerfect', 'startGood', 'stall', 'raceDone',
  'voiceHurt', 'voiceJoy', 'voiceWin', 'voiceSad',
] as const;
export type SfxId = typeof SFX_IDS[number];

/** Every RaceEvent discriminant. `satisfies` makes the compiler flag new variants. */
export const EVENT_TYPES = {
  countdown: true, lap: true, finalLap: true, finish: true, itemBox: true, itemGet: true, itemUse: true,
  hit: true, blocked: true, boost: true, driftLevel: true, driftStart: true, driftEnd: true, hop: true,
  trick: true, land: true, wall: true, kartBump: true, coin: true, coinLoss: true, explosion: true,
  projectileBounce: true, projectileGone: true, thunder: true, ink: true, fall: true, respawn: true,
  wrongWay: true, position: true, startBoost: true, stall: true, raceDone: true,
} as const satisfies Record<RaceEvent['t'], true>;

export type SoundWhere = 'kart' | 'point' | 'global';

export interface SoundCall {
  id: SfxId;
  where: SoundWhere;
  /** Source kart for 'kart' sounds (and the owner for voice chirps). */
  kart: number;
  x: number;
  z: number;
  /** Sound-specific parameter (impact, coin count, drift level, position…). */
  param: number;
  /** 0..10 — higher survives voice stealing. */
  priority: number;
  /** Seconds after "now". */
  delay: number;
}

export interface PlanEnv {
  isHuman(kart: number): boolean;
  /** Karts that received a `finalLap` event in the same batch (their lap chime is replaced by the sting). */
  finalLapKarts: ReadonlySet<number>;
}

export const ITEM_USE_SOUND: Record<ItemId, SfxId> = {
  banana: 'useBanana', banana3: 'useBanana',
  orb: 'useOrb', orb3: 'useOrb',
  rocket: 'useRocket', rocket3: 'useRocket',
  nitro: 'useNitro', nitro3: 'useNitro',
  star: 'useStar', thunder: 'useThunder', ink: 'useInk',
  autopilot: 'useAutopilot', skybomb: 'useSkybomb', coins: 'useCoins',
};

export const HIT_SOUND: Record<HitKind, SfxId> = {
  spin: 'hitSpin', tumble: 'hitTumble', squash: 'hitSquash', bump: 'hitBump',
};

export const BOOST_SOUND: Record<BoostKind, SfxId> = {
  mini1: 'boostMini1', mini2: 'boostMini2', mini3: 'boostMini3', pad: 'boostPad', nitro: 'boostNitro',
  trick: 'boostTrick', start: 'boostStart', coin: 'boostCoin', ramp: 'boostRamp',
};

export const PROJECTILE_INDEX: Record<ProjectileKind, number> = { banana: 0, orb: 1, rocket: 2, skybomb: 3 };

function call(id: SfxId, where: SoundWhere, kart: number, priority: number, param = 0, x = 0, z = 0, delay = 0): SoundCall {
  return { id, where, kart, x, z, param, priority, delay };
}

/** Sounds for one event. Empty when the event is inaudible in this context (e.g. a CPU lap). */
export function planEvent(e: RaceEvent, env: PlanEnv): SoundCall[] {
  const H = (k: number) => env.isHuman(k);
  const pr = (k: number, human: number, cpu: number) => (H(k) ? human : cpu);
  switch (e.t) {
    case 'countdown':
      return [e.n === 0 ? call('countGo', 'global', -1, 10) : call('countBeep', 'global', -1, 10, e.n)];
    case 'lap':
      if (!H(e.kart) || e.lap < 2 || env.finalLapKarts.has(e.kart)) return [];
      return [call('lapChime', 'global', e.kart, 9, e.lap)];
    case 'finalLap':
      return H(e.kart) ? [call('finalLap', 'global', e.kart, 10)] : [];
    case 'finish':
      if (H(e.kart)) {
        return [
          call('finishFanfare', 'global', e.kart, 10, e.position),
          call(e.position <= 3 ? 'voiceWin' : 'voiceSad', 'kart', e.kart, 8, e.position, 0, 0, 0.35),
        ];
      }
      return [call('finishCpu', 'kart', e.kart, 2, e.position)];
    case 'itemBox':
      return [call('itemBox', 'kart', e.kart, pr(e.kart, 7, 3))];
    case 'itemGet':
      return H(e.kart) ? [call('itemGet', 'global', e.kart, 8)] : [];
    case 'itemUse':
      return [call(ITEM_USE_SOUND[e.item], 'kart', e.kart, pr(e.kart, 7, 4))];
    case 'hit': {
      const out = [call(HIT_SOUND[e.kind], 'kart', e.kart, pr(e.kart, 9, 5))];
      if (e.kind !== 'bump') out.push(call('voiceHurt', 'kart', e.kart, pr(e.kart, 7, 2), 0, 0, 0, 0.06));
      return out;
    }
    case 'blocked':
      return [call('shieldClang', 'kart', e.kart, pr(e.kart, 7, 4))];
    case 'boost': {
      const out = [call(BOOST_SOUND[e.kind], 'kart', e.kart, pr(e.kart, 7, 3))];
      if (H(e.kart) && (e.kind === 'mini3' || e.kind === 'start')) out.push(call('voiceJoy', 'kart', e.kart, 5, 0, 0, 0, 0.05));
      return out;
    }
    case 'driftLevel':
      return [call('driftPing', 'kart', e.kart, pr(e.kart, 7, 1), e.level)];
    case 'driftStart':
      return [call('driftStart', 'kart', e.kart, pr(e.kart, 5, 1), e.dir)];
    case 'driftEnd':
      return [call('driftEnd', 'kart', e.kart, pr(e.kart, 3, 1))];
    case 'hop':
      return [call('hop', 'kart', e.kart, pr(e.kart, 4, 1))];
    case 'trick': {
      const out = [call('trick', 'kart', e.kart, pr(e.kart, 7, 3))];
      if (H(e.kart)) out.push(call('voiceJoy', 'kart', e.kart, 5, 1, 0, 0, 0.08));
      return out;
    }
    case 'land':
      return [call(e.hard ? 'landHard' : 'land', 'kart', e.kart, pr(e.kart, 5, 2))];
    case 'wall':
      return [call('wall', 'point', e.kart, pr(e.kart, 6, 2), e.impact, e.x, e.z)];
    case 'kartBump':
      return [call('kartBump', 'point', H(e.a) ? e.a : e.b, H(e.a) || H(e.b) ? 6 : 2, e.impact, e.x, e.z)];
    case 'coin':
      return [call('coin', 'kart', e.kart, pr(e.kart, 6, 1), e.coins)];
    case 'coinLoss':
      return [call('coinLoss', 'kart', e.kart, pr(e.kart, 6, 2), e.count)];
    case 'explosion':
      return [call('explosion', 'point', -1, 8, e.radius, e.x, e.z)];
    case 'projectileBounce':
      return [call('bounce', 'point', -1, 3, 0, e.x, e.z)];
    case 'projectileGone':
      return [call('poof', 'point', -1, 2, PROJECTILE_INDEX[e.kind], e.x, e.z)];
    case 'thunder':
      return [call('thunderCrack', 'global', e.by, 10, 0, 0, 0, 0.12)];
    case 'ink': {
      const humanHit = e.targets.some(H);
      return [call('inkSplat', 'global', e.by, humanHit ? 9 : 3, humanHit ? 1 : 0, 0, 0, 0.1)];
    }
    case 'fall':
      return [call('fallWhistle', 'kart', e.kart, pr(e.kart, 9, 3))];
    case 'respawn':
      return [call('respawn', 'kart', e.kart, pr(e.kart, 7, 2))];
    case 'wrongWay':
      if (!H(e.kart)) return [];
      return [e.on ? call('wrongWay', 'global', e.kart, 9) : call('wrongWayOff', 'global', e.kart, 4)];
    case 'position':
      if (!H(e.kart) || e.from === e.to) return [];
      return [call(e.to < e.from ? 'posUp' : 'posDown', 'global', e.kart, 4, e.to)];
    case 'startBoost':
      return H(e.kart) ? [call(e.good ? 'startPerfect' : 'startGood', 'global', e.kart, 9)] : [];
    case 'stall':
      return [call('stall', 'kart', e.kart, pr(e.kart, 8, 2))];
    case 'raceDone':
      return [call('raceDone', 'global', -1, 5, 0, 0, 0, 0.4)];
    default: {
      const never: never = e;
      return never;
    }
  }
}

/** Minimum seconds between two plays of the same sound from the same kart. */
export const RATE_LIMIT: Partial<Record<SfxId, number>> = {
  wall: 0.09, kartBump: 0.12, coin: 0.035, hop: 0.06, land: 0.12, landHard: 0.12, bounce: 0.05,
  poof: 0.05, driftStart: 0.08, driftEnd: 0.08, posUp: 0.35, posDown: 0.35, itemBox: 0.04,
  voiceHurt: 1.2, voiceJoy: 1.6, rouletteTick: 0.03, shieldClang: 0.08,
};
