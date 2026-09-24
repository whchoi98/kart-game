/**
 * TURBO PALS GRAND PRIX — procedural audio.
 *
 * Pure WebAudio synthesis (no asset files): chiptune/pop music sequencer with one original
 * song per track and menu cue, spatialised race SFX for every sim event, and continuous
 * engine/drift/boost layers. In environments without WebAudio a silent implementation is
 * returned so callers never need to guard.
 */
import type { AudioSystem } from '../contracts.js';
import { getAudioContextCtor } from './context.js';
import { SilentAudioSystem } from './noop.js';
import { WebAudioSystem } from './system.js';

export function createAudioSystem(): AudioSystem {
  try {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return new SilentAudioSystem();
    return new WebAudioSystem(Ctor);
  } catch {
    return new SilentAudioSystem();
  }
}

export { SilentAudioSystem } from './noop.js';
