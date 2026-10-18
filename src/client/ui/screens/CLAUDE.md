# UI Screens Module

## Role
- One module per screen of the app shell. Each exports a factory (`createXScreen(app, opts)`, returning a `BaseScreen`) or, for the race, the `RaceScreen` class.
- Screens do not reach into each other: `../flows.ts` and `main-menu.ts` wire them together through callbacks (`onNext`, `onStart`, `onFinish`, `onRetry`, `onOtherTrack`, `onMenu`).

## Key Files
- `boot.ts` — `createBootScreen`: logo, progress bar, `엔진 예열 중…`, no hints. Shown while `App.boot` waits for the fonts.
- `title.ts` — `createTitleScreen`, `APP_VERSION`: any key or click (250 ms after `show`) unlocks audio, starts the `title` cue and pushes the reused main menu. Hosts the offline chip, install button and update banner; their clicks stop propagating (`stopClicks`, and the banner always), so a tap on them does not also leave the title.
- `main-menu.ts` — `createMainMenu`: modes `그랑프리`, `VS 레이스`, `타임 어택`, `2인 대전`; extras `랭킹`, `설정`, `조작 안내`, `크레딧`. Side column: chip, install, update banner, `pendingNotice` (with the dropped-version note), profile card re-rendered on every `show`. Back returns to the title.
- `class-select.ts` — `createClassScreen`, `MODE_LABEL`, `CPU_LABEL`, `LOCK_200`, `LOCK_MIRROR`: cc cards (200cc locked until unlocked), CPU level (every mode but time trial) and mirror toggle (GP / VS only). Time trial advances on the card click.
- `char-select.ts` — `createCharSelect` (grid, detail panel, garage backdrop following focus) and `createDuoCharSelect` (P1 / P2 cursors on a 4-column grid, `inputMode = 'duo'`, no shared pick, advances 650 ms after both are ready).
- `course-select.ts` — `createCupSelect` (trophy per cup for this cc), `createTrackSelect` (thumbnails painted one per frame; time-trial best badges refresh on return), `cupEmblem`, `trackLaps`.
- `options.ts` — `createVersusOptions` (items toggle, CPU stepper capped at `8 - humans`) and `createTimeTrialOptions` (ghost `none` / `best` / `world`; the world record is loading / ready / empty / error / offline, and an offline state reloads when `net` reports online).
- `race.ts` — `RaceScreen`: loading card with a random TIP, `view.startRace`, HUD rAF loop, intro skip, pause menu (`계속하기`, `다시 시작`, `설정`, `메뉴로 나가기`), `beforeunload` guard, `leaveRace()`.
- `results.ts` — `createVersusResults`, `createGrandPrixResults` (race table, then standings after 2600 ms or confirm), `createPodium`, `createTimeTrialResults` (delta, laps, nickname and `랭킹 등록`, offline queue; an assisted run shows the `자동 주행 기록` card instead of the nickname and submit form).
- `leaderboard.ts` — `createLeaderboardScreen`: track tabs, cc picker (left / right from anywhere), my best, inline `pendingNotice`, 45 s cache invalidated by `leaderboardVersion()`, last board kept when offline, row click confirms then calls `challengeGhost`.
- `settings.ts` — `createSettingsScreen(app, { inRace })`: sections `사운드`, `화면`, `조작`, `프로필`, `앱` (offline detail, install, version).
- `controls.ts` — `createControlsScreen`: tabs for keyboard 1P, keyboard 2P, gamepad, touch, plus racing tips.
- `credits.ts` — `createCreditsScreen`: up / down scrolls the credits; open-source licences (three.js, Fastify, Black Han Sans, Jua).

## Rules
- Screen contract (`../screen.ts`): `el`, `nav`, `show(first)`, `hide()`, `dispose()`; optional `music` (undefined keeps the current cue, null silences), `backdrop`, `inputMode` (defaults to `'single'`, so a duo screen must set `'duo'`), `touchControls`, `immersive`, `hints`, `onMenu` (return true to consume the action), `onBack`, `onTab`. `App.applyScreenEnv` applies them on every transition. `App` also calls an optional `onHidden()` on the top screen when the tab is hidden (`RaceScreen` pauses there).
- Build on `BaseScreen` (instantiate it or subclass it) and build menu headers with `frame()`. Register listeners, timers and `app.on(...)` subscriptions with `own()`; abort in-flight fetches in `dispose()`. A screen is disposed 450 ms after it leaves the stack; the main menu is reused and never disposed.
- Navigation is a stack. Setup steps `push`. Results are pushed over `RaceScreen`, so the race stays active (no update reload) until the results are left: `onRetry` = `popTo(race)` + `restart()`, `onOtherTrack` = `leaveRace()` + `popTo(trackScreen)`, `onMenu` = `leaveRace()` + `toMainMenu()`. GP advances with `popTo(race)`; the finale calls `leaveRace()` before `view.showPodium` and pushes the podium.
- Results and podium arm an `InputHold` in `show(first)`; keep that for any screen that appears right after a press.
- PWA surfaces come from `../pwa-ui.ts` and are disposed with `own()`. The update banner is on the title and main menu only and hides while `app.raceActive`; the in-race settings screen just says the update applies from the menu after the race.
- Pending offline runs: `results.ts` calls `queuePendingRun` when a time trial finishes offline or submission fails for connectivity, and `settlePending` once the server answered. Main menu and leaderboard show `pendingNotice`, whose `등록` runs `submitPendingRuns`. Call `app.pendingChanged()` after every queue change.
- User-provided names are set with `textContent` (`leaderboard.ts` rows); copy is Korean.
- `controls.ts` hardcodes key and pad labels and `char-select.ts` hardcodes the duo key hints: update them with `src/client/input/bindings.ts`.

## How to extend
- New screen:
  1. Create `<name>.ts` exporting `createXScreen(app, opts)` built on `BaseScreen` + `frame()`; set `music`, `backdrop`, `hints` (and `inputMode` for duo).
  2. Build controls from `../widgets.ts`; override `onMenu` / `onBack` / `onTab` only when the Nav defaults are not enough.
  3. Push it from `main-menu.ts` or from a chain in `../flows.ts`.
  4. Style it in `../screens-menu.css` or `../screens-extra.css` (already imported by `../app.ts`; a new stylesheet must be imported there).
  5. Move testable logic into a DOM-free module in `src/client/ui/` with a `test/client/ui-*.test.ts`, then check the screen in `ui-preview.html?mockapi`. Add the file to the list above.
- New mode (a new `RaceMode` in `src/sim/types.ts` is a sim change first): a `start*` chain and a session class in `../flows.ts`, a `MODE_LABEL` entry and a main-menu button.
