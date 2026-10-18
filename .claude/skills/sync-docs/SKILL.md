---
name: sync-docs
description: Synchronize TURBO PALS GRAND PRIX documentation with the current code - root and module CLAUDE.md files, docs/architecture.md, docs/reference/* (INDEX.md and root CLAUDE.md AUTO-MANAGED blocks, code pointers), ADRs, runbooks, docs/api-reference.md, docs/onboarding.md, and the bilingual README and CHANGELOG - then prove it with npm run test:harness. Use when the user asks to sync, refresh, audit or fix the docs, after a feature or infra change, after [doc-sync] hook reminders pile up, or before a release.
---

# Sync Docs Skill

Synchronize project documentation with the current code state. The code is the source of truth: read the source
(or run the tool) before changing a sentence, and never copy a claim from an older doc without checking it.

## Actions

### 0. Scope and Baseline
- What changed: `git log --oneline -20`, `git status --short`, and `git diff --stat <ref>..HEAD` for the range the
  user names (default: since the `Last updated` date in `docs/reference/INDEX.md`, if present).
- Baseline: `npm run test:harness` (record the failures; the same run must be green at the end).
- Map changed paths to documents (the same rules `.claude/hooks/check-doc-sync.sh` prints as `[doc-sync]`):

| Changed path | Documents to update |
|---|---|
| new directory under `src/` | its own `CLAUDE.md` (there is no `src/CLAUDE.md`) |
| `src/shared/api.ts`, `src/server/app.ts`, `src/server/validation.ts` | `src/server/CLAUDE.md`, `docs/api-reference.md`, `docs/reference/api.md` |
| `src/server/*repository*.ts`, `infra/lib/data.ts` | `docs/reference/data.md`, `src/server/CLAUDE.md` |
| `src/shared/csp.ts`, `src/server/security.ts` | `docs/reference/security.md` |
| `infra/**`, `Dockerfile`, `.dockerignore`, `cdk.json`, `cdk.context.json` | `docs/architecture.md` (Infrastructure), `docs/reference/iac.md`, `docs/reference/infrastructure.md`, affected `docs/runbooks/*.md` |
| `src/client/**` | `docs/reference/frontend.md`; screens, HUD, widgets also `docs/reference/ui.md` |
| `src/sim/**` (trajectory change to existing code or tracks; a brand-new track does not force a bump) | `CHANGELOG.md` entry and a `package.json` version bump before the next deploy (release skill: the harness needs a dated section and README badge equal to the version); `docs/architecture.md` Simulation API if exports changed |
| `package.json` scripts or dependencies | root `CLAUDE.md` (Tech Stack, Key Commands), README (Prerequisites, Installation, Usage, Testing), `docs/onboarding.md` |
| `.claude/**`, `scripts/**`, `test/harness/**` | root `CLAUDE.md` (Claude Code harness), `test/CLAUDE.md`, ADR-007 if a harness decision changed |

### 1. Quality Assessment
Score each `CLAUDE.md` file (0-100) across:
- Commands/workflows (20 pts)
- Architecture clarity (20 pts)
- Non-obvious patterns (15 pts)
- Conciseness (15 pts)
- Currency (15 pts)
- Actionability (15 pts)

Apply anti-pattern deductions:
- Over 500 lines (-15); module files outside 25-90 lines also lose Conciseness points
- Vague instructions (-10)
- Duplicated docs (-10)
- No test guidance (-10)
- Contains secrets (-20)

Output the quality report with grades (A 90-100, B 70-89, C 50-69, D 30-49, F 0-29) before making changes.

### 2. Root CLAUDE.md Sync
- Required sections, in this order: Overview, Tech Stack, Project Structure, Conventions, Key Commands, Auto-Sync
  Rules, Implementation References, with `## Project Rules` kept after Conventions (the harness checks each
  required `## ` heading and the 500-line limit).
- Tech Stack versions match `package.json`; Key Commands exist: list scripts with
  `node -p "Object.keys(require('./package.json').scripts).join('\n')"` and check every `tools/*` flag against the
  script's usage comment.
- Project Rules stay true (determinism list, version bump rule, step order, CSP source, Docker parity, debug hook,
  PWA updates, deploy runbook, no destroy, secrets, fixed environment). Update the ADR count line under ADR
  Numbering when ADRs are added.

### 3. Architecture Doc Sync
- `docs/architecture.md` is bilingual. Keep its sections: module map, Simulation API, game loop, visual/audio
  identity, Simulation versioning. Update exports, `RaceWorld` members and infrastructure facts from the code.
- Diagrams are Mermaid: `flowchart TB` with one `subgraph` per layer for the architecture, `flowchart LR` for the
  critical path; the Mermaid text is identical in both halves (English labels).
- Do not edit `docs/design.md` or `docs/infra.md` unless the user asks: they are Korean-only originals kept as-is and
  partly stale, so current facts belong in `docs/architecture.md`, `docs/reference/*` and the runbooks.

### 4. Module CLAUDE.md Audit
- Coverage: every directory from `find src -mindepth 1 -type d | sort` has its own `CLAUDE.md`; `infra/`, `test/`
  and `tools/` have one at the top of the tree.
- Format: `# <Module Name> Module`, then `## Role`, `## Key Files`, `## Rules` (required) and optionally
  `## Testing`, `## Gotchas`, `## How to extend`. English, bullets, paths in backticks, 25-90 lines.
- Key Files must match the directory listing (`ls <dir>`); extension steps must name every registration point
  (for example a new track touches `src/sim/tracks/index.ts`, `catalog.ts`, a theme and a song).
- Score each module file with the Step 1 criteria.

### 5. Implementation References
- Layers: `infrastructure`, `iac`, `frontend`, `ui`, `security`, `api`, `data` (no `agent-llm` layer in this project).
- Each `docs/reference/<layer>.md` keeps `## English` / `## 한국어` halves with `### 1. Overview`,
  `### 2. Components`, `### 3. Key Decisions`, `### 4. Code Pointers`, `### 5. Cross-references`. Code pointers must
  exist on disk (at least 3 paths with a `/`). Find broken ones with
  `node test/harness/structure/check-docs.mjs | grep -E '^FAIL.*docs/reference'`.
- Update a layer file only where the mapped code changed (Step 0 table), in both halves, keeping the five sections.
- Regenerate `docs/reference/INDEX.md`: rewrite only the table inside each `<!-- AUTO-MANAGED:index -->` ...
  `<!-- /AUTO-MANAGED -->` region (one per language half) from `ls docs/reference/*.md`: one row per layer, a
  relative link such as `(security.md)` when the file exists, the header row in that half's language. Update its
  `Last updated` line if present. Report `INDEX.md auto-corrected` when the table differed.
- Root `CLAUDE.md`: keep the `<!-- AUTO-MANAGED:references -->` ... `<!-- /AUTO-MANAGED -->` block listing every
  layer file, one bullet each:
  ```text
  - [Security](docs/reference/security.md) — CloudFront-only origin access, CSP from src/shared/csp.ts, rate limits
  ```

### 6. ADR and Runbook Audit
- ADRs: `docs/decisions/ADR-NNN-kebab-title.md`, consecutive from 001 (ADR-001 to ADR-007 exist today). A new
  decision gets the next number from `docs/decisions/.template.md`, bilingual. Flag ADRs whose context or
  consequences no longer match the code; supersede rather than rewrite accepted decisions.
- Runbooks (`docs/runbooks/`): deploy-production, rollback-production, teardown, rotate-origin-secret,
  custom-domain, incident-response; new ones from `docs/runbooks/.template.md`. Verify every command is copy-paste
  ready: npm scripts exist, `tools/*` flags match, stack name `TurboPalsStack`, region `ap-northeast-2`, output
  names from `infra/lib/stack.ts` (`SiteUrl`, `NativeSiteUrl`, `DistributionId`, `AlbDnsName`, `ClusterName`,
  `ServiceName`, `TableName`). Do not run AWS commands to check them.

### 7. README.md and CHANGELOG.md Sync
- Both bilingual (English first). README sections in this order - English: Overview, Features, Architecture,
  Prerequisites, Installation, Usage, Configuration, Project Structure, Testing, API Documentation, Contributing,
  License, Contact; Korean: 개요, 주요 기능, 아키텍처, 사전 요구 사항, 설치 방법, 사용법, 환경 설정, 프로젝트 구조,
  테스트, API 문서, 기여 방법, 라이선스, 연락처.
- README contract: version badge `Version-<package.json version>-`, a `License-` badge, feature lines
  `- **Name** — description`, a `| Variable | Description | Default |` table (`| 변수 | 설명 | 기본값 |` in Korean)
  matching `.env.example` and `src/server/config.ts`, Contributing with `git checkout -b`, `feat: ` and
  `Pull Request`, a link to `LICENSE` (all rights reserved), Contact = GitHub profile and Issues (no email).
  Keep the features, the QA build and `?debug` hook notes, the PWA section and the deploy steps.
- CHANGELOG: `# Changelog`, the English and Korean intro sentences, `## [Unreleased]` in both halves, released
  sections `## [X.Y.Z] - YYYY-MM-DD` identical in both halves, only the six English Keep a Changelog `###` headings,
  latest release equal to `package.json`, reference links in both halves. Add `[Unreleased]` entries for
  undocumented commits; never rewrite released sections.

### 8. Writing Rules (all bilingual docs)
- Skeleton (README, CHANGELOG, architecture, onboarding, api-reference, ADRs, runbooks):
  ```text
  # <Title>

  <a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

  ---

  <a id="english"></a>

  # English
  ...
  ---

  <a id="korean"></a>

  # 한국어
  ...
  ```
- Both halves have the same headings (count and level), tables and number of code blocks; only prose is
  translated. Code, commands, paths and identifiers stay untranslated; Korean UI strings quoted in the English half
  are wrapped in backticks.
- English imperative and concise; Korean 경어체 (~합니다), natural phrasing; changelog items in 명사형 종결.
- Every fenced block names its language (`text` for trees and output); ISO 8601 dates; no emoji; no box-drawing
  diagrams; no `<!-- TODO` or `{{VAR}}` placeholders; relative links resolve from the file's own directory.

### 9. Validate
- `npm run test:harness` must pass. For quick iterations: `bash test/harness/run-all.sh structure` or
  `node test/harness/structure/check-docs.mjs | grep FAIL`.
- If a failure belongs to code (for example `.dockerignore matches IMAGE_CONTEXT_EXCLUDE`), report it instead of
  papering over it in the docs.

### 10. Report
Output before/after quality scores, anti-patterns detected, the list of files created and updated, suggested ADRs,
INDEX.md status, README/CHANGELOG status (version badge, new entries), the harness result (passed/failed/skipped)
and remaining gaps.
