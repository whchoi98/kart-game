# TURBO PALS GRAND PRIX - Project Context

## Overview

TURBO PALS GRAND PRIX (`터보 팰즈 그랑프리`, package `turbo-pals-grand-prix` v1.0.0, released 2026-09-24) is an
arcade 3D kart racer that runs in the browser: drift mini-turbos, 14 items, 8 original drivers, 2 cups x 4 tracks,
Grand Prix against 7 CPUs, VS race, time trial with ghosts, 2-player split screen, and an online time-trial
leaderboard. It is an offline-first PWA. All characters, tracks, art, music and sound are procedural and original.

- **Deterministic simulation**: `src/sim` is pure TypeScript at a fixed 60 Hz step. The browser and the server run
  the same code. The server re-simulates every submitted time-trial input log in a worker thread and accepts the run
  only if the finish ticks and lap ticks match exactly.
- **Topology** (AWS account `061525506239`, `ap-northeast-2`, stack `TurboPalsStack`):
  - Browser -> CloudFront (HTTP redirects to HTTPS; security headers policy; a viewer-request function overwrites
    `x-turbo-client-ip`).
  - CloudFront -> ALB over HTTP :80 with the `X-Origin-Verify` header. The ALB SG admits only the CloudFront
    origin-facing prefix list `pl-22a6434b`; the listener default is a fixed 403 and a priority-10 rule forwards
    only when the header matches the Secrets Manager value.
  - ALB -> ECS Fargate ARM64 tasks (2-6, 1 vCPU / 2 GiB, port 8080) in the private subnets of the EXISTING VPC
    `vpc-0dfa5610180dfa628`. Egress is TCP 443 through that VPC's existing NAT gateways. The stack creates no
    VPC, subnet, NAT, route or endpoint.
  - Leaderboard storage: one DynamoDB single-table design (construct `Rankings`; on-demand, PITR, deletion
    protection, RETAIN).
- **Live**: https://my-kart.whchoi.net/ (custom domain; its CNAME lives in a DNS zone in another AWS account) and
  https://d374w2735k9eto.cloudfront.net/ (native), distribution `E3M557KCLIGK5L`.
- **Repository**: https://github.com/whchoi98/kart-game (public). License: all rights reserved ([LICENSE](LICENSE)).

## Tech Stack

| Area | Technology | Version (package.json) |
|---|---|---|
| Language | TypeScript (strict, ESM) | 7.0.2 |
| Runtime | Node.js (`engines`); container base `node:24-alpine` (digest pinned in `Dockerfile`) | >=22.12.0 |
| 3D rendering | three.js (`@types/three` same version) | 0.186.0 |
| Client build / dev server | Vite | 8.3.0 |
| HTTP server | Fastify, `@fastify/compress` 9.2.0, `@fastify/rate-limit` 11.2.0, `@fastify/static` 10.1.4 | 5.12.5 |
| AWS SDK v3 | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | 3.1136.0 |
| IaC | `aws-cdk-lib` (CLI `aws-cdk` 2.1142.0, `constructs` 10.8.1) | 2.270.0 |
| IaC checks | `cdk-nag` AwsSolutionsChecks (violations fail synth) | 3.0.2 |
| Unit tests | vitest | ^4.1.0 |
| Browser automation | Playwright (QA screenshots, PWA live check, track PNGs, perf tools) | 1.63.0 |
| TS runner | tsx (dev server, tools, CDK app) | 4.23.15 |
| Bundler | esbuild (server bundle, verify worker, service worker) | 0.28.2 |
| Fonts | `@fontsource/black-han-sans`, `@fontsource/jua` (self-hosted from npm) | ^5.3.0 |

Audio is WebAudio synthesis and textures are procedural canvas; there are no audio files, and the only image files
are the PWA icons in `public/` (the PNGs are rendered from `public/favicon.svg` by `tools/gen-icons.ts`).

## Project Structure

Every directory under `src/`, plus `infra/`, `test/` and `tools/`, has its own `CLAUDE.md` (Role / Key Files /
Rules). Read it before editing that module.

```text
src/
  sim/              Deterministic race simulation shared by client and server (RaceWorld, physics, items, AI, replay)
    tracks/         8 TrackDef files + TRACK_CATALOG (cups, order, menu metadata)
  shared/           Cross-tier contracts: api.ts (HTTP types, API_LIMITS), csp.ts (security headers)
  client/           Browser entry (Vite root): main.ts, api.ts, storage.ts, pwa.ts, sw.ts, contracts.ts
    audio/          WebAudio engine: mixer, sequencer, SFX, engine loops, voices
      songs/        14 original SongDefs (8 track songs, 5 menu cues, star layer)
    dev/            Dev-only render QA pages (/dev/*.html); not part of the production build
    game/           Glue: GameView, RaceSession (fixed step + interpolation), HudModel
    input/          Keyboard, gamepad and touch -> KartInput and menu actions
    render/         three.js pipeline, track mesh, karts, particles, camera, showroom
      themes/       8 procedural scenery themes + shared props helpers
    ui/             Framework-free DOM app shell, flows, HUD, widgets, PWA UI
      art/          Code-generated SVG/canvas art (icons, logo, portraits, track outlines)
      screens/      One module per screen
  server/           Fastify API + static hosting, worker-thread replay verifier, memory/DynamoDB repositories
infra/              AWS CDK app: bin/app.ts, lib/{settings,network,data,logs,service,edge,stack}.ts
test/               vitest suites (sim/, client/, server/, infra/) + harness/ (hook, secret and docs checks)
tools/              build.mjs, dev.mjs, verify-live*, sim/track reports, QA screenshots, perf probes, gen-icons
public/             manifest.webmanifest, favicon.svg, icon-maskable.svg, icons/ (PWA icons)
docs/               architecture, onboarding, api-reference, design, infra, decisions/, runbooks/, reference/, quality/
scripts/            setup.sh (new machine), install-hooks.sh (git commit-msg hook)
.claude/            settings.json, hooks/, skills/, commands/, agents/
```

Root build files: `Dockerfile`, `.dockerignore`, `cdk.json`, `cdk.context.json` (checked-in VPC lookup cache),
`vite.config.ts`, `vitest.config.ts`, `tsconfig.json` (app) and `infra/tsconfig.json` (CDK, NodeNext).

## Conventions

- **Code style**: 2-space indent, LF, UTF-8, final newline (`.editorconfig`; 4 spaces for `*.sh` and `Dockerfile`).
  Single quotes and semicolons. Strict TypeScript everywhere. Code comments and identifiers are English.
- **Modules**: ESM only (`"type": "module"`). Relative imports carry the `.js` extension
  (`import { Rng } from './rng.js'`); JSON imports use `with { type: 'json' }`.
- **File names**: kebab-case `.ts` (`race-session.ts`, `kart-physics.ts`); Node scripts that run without tsx are
  `.mjs`. Tests live in `test/<area>/<name>.test.ts` (vitest includes only `test/**/*.test.ts`).
- **UI copy is Korean first** (`lang="ko"`). English is used only for decorative labels such as `GO!`, `FINISH!`,
  `FINAL LAP`. A new server error code needs a Korean message in `CODE_MESSAGES` (`src/client/api.ts`). Insert
  player names with `textContent`; `innerHTML`/`svg()` take trusted static markup only.
- **Original content only**: no external asset files and no third-party IP. Geometry, textures, music and SFX are
  generated in code; `test/client/audio-songs.test.ts` rejects song titles that reference existing franchises.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). The commit-msg hook
  from `scripts/install-hooks.sh` strips `Co-Authored-By` trailers.
- **Docs**: README, CHANGELOG, `docs/architecture.md`, `docs/onboarding.md`, `docs/api-reference.md`, ADRs,
  runbooks and `docs/reference/*` are bilingual, English first then Korean, with identical structure (HTML language
  toggle, `<a id="english">` / `<a id="korean">` anchors). CLAUDE.md files are English only. Diagrams are Mermaid;
  no emoji. `docs/design.md` and `docs/infra.md` are Korean-only originals and partly stale: the code wins.

## Project Rules

1. **Simulation determinism.** In `src/sim` never use `Math.sin/cos/tan/atan/atan2/exp/pow/log/hypot/random`, `**`,
   `Date`, `performance`, the DOM or three.js. Use `dmath.ts` (`dsin`, `dcos`, `datan2`, `dexp`, ...) and `Rng`
   (mulberry32). No lint rule enforces this; check it in review.
2. **Version bump for trajectory changes.** An edit to existing `src/sim` code or an existing track that can alter
   a time-trial trajectory (physics, `PHYS`/`SPEED_CLASSES`/countdown constants, character stats, an existing
   track def, the track builder/query, input quantization, step order, the nitro path, `dmath`, RNG order) needs a
   `package.json` version bump and a CHANGELOG entry before it is deployed. The server compares the semver core
   only after a re-simulation fails, so a stale client's failed replay then gets `VERSION_MISMATCH` instead of
   `REPLAY_INVALID`. A brand-new track alters no existing replay, so the rule does not force a bump; any bump makes
   clients discard offline runs still queued under the old core (`dropStalePendingRuns`, `src/client/storage.ts`).
   Edits confined to `src/sim/ai.ts` do not affect time-trial verification (a time trial has no CPUs). See ADR-001
   and the Simulation versioning section of `docs/architecture.md`.
3. **Never change the `RaceWorld.step()` order** (`src/sim/race.ts`): countdown, `humanLeadProgress`, inputs
   (`quantizeInput` for humans, `computeAiInput` otherwise), `updateKartItem` for all karts, `stepKart` for all
   karts, then while racing `collideKarts`, `updateProjectiles`, `pickups`, `moverCollisions`, `progressAndLaps`,
   then `prevDrift/prevItem`, `updatePositions`, `checkDone`, `tick++`. Adding or reordering `world.rng`
   consumers changes every seeded race. Human input enters only through `step()`; a new `KartInput` field
   changes the input-log protocol and the server verification.
4. **CSP has one source**: `src/shared/csp.ts`. `src/server/security.ts` (origin) and `infra/lib/edge.ts`
   (CloudFront response headers policy) both import it. Change security headers only there.
5. **`.dockerignore` must equal `IMAGE_CONTEXT_EXCLUDE`** in `infra/lib/service.ts` (same patterns, same order).
   The list decides the Docker build context and the CDK image asset hash; `npm run test:harness` checks parity.
6. **The QA debug hook never ships.** `?debug` -> `window.__turbo` exists only when `__DEBUG_HOOK__` is true:
   `TURBO_DEBUG_HOOK=1` builds, the Vite dev server and `tools/vite-qa.config.mjs`. Never set `TURBO_DEBUG_HOOK`
   in the `Dockerfile` or deploy path; `tools/verify-live-pwa.mjs` asserts the release has no hook.
7. **The PWA never swaps versions mid-race.** `PwaManager.applyUpdate()` returns false during a race, and the
   service worker calls `skipWaiting()` only after every window answers `RACE_STATUS` with `inRace: false`.
   Updates apply from the menu after a race; keep the race-owner registration in the race screen intact.
8. **Deploy only via [docs/runbooks/deploy-production.md](docs/runbooks/deploy-production.md)**, then run
   `npm run verify:live` against the build you just deployed (a stale deploy fails the honest-run E2E check).
   `npm run deploy` skips the approval prompt (`--require-approval never`).
9. **Never destroy `TurboPalsStack` or delete its data** (Rankings table, access-log bucket, origin secret) or
   disable the table's deletion protection without an explicit user request. `.claude/settings.json` denies
   `cdk destroy`, `aws cloudformation delete-stack`, `aws dynamodb delete-table`, `aws secretsmanager delete-secret`.
10. **Secrets live only in AWS Secrets Manager.** The origin-verify value is generated there and reaches the ALB
    rule and CloudFront through a CloudFormation dynamic reference; it must never appear in task env, IAM policies,
    stack outputs, code, docs or `.env`. Rotate it with `-c originSecretGeneration=N`
    ([docs/runbooks/rotate-origin-secret.md](docs/runbooks/rotate-origin-secret.md)). MCP tokens use `${VAR}`.
11. **The target environment is fixed.** `infra/lib/stack.ts` throws for any other account, region, VPC, prefix
    list or domain, or a certificate that is not a us-east-1 ACM certificate of this account. The custom domain's
    DNS is outside this account: the `whchoi.net` hosted zone here is not delegated, so its records have no effect.

## Key Commands

```bash
bash scripts/setup.sh                        # new machine: Node >= 22.12 check, npm ci, git hooks
bash scripts/setup.sh --with-browsers        # same + Playwright Chromium (qa:screens, verify-live-pwa, --png)
npm run dev                                  # Vite http://localhost:8200 + API 127.0.0.1:8201 (in-memory leaderboard)
npm run typecheck                            # tsc for the app and infra/tsconfig.json
npm test                                     # vitest run: test/sim, test/client, test/server, test/infra
npx vitest run test/sim                      # one area only
npm run test:harness                         # hooks, secret patterns, structure and docs contracts
npm run build                                # release build: dist/client + dist/server (hook compiled out)
npm start                                    # serve the build at http://127.0.0.1:8080
npx tsx tools/sim-report.ts                  # CPU race + bot time trial + verify on every track
npx tsx tools/sim-report.ts sunny-meadow --cc 150 --level hard
npx tsx tools/track-report.ts                # track geometry checks, exit 1 on problems (test-results/tracks)
TURBO_DEBUG_HOOK=1 node tools/build.mjs      # QA build with the ?debug hook - never deploy it
npm run qa:screens                           # per-track screenshots via ?debug; needs npm run dev running
npm run synth                                # cdk synth --quiet (cdk-nag runs; violations fail)
npm run deploy                               # production deploy; follow docs/runbooks/deploy-production.md
npm run verify:live                          # 35 live checks (AWS creds); writes docs/quality/live-verify.json
npm run verify:live -- --custom --out docs/quality/live-verify-custom.json   # same checks via the custom domain
node tools/verify-live-pwa.mjs https://my-kart.whchoi.net   # 8 headless PWA / offline checks
```

DynamoDB repository tests run only against DynamoDB Local:
`DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 npx vitest run test/server/repository.test.ts`.

## Auto-Sync Rules

### Post-Plan Mode Actions

After exiting Plan mode (`/plan`), before starting implementation:

1. **Architecture decision made** -> update [docs/architecture.md](docs/architecture.md) (both language halves).
2. **Technical choice or trade-off made** -> create `docs/decisions/ADR-NNN-title.md` from `.template.md` there.
3. **New module added** -> create `CLAUDE.md` in that directory (Role / Key Files / Rules).
4. **Operational procedure defined** -> create a runbook in `docs/runbooks/` from `docs/runbooks/.template.md`.
5. **This file affected** -> update the relevant sections above.

### Code Change Sync Rules

- New directory under `src/` -> create its own `CLAUDE.md` (there is no `src/CLAUDE.md`). `infra/`, `test/` and
  `tools/` are covered by their top-level `CLAUDE.md`.
- API endpoint, payload, limit or error code changed (`src/shared/api.ts`, `src/server/app.ts`,
  `src/server/validation.ts`) -> update `src/server/CLAUDE.md`, [docs/api-reference.md](docs/api-reference.md)
  and [docs/reference/api.md](docs/reference/api.md).
- Data model, key layout or access pattern changed (`src/server/*repository*.ts`, `infra/lib/data.ts`) -> update
  [docs/reference/data.md](docs/reference/data.md) and `src/server/CLAUDE.md`. New DynamoDB actions also need the
  task role policy in `infra/lib/service.ts`.
- Security boundary changed (`src/shared/csp.ts`, `src/server/security.ts`) -> update
  [docs/reference/security.md](docs/reference/security.md).
- Infrastructure changed (`infra/**`, `Dockerfile`, `.dockerignore`, `cdk.json`, `cdk.context.json`) -> update
  the Infrastructure section of [docs/architecture.md](docs/architecture.md),
  [docs/reference/iac.md](docs/reference/iac.md) and the affected runbooks in `docs/runbooks/`.
- Trajectory-changing edit to existing sim code or tracks (Project Rule 2) -> add the `CHANGELOG.md` entry (both
  languages) and bump `version` in `package.json` before the next deploy (release skill). The harness requires the
  latest dated `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG section and the README version badge to equal `package.json`,
  so a bump always lands together with that section and the badge.
- `.dockerignore` and `IMAGE_CONTEXT_EXCLUDE` (`infra/lib/service.ts`) -> always edit both, in the same order.
- New track, theme, song, item, screen, setting or input binding -> follow the extension steps in the owning
  module's `CLAUDE.md`; each has several registration points.
- Layer implementation changed -> update the matching `docs/reference/<layer>.md`; its code pointers must exist.

`.claude/hooks/check-doc-sync.sh` (PostToolUse on `Write|Edit`) applies these rules automatically: after each edit
it adds `[doc-sync]`, `[sim-version]` or `[docker-context]` reminders to Claude's context for the touched path
(missing module `CLAUDE.md`, sim version bump, API/data/security/infra docs, Docker context parity).
`npm run test:harness` enforces the structural parts.

### ADR Numbering

Find the highest number in `docs/decisions/ADR-*.md` and add 1. Format: `ADR-NNN-concise-kebab-title.md`
(three digits, consecutive from 001; the harness checks the sequence). ADR-001 to ADR-007 exist.

## Implementation References

<!-- AUTO-MANAGED:references -->
Layer-by-layer implementation guides in `docs/reference/`. See [INDEX](docs/reference/INDEX.md).
- [Infrastructure](docs/reference/infrastructure.md) — CloudFront -> ALB -> Fargate ARM64 topology in the existing VPC, NAT egress, sizing, scaling, logs, DNS
- [IaC](docs/reference/iac.md) — CDK app layout (settings, network, data, logs, service, edge, stack), stack guards, cdk-nag, infra tests
- [Frontend](docs/reference/frontend.md) — Vite client, RaceSession game loop, three.js render pipeline, WebAudio, input, PWA service worker, storage
- [UI](docs/reference/ui.md) — framework-free DOM app shell, screens, HUD, navigation, widgets, Korean-first copy
- [Security](docs/reference/security.md) — CloudFront-only origin access (prefix list + X-Origin-Verify), CSP and headers from src/shared/csp.ts, rate limits, validation, secrets
- [API](docs/reference/api.md) — Fastify endpoints (/healthz, leaderboard, ghost, runs), replay verification, rejection codes, limits
- [Data](docs/reference/data.md) — DynamoDB `Rankings` single-table key layout, repositories, PITR and retention
<!-- /AUTO-MANAGED -->

### Other documentation

- [docs/architecture.md](docs/architecture.md) — architecture, module map, Simulation API, Simulation versioning.
- [docs/decisions/](docs/decisions/) — ADR-001 to ADR-007 (sim verification, CloudFront-only origin, Fargate in the
  existing VPC, DynamoDB leaderboard, procedural content, race-safe PWA updates, harness adaptations).
- [docs/runbooks/](docs/runbooks/) — deploy-production, rollback-production, teardown, rotate-origin-secret,
  custom-domain, incident-response.
- [docs/onboarding.md](docs/onboarding.md) — new developer setup and first tasks.
- [docs/api-reference.md](docs/api-reference.md) — HTTP API contract.
- [docs/design.md](docs/design.md) — game design; [docs/infra.md](docs/infra.md) — infra and ops guide (both Korean).
- `docs/quality/` — `verify-live` reports (`live-verify.json`, `live-verify-custom.json`).

### Claude Code harness

- `npm run test:harness` (`bash test/harness/run-all.sh [filter]`) — shell + node checks for hooks, secret
  patterns, project structure and documentation contracts. It is separate from vitest.
- `.claude/hooks/session-context.sh` (SessionStart) — prints version, branch, last commit, uncommitted count,
  the last deployed SiteUrl from `cdk-outputs.json` (when `jq` is installed) and the key rules.
- `.claude/hooks/secret-scan.sh` (PreToolUse, `git commit`) — scans staged content and blocks the commit
  (exit 2) on a secret pattern, printing only file names and pattern labels.
- `.claude/hooks/check-doc-sync.sh` (PostToolUse, `Write|Edit`) — the Auto-Sync reminders above (never blocks).
- `.claude/hooks/notify.sh` (Notification) — posts to `$CLAUDE_NOTIFY_WEBHOOK` when set (`CLAUDE_NOTIFY_DRY_RUN=1`
  prints instead).
- Skills `.claude/skills/{code-review,refactor,release,sync-docs}/`, commands
  `.claude/commands/{review,test-all,deploy}.md`, agents `.claude/agents/{code-reviewer,security-auditor}.md`.
- `.claude/settings.json` denies destructive commands (`rm -rf`, force push, `git reset --hard`, stack/table/secret
  deletion). Deny rules are a guard rail, not a security boundary.
