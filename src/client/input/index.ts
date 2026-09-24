/**
 * InputManager: keyboard + gamepad + touch → KartInput per human player, plus menu
 * navigation events. See src/client/contracts.ts for the contract.
 *
 * Menu handlers receive a third argument `player` (0 or 1): in duo mode it tells which
 * player's keys / pad produced the action (P1 = WASD side / first pad, P2 = arrows side /
 * second pad). In single mode it is always 0.
 */
import type { KartInput } from '../../sim/types.js';
import type { InputManager, MenuAction, Settings } from '../contracts.js';
import {
  DUO_P1_BINDINGS, DUO_P2_BINDINGS, MENU_KEYS, PAD, PAUSE_KEYS, REPEATABLE, SINGLE_BINDINGS,
  SUPPRESS_DEFAULT, type DriveBindings,
} from './bindings.js';
import { axis, btn, connectedPads, padActive, readPadDrive, vibrate } from './gamepad.js';
import { KeyboardState, codeOf, isTextField } from './keyboard.js';
import { RepeatGate, digitalSteerTarget, mergeSteer, rampSteer, stickDirection } from './steering.js';
import { TouchControls } from './touch.js';

export type MenuSource = 'keyboard' | 'gamepad' | 'touch';
export type MenuHandler = (action: MenuAction, source: MenuSource, player?: number) => void;

/** The contract plus UI-only extras (structurally still an `InputManager`). */
export interface TurboInputManager extends InputManager {
  /**
   * Stop auto-accelerate from holding the throttle (race intro / countdown). Holding the
   * throttle from the first countdown tick stalls the engine at GO (START_STALL_BEFORE), so
   * the race screen holds it until the race starts. Throttle pressed by the player still counts.
   */
  holdAutoAccelerate(hold: boolean): void;
}

interface PadMenuState {
  gates: Record<'up' | 'down' | 'left' | 'right', RepeatGate>;
  stick: Record<'up' | 'down' | 'left' | 'right', boolean>;
  prev: Record<number, boolean>;
}

const EDGE_BUTTONS: Array<[number, MenuAction]> = [
  [PAD.A, 'confirm'],
  [PAD.B, 'back'],
  [PAD.SELECT, 'back'],
  [PAD.START, 'pause'],
  [PAD.LB, 'tabPrev'],
  [PAD.RB, 'tabNext'],
];

function neutralInput(): KartInput {
  return { throttle: false, brake: false, steer: 0, drift: false, item: false, back: false };
}

export function createInputManager(): TurboInputManager {
  const kb = new KeyboardState();
  const handlers = new Set<MenuHandler>();
  let mode: 'single' | 'duo' = 'single';
  let autoAccelerate = false;
  let autoHold = false;
  let disposed = false;

  // Ramped digital steering per player: keyboard and D-pad.
  const keySteer = [0, 0];
  const dpadSteer = [0, 0];

  // Touch detection: coarse primary pointer counts as a touch device from the start.
  let touchDetected = false;
  try {
    touchDetected = (navigator.maxTouchPoints ?? 0) > 0 && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    touchDetected = false;
  }
  let lastWasTouch = touchDetected;
  let touchWanted = false;

  const emit = (action: MenuAction, source: MenuSource, player: number) => {
    for (const h of [...handlers]) {
      try {
        h(action, source, player);
      } catch (err) {
        console.error('[input] menu handler failed', err);
      }
    }
  };

  const touch = new TouchControls(() => emit('pause', 'touch', 0));

  const refreshTouch = () => {
    touch.setShown(touchWanted && touchDetected && lastWasTouch);
  };

  // ── keyboard ──

  const onKeyDown = (e: KeyboardEvent) => {
    if (disposed) return;
    const code = codeOf(e);
    // Typing in a text field: every key is text. The field itself handles Enter / Esc
    // (commit and hand focus back to menu navigation).
    if (isTextField(e.target)) return;
    if (e.metaKey || e.altKey) return; // leave OS / browser shortcuts alone
    if (e.ctrlKey && code !== 'ControlLeft' && code !== 'ControlRight' && !SUPPRESS_DEFAULT.has(code)) return;
    if (SUPPRESS_DEFAULT.has(code)) e.preventDefault();
    if (!e.repeat) kb.press(code);
    if (lastWasTouch) {
      lastWasTouch = false;
      refreshTouch();
    }
    const m = MENU_KEYS[code];
    if (m) {
      if (e.repeat && !REPEATABLE.has(m.action)) return;
      emit(m.action, 'keyboard', mode === 'duo' ? m.duoPlayer : 0);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const code = codeOf(e);
    kb.release(code);
    if (SUPPRESS_DEFAULT.has(code) && !isTextField(e.target)) e.preventDefault();
  };

  const clearKeys = () => {
    kb.clear();
    keySteer[0] = keySteer[1] = 0;
    dpadSteer[0] = dpadSteer[1] = 0;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') clearKeys();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const changed = !touchDetected || !lastWasTouch;
      touchDetected = true;
      lastWasTouch = true;
      if (changed) refreshTouch();
    }
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

  // ── gamepad menu polling ──

  const padMenu = new Map<number, PadMenuState>();
  let raf = 0;

  const menuStateFor = (index: number): PadMenuState => {
    let s = padMenu.get(index);
    if (!s) {
      s = {
        gates: { up: new RepeatGate(), down: new RepeatGate(), left: new RepeatGate(), right: new RepeatGate() },
        stick: { up: false, down: false, left: false, right: false },
        prev: {},
      };
      // Buttons already held when the pad appears must not fire.
      padMenu.set(index, s);
    }
    return s;
  };

  const pollPadsForMenu = () => {
    raf = 0;
    if (disposed) return;
    const pads = connectedPads();
    const now = performance.now();
    pads.forEach((gp, order) => {
      const player = mode === 'duo' ? Math.min(order, 1) : 0;
      const fresh = !padMenu.has(gp.index);
      const s = menuStateFor(gp.index);
      if (padActive(gp) && lastWasTouch) {
        lastWasTouch = false;
        refreshTouch();
      }
      const ax = axis(gp, 0);
      const ay = axis(gp, 1);
      s.stick.left = stickDirection(-ax, s.stick.left);
      s.stick.right = stickDirection(ax, s.stick.right);
      s.stick.up = stickDirection(-ay, s.stick.up);
      s.stick.down = stickDirection(ay, s.stick.down);
      const dirs: Array<['up' | 'down' | 'left' | 'right', number]> = [
        ['up', PAD.UP], ['down', PAD.DOWN], ['left', PAD.LEFT], ['right', PAD.RIGHT],
      ];
      for (const [dir, b] of dirs) {
        const active = btn(gp, b) || s.stick[dir];
        if (s.gates[dir].update(active, now) && !fresh) emit(dir, 'gamepad', player);
      }
      for (const [b, action] of EDGE_BUTTONS) {
        const down = btn(gp, b, 0.5);
        const was = s.prev[b] ?? (fresh ? down : false);
        s.prev[b] = down;
        if (down && !was) emit(action, 'gamepad', player);
      }
    });
    // Forget pads that went away.
    for (const idx of [...padMenu.keys()]) if (!pads.some(p => p.index === idx)) padMenu.delete(idx);
    if (pads.length > 0) raf = requestAnimationFrame(pollPadsForMenu);
  };

  const startPadLoop = () => {
    if (!raf && !disposed) raf = requestAnimationFrame(pollPadsForMenu);
  };
  window.addEventListener('gamepadconnected', startPadLoop);
  if (connectedPads().length > 0) startPadLoop();

  // ── race input ──

  const keyboardFor = (player: number): DriveBindings | null => {
    if (mode === 'single') return player === 0 ? SINGLE_BINDINGS : null;
    return player === 0 ? DUO_P1_BINDINGS : player === 1 ? DUO_P2_BINDINGS : null;
  };

  const padsFor = (player: number): Gamepad[] => {
    const pads = connectedPads();
    if (mode === 'single') return player === 0 ? pads : [];
    const gp = pads[player];
    return gp ? [gp] : [];
  };

  const manager: TurboInputManager = {
    poll(player: number, dtSeconds: number): KartInput {
      const out = neutralInput();
      if (disposed || (player !== 0 && player !== 1)) return out;
      const dt = Math.min(0.25, Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0));

      // Keyboard
      const b = keyboardFor(player);
      let keySteerValue = 0;
      if (b) {
        const left = kb.any(b.left);
        const right = kb.any(b.right);
        const target = digitalSteerTarget(left, right, kb.order(b.left), kb.order(b.right));
        keySteer[player] = rampSteer(keySteer[player]!, target, dt);
        keySteerValue = keySteer[player]!;
        out.throttle = kb.any(b.throttle);
        out.brake = kb.any(b.brake);
        out.drift = kb.any(b.drift);
        out.item = kb.any(b.item);
        out.back = kb.any(b.back);
      }

      // Gamepads
      let stick = 0;
      let dpadTarget: -1 | 0 | 1 = 0;
      for (const gp of padsFor(player)) {
        const d = readPadDrive(gp);
        out.throttle ||= d.throttle;
        out.brake ||= d.brake;
        out.drift ||= d.drift;
        out.item ||= d.item;
        out.back ||= d.back;
        stick = mergeSteer(stick, d.stick);
        if (d.dpad !== 0) dpadTarget = d.dpad;
      }
      dpadSteer[player] = rampSteer(dpadSteer[player]!, dpadTarget, dt);

      // Touch (player 1 only)
      let touchSteerValue = 0;
      if (player === 0 && touch.visible) {
        const t = touch.state();
        out.throttle ||= t.throttle;
        out.brake ||= t.brake;
        out.drift ||= t.drift;
        out.item ||= t.item;
        out.back ||= t.back;
        touchSteerValue = t.steer;
      }

      let steer = mergeSteer(keySteerValue, dpadSteer[player]!);
      steer = mergeSteer(steer, stick);
      steer = mergeSteer(steer, touchSteerValue);
      out.steer = Math.max(-1, Math.min(1, steer));

      // Auto-accelerate holds the throttle unless the player is braking / reversing
      // (and not before GO — see holdAutoAccelerate).
      if (autoAccelerate && !autoHold && !out.brake) out.throttle = true;
      return out;
    },

    holdAutoAccelerate(hold: boolean): void {
      autoHold = hold;
    },

    onMenu(handler: MenuHandler): () => void {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },

    setMode(next: 'single' | 'duo'): void {
      if (mode === next) return;
      mode = next;
      keySteer[0] = keySteer[1] = 0;
      dpadSteer[0] = dpadSteer[1] = 0;
    },

    setTouchVisible(visible: boolean): void {
      touchWanted = visible;
      refreshTouch();
    },

    get touchDetected(): boolean {
      return touchDetected;
    },

    rumble(player: number, strength: number, ms: number): void {
      if (disposed) return;
      const pads = padsFor(player);
      for (const gp of pads) vibrate(gp, strength, ms);
      if (pads.length === 0 && player === 0 && touch.visible && strength >= 0.4) {
        try {
          if (typeof navigator.vibrate === 'function') navigator.vibrate(Math.min(120, Math.max(10, ms)));
        } catch { /* ignore */ }
      }
    },

    applySettings(s: Settings): void {
      autoAccelerate = s.autoAccelerate;
      touch.setAutoAccelerate(s.autoAccelerate);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      handlers.clear();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('gamepadconnected', startPadLoop);
      if (raf) cancelAnimationFrame(raf);
      touch.dispose();
    },
  };
  return manager;
}

/** Physical pause keys (Esc / P) — exported for the controls guide. */
export const PAUSE_KEY_CODES = PAUSE_KEYS;
