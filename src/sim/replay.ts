/**
 * Time-trial configuration and server-side verification by re-simulation.
 * A run's log holds one input word per tick from tick 0 of the countdown up to
 * (and including) the tick on which the kart crossed the final finish line.
 */
import { isCharacterId } from './characters.js';
import { COUNTDOWN_TICKS } from './constants.js';
import { decodeInputWord, decodeLog, NEUTRAL_INPUT } from './input-log.js';
import { RaceWorld } from './race.js';
import { hasTrackDef } from './tracks/index.js';
import type { CharacterId, KartInput, RaceConfig, SpeedClass } from './types.js';

export const TIME_TRIAL_SEED = 0x7a11;
/** Hard ceiling on a verified run: 12 minutes of racing. */
export const MAX_TT_TICKS = COUNTDOWN_TICKS + 60 * 60 * 12;

export function createTimeTrialConfig(trackId: string, cc: SpeedClass, charId: CharacterId): RaceConfig {
  return {
    trackId,
    mode: 'tt',
    cc,
    cpuLevel: 'normal',
    mirror: false,
    racers: [{ charId, human: 0 }],
    items: false,
    seed: TIME_TRIAL_SEED,
  };
}

export type VerifyResult = { ok: true; ticks: number; lapTicks: number[] } | { ok: false; reason: string };

export function verifyTimeTrial(input: { trackId: string; cc: SpeedClass; charId: CharacterId; log: string }): VerifyResult {
  if (!hasTrackDef(input.trackId)) return { ok: false, reason: 'unknown track' };
  if (!isCharacterId(input.charId)) return { ok: false, reason: 'unknown character' };
  if (![50, 100, 150, 200].includes(input.cc)) return { ok: false, reason: 'bad speed class' };
  let words: Uint16Array;
  try {
    words = decodeLog(input.log, MAX_TT_TICKS);
  } catch (e) {
    return { ok: false, reason: `malformed log: ${(e as Error).message}` };
  }
  const world = new RaceWorld(createTimeTrialConfig(input.trackId, input.cc, input.charId));
  const kart = world.karts[0]!;
  const buf: KartInput[] = [NEUTRAL_INPUT];
  for (let i = 0; i < words.length; i++) {
    buf[0] = decodeInputWord(words[i]!);
    world.step(buf);
    if (kart.finished) {
      if (i !== words.length - 1) return { ok: false, reason: 'log continues after the finish' };
      return { ok: true, ticks: kart.finishTick, lapTicks: [...kart.lapTicks] };
    }
  }
  return { ok: false, reason: 'run did not finish' };
}

/** Plays an encoded time-trial log in its own world (ghost racer). */
export class GhostPlayer {
  readonly world: RaceWorld;
  private readonly words: Uint16Array;
  private cursor = 0;
  private readonly buf: KartInput[] = [NEUTRAL_INPUT];

  constructor(trackId: string, cc: SpeedClass, charId: CharacterId, log: string) {
    this.words = decodeLog(log, MAX_TT_TICKS);
    this.world = new RaceWorld(createTimeTrialConfig(trackId, cc, charId));
  }

  get kart() { return this.world.karts[0]!; }
  get done(): boolean { return this.cursor >= this.words.length; }

  step(): void {
    this.buf[0] = this.cursor < this.words.length ? decodeInputWord(this.words[this.cursor++]!) : NEUTRAL_INPUT;
    this.world.step(this.buf);
    this.world.drainEvents();
  }
}
