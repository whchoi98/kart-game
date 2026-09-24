/**
 * Race sound library, part 1: items, hits, boosts, drifting and kart physics.
 * Each sound renders into an `Out` at time `t` and returns the time it is silent.
 */
import type { Kit, Out } from './sfx-lib.js';
import { bell, fmHit, hz, noise, tone } from './sfx-lib.js';

export type SoundFn = (k: Kit, o: Out, t: number, p: number) => number;

const max = Math.max;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ───────────── items ─────────────

export const useBanana: SoundFn = (k, o, t) => max(
  noise(k, o, t, { f0: 700, f1: 2600, q: 2.5, dur: 0.1, peak: 0.28, decay: 0.04 }),
  tone(k, o, t + 0.1, { wave: 'sine', f0: 360, f1: 170, dur: 0.12, peak: 0.42, decay: 0.05 }),
  tone(k, o, t + 0.1, { wave: 'triangle', f0: 720, f1: 340, dur: 0.1, peak: 0.12, decay: 0.03 }),
);

export const useOrb: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'pulse25', f0: 1500, f1: 280, sweep: 0.2, dur: 0.22, peak: 0.26, decay: 0.07, lp: 5000 }),
  noise(k, o, t, { filter: 'highpass', f0: 2500, dur: 0.05, peak: 0.25, decay: 0.012 }),
  tone(k, o, t, { wave: 'sine', f0: 220, f1: 90, dur: 0.1, peak: 0.35, decay: 0.035 }),
);

export const useRocket: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 120, f1: 50, dur: 0.12, peak: 0.5, decay: 0.05 }),
  noise(k, o, t, { f0: 300, f1: 3200, sweep: 0.5, q: 1.8, dur: 0.6, peak: 0.34, a: 0.03 }),
  tone(k, o, t + 0.02, { wave: 'sawtooth', f0: 140, f1: 620, sweep: 0.45, dur: 0.5, peak: 0.13, lp: 2200, a: 0.05 }),
);

export const useNitro: SoundFn = (k, o, t) => max(
  noise(k, o, t, { filter: 'highpass', f0: 2200, f1: 900, dur: 0.28, peak: 0.3, a: 0.01 }),
  tone(k, o, t + 0.04, { wave: 'sawtooth', f0: 180, f1: 760, sweep: 0.3, dur: 0.32, peak: 0.12, lp: 2600 }),
);

export const useStar: SoundFn = (k, o, t) => {
  let end = t;
  [84, 88, 91, 96, 100].forEach((m, i) => { end = max(end, bell(k, o, t + i * 0.05, hz(m), 0.12, 0.2)); });
  return max(end, noise(k, o, t, { filter: 'highpass', f0: 6000, dur: 0.5, peak: 0.1, a: 0.1 }));
};

export const useThunder: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sawtooth', f0: 70, f1: 1400, sweep: 0.32, dur: 0.34, peak: 0.16, vib: [38, 90], lp: 4000 }),
  noise(k, o, t, { filter: 'bandpass', f0: 3000, q: 0.8, dur: 0.34, peak: 0.16, a: 0.02 }),
);

export const useInk: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 620, f1: 150, dur: 0.3, peak: 0.38, vib: [18, 160] }),
  noise(k, o, t + 0.05, { filter: 'lowpass', f0: 1800, f1: 300, q: 4, dur: 0.22, peak: 0.24, decay: 0.07 }),
);

export const useAutopilot: SoundFn = (k, o, t) => max(
  noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 200, f1: 2600, sweep: 0.8, q: 1.2, dur: 0.9, peak: 0.5, a: 0.08 }),
  tone(k, o, t, { wave: 'sawtooth', f0: 60, f1: 240, sweep: 0.8, dur: 0.9, peak: 0.14, lp: 1400, a: 0.05 }),
  tone(k, o, t, { wave: 'sine', f0: 90, f1: 40, dur: 0.2, peak: 0.45, decay: 0.08 }),
);

export const useSkybomb: SoundFn = (k, o, t) => max(
  noise(k, o, t, { f0: 400, f1: 2400, sweep: 0.3, q: 2, dur: 0.35, peak: 0.25, a: 0.02 }),
  tone(k, o, t + 0.12, { wave: 'sine', f0: 820, dur: 1.1, peak: 0.2, a: 0.05, vib: [3.4, 280] }),
  tone(k, o, t + 0.12, { wave: 'triangle', f0: 1640, dur: 1.1, peak: 0.05, a: 0.05, vib: [3.4, 280] }),
);

export const useCoins: SoundFn = (k, o, t) => {
  let end = t;
  [95, 100, 98, 103].forEach((m, i) => { end = max(end, fmHit(k, o, t + i * 0.07, hz(m), 2.76, 0.6, 0.09, 0.18)); });
  return end;
};

// ───────────── hits & shields ─────────────

export const hitSpin: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'triangle', f0: 950, f1: 230, sweep: 0.65, dur: 0.7, peak: 0.28, vib: [13, 90] }),
  noise(k, o, t, { f0: 1300, q: 3, dur: 0.55, peak: 0.16, a: 0.02, decay: 0.2 }),
  tone(k, o, t, { wave: 'sine', f0: 160, f1: 70, dur: 0.12, peak: 0.4, decay: 0.05 }),
);

export const hitTumble: SoundFn = (k, o, t) => max(
  noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 4000, f1: 300, sweep: 0.4, dur: 0.5, peak: 0.55, decay: 0.12 }),
  tone(k, o, t, { wave: 'sine', f0: 130, f1: 38, sweep: 0.35, dur: 0.4, peak: 0.6, decay: 0.12 }),
  fmHit(k, o, t + 0.03, 330, 1.41, 3, 0.1, 0.18),
  fmHit(k, o, t + 0.16, 470, 1.73, 2.5, 0.07, 0.12),
);

export const hitSquash: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sawtooth', f0: 520, f1: 110, sweep: 0.26, dur: 0.3, peak: 0.2, lp: 1600, decay: 0.09 }),
  tone(k, o, t, { wave: 'sine', f0: 300, f1: 70, sweep: 0.2, dur: 0.22, peak: 0.45, decay: 0.07 }),
  noise(k, o, t, { filter: 'lowpass', f0: 900, dur: 0.12, peak: 0.25, decay: 0.04 }),
);

export const hitBump: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 150, f1: 62, dur: 0.15, peak: 0.45, decay: 0.05 }),
  noise(k, o, t, { filter: 'lowpass', f0: 700, dur: 0.08, peak: 0.25, decay: 0.025 }),
);

export const shieldClang: SoundFn = (k, o, t) => max(
  fmHit(k, o, t, 880, 2.76, 4.5, 0.12, 0.3, 0.05),
  fmHit(k, o, t + 0.004, 1294, 1.47, 2, 0.09, 0.16),
  noise(k, o, t, { filter: 'highpass', f0: 4000, dur: 0.05, peak: 0.2, decay: 0.012 }),
);

// ───────────── boosts ─────────────

const pop = (f: number, peak: number): SoundFn => (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: f, f1: f * 1.9, sweep: 0.07, dur: 0.1, peak, decay: 0.04 }),
  noise(k, o, t, { f0: 2200, q: 1.2, dur: 0.14, peak: peak * 0.7, decay: 0.05 }),
);

export const boostMini1: SoundFn = pop(480, 0.45);

export const boostMini2: SoundFn = (k, o, t) => max(
  pop(620, 0.5)(k, o, t, 0),
  noise(k, o, t, { f0: 600, f1: 2600, q: 1.5, dur: 0.3, peak: 0.16, a: 0.02 }),
);

export const boostMini3: SoundFn = (k, o, t) => {
  let end = max(
    pop(760, 0.55)(k, o, t, 0),
    noise(k, o, t, { f0: 500, f1: 3600, q: 1.4, dur: 0.42, peak: 0.24, a: 0.02 }),
  );
  for (const m of [88, 92, 95]) end = max(end, tone(k, o, t + 0.03, { wave: 'pulse25', f0: hz(m), dur: 0.16, peak: 0.07, decay: 0.08 }));
  return end;
};

export const boostPad: SoundFn = (k, o, t) => max(
  noise(k, o, t, { f0: 500, f1: 4200, sweep: 0.4, q: 1.5, dur: 0.48, peak: 0.3, a: 0.02 }),
  tone(k, o, t, { wave: 'sine', f0: 420, f1: 1700, sweep: 0.22, dur: 0.24, peak: 0.16, decay: 0.08 }),
);

export const boostNitro: SoundFn = (k, o, t) => max(
  noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 700, f1: 2800, sweep: 0.5, q: 1.3, dur: 0.65, peak: 0.42, a: 0.02 }),
  tone(k, o, t, { wave: 'sawtooth', f0: 90, f1: 190, sweep: 0.5, dur: 0.6, peak: 0.12, lp: 1200 }),
);

export const boostTrick: SoundFn = (k, o, t) => {
  let end = noise(k, o, t, { f0: 800, f1: 3800, sweep: 0.3, q: 1.6, dur: 0.35, peak: 0.2, a: 0.02 });
  [96, 100, 103].forEach((m, i) => { end = max(end, bell(k, o, t + i * 0.045, hz(m), 0.1, 0.13)); });
  return end;
};

export const boostStart: SoundFn = (k, o, t) => max(
  noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 400, f1: 3200, sweep: 0.6, q: 1.2, dur: 0.75, peak: 0.5, a: 0.02 }),
  tone(k, o, t, { wave: 'sawtooth', f0: 110, f1: 340, sweep: 0.6, dur: 0.7, peak: 0.15, lp: 1800 }),
  tone(k, o, t, { wave: 'sine', f0: 80, f1: 45, dur: 0.2, peak: 0.5, decay: 0.08 }),
);

export const boostCoin: SoundFn = (k, o, t) => tone(k, o, t, { wave: 'sine', f0: 2640, dur: 0.1, peak: 0.28, decay: 0.045 });

export const boostRamp: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 220, f1: 700, sweep: 0.2, dur: 0.28, peak: 0.3, vib: [22, 60], decay: 0.1 }),
  noise(k, o, t, { f0: 700, f1: 2800, q: 1.5, dur: 0.3, peak: 0.16, a: 0.02 }),
);

// ───────────── drifting & kart physics ─────────────

const DRIFT_PING = [0, 88, 93, 98]; // E6 (blue) → A6 (orange) → D7 (purple)

export const driftPing: SoundFn = (k, o, t, level) => {
  const m = DRIFT_PING[Math.min(3, Math.max(1, Math.round(level)))]!;
  return max(
    tone(k, o, t, { wave: 'sine', f0: hz(m), dur: 0.3, peak: 0.4, decay: 0.08 }),
    tone(k, o, t, { wave: 'triangle', f0: hz(m + 12), dur: 0.2, peak: 0.12, decay: 0.05 }),
    noise(k, o, t, { filter: 'highpass', f0: 6000, dur: 0.12, peak: 0.16, decay: 0.03 }),
  );
};

export const driftStart: SoundFn = (k, o, t) => noise(k, o, t, { f0: 1700, q: 2.5, dur: 0.12, peak: 0.6, a: 0.005, decay: 0.045 });

export const driftEnd: SoundFn = (k, o, t) => noise(k, o, t, { filter: 'highpass', f0: 3200, dur: 0.14, peak: 0.16, decay: 0.045 });

export const hop: SoundFn = (k, o, t) => tone(k, o, t, { wave: 'sine', f0: 190, f1: 390, sweep: 0.06, dur: 0.08, peak: 0.3, decay: 0.03 });

export const trick: SoundFn = (k, o, t) => max(
  noise(k, o, t, { f0: 600, f1: 3200, sweep: 0.18, q: 2, dur: 0.36, peak: 0.24, a: 0.02, decay: 0.1 }),
  bell(k, o, t + 0.12, hz(96), 0.12, 0.14),
);

export const land: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 115, f1: 45, dur: 0.12, peak: 0.34, decay: 0.045 }),
  noise(k, o, t, { filter: 'lowpass', f0: 500, dur: 0.08, peak: 0.2, decay: 0.03 }),
);

export const landHard: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 125, f1: 40, dur: 0.18, peak: 0.55, decay: 0.07 }),
  noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 900, dur: 0.14, peak: 0.34, decay: 0.05 }),
  fmHit(k, o, t + 0.01, 260, 1.7, 2, 0.07, 0.12),
);

export const wall: SoundFn = (k, o, t, impact) => {
  const lv = 0.25 + 0.75 * clamp01((impact - 3) / 11);
  return max(
    fmHit(k, o, t, 300 + lv * 80, 2.41, 3.5, 0.05 + lv * 0.08, 0.26 * lv),
    noise(k, o, t, { f0: 1900, q: 1.2, dur: 0.1, peak: 0.28 * lv, decay: 0.025 + lv * 0.02 }),
    tone(k, o, t, { wave: 'sine', f0: 110, f1: 55, dur: 0.12, peak: 0.35 * lv, decay: 0.04 }),
  );
};

export const kartBump: SoundFn = (k, o, t, impact) => {
  const lv = 0.3 + 0.7 * clamp01((impact - 1.5) / 7);
  return max(
    tone(k, o, t, { wave: 'sine', f0: 270, f1: 150, dur: 0.12, peak: 0.45 * lv, decay: 0.04 }),
    tone(k, o, t, { wave: 'triangle', f0: 405, f1: 220, dur: 0.1, peak: 0.14 * lv, decay: 0.03 }),
    tone(k, o, t + 0.02, { wave: 'sine', f0: 950, f1: 620, dur: 0.06, peak: 0.07 * lv, decay: 0.02 }),
  );
};

export const coin: SoundFn = (k, o, t, count) => {
  const m = 95 + Math.min(10, Math.max(0, Math.round(count)));
  return max(
    fmHit(k, o, t, hz(m), 2.0, 0.8, 0.05, 0.2, 0.02),
    fmHit(k, o, t + 0.06, hz(m + 5), 2.0, 0.8, 0.12, 0.2, 0.04),
  );
};

export const coinLoss: SoundFn = (k, o, t, count) => {
  const n = Math.min(5, Math.max(1, Math.round(count)));
  let end = t;
  for (let i = 0; i < n; i++) end = max(end, fmHit(k, o, t + i * 0.065, hz(100 - i * 3), 2.0, 0.7, 0.06, 0.32));
  return end;
};

export const explosion: SoundFn = (k, o, t, radius) => {
  const lv = 0.55 + 0.45 * clamp01((radius - 1.5) / 4.5);
  let end = max(
    noise(k, o, t, { color: 'pink', filter: 'lowpass', f0: 3200, f1: 180, sweep: 0.9, q: 0.9, dur: 1.0, peak: 0.7 * lv, decay: 0.22 }),
    tone(k, o, t, { wave: 'sine', f0: 95, f1: 30, sweep: 0.6, dur: 0.7, peak: 0.75 * lv, decay: 0.18 }),
  );
  for (let i = 0; i < 4; i++) {
    end = max(end, noise(k, o, t + 0.08 + i * 0.07 + Math.random() * 0.04, { filter: 'highpass', f0: 2500, dur: 0.03, peak: 0.12 * lv, decay: 0.01 }));
  }
  return end;
};

export const bounce: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'sine', f0: 720, f1: 520, dur: 0.08, peak: 0.3, decay: 0.03 }),
  tone(k, o, t, { wave: 'triangle', f0: 1440, dur: 0.05, peak: 0.06, decay: 0.015 }),
);

export const poof: SoundFn = (k, o, t, kind) => {
  const f = [1300, 1600, 900, 700][Math.max(0, Math.min(3, Math.round(kind)))]!;
  return noise(k, o, t, { f0: f, f1: f * 0.35, q: 0.9, dur: 0.2, peak: 0.45, a: 0.01, decay: 0.06 });
};
