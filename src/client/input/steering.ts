/**
 * Pure input shaping: keyboard steering ramp, analog stick response curve and the
 * menu auto-repeat gate. No DOM access (unit tested in test/client/input-steering.test.ts).
 * All functions work on raw floats; quantisation to the sim's 1/63 steps happens later.
 */

/** Keyboard steering reaches full lock in ~0.1 s … */
export const KEY_STEER_RISE = 1 / 0.1;
/** … and springs back to centre (or through it) about twice as fast. */
export const KEY_STEER_RETURN = 1 / 0.045;

/**
 * Move `current` toward `target` (both −1..1). Growing in magnitude uses the rise rate;
 * shrinking or crossing zero uses the (faster) return rate until centre, then rises.
 */
export function rampSteer(
  current: number, target: number, dt: number,
  rise = KEY_STEER_RISE, ret = KEY_STEER_RETURN,
): number {
  if (!(dt > 0)) return current;
  if (current === target) return current;
  const cur = clamp1(current);
  const tgt = clamp1(target);
  if (cur !== 0 && Math.sign(cur) !== Math.sign(tgt)) {
    // Head back toward centre first (target is on the other side or at zero).
    const toZero = Math.abs(cur) / ret;
    if (dt <= toZero) return cur - Math.sign(cur) * ret * dt;
    if (tgt === 0) return 0;
    const left = dt - toZero;
    return Math.sign(tgt) * Math.min(Math.abs(tgt), rise * left);
  }
  // Same side (or starting from centre).
  const mag = Math.abs(cur);
  const want = Math.abs(tgt);
  const sign = Math.sign(tgt) || Math.sign(cur);
  if (want > mag) return sign * Math.min(want, mag + rise * dt);
  return sign * Math.max(want, mag - ret * dt);
}

/** Last-pressed-wins resolution of opposing digital directions. */
export function digitalSteerTarget(left: boolean, right: boolean, leftOrder: number, rightOrder: number): -1 | 0 | 1 {
  if (left && right) return rightOrder > leftOrder ? 1 : -1;
  if (left) return -1;
  if (right) return 1;
  return 0;
}

export interface StickCurve {
  /** Inner radius treated as zero. */
  deadzone: number;
  /** Magnitude treated as full deflection (worn sticks rarely reach 1.0). */
  outer: number;
  /** Response exponent (> 1 = finer control near centre). */
  exponent: number;
  /** Blend of linear response mixed into the curve (0..1) to avoid a dead-feeling middle. */
  linear: number;
}

export const DEFAULT_STICK: StickCurve = { deadzone: 0.14, outer: 0.94, exponent: 1.8, linear: 0.3 };

/** Shape one analog axis value (−1..1) with deadzone rescaling and a response curve. */
export function shapeAxis(v: number, curve: StickCurve = DEFAULT_STICK): number {
  if (!Number.isFinite(v)) return 0;
  const m = Math.abs(v);
  if (m <= curve.deadzone) return 0;
  const n = Math.min(1, (m - curve.deadzone) / Math.max(1e-6, curve.outer - curve.deadzone));
  const shaped = curve.linear * n + (1 - curve.linear) * Math.pow(n, curve.exponent);
  return Math.sign(v) * Math.min(1, shaped);
}

/** Combine two steering sources: the one with the larger magnitude wins. */
export function mergeSteer(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

/** Touch thumb-stick: horizontal drag distance → steer with a small deadzone and gentle curve. */
export function touchSteer(dx: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const n = clamp1(dx / radius);
  const m = Math.abs(n);
  const dz = 0.08;
  if (m <= dz) return 0;
  return Math.sign(n) * Math.pow((m - dz) / (1 - dz), 1.25);
}

/**
 * Auto-repeat gate for held menu directions: fires on press, again after `delay` ms,
 * then every `interval` ms (speeding up to `fastInterval` after a few repeats).
 */
export class RepeatGate {
  private held = false;
  private nextAt = 0;
  private repeats = 0;
  constructor(
    private readonly delay = 380,
    private readonly interval = 120,
    private readonly fastInterval = 70,
    private readonly fastAfter = 5,
  ) {}

  /** Returns true when an action should be emitted at time `now` (ms). */
  update(active: boolean, now: number): boolean {
    if (!active) {
      this.held = false;
      this.repeats = 0;
      return false;
    }
    if (!this.held) {
      this.held = true;
      this.repeats = 0;
      this.nextAt = now + this.delay;
      return true;
    }
    if (now >= this.nextAt) {
      this.repeats++;
      this.nextAt = now + (this.repeats >= this.fastAfter ? this.fastInterval : this.interval);
      return true;
    }
    return false;
  }

  reset(): void {
    this.held = false;
    this.repeats = 0;
  }
}

/** Analog threshold with hysteresis so a stick hovering at the edge doesn't chatter. */
export function stickDirection(value: number, wasActive: boolean, on = 0.55, off = 0.35): boolean {
  return wasActive ? Math.abs(value) > off : Math.abs(value) > on;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
