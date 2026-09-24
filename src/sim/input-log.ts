/**
 * Input quantisation and compact logs.
 *
 * Every human input is quantised before it reaches the simulation, so a live
 * race and a replay of its recorded log are bit-identical. One 16-bit word per
 * tick:  bits 0-6 steer (+63 offset, 0..126), 7 throttle, 8 brake, 9 drift,
 * 10 item, 11 back. Logs are run-length encoded as (word, count) uint16 pairs
 * and base64 encoded.
 */
import type { KartInput } from './types.js';

export const STEER_STEPS = 63;
export const NEUTRAL_INPUT: KartInput = Object.freeze({ throttle: false, brake: false, steer: 0, drift: false, item: false, back: false });

export function encodeInputWord(i: KartInput): number {
  let s = Math.round((i.steer > 1 ? 1 : i.steer < -1 ? -1 : i.steer) * STEER_STEPS);
  if (!(s >= -STEER_STEPS && s <= STEER_STEPS)) s = 0; // NaN guard
  return ((s + STEER_STEPS) & 0x7f)
    | (i.throttle ? 1 << 7 : 0)
    | (i.brake ? 1 << 8 : 0)
    | (i.drift ? 1 << 9 : 0)
    | (i.item ? 1 << 10 : 0)
    | (i.back ? 1 << 11 : 0);
}

export function decodeInputWord(w: number): KartInput {
  const raw = (w & 0x7f) - STEER_STEPS;
  const s = raw > STEER_STEPS ? STEER_STEPS : raw;
  return {
    steer: s / STEER_STEPS,
    throttle: (w & (1 << 7)) !== 0,
    brake: (w & (1 << 8)) !== 0,
    drift: (w & (1 << 9)) !== 0,
    item: (w & (1 << 10)) !== 0,
    back: (w & (1 << 11)) !== 0,
  };
}

export function quantizeInput(i: KartInput): KartInput {
  return decodeInputWord(encodeInputWord(i));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new Error('bad base64 length');
  let pad = 0;
  if (s.endsWith('==')) pad = 2; else if (s.endsWith('=')) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map(k => {
      const ch = s.charCodeAt(i + k);
      if (ch === 61 /* = */) return 0;
      const v = ch < 128 ? B64_INV[ch]! : -1;
      if (v < 0) throw new Error('bad base64 character');
      return v;
    });
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Records one quantised word per tick and encodes the run-length log. */
export class InputRecorder {
  private runs: number[] = [];
  private last = -1;
  private count = 0;
  private total = 0;

  push(i: KartInput): void {
    const w = encodeInputWord(i);
    this.total++;
    if (w === this.last && this.count < 0xffff) { this.count++; return; }
    if (this.count > 0) this.runs.push(this.last, this.count);
    this.last = w;
    this.count = 1;
  }

  get length(): number { return this.total; }

  encode(): string {
    const runs = this.count > 0 ? [...this.runs, this.last, this.count] : this.runs;
    const bytes = new Uint8Array(runs.length * 2 + 2);
    bytes[0] = 1; // format version
    bytes[1] = 0;
    for (let k = 0; k < runs.length; k++) {
      bytes[2 + k * 2] = runs[k]! & 255;
      bytes[3 + k * 2] = (runs[k]! >> 8) & 255;
    }
    return bytesToBase64(bytes);
  }
}

/** Decode to one word per tick. Throws on malformed input or > maxTicks. */
export function decodeLog(s: string, maxTicks = 60 * 60 * 15): Uint16Array {
  if (typeof s !== 'string' || s.length === 0) throw new Error('empty log');
  const bytes = base64ToBytes(s);
  if (bytes.length < 2 || bytes[0] !== 1 || (bytes.length - 2) % 4 !== 0) throw new Error('bad log header');
  let total = 0;
  for (let p = 2; p < bytes.length; p += 4) {
    const count = bytes[p + 2]! | (bytes[p + 3]! << 8);
    if (count === 0) throw new Error('zero-length run');
    total += count;
    if (total > maxTicks) throw new Error('log too long');
  }
  if (total === 0) throw new Error('empty log');
  const out = new Uint16Array(total);
  let o = 0;
  for (let p = 2; p < bytes.length; p += 4) {
    const w = bytes[p]! | (bytes[p + 1]! << 8);
    if (w > 0xfff) throw new Error('bad input word');
    const count = bytes[p + 2]! | (bytes[p + 3]! << 8);
    out.fill(w, o, o + count);
    o += count;
  }
  return out;
}
