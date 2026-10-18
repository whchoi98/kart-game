# Input Module

## Role
Turns keyboard, gamepad and touch into one `KartInput` per human player (`poll`) and into menu actions (`onMenu`).
Implements the `InputManager` contract (`src/client/contracts.ts`) plus `holdAutoAccelerate` (`TurboInputManager`).

## Key Files
- `bindings.ts`: `KeyboardEvent.code` tables: `SINGLE_BINDINGS`, `DUO_P1_BINDINGS`, `DUO_P2_BINDINGS`, `PAUSE_KEYS`, `MENU_KEYS`
  (`{action, duoPlayer}`), derived `SUPPRESS_DEFAULT`, `REPEATABLE` (directions only), `PAD` (standard-mapping indices).
- `keyboard.ts`: `KeyboardState` (held keys with press order), `codeOf` (fills an empty `code` from `key` for virtual
  keyboards), `isTextField`.
- `gamepad.ts`: `connectedPads` (sorted by index), `btn` (threshold 0.35), `axis`, `readPadDrive`, `padActive` (0.5), `vibrate`.
- `steering.ts`: pure shaping, no DOM: `rampSteer`, `digitalSteerTarget`, `shapeAxis`/`DEFAULT_STICK`, `mergeSteer`,
  `touchSteer`, `RepeatGate`, `stickDirection`.
- `touch.ts` + `touch.css`: `TouchControls`: floating thumb-stick (left 46% x 72% zone), five buttons (throttle, brake, drift,
  item, look back) and a pause button. Pointer Events, one pointer per control, multi-touch; appends `.tc` to `document.body`.
- `index.ts`: `createInputManager()`: capture-phase key listeners, blur/visibility key clearing, pad menu rAF polling,
  `poll`, `rumble`, `applySettings`, `dispose`.

## Rules
- **Right Ctrl only.** `ControlRight` is an item key (single) and P2 look-back (duo). Never bind `ControlLeft`: Left Ctrl + W
  (throttle) is the browser's close-tab shortcut, which a page cannot cancel. Right Ctrl + W can still happen (duo P2 looks back
  while P1 throttles), so `ui/screens/race.ts` adds a `beforeunload` prompt while a race runs. `onKeyDown` ignores meta/alt
  combos and Ctrl combos outside `SUPPRESS_DEFAULT`.
- Bind physical keys by `KeyboardEvent.code`, never `key`: positions then match on Korean 2-beolsik and other layouts.
- Text fields receive every key (`isTextField`); menus must not steal typing.
- `SUPPRESS_DEFAULT` is built from `MENU_KEYS`, `SINGLE_BINDINGS` and `DUO_P2_BINDINGS`. A key bound only in
  `DUO_P1_BINDINGS` is not included automatically.
- **Steering.** Keys: `digitalSteerTarget` (last pressed wins); D-pad: `readPadDrive().dpad` (both held = 0). Both are ramped
  by `rampSteer` (full lock in about 0.1 s, return about twice as fast). Stick: `shapeAxis` with `DEFAULT_STICK` (deadzone 0.14, outer 0.94, exponent 1.8, linear 0.3).
  Touch: `touchSteer` (deadzone 0.08, exponent 1.25). Sources merge with `mergeSteer` in order keys, D-pad, stick, touch:
  the larger magnitude wins, nothing is summed; the result is clamped to -1..1. Ramps are `dt`-based, and `RaceSession`
  calls `poll(p, DT)` once per sim tick. Output stays a float: the sim quantises steer to 1/63 (`src/sim/input-log.ts`).
- **Players.** Single: P1 gets `SINGLE_BINDINGS`, every pad and touch. Duo: P1 `DUO_P1_BINDINGS` + first pad, P2
  `DUO_P2_BINDINGS` + second pad. Touch drives P1 only, and only while visible. `setMode` resets the ramps.
- **Auto-accelerate**: throttle is forced on when `autoAccelerate && !autoHold && !brake`. The race screen calls
  `holdAutoAccelerate(true)` through intro and countdown, because throttle held from the first countdown tick stalls the
  engine at GO (`START_STALL_BEFORE`, `src/sim/constants.ts`). It is not on the contract: the UI calls it via
  `Partial<TurboInputManager>`, so keep it optional-safe.
- **Touch visibility** = `touchWanted && touchDetected && lastWasTouch`: the screen asked for it (`setTouchVisible`), the
  device counts as touch (coarse pointer with touch points at start, or a touch/pen pointer seen since), and the last input was
  touch. Any key press or active pad hides it again.
- **Gamepad** (standard mapping only). Race: A throttle, B brake, RB/RT drift, LB/LT item, X/Y look back, left stick x or
  D-pad steer. Menu: D-pad or stick (hysteresis 0.55 on / 0.35 off) through `RepeatGate(380, 120, 70, 5)`; `EDGE_BUTTONS`:
  A confirm, B/SELECT back, START pause, LB/RB tabs. Edge buttons already held when a pad first appears never fire (a held
  direction skips its first press but still auto-repeats). The pad menu
  loop runs only while a pad is connected (restarted on `gamepadconnected`).
- **Vibration.** `vibrate` prefers `vibrationActuator.playEffect('dual-rumble')` (weak magnitude `min(1, s*0.75+0.1)`, duration
  capped at 5000 ms), else `hapticActuators[0].pulse`; failures are swallowed. `rumble()` falls back to `navigator.vibrate`
  (10..120 ms) only for P1 with no pad, touch UI visible and strength >= 0.4. The `settings.rumble` gate lives upstream
  (`main.ts` wrapper and `RaceSession.rumble`), not here.
- Touch labels are Korean player-visible text (the throttle label becomes `자동 가속` with auto-accelerate on).
  `ICONS` markup is trusted static SVG.
- Tilt steering is not possible as deployed: Permissions-Policy blocks accelerometer and gyroscope (`src/shared/csp.ts`).

## How to extend
1. Add the `code` to the drive tables (`SINGLE_BINDINGS` / `DUO_P1_BINDINGS` / `DUO_P2_BINDINGS`) or to `MENU_KEYS`.
2. Check `SUPPRESS_DEFAULT` covers it (DUO_P1-only keys need attention) and that it has no un-cancellable browser default.
3. Gamepad: `readPadDrive` in `gamepad.ts` (drive) or `EDGE_BUTTONS` in `index.ts` (menu). Touch: `BUTTONS`, `ICONS`,
   `TouchButton` in `touch.ts`, styles in `touch.css`.
4. Update the hand-written guides: keyboard diagram and `bindList` rows in `src/client/ui/screens/controls.ts`, and the duo
   key hint in `src/client/ui/screens/char-select.ts`.
5. A new drive action needs a new `KartInput` field: that changes the sim input-log format and server replay verification
   (`src/sim/input-log.ts`), so the simulation versioning rule in `docs/architecture.md` applies.

## Testing
- `npx vitest run test/client/input-steering` covers `steering.ts` only.
- `keyboard.ts`, `gamepad.ts`, `touch.ts` and `index.ts` have no unit tests: check by hand under `npm run dev` (pad, and a
  phone on the LAN at `http://<lan-ip>:8200`; `tools/dev.mjs` allows LAN origins).
