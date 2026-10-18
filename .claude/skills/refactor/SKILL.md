---
name: refactor
description: Refactor TURBO PALS GRAND PRIX code without changing behavior, using the project's safety nets - bit-identical simulation output for src/sim (vitest + tools/sim-report.ts before/after diff), perf tool comparisons for src/client/render, test/server for the API, and template diffs for infra. Use when the user asks to refactor, restructure, clean up, rename, extract or split code, or to reduce duplication or complexity without a feature change.
---

# Refactor Skill

Refactor existing code to improve quality without changing behavior. In this project "behavior" includes the
exact floating-point trajectory of every simulated race, the synthesized CloudFormation template and the rendered
draw calls, so each area has its own proof of equivalence.

## Principles
- Improve structure without changing behavior.
- Single Responsibility Principle (SRP).
- Remove duplicate code (DRY).
- Small, incremental steps with verification after each one.
- A refactor never needs a version bump. If the simulation output changes, it is not a refactor: stop and treat it
  as a behavior change (version bump and CHANGELOG entry, see the release skill).

## Process

### 1. Analysis
- Identify the target code, its module `CLAUDE.md` (Rules, How to extend) and the tests that guard it
  (`test/sim`, `test/client`, `test/server`, `test/infra`; the code-review skill has the path-to-test table).
- Map callers and dependencies with Grep. Remember the non-obvious consumers:
  - `tools/sim-report.ts` (`runCpuRace`, `runBotTimeTrial`) and `tools/track-report.ts` (`analyzeTrack`) are
    imported by `test/sim/sim.test.ts`; `tools/verify-live.ts` imports `runBotTimeTrial` and server key builders.
  - `src/shared/csp.ts` is imported by the server and by `infra/lib/edge.ts`.
  - `src/sim` runs in the browser, in the server's verify worker (`src/server/verify-worker.ts`) and in tools.
- Confirm coverage exists; if a path has no test (theme builders and `track-mesh.ts` are mocked in the game
  tests), propose a test or a perf/screenshot comparison first.
- Record the baseline (Step 3 commands) before editing anything.

### 2. Plan
Present the plan to the user:
- What will change.
- What will NOT change (behavior preservation): trajectories, API responses, template resources, draw calls.
- Risk assessment (low/medium/high). `src/sim`, `infra/` construct ids and `src/server` schemas are high risk.

### 3. Execute
Make changes in small, verifiable steps and run the area's safety net after each step.

**Simulation (`src/sim/**`)**: trajectories must stay bit-identical.
- Do not reorder or regroup floating-point operations (`a + b + c` vs `a + (b + c)`), replace `x / k` with
  `x * (1 / k)`, switch `Float64Array` to `Float32Array`, change iteration order over karts, projectiles or pickups,
  add or move `world.rng` calls, or change the `RaceWorld.step()` order.
- Baseline and comparison (the timing figure is the only nondeterministic text in the report):
  ```bash
  mkdir -p test-results/refactor
  npx tsx tools/sim-report.ts | sed -E 's/simulated in [0-9]+ ms/simulated in N ms/' > test-results/refactor/sim-before.txt
  # ... edit ...
  npx tsx tools/sim-report.ts | sed -E 's/simulated in [0-9]+ ms/simulated in N ms/' > test-results/refactor/sim-after.txt
  diff test-results/refactor/sim-before.txt test-results/refactor/sim-after.txt && echo identical
  npx vitest run test/sim
  ```
  The report covers a full 8-CPU race with items (seed 12345) and a bot time trial per track; every
  `bot TT: finished=...` line must still show `verify={"ok":true,"ticks":N}` with the same `N`. `test-results/` is
  git-ignored.
- For extra coverage repeat with `--cc 200 --level easy`. Track geometry refactors also need
  `npx tsx tools/track-report.ts` (exit 0, no problems).

**Render (`src/client/render/**`)**: tests plus before/after perf runs.
- Tests: `npx vitest run test/client/render- test/client/kart-visual-stability test/client/particles-`.
- Perf tools drive a QA server with the `?debug` hook; it has no HMR or file watching, so restart it after each
  code change. Playwright Chromium is required (`bash scripts/setup.sh --with-browsers`).
  ```bash
  npx vite --config tools/vite-qa.config.mjs --port 8244 --strictPort     # separate terminal; restart after edits
  npx tsx tools/perf-views.ts --tag before                                # deterministic draw calls / triangles
  npx tsx tools/perf-race.ts --tracks sunny-meadow,neon-city --tag before # CPU ms per frame, programs, textures
  npx tsx tools/perf-leaks.ts                                             # geometry/texture leaks across races
  ```
  Repeat with `--tag after` and compare `test-results/perf/views-before.json` with `views-after.json` (draw calls and
  triangles should match for a pure refactor) and `perf-before.json` with `perf-after.json` (no regression beyond
  run-to-run noise). A changed shader patch must also change its `customProgramCacheKey` string
  (`src/client/render/kart-materials.ts`, `item-models.ts`, `track-mesh.ts`, and `themes/city.ts`, `snow.ts`,
  `props-a.ts`): three.js keys compiled programs by it, so two different patches with one key share a program.

**Server (`src/server/**`)**: `npx vitest run test/server`. Repository refactors also run the DynamoDB Local subset
(`/test-all ddb`). Response schemas are allow-lists (`additionalProperties: false`): a renamed field silently
disappears from responses.

**Infra (`infra/**`)**: `npx vitest run test/infra`, then compare synthesized templates.
- Construct ids form CloudFormation logical ids; renaming or re-parenting a construct replaces the resource. Never
  change the ids behind `DataRankings44FBEC0A` (table, RETAIN + deletion protection) or `DataOriginVerify0E337E8C`
  (generation-1 secret `OriginVerify`).
  ```bash
  mkdir -p test-results/refactor
  npm run synth && cp cdk.out/TurboPalsStack.template.json test-results/refactor/template-before.json
  # ... edit ...
  npm run synth && diff test-results/refactor/template-before.json cdk.out/TurboPalsStack.template.json && echo identical
  ```

**Client app, UI, input, audio**: `npx vitest run test/client` (audio only: `npx vitest run test/client/audio-`).
Visual checks: `npm run qa:screens` against `npm run dev` (screenshots in `test-results/qa`).

### 4. Verify
- `npm run typecheck`, `npm test` and, if `.claude/`, docs or `CLAUDE.md` files changed, `npm run test:harness`.
- The area's equivalence proof from Step 3 is clean (identical sim report, identical template, matching draw calls).
- Update the module `CLAUDE.md` if file names, key files or extension steps changed (the doc-sync hook reminds you).
- Check that the refactoring achieved its goal and report what changed, which proof was used and its result.
