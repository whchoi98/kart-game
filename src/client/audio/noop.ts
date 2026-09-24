/**
 * Silent AudioSystem used where WebAudio is unavailable (Node/vitest, locked-down
 * browsers) or failed to start. Every method is safe to call and does nothing audible.
 */
import type { AudioSystem, Listener, MusicCue, UiSound } from '../contracts.js';
import type { KartState, RaceEvent } from '../../sim/types.js';

export class SilentAudioSystem implements AudioSystem {
  private isUnlocked = false;
  private cue: string | null = null;
  private finalLap = false;

  get unlocked(): boolean { return this.isUnlocked; }

  /** Current requested cue (useful for tests and debugging). */
  get currentCue(): string | null { return this.cue; }
  get finalLapActive(): boolean { return this.finalLap; }

  unlock(): Promise<void> {
    this.isUnlocked = true;
    return Promise.resolve();
  }

  setVolumes(_v: { master: number; music: number; sfx: number }): void { /* silent */ }
  playMusic(cue: MusicCue): void { this.cue = cue; }
  setFinalLap(on: boolean): void { this.finalLap = on; }
  stopMusic(_fadeSeconds?: number): void { this.cue = null; this.finalLap = false; }
  ui(_sound: UiSound): void { /* silent */ }
  handleEvents(_events: readonly RaceEvent[], _karts: readonly KartState[], _humanKarts: readonly number[]): void { /* silent */ }
  update(_karts: readonly KartState[], _listeners: readonly Listener[], _humanKarts: readonly number[], _dt: number): void { /* silent */ }
  suspend(): void { /* silent */ }
  resume(): void { /* silent */ }
  stopRace(): void { this.finalLap = false; }
}
