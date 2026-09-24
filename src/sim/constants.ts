import type { SpeedClass, CpuLevel } from './types.js';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

/** Countdown: 3 at tick 0, 2 at 60, 1 at 120, GO at 180. */
export const COUNTDOWN_TICKS = 180;
/** Rocket-start windows (ticks since countdown start) for the first throttle press. */
export const START_BOOST_PERFECT: readonly [number, number] = [128, 152];
export const START_BOOST_GOOD: readonly [number, number] = [152, 172];
/** Pressing (and holding) before this tick stalls the engine at GO. */
export const START_STALL_BEFORE = 116;

export const GRAVITY = 30;
export const KART_RADIUS = 1.05;
export const KART_HEIGHT = 1.1;
export const MAX_COINS = 10;

export interface ClassTuning { maxSpeed: number; accel: number; label: string }
export const SPEED_CLASSES: Record<SpeedClass, ClassTuning> = {
  50: { maxSpeed: 21, accel: 11, label: '50cc' },
  100: { maxSpeed: 25, accel: 12.5, label: '100cc' },
  150: { maxSpeed: 29, accel: 14, label: '150cc' },
  200: { maxSpeed: 34, accel: 16, label: '200cc' },
};

export const PHYS = {
  /** Base turn rate at full steer (rad/s) before handling stat. */
  turnRate: 2.25,
  /** Speed at which steering reaches full authority. */
  steerFullSpeed: 9,
  /** Steering authority multiplier at top speed. */
  steerHighSpeedFactor: 0.7,
  brakeDecel: 26,
  reverseMax: 8,
  coastDecel: 4,
  overSpeedDecel: 9,
  gripRoad: 14,
  gripDrift: 4.2,
  gripIce: 2.2,
  gripAir: 0.6,
  offroadSpeedFactor: 0.55,
  mudSpeedFactor: 0.42,
  iceSpeedFactor: 1.0,
  hopVelocity: 4.2,
  driftMinSpeed: 9,
  /** Drift arc radii (m) at steer counter / neutral / into the drift (scaled by handling). */
  driftRadiusWide: 52,
  driftRadiusNeutral: 25,
  driftRadiusTight: 12.5,
  /** Charge thresholds (seconds of neutral drifting). */
  driftLevels: [0.75, 1.55, 2.6] as const,
  driftBoostTime: [0.55, 1.05, 1.6] as const,
  boostSpeedFactor: 1.32,
  boostAccel: 38,
  padBoostTime: 1.1,
  nitroBoostTime: 1.35,
  trickBoostTime: 0.7,
  startBoostPerfect: 1.25,
  startBoostGood: 0.6,
  coinSpeedBonus: 0.005,
  starSpeedFactor: 1.18,
  shrinkSpeedFactor: 0.82,
  autopilotSpeed: 44,
  slopeGravityFactor: 0.45,
  wallRestitution: 0.25,
  wallSpeedLoss: 0.18,
  kartRestitution: 0.35,
  spinTime: 1.05,
  tumbleTime: 1.45,
  squashTime: 1.6,
  /** Must exceed tumbleTime so a recovering kart can't be re-hit by the same hazard. */
  invulnAfterHit: 2.2,
  respawnTime: 1.6,
  rouletteTime: 1.9,
  itemBoxRespawn: 2.2,
  coinRespawn: 11,
} as const;

export interface CpuTuning {
  /** Multiplier on max speed. */
  speedFactor: number;
  /** Probability of a perfect rocket start. */
  startSkill: number;
  /** Steering noise amplitude. */
  noise: number;
  /** Lateral wander of the racing line (m). */
  wander: number;
  /** Drift usage skill 0..1. */
  driftSkill: number;
  /** Item usage aggressiveness 0..1. */
  itemSkill: number;
}
export const CPU_LEVELS: Record<CpuLevel, CpuTuning> = {
  easy: { speedFactor: 0.9, startSkill: 0.15, noise: 0.14, wander: 2.4, driftSkill: 0.35, itemSkill: 0.35 },
  normal: { speedFactor: 0.96, startSkill: 0.4, noise: 0.08, wander: 1.6, driftSkill: 0.7, itemSkill: 0.65 },
  hard: { speedFactor: 1.0, startSkill: 0.7, noise: 0.04, wander: 1.0, driftSkill: 1.0, itemSkill: 0.95 },
};

/** Grand Prix points for positions 1..8. */
export const GP_POINTS = [15, 12, 10, 8, 6, 4, 2, 1] as const;

/** Convert m/s to the km/h figure shown on the HUD (arcade scale). */
export const SPEED_DISPLAY_FACTOR = 3.6 * 1.45;
