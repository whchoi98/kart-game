/**
 * Deterministic math for the shared simulation.
 *
 * ECMAScript only requires +, -, *, /, Math.sqrt (and floor/abs/min/max/sign)
 * to be exactly IEEE-754 rounded. Math.sin/cos/atan2/exp/pow are
 * "implementation-approximated" and differ between V8, SpiderMonkey and
 * JavaScriptCore. The server re-simulates time-trial runs, so the simulation
 * must never call those. Everything here is built from exact operations only.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  if (a > PI || a <= -PI) {
    a = a - TAU * Math.floor((a + PI) / TAU);
    if (a <= -PI) a += TAU;
  }
  return a;
}

// Minimax-style Taylor polynomial on [-PI/4, PI/4] after octant reduction.
function sinPoly(x: number): number {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800))))));
}
function cosPoly(x: number): number {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600))))));
}

const QUARTER_PI = 0.7853981633974483;

export function dsin(a: number): number {
  const x = wrapAngle(a);
  // reduce to quadrant k and remainder r in [-PI/4, PI/4]
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * HALF_PI;
  switch (((k % 4) + 4) % 4) {
    case 0: return sinPoly(r);
    case 1: return cosPoly(r);
    case 2: return -sinPoly(r);
    default: return -cosPoly(r);
  }
}

export function dcos(a: number): number {
  const x = wrapAngle(a);
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * HALF_PI;
  switch (((k % 4) + 4) % 4) {
    case 0: return cosPoly(r);
    case 1: return -sinPoly(r);
    case 2: return -cosPoly(r);
    default: return sinPoly(r);
  }
}

/** atan on [0, 1] via argument halving + series (accurate to ~1e-15). */
function atanUnit(x: number): number {
  // reduce: atan(x) = 2 * atan(x / (1 + sqrt(1 + x^2)))  (twice → |x| <= tan(PI/16))
  let y = x / (1 + Math.sqrt(1 + x * x));
  y = y / (1 + Math.sqrt(1 + y * y));
  const y2 = y * y;
  // series up to y^19 — |y| <= 0.199 so error < 1e-15
  let term = y;
  let sum = y;
  for (let n = 1; n <= 9; n++) {
    term *= -y2;
    sum += term / (2 * n + 1);
  }
  return 4 * sum;
}

export function datan(x: number): number {
  if (x !== x) return x;
  const neg = x < 0;
  let ax = neg ? -x : x;
  let r: number;
  if (ax <= 1) r = atanUnit(ax);
  else r = HALF_PI - atanUnit(1 / ax);
  return neg ? -r : r;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  return y > 0 ? HALF_PI : -HALF_PI;
}

/** e^x for |x| <= ~50, via range reduction by powers of two and series. */
export function dexp(x: number): number {
  if (x === 0) return 1;
  // e^x = (e^(x/2^k))^(2^k)
  let k = 0;
  let r = x;
  while (r > 0.5 || r < -0.5) { r /= 2; k++; }
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 14; n++) {
    term *= r / n;
    sum += term;
  }
  for (let i = 0; i < k; i++) sum *= sum;
  return sum;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const hypot2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);
export const hypot3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

/** Move `v` toward `target` by at most `step`. */
export function approach(v: number, target: number, step: number): number {
  if (v < target) return v + step > target ? target : v + step;
  if (v > target) return v - step < target ? target : v - step;
  return v;
}

/** Frame-rate independent damping factor for rate `k` over `dt` (deterministic). */
export function damp(k: number, dt: number): number {
  return dexp(-k * dt);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
