---
name: code-review
description: Review changed code in TURBO PALS GRAND PRIX with confidence-scored findings (report only >= 75). Use when the user asks to review a diff, commit, branch or files, before committing changes under src/, infra/, tools/, test/ or .claude/, or when /review or the code-reviewer agent runs. Adds this project's checks to the generic bug, security and quality criteria - sim determinism and version bump, single-source CSP, origin allow-list, .dockerignore parity, Korean-first UI copy, procedural-only assets - and names the tests to run for each touched area.
---

# Code Review Skill

Review changed code with confidence-based scoring to filter false positives. Every finding must be verified in the
code you read; never report from memory or from a file name alone.

## Review Scope

- Default: unstaged changes (`git diff`). If empty, staged changes (`git diff --cached`). If both are empty, the
  last commit (`git log -1 --stat`, then `git diff HEAD~1 HEAD`).
- The user may name files, a directory or a range (`git diff main...HEAD`).
- Untracked files are not in `git diff`: list them with `git status --short` and read them in full.
- Guideline sources, read before judging:
  - root `CLAUDE.md` (Conventions and Project Rules 1-11);
  - the nearest module `CLAUDE.md` of every changed file. Every directory under `src/` has its own
    (`src/sim/CLAUDE.md`, `src/client/render/themes/CLAUDE.md`, ...); `infra/`, `test/` and `tools/` have one at the
    top of the tree.

## Review Criteria

### Project Guidelines Compliance
- ESM only; relative imports end in `.js`; JSON imports use `with { type: 'json' }`.
- kebab-case `.ts` files; tests live in `test/<area>/<name>.test.ts` (vitest includes only `test/**/*.test.ts`).
- 2-space indent, single quotes, semicolons, strict TypeScript, English comments and identifiers.
- Module boundaries: `src/sim` imports only other `src/sim` files (no DOM, three.js, Node, client or server code);
  `src/shared/api.ts` and `src/shared/csp.ts` are the only cross-tier contracts.
- Extension steps in the owning module `CLAUDE.md` (new track, theme, song, item, screen, setting, binding): every
  registration point is updated in the same change.

### Bug Detection
- Logic errors and null/undefined handling; tick arithmetic (`COUNTDOWN_TICKS` = 180, lap ticks count from GO).
- Race conditions: async order in `GameView`/`RaceSession` (a new `startRace` while a build is in flight), service
  worker update messages, concurrent DynamoDB submits (`TransactWriteItems` conditions in `dynamo-repository.ts`).
- Memory leaks: three.js geometries, textures and materials not disposed; listeners not registered with `s.own(...)`.
- Security vulnerabilities (OWASP Top 10): user input in `innerHTML`, unvalidated request fields, internal error
  text leaking into responses (public errors come only from `src/server/errors.ts` factories).
- Performance: per-frame allocations in `RaceSession`/renderer hot paths, quality tier changes during a race
  (shader recompiles), new per-tick work in `src/sim`.

### Code Quality
- Code duplication and unnecessary complexity.
- Missing critical error handling.
- Test coverage gaps (see "Tests to run" below).
- Accessibility for UI code: interactive elements need `data-nav`; initial focus via `data-autofocus`.

### Project Checks

Apply every check whose paths appear in the diff.

1. **Simulation determinism** (`src/sim/**`)
   - Forbidden: `Math.sin/cos/tan/atan/atan2/exp/pow/log/hypot/random`, `**`, `Date`, `performance`, DOM, three.js.
     Use `dmath.ts` and `Rng`. No lint rule enforces this, so search:
     ```bash
     grep -rnE 'Math\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log(2|10|1p)?|pow|hypot|cbrt|random)\b|\bDate\b|performance\.|[A-Za-z0-9_)] *\*\* *[A-Za-z0-9_(]' src/sim --include='*.ts'
     ```
     Expected today: only the two comment lines `src/sim/types.ts:5` and `src/sim/dmath.ts:5`. Any other hit is
     CRITICAL.
   - Imports: `grep -rhoE "from '[^']+'" src/sim | sort -u` must show only `./` and `../` paths.
   - `RaceWorld.step()` order (`src/sim/race.ts`) is unchanged: countdown, `humanLeadProgress`, inputs
     (`quantizeInput` for humans, `computeAiInput` otherwise), `updateKartItem` for all karts, `stepKart` for all
     karts, then while racing `collideKarts`, `updateProjectiles`, `pickups`, `moverCollisions`, `progressAndLaps`,
     then `prevDrift/prevItem`, `updatePositions`, `checkDone`, `tick++`.
   - No new consumer of `world.rng`; human input enters only through `step()`; reused buffers (`inputBuf`,
     `aiInputs`, the `out` of `computeAiInput`) are not kept across ticks; `BuiltTrack` objects are never mutated.
   - A new `KartInput` field or a change to `src/sim/input-log.ts` changes the input-log protocol, the server
     verification and the duplicate-run digest (`logDigest` in `src/server/validation.ts`).
   - **Version bump**: an edit to existing sim code or an existing track that can alter a time-trial trajectory
     (physics, `PHYS`/`SPEED_CLASSES`/countdown constants, character stats, an existing track def, the track
     builder/query, input quantization, step order, the nitro path, `dmath`, RNG order) needs a `package.json`
     `version` bump before it is deployed, plus a `CHANGELOG.md` entry in both halves. The harness requires the
     latest dated `## [X.Y.Z] - YYYY-MM-DD` section and the README badge to equal `package.json`, so either the
     change set bumps together with that dated section and badge (release skill), or it records the trajectory
     change under `[Unreleased]` so the release skill bumps before the next deploy. Neither: CRITICAL, unless the
     author shows identical `tools/sim-report.ts` output before and after (see the refactor skill). A brand-new
     track (new `TrackDef` plus catalog entry) alters no existing replay and does not force a bump; compare
     `sim-report` output for the existing track ids only. Any bump makes clients drop offline runs queued under
     the old core (`dropStalePendingRuns` in `src/client/storage.ts`). Changes confined to `src/sim/ai.ts` do not
     affect time-trial verification (no CPUs in a time trial; AI drives only after the finish).
2. **CSP has one source** (`src/shared/csp.ts`)
   - Header values change only there; `src/server/security.ts` and `infra/lib/edge.ts` import them. Search for
     copies (expected output: nothing):
     ```bash
     grep -rnE "'(default|script|style|img|connect|worker|font|media)-src|unsafe-(inline|eval)|max-age=31536000; includeSubDomains" src infra --include='*.ts' | grep -v '^src/shared/csp.ts'
     ```
   - No `'unsafe-eval'`, no remote hosts, no inline `<script>`. The origin CSP has no `upgrade-insecure-requests`
     and the origin sends no HSTS by design; both are added at the edge.
3. **Origin allow-list and API surface** (`src/server/**`, `src/shared/api.ts`, `infra/lib/stack.ts`)
   - `POST /api/runs` keeps `onRequest: [submitLimit, originGuard, jsonOnly]` in that order (malformed requests are
     still charged).
   - `isOriginAllowed` stays exact-match (no suffix, regex or `'null'`); a missing `Origin` is allowed and relies on
     replay verification. Origins come from `PUBLIC_ORIGIN` + `ALLOWED_ORIGINS` (exact origins, max 16).
   - No CORS headers are added. New routes: registered before `registerStatic`, own limiter, listed in
     `SELF_LIMITED_ROUTES`, `noQuerySchema` when there is no query, response schema with
     `additionalProperties: false` and the type in `src/shared/api.ts`.
   - A new rejection code needs `RunRejectionCode` (`src/shared/api.ts`), `compareResult` (`src/server/app.ts`) and
     a Korean message in `CODE_MESSAGES` (`src/client/api.ts`).
4. **Docker build context parity**: `.dockerignore` and `IMAGE_CONTEXT_EXCLUDE` (`infra/lib/service.ts`) list the
   same patterns in the same order. Check with
   `node test/harness/structure/check-docs.mjs | grep -i docker` (every line must start with `PASS`).
5. **Korean-first UI copy** (`src/client/**`): user-visible strings are Korean; English only for decorative
   labels (`GO!`, `FINISH!`, `FINAL LAP`, `NEW RECORD`, `LAP`, `BEST`, `TIP`, `km/h`). Server messages in
   `src/server/errors.ts` and `compareResult` are Korean too. Player names go in with `textContent`; `innerHTML` and
   `svg()` take trusted static markup only.
6. **No external assets or third-party IP**: no new image, audio, font or model files and no remote URLs. Fonts
   come from the `@fontsource/*` packages; textures, geometry, music and SFX are generated in code. The PNGs under
   `public/icons/` are generated from `public/favicon.svg` by `tools/gen-icons.ts`. New files to inspect:
   `git diff --name-only --diff-filter=A HEAD`. Song titles must pass `test/client/audio-songs.test.ts`.
7. **Release safety**: `TURBO_DEBUG_HOOK` never appears in `Dockerfile` or the deploy path; `PwaManager.applyUpdate()`
   still refuses during a race; the origin-verify secret never reaches task env, IAM policies, outputs or code;
   construct ids in `infra/lib/*.ts` are unchanged unless replacement is intended (logical ids such as
   `DataRankings44FBEC0A` and `DataOriginVerify0E337E8C` derive from them).

### Tests to run

Name the commands for every touched area in the report; `npm run typecheck` always applies.

| Touched path | Run |
|---|---|
| `src/sim/**` | `npx vitest run test/sim test/server/replay.integration.test.ts test/client/game-` and `npx tsx tools/sim-report.ts` |
| `src/sim/tracks/**` | the row above, plus `npx tsx tools/track-report.ts <trackId>` and `npx vitest run test/client/audio-songs.test.ts test/client/audio-system.test.ts` |
| `src/shared/api.ts` | `npx vitest run test/server test/client` |
| `src/shared/csp.ts`, `src/server/security.ts` | `npx vitest run test/server/http.test.ts test/infra` |
| `src/server/**` | `npx vitest run test/server`; repository files also the DynamoDB Local subset (`/test-all ddb`) |
| `src/client/render/**` | `npx vitest run test/client/render- test/client/kart-visual-stability test/client/particles-`; perf tools (refactor skill) |
| `src/client/audio/**` | `npx vitest run test/client/audio-` |
| other `src/client/**` | `npx vitest run test/client` |
| `infra/**`, `cdk.json`, `cdk.context.json` | `npx vitest run test/infra` and `npm run synth` |
| `.dockerignore`, `Dockerfile` | `bash test/harness/run-all.sh structure`; Dockerfile also `docker build --platform linux/arm64 -t turbo-pals:local .` |
| `tools/sim-report.ts`, `tools/track-report.ts` | `npx vitest run test/sim` (the tests import them) |
| `.claude/**`, `scripts/**`, `test/harness/**`, `CLAUDE.md`, `docs/**`, `README.md`, `CHANGELOG.md` | `npm run test:harness` |

## Confidence Scoring

Rate each issue 0-100:
- **0-24**: Likely false positive or pre-existing issue. Do not report.
- **25-49**: Might be real but possibly a nitpick. Do not report.
- **50-74**: Real issue but minor. Report only if critical.
- **75-89**: Verified real issue, important. Report with fix suggestion.
- **90-100**: Confirmed critical issue. Must report.

**Only report issues with confidence >= 75.** A broken project invariant (forbidden math in `src/sim`, missing
version bump for a trajectory change, a CSP value outside `src/shared/csp.ts`, `.dockerignore` drift, a secret in
code) is confirmed by the commands above and scores 90 or more.

## Output Format

For each issue:
### [CRITICAL|IMPORTANT] <issue title> (confidence: XX)
**File:** `path/to/file.ts:line`
**Issue:** Clear description of the problem
**Guideline:** Root or module `CLAUDE.md` rule, project check number above, or security standard
**Fix:** Concrete code suggestion

End with a **Tests to run** list (commands from the table above) for the touched areas.

If no high-confidence issues are found, confirm the code meets the project standards with a brief summary, the
project checks that were applied, and the tests to run.
