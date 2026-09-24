/**
 * Pure engine/continuous-sound models (unit-testable, no WebAudio).
 */
import type { CharacterDef, KartState } from '../../sim/types.js';

/** Upper speed-ratio bound of each gear (the last gear runs to the top). */
export const GEAR_BOUNDS = [0.2, 0.42, 0.64, 0.86] as const;

export interface EngineTone {
  gear: number;
  /** 0..1 engine speed inside the current gear, scaled across gears. */
  rpm: number;
  freq: number;
  cutoff: number;
}

/**
 * Speed ratio (|speed| / maxSpeed) + load (0..1 throttle/boost estimate) → engine tone.
 * Within a gear the pitch climbs; crossing into the next gear drops it again, which
 * reads as a gear shift.
 */
export function engineTone(ratio: number, load: number, baseHz: number, out: EngineTone): EngineTone {
  const r = Math.min(1.45, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const l = Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0));
  let gear = 0;
  while (gear < GEAR_BOUNDS.length && r >= GEAR_BOUNDS[gear]!) gear++;
  const lo = gear === 0 ? 0 : GEAR_BOUNDS[gear - 1]!;
  const hi = gear < GEAR_BOUNDS.length ? GEAR_BOUNDS[gear]! : 1.45;
  const within = (r - lo) / (hi - lo);
  const rpm = (0.3 + 0.7 * within) * (0.78 + gear * 0.07);
  out.gear = gear;
  out.rpm = gear === 0 ? Math.max(0.22, rpm) : rpm;
  out.freq = baseHz * (1 + out.rpm * 2.2);
  out.cutoff = 380 + 2800 * out.rpm * (0.4 + 0.6 * l);
  return out;
}

/** Engine base pitch by weight class (heavier karts rumble lower). */
export function engineBaseHz(def: Pick<CharacterDef, 'weightClass' | 'species'>): number {
  const base = def.weightClass === 'light' ? 47 : def.weightClass === 'medium' ? 41 : 35;
  return def.species === 'robot' ? base * 1.12 : base;
}

/** Roulette tick interval: fast at first, slowing as the roulette winds down. */
export function rouletteInterval(remaining: number, total: number): number {
  const f = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 1;
  return 0.055 + 0.11 * f * f;
}

/** Continuous-layer targets for one kart (0..1 levels). */
export interface LoopTargets {
  drift: number;
  driftTint: number;
  boost: number;
  jet: number;
  offroad: number;
  mud: boolean;
  ice: number;
  propeller: number;
}

export function loopTargets(k: KartState, out: LoopTargets): LoopTargets {
  const ratio = k.maxSpeed > 0 ? Math.min(1.4, Math.abs(k.speed) / k.maxSpeed) : 0;
  const ground = k.grounded && k.respawnTime <= 0;
  out.drift = k.driftDir !== 0 && ground ? 0.55 + 0.45 * Math.min(1, ratio) : 0;
  out.driftTint = k.driftLevel;
  out.boost = k.boostTime > 0 && k.autopilotTime <= 0 ? Math.min(1, 0.45 + k.boostTime) : 0;
  out.jet = k.autopilotTime > 0 ? 1 : 0;
  const rough = ground && (k.surface === 'dirt' || k.surface === 'mud');
  out.offroad = rough ? Math.min(1, 0.25 + ratio) : 0;
  out.mud = k.surface === 'mud';
  out.ice = ground && k.surface === 'ice' ? Math.min(1, 0.15 + ratio) : 0;
  out.propeller = k.respawnTime > 0 ? 1 : 0;
  return out;
}

export function newLoopTargets(): LoopTargets {
  return { drift: 0, driftTint: 0, boost: 0, jet: 0, offroad: 0, mud: false, ice: 0, propeller: 0 };
}
