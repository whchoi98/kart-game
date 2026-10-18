---
name: release
description: Cut a TURBO PALS GRAND PRIX release - choose the semver bump (trajectory-changing src/sim edits always need one, because the server compares the semver core of SubmitRunRequest.version), update package.json, move CHANGELOG [Unreleased] entries into a dated section in both languages with reference links, tag vX.Y.Z, then deploy through docs/runbooks/deploy-production.md and verify live. Use when the user asks to release, bump the version, tag, write release notes, or ship src/sim changes.
---

# Release Skill

Automate the release process with validation checks. A release here is: version bump, bilingual CHANGELOG
section, annotated tag, production deploy of exactly that commit, and live verification.

## Procedure

### 1. Pre-release Checks
- Working tree clean apart from the release edits: `git status --short`.
- On `main`: `git branch --show-current`.
- All checks pass:
  ```bash
  npm run typecheck
  npm test
  npm run test:harness
  ```
- Stop and report on any failure; do not release a red tree.

### 2. Determine Version
- Find the previous release. No tag exists yet for 1.0.0 (initial commit `23080fe`, released 2026-09-24), so:
  ```bash
  git describe --tags --abbrev=0 2>/dev/null || git log -1 --format=%h -G '"version"' -- package.json
  git log --oneline <previous>..HEAD
  git diff --stat <previous>..HEAD -- src/sim
  ```
- Deployed version: `curl -s https://my-kart.whchoi.net/healthz` returns `{"ok":true,"version":"X.Y.Z+<12 hex>"}`;
  the part before `+` is the live core version.
- Apply semver rules (adapted):
  - **MAJOR**: incompatible public contract change - an HTTP API endpoint or field removed or renamed
    (`src/shared/api.ts`), the input-log format version byte (`src/sim/input-log.ts`), or a storage key layout old
    servers cannot read (`src/server/repository.ts`).
  - **MINOR**: new tracks, characters, items, modes, screens or settings; backward-compatible API additions;
    noticeable physics or balance changes.
  - **PATCH**: bug fixes, small tuning, performance, docs, infrastructure-only changes.
- **Simulation rule**: any edit to existing sim code or an existing track that can alter a time-trial trajectory
  (physics, `PHYS`/`SPEED_CLASSES`/countdown constants, character stats, an existing track def, the track
  builder/query, input quantization, `RaceWorld.step()` order, the nitro path, `dmath`, RNG order) needs at least a
  PATCH bump. When re-simulation of a submitted run fails, the server compares `semverCore(SubmitRunRequest.version)`
  with the core of its `APP_VERSION` (`compareResult` in `src/server/app.ts`): a bumped version turns stale-client
  replay failures into a clear `VERSION_MISMATCH` instead of `REPLAY_INVALID`. If
  `git diff --stat <previous>..HEAD -- src/sim` is non-empty and the user claims no trajectory change, require the
  refactor skill's identical `tools/sim-report.ts` output as proof. A brand-new track alters no existing replay, so
  this rule does not force a bump for it (its MINOR bump, if any, is a product decision); compare `sim-report` output
  for the existing track ids only.
- Every bump, whatever its reason, makes clients discard the offline time-trial runs they queued under the old
  semver core at their next start (`dropStalePendingRuns` in `src/client/storage.ts`, called from
  `src/client/ui/app.ts`). Mention it in the release notes.
- Use plain `X.Y.Z`, no pre-release suffix: the server's `semverCore` strips only `+build` while the client's
  `versionCore` (`src/client/storage.ts`) strips `-pre` and `+build`, so `1.2.0-rc.1` would mean different things
  to each side. Never write build metadata in `package.json`; CDK appends `+<asset hash>` to `APP_VERSION`.
- Confirm the chosen version with the user.

### 3. Update Changelog
- Set the version without git side effects (updates `package.json` and `package-lock.json`):
  `npm version X.Y.Z --no-git-tag-version`.
- `CHANGELOG.md` has an English half and a Korean half; edit BOTH identically:
  - Move the items under `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section (today, ISO 8601) directly
    below it, and leave an empty `## [Unreleased]` heading in each half.
  - Group by the six Keep a Changelog headings `### Added`, `### Changed`, `### Deprecated`, `### Removed`,
    `### Fixed`, `### Security`. The headings stay English in the Korean half too (the harness rejects others).
  - English items are imperative ("Add Frost Peak ice zones"); Korean items use 명사형 종결 ("빙판 구간 추가").
  - If `[Unreleased]` is empty, draft entries from `git log --oneline <previous>..HEAD` (Conventional Commits:
    `feat` to Added, `fix` to Fixed, `refactor`/`perf` to Changed, security fixes to Security) and include commit
    references.
  - A trajectory change gets a `### Changed` item stating that time-trial runs recorded by older clients may be
    rejected with `VERSION_MISMATCH` and that runs still queued offline under the old version are discarded.
  - Reference links at the end of each half (keep the old ones):
    ```text
    [Unreleased]: https://github.com/whchoi98/kart-game/compare/vX.Y.Z...HEAD
    [X.Y.Z]: https://github.com/whchoi98/kart-game/compare/vPREVIOUS...vX.Y.Z
    [1.0.0]: https://github.com/whchoi98/kart-game/releases/tag/v1.0.0
    ```
- Version mentions elsewhere: the README badge `https://img.shields.io/badge/Version-X.Y.Z-...` and the version in
  the root `CLAUDE.md` Overview. Find mentions of the old version (here 1.0.0) with
  `grep -rnE --include='*.md' --exclude-dir=node_modules 'v?1\.0\.0' .` and update only statements of the current
  version, never historical ones (CHANGELOG sections, ADR dates, verify reports).
- Validate: `npm run test:harness` (checks the latest CHANGELOG release equals `package.json`, the same releases in
  both languages, category names, reference links and the README badge), then `npm run typecheck` and `npm test`.

### 4. Create Release
- Show the diff (`git diff --stat`) and ask before committing and tagging unless the user already asked for both.
  ```bash
  git add package.json package-lock.json CHANGELOG.md README.md CLAUDE.md
  git commit -m "chore(release): vX.Y.Z"
  git tag -a vX.Y.Z -m "Release vX.Y.Z"
  ```
  The PreToolUse secret scan checks the staged content on `git commit`; the commit-msg hook (installed by
  `bash scripts/install-hooks.sh`) strips `Co-Authored-By` trailers.
- If the repository has no `v1.0.0` tag yet, offer to add it so compare links resolve:
  `git tag -a v1.0.0 23080fe -m "Release v1.0.0"`.
- Push only when the user asks: `git push origin main` and `git push origin vX.Y.Z`. Never force-push or move a
  pushed tag (force push is denied in `.claude/settings.json`).
- Release notes: the new CHANGELOG section (English half first, then Korean).

### 5. Deploy and Verify
- Deploy exactly the tagged commit by following `docs/runbooks/deploy-production.md` (or run `/deploy`). It runs
  `npm run deploy` (`cdk deploy --require-approval never --outputs-file cdk-outputs.json`).
- Then:
  ```bash
  curl -s https://my-kart.whchoi.net/healthz                                  # version core must be X.Y.Z
  npm run verify:live                                                         # 35 checks via the native host
  npm run verify:live -- --custom --out docs/quality/live-verify-custom.json  # 35 checks via the custom domain
  node tools/verify-live-pwa.mjs                  # 8 headless PWA/offline checks; default URL is the custom domain
  ```
  `verify:live` needs AWS credentials and writes `docs/quality/live-verify.json` unless `--out <file>` is given.
- Run `verify:live` only from the commit you just deployed: its honest-run E2E check re-simulates locally, and a
  local/deployed sim skew makes the submission fail.

### 6. Summary
- Display the version bump (old to new) and why (semver rule, simulation rule).
- List the key changes from the CHANGELOG section.
- Show the commit, the tag, whether they were pushed, the deployed `/healthz` version and the live check results.
- Show next steps (push the commit and tag if not pushed; if players report problems, follow
  `docs/runbooks/incident-response.md`).

## Error Recovery

| Symptom | Cause | Fix |
|---|---|---|
| `CHANGELOG.md: latest release matches package.json` fails | dated section missing, misnamed or not first | add `## [X.Y.Z] - YYYY-MM-DD` right under `## [Unreleased]` in both halves |
| `CHANGELOG.md: same releases in both languages` fails | Korean half not updated | mirror the English release headings |
| `category headings are the six English Keep a Changelog names` fails | translated `###` headings | use the English names in both halves |
| `README.md: version badge matches package.json` fails | badge not bumped | edit `Version-X.Y.Z-` in the badge URL |
| `git tag` says the tag already exists | version already released | pick the next version; never move a pushed tag |
| live honest run rejected (`REPLAY_INVALID`, `TIME_MISMATCH` or `LAP_MISMATCH`; never `VERSION_MISMATCH`, the tool submits the server's own version) | local checkout differs from the deployed build | check out the deployed commit or redeploy it, then rerun `npm run verify:live` |
| deploy or live checks fail | bad release | follow `docs/runbooks/rollback-production.md`; an unpushed tag can be removed with `git tag -d vX.Y.Z` |

Never destroy `TurboPalsStack` or delete its table, log bucket or secret as part of a release.
