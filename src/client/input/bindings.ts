/**
 * Key bindings (KeyboardEvent.code, i.e. physical keys — layout independent, so
 * Korean 2-beolsik IME users get the same positions as QWERTY users).
 */
import type { MenuAction } from '../contracts.js';

export type DriveAction = 'left' | 'right' | 'throttle' | 'brake' | 'drift' | 'item' | 'back';

export type DriveBindings = Record<DriveAction, readonly string[]>;

/** Single player: every binding drives player 1. */
export const SINGLE_BINDINGS: DriveBindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight'],
  // Right Ctrl only: Left Ctrl + W (throttle) is the browser's un-cancellable "close tab".
  item: ['KeyE', 'KeyZ', 'ControlRight'],
  back: ['KeyQ', 'KeyC'],
};

/** Split keyboard: player 1 on the left hand side. */
export const DUO_P1_BINDINGS: DriveBindings = {
  left: ['KeyA'],
  right: ['KeyD'],
  throttle: ['KeyW'],
  brake: ['KeyS'],
  drift: ['ShiftLeft'],
  item: ['KeyE'],
  back: ['KeyQ'],
};

/** Split keyboard: player 2 on the arrows / numpad side. */
export const DUO_P2_BINDINGS: DriveBindings = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  throttle: ['ArrowUp'],
  brake: ['ArrowDown'],
  drift: ['ShiftRight', 'Numpad0', 'Slash'],
  item: ['Enter', 'NumpadEnter', 'Numpad1', 'Period'],
  back: ['ControlRight', 'Comma'],
};

export const PAUSE_KEYS: readonly string[] = ['Escape', 'KeyP'];

/** Menu mapping: code → action + which duo player owns the key (single mode: always 0). */
export const MENU_KEYS: Readonly<Record<string, { action: MenuAction; duoPlayer: 0 | 1 }>> = {
  ArrowUp: { action: 'up', duoPlayer: 1 },
  ArrowDown: { action: 'down', duoPlayer: 1 },
  ArrowLeft: { action: 'left', duoPlayer: 1 },
  ArrowRight: { action: 'right', duoPlayer: 1 },
  KeyW: { action: 'up', duoPlayer: 0 },
  KeyS: { action: 'down', duoPlayer: 0 },
  KeyA: { action: 'left', duoPlayer: 0 },
  KeyD: { action: 'right', duoPlayer: 0 },
  Enter: { action: 'confirm', duoPlayer: 1 },
  NumpadEnter: { action: 'confirm', duoPlayer: 1 },
  Space: { action: 'confirm', duoPlayer: 0 },
  Escape: { action: 'back', duoPlayer: 0 },
  Backspace: { action: 'back', duoPlayer: 1 },
  KeyP: { action: 'pause', duoPlayer: 0 },
  KeyQ: { action: 'tabPrev', duoPlayer: 0 },
  KeyE: { action: 'tabNext', duoPlayer: 0 },
  PageUp: { action: 'tabPrev', duoPlayer: 1 },
  PageDown: { action: 'tabNext', duoPlayer: 1 },
};

/** Keys whose browser default (scrolling, button activation, find-as-you-type) we suppress. */
export const SUPPRESS_DEFAULT = new Set<string>([
  ...Object.keys(MENU_KEYS),
  ...Object.values(SINGLE_BINDINGS).flat(),
  ...Object.values(DUO_P2_BINDINGS).flat(),
]);

/** Keys that repeat while held in menus (directions only). */
export const REPEATABLE: ReadonlySet<MenuAction> = new Set<MenuAction>(['up', 'down', 'left', 'right']);

/** Standard-mapping gamepad button indices. */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;
