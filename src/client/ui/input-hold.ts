/**
 * Input hold for screens that appear as the result of a button press (race results, podium).
 * A player still mashing A / Enter from the previous screen — or drifting with Space, which is
 * also "confirm" — must not fire the new screen's focused button in the same breath (e.g. skip
 * the whole GP podium ceremony with one extra press). Pure logic, no DOM (unit tested).
 */
import type { MenuAction } from '../contracts.js';

const HELD: ReadonlySet<MenuAction> = new Set<MenuAction>(['confirm', 'back', 'pause']);

export class InputHold {
  private until = -Infinity;

  /** Swallow confirm / back / pause for `ms` from `now`. */
  arm(ms: number, now: number = performance.now()): void {
    this.until = now + Math.max(0, ms);
  }

  /** True when `action` must be ignored right now. Movement is never held. */
  blocks(action: MenuAction, now: number = performance.now()): boolean {
    return HELD.has(action) && now < this.until;
  }
}
