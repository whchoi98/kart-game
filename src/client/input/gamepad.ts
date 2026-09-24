/** Gamepad helpers (standard mapping). */
import { PAD } from './bindings.js';
import { DEFAULT_STICK, shapeAxis } from './steering.js';

/** Connected pads ordered by index: the first drives P1, the second P2. */
export function connectedPads(): Gamepad[] {
  let list: ReadonlyArray<Gamepad | null> = [];
  try {
    list = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  } catch {
    list = [];
  }
  const out: Gamepad[] = [];
  for (const gp of list) if (gp && gp.connected) out.push(gp);
  out.sort((a, b) => a.index - b.index);
  return out;
}

export function btn(gp: Gamepad, i: number, threshold = 0.35): boolean {
  const b = gp.buttons[i];
  if (!b) return false;
  return b.pressed || b.value > threshold;
}

export function axis(gp: Gamepad, i: number): number {
  const v = gp.axes[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface PadDrive {
  throttle: boolean;
  brake: boolean;
  drift: boolean;
  item: boolean;
  back: boolean;
  /** Shaped analog stick steer (−1..1). */
  stick: number;
  /** D-pad digital direction (ramped by the caller). */
  dpad: -1 | 0 | 1;
}

export function readPadDrive(gp: Gamepad): PadDrive {
  const left = btn(gp, PAD.LEFT);
  const right = btn(gp, PAD.RIGHT);
  return {
    throttle: btn(gp, PAD.A),
    brake: btn(gp, PAD.B),
    drift: btn(gp, PAD.RB) || btn(gp, PAD.RT, 0.3),
    item: btn(gp, PAD.LB) || btn(gp, PAD.LT, 0.3),
    back: btn(gp, PAD.X) || btn(gp, PAD.Y),
    stick: shapeAxis(axis(gp, 0), DEFAULT_STICK),
    dpad: left === right ? 0 : left ? -1 : 1,
  };
}

/** Any meaningful activity on the pad (used to decide which input the player is on). */
export function padActive(gp: Gamepad): boolean {
  for (let i = 0; i < gp.buttons.length; i++) if (btn(gp, i, 0.5)) return true;
  return Math.abs(axis(gp, 0)) > 0.5 || Math.abs(axis(gp, 1)) > 0.5;
}

interface HapticLike {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
  pulse?: (value: number, duration: number) => Promise<unknown>;
}

export function vibrate(gp: Gamepad, strength: number, ms: number): void {
  const s = Math.max(0, Math.min(1, strength));
  const duration = Math.max(0, Math.min(5000, ms));
  if (s <= 0 || duration <= 0) return;
  try {
    const act = (gp as unknown as { vibrationActuator?: HapticLike | null }).vibrationActuator;
    if (act && typeof act.playEffect === 'function') {
      act.playEffect('dual-rumble', { startDelay: 0, duration, strongMagnitude: s, weakMagnitude: Math.min(1, s * 0.75 + 0.1) })
        .catch(() => undefined);
      return;
    }
    const hap = (gp as unknown as { hapticActuators?: HapticLike[] }).hapticActuators;
    const first = hap && hap[0];
    if (first && typeof first.pulse === 'function') first.pulse(s, duration).catch(() => undefined);
  } catch {
    /* haptics are best-effort */
  }
}
