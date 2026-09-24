/**
 * Race sound library, part 2: race flow (countdown, laps, finish), feedback cues,
 * hazards (thunder, ink, falls) and the menu UI sounds.
 */
import type { UiSound } from '../contracts.js';
import type { Kit, Out } from './sfx-lib.js';
import { bell, fmHit, hz, noise, tone } from './sfx-lib.js';
import type { SoundFn } from './sfx-race.js';

const max = Math.max;

// ───────────── race flow ─────────────

export const countBeep: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'pulse25', f0: hz(69), dur: 0.2, peak: 0.24, lp: 3500 }),
  tone(k, o, t, { wave: 'sine', f0: hz(57), dur: 0.2, peak: 0.2 }),
);

export const countGo: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'pulse25', f0: hz(81), dur: 0.62, peak: 0.24, lp: 5000, vib: [6, 10] }),
  tone(k, o, t, { wave: 'square', f0: hz(88), dur: 0.62, peak: 0.08, lp: 4000 }),
  tone(k, o, t, { wave: 'sine', f0: hz(69), dur: 0.62, peak: 0.2 }),
  noise(k, o, t, { filter: 'highpass', f0: 5000, dur: 0.3, peak: 0.08, decay: 0.1 }),
);

export const lapChime: SoundFn = (k, o, t) => {
  let end = t;
  [88, 92, 95, 100].forEach((m, i) => { end = max(end, bell(k, o, t + i * 0.085, hz(m), 0.2, 0.2)); });
  return end;
};

/** Short riser under the music sting (the sting itself is played by the sequencer). */
export const finalLap: SoundFn = (k, o, t) => noise(k, o, t, { f0: 400, f1: 5000, sweep: 0.45, q: 1.4, dur: 0.5, peak: 0.12, a: 0.3 });

const FANFARE_TOP: ReadonlyArray<readonly [number, number, number]> = [
  // [midi, offset s, length s]
  [72, 0, 0.12], [76, 0.13, 0.12], [79, 0.26, 0.12], [84, 0.39, 0.9],
];

export const finishFanfare: SoundFn = (k, o, t, position) => {
  let end = t;
  if (position <= 1) {
    for (const [m, off, len] of FANFARE_TOP) {
      end = max(end, tone(k, o, t + off, { wave: 'sawtooth', f0: hz(m), dur: len, peak: 0.12, lp: 3000, a: 0.02, vib: len > 0.3 ? [5.5, 14] : undefined }));
      end = max(end, tone(k, o, t + off, { wave: 'pulse25', f0: hz(m - 12), dur: len, peak: 0.1 }));
    }
    for (const m of [76, 79, 88]) end = max(end, tone(k, o, t + 0.39, { wave: 'triangle', f0: hz(m), dur: 0.9, peak: 0.1, a: 0.03 }));
    end = max(end, noise(k, o, t + 0.39, { filter: 'highpass', f0: 4500, dur: 1.2, peak: 0.12, decay: 0.3 }));
  } else if (position <= 3) {
    [[72, 0], [76, 0.12], [79, 0.24]].forEach(([m, off]) => {
      end = max(end, tone(k, o, t + off!, { wave: 'pulse25', f0: hz(m!), dur: 0.11, peak: 0.18 }));
    });
    for (const m of [72, 76, 79, 84]) end = max(end, tone(k, o, t + 0.36, { wave: 'triangle', f0: hz(m), dur: 0.7, peak: 0.1, a: 0.02 }));
  } else {
    [[67, 0], [72, 0.16], [76, 0.32]].forEach(([m, off]) => {
      end = max(end, tone(k, o, t + off!, { wave: 'triangle', f0: hz(m!), dur: 0.15, peak: 0.2 }));
    });
    end = max(end, bell(k, o, t + 0.48, hz(84), 0.3, 0.16));
  }
  return end;
};

export const finishCpu: SoundFn = (k, o, t) => max(
  noise(k, o, t, { f0: 900, f1: 2600, q: 1.2, dur: 0.25, peak: 0.12, a: 0.02 }),
  bell(k, o, t + 0.05, hz(91), 0.12, 0.08),
);

export const raceDone: SoundFn = (k, o, t) => {
  let end = t;
  [84, 91, 100].forEach((m, i) => { end = max(end, bell(k, o, t + i * 0.12, hz(m), 0.35, 0.12)); });
  return end;
};

// ───────────── items & feedback ─────────────

export const itemBox: SoundFn = (k, o, t) => {
  let end = max(
    tone(k, o, t, { wave: 'sine', f0: 520, f1: 1500, sweep: 0.06, dur: 0.08, peak: 0.45, decay: 0.035 }),
    noise(k, o, t, { filter: 'highpass', f0: 3500, dur: 0.05, peak: 0.24, decay: 0.012 }),
  );
  for (let i = 0; i < 3; i++) {
    end = max(end, tone(k, o, t + 0.03 + i * 0.04, { wave: 'sine', f0: 2200 + Math.random() * 2000, dur: 0.06, peak: 0.11, decay: 0.02 }));
  }
  return end;
};

export const itemGet: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'pulse25', f0: hz(91), dur: 0.08, peak: 0.16 }),
  tone(k, o, t + 0.09, { wave: 'pulse25', f0: hz(96), dur: 0.2, peak: 0.16, decay: 0.08 }),
  bell(k, o, t + 0.09, hz(103), 0.15, 0.08),
);

const TICK_NOTES = [91, 93, 95, 96];
export const rouletteTick: SoundFn = (k, o, t, idx) =>
  tone(k, o, t, { wave: 'square', f0: hz(TICK_NOTES[Math.abs(Math.round(idx)) % 4]!), dur: 0.03, peak: 0.16, decay: 0.016, lp: 5000 });

export const posUp: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'triangle', f0: hz(84), dur: 0.05, peak: 0.16, decay: 0.03 }),
  tone(k, o, t + 0.06, { wave: 'triangle', f0: hz(91), dur: 0.08, peak: 0.16, decay: 0.04 }),
);

export const posDown: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'triangle', f0: hz(79), dur: 0.05, peak: 0.13, decay: 0.03 }),
  tone(k, o, t + 0.06, { wave: 'triangle', f0: hz(72), dur: 0.08, peak: 0.13, decay: 0.04 }),
);

export const startPerfect: SoundFn = (k, o, t) => {
  let end = noise(k, o, t, { f0: 600, f1: 5000, sweep: 0.3, q: 1.3, dur: 0.35, peak: 0.16, a: 0.01 });
  [84, 88, 91, 96].forEach((m, i) => { end = max(end, tone(k, o, t + i * 0.04, { wave: 'pulse25', f0: hz(m), dur: 0.14, peak: 0.12, decay: 0.07 })); });
  return max(end, bell(k, o, t + 0.16, hz(100), 0.3, 0.12));
};

export const startGood: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'pulse25', f0: hz(91), dur: 0.07, peak: 0.18, decay: 0.04 }),
  tone(k, o, t + 0.07, { wave: 'pulse25', f0: hz(96), dur: 0.12, peak: 0.18, decay: 0.06 }),
);

export const stall: SoundFn = (k, o, t) => {
  let end = t;
  for (const off of [0, 0.15, 0.24, 0.43]) {
    end = max(end,
      noise(k, o, t + off, { color: 'brown', filter: 'lowpass', f0: 600, dur: 0.07, peak: 0.4, decay: 0.03 }),
      tone(k, o, t + off, { wave: 'square', f0: 58, f1: 40, dur: 0.07, peak: 0.1, decay: 0.03, lp: 500 }));
  }
  return max(end, fmHit(k, o, t + 0.55, 180, 1.6, 1.8, 0.06, 0.14));
};

export const wrongWay: SoundFn = (k, o, t) => {
  let end = t;
  for (let i = 0; i < 4; i++) {
    end = max(end, tone(k, o, t + i * 0.17, { wave: 'square', f0: i % 2 === 0 ? 880 : 660, dur: 0.15, peak: 0.1, lp: 2800 }));
  }
  return end;
};

export const wrongWayOff: SoundFn = (k, o, t) => max(
  tone(k, o, t, { wave: 'triangle', f0: 660, dur: 0.06, peak: 0.12, decay: 0.03 }),
  tone(k, o, t + 0.07, { wave: 'triangle', f0: 880, dur: 0.1, peak: 0.12, decay: 0.05 }),
);

// ───────────── hazards ─────────────

export const thunderCrack: SoundFn = (k, o, t) => max(
  noise(k, o, t, { filter: 'highpass', f0: 1500, dur: 0.1, peak: 0.6, a: 0.001, decay: 0.03 }),
  noise(k, o, t + 0.02, { filter: 'bandpass', f0: 2500, f1: 600, q: 0.7, dur: 0.4, peak: 0.3, decay: 0.1 }),
  noise(k, o, t + 0.05, { color: 'brown', filter: 'lowpass', f0: 380, q: 0.8, dur: 1.8, peak: 0.75, a: 0.06, decay: 0.45 }),
  tone(k, o, t + 0.04, { wave: 'sine', f0: 58, f1: 32, sweep: 0.9, dur: 1, peak: 0.55, decay: 0.3 }),
);

export const inkSplat: SoundFn = (k, o, t, humanHit) => {
  const lv = humanHit > 0 ? 1 : 0.45;
  return max(
    noise(k, o, t, { filter: 'lowpass', f0: 2600, f1: 260, sweep: 0.3, q: 5, dur: 0.35, peak: 0.4 * lv, decay: 0.1 }),
    tone(k, o, t, { wave: 'sine', f0: 240, f1: 80, dur: 0.25, peak: 0.4 * lv, vib: [24, 200], decay: 0.08 }),
    noise(k, o, t + 0.09, { filter: 'lowpass', f0: 1200, f1: 400, q: 6, dur: 0.18, peak: 0.2 * lv, decay: 0.05 }),
  );
};

export const fallWhistle: SoundFn = (k, o, t) => tone(k, o, t, { wave: 'sine', f0: 1450, f1: 210, sweep: 1.1, dur: 1.15, peak: 0.22, vib: [7, 25], a: 0.02 });

export const respawn: SoundFn = (k, o, t) => {
  const v = tone(k, o, t, { wave: 'sawtooth', f0: 100, f1: 130, sweep: 0.5, dur: 0.55, peak: 0.08, lp: 1100, vib: [28, 120], a: 0.05 });
  return max(v, tone(k, o, t + 0.5, { wave: 'sine', f0: 420, f1: 180, dur: 0.12, peak: 0.26, decay: 0.04 }));
};

// ───────────── UI ─────────────

type UiFn = (k: Kit, o: Out, t: number) => number;

export const UI_SOUNDS: Record<UiSound, UiFn> = {
  move: (k, o, t) => tone(k, o, t, { wave: 'triangle', f0: 1320, dur: 0.035, peak: 0.3, decay: 0.018 }),
  select: (k, o, t) => max(
    tone(k, o, t, { wave: 'pulse25', f0: hz(88), dur: 0.05, peak: 0.12, decay: 0.03 }),
    tone(k, o, t + 0.05, { wave: 'pulse25', f0: hz(95), dur: 0.09, peak: 0.12, decay: 0.05 }),
  ),
  back: (k, o, t) => max(
    tone(k, o, t, { wave: 'pulse25', f0: hz(83), dur: 0.05, peak: 0.11, decay: 0.03 }),
    tone(k, o, t + 0.05, { wave: 'pulse25', f0: hz(76), dur: 0.08, peak: 0.11, decay: 0.05 }),
  ),
  start: (k, o, t) => {
    let end = noise(k, o, t, { f0: 800, f1: 5000, sweep: 0.3, q: 1.2, dur: 0.35, peak: 0.1, a: 0.02 });
    [84, 88, 91, 96].forEach((m, i) => { end = max(end, tone(k, o, t + i * 0.06, { wave: 'pulse25', f0: hz(m), dur: 0.16, peak: 0.13, decay: 0.09 })); });
    return max(end, bell(k, o, t + 0.24, hz(100), 0.3, 0.1));
  },
  error: (k, o, t) => max(
    tone(k, o, t, { wave: 'square', f0: 180, dur: 0.09, peak: 0.1, lp: 1500 }),
    tone(k, o, t + 0.12, { wave: 'square', f0: 150, dur: 0.12, peak: 0.1, lp: 1500 }),
  ),
  toggle: (k, o, t) => max(
    tone(k, o, t, { wave: 'sine', f0: 2000, dur: 0.02, peak: 0.2, decay: 0.01 }),
    tone(k, o, t + 0.03, { wave: 'sine', f0: 1500, dur: 0.03, peak: 0.17, decay: 0.014 }),
  ),
  unlock: (k, o, t) => {
    let end = t;
    [84, 88, 91, 95, 100].forEach((m, i) => { end = max(end, bell(k, o, t + i * 0.07, hz(m), 0.25, 0.12)); });
    return max(end, noise(k, o, t, { filter: 'highpass', f0: 6000, dur: 0.6, peak: 0.06, a: 0.2 }));
  },
};
