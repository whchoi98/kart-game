/** Tiny AudioSystem stand-in for the UI preview: short synth blips for UI sounds, silent music. */
import type { AudioSystem, MusicCue, UiSound } from '../contracts.js';

const TONES: Record<UiSound, Array<[number, number]>> = {
  move: [[660, 0.04]],
  select: [[740, 0.05], [990, 0.07]],
  back: [[520, 0.05], [390, 0.07]],
  start: [[523, 0.07], [659, 0.07], [784, 0.12]],
  error: [[220, 0.09], [180, 0.12]],
  toggle: [[880, 0.04]],
  unlock: [[784, 0.08], [988, 0.08], [1319, 0.16]],
};

export function createMockAudio(): AudioSystem & { readonly cue: MusicCue | null } {
  let ctx: AudioContext | null = null;
  let unlocked = false;
  let volume = 0.8 * 0.8;
  let cue: MusicCue | null = null;
  let suspended = false;
  return {
    async unlock() {
      try {
        ctx ??= new AudioContext();
        await ctx.resume();
        unlocked = true;
      } catch { /* preview only */ }
    },
    get unlocked() { return unlocked; },
    get cue() { return cue; },
    setVolumes(v) { volume = v.master * v.sfx; },
    playMusic(c) { cue = c; },
    setFinalLap() { /* no-op */ },
    stopMusic() { cue = null; },
    ui(sound) {
      if (!ctx || !unlocked || suspended || volume <= 0) return;
      let t = ctx.currentTime;
      for (const [f, d] of TONES[sound]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.05 * volume, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + d + 0.01);
        t += d * 0.8;
      }
    },
    handleEvents() { /* no-op */ },
    update() { /* no-op */ },
    suspend() { suspended = true; },
    resume() { suspended = false; },
    stopRace() { /* no-op */ },
  };
}
