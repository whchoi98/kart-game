/**
 * Pure 2D spatialisation against the nearest listener (split-screen has two).
 * Coordinate convention matches the sim: yaw = 0 faces +Z, right = (-cos yaw, 0, sin yaw).
 */
import type { Listener } from '../contracts.js';

export interface Spatial {
  gain: number;
  pan: number;
  dist: number;
  /** Index of the nearest listener (-1 if none). */
  listener: number;
}

/** Full volume inside this radius (m). */
export const REF_DISTANCE = 8;
/** Silent beyond this distance (m). */
export const MAX_DISTANCE = 110;
/** Sounds quieter than this are skipped entirely. */
export const AUDIBLE_FLOOR = 0.025;

/** Distance gain: inverse law beyond REF_DISTANCE, faded to zero at MAX_DISTANCE. */
export function distanceGain(d: number, ref = REF_DISTANCE, max = MAX_DISTANCE, rolloff = 1.1): number {
  if (!Number.isFinite(d)) return 0;
  if (d <= ref) return 1;
  if (d >= max) return 0;
  const inv = ref / (ref + rolloff * (d - ref));
  const edge = d > max * 0.65 ? (max - d) / (max * 0.35) : 1;
  return inv * edge;
}

/** Spatialise a world point. Writes into `out` (no allocation) and returns it. */
export function spatialize(x: number, z: number, listeners: readonly Listener[], out: Spatial): Spatial {
  if (listeners.length === 0) {
    out.gain = 1; out.pan = 0; out.dist = 0; out.listener = -1;
    return out;
  }
  let best = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < listeners.length; i++) {
    const l = listeners[i]!;
    const dx = x - l.x, dz = z - l.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  const l = listeners[best]!;
  const dx = x - l.x, dz = z - l.z;
  const d = Math.sqrt(bestD2);
  const lateral = dx * -Math.cos(l.yaw) + dz * Math.sin(l.yaw);
  const nearBlend = Math.min(1, d / 6);
  out.dist = d;
  out.listener = best;
  out.gain = distanceGain(d);
  out.pan = d > 0.001 ? Math.max(-1, Math.min(1, lateral / d)) * 0.8 * nearBlend : 0;
  // Split screen: each player hears their own half more centred, so narrow the image.
  if (listeners.length > 1) out.pan *= 0.6;
  return out;
}

export function newSpatial(): Spatial {
  return { gain: 1, pan: 0, dist: 0, listener: -1 };
}
