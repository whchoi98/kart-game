---
description: Review the current diff (or the given files or range) with the project code-review criteria and confidence filtering
allowed-tools: Read, Glob, Grep, Bash(git diff *), Bash(git log *), Bash(git status *)
argument-hint: "[file ... | <ref>..<ref> | --staged]"
---

# Code Review

Review the current code changes using confidence-based scoring and the project checks in
`.claude/skills/code-review/SKILL.md`. This command is read-only: it never edits files, runs tests or commits.

Arguments: $ARGUMENTS

## Step 1: Get Changes

Determine the scope of review from the arguments above:

- Files or directories: review those paths, `git diff HEAD -- <paths>`, and read each file in full.
- A range containing `..` (for example `main...HEAD`): `git diff <range>` and `git log --oneline <range>`.
- `--staged`: `git diff --cached`.
- No arguments: unstaged changes, `git diff`. If none, staged changes, `git diff --cached`. If none, the last
  commit: `git log -1 --stat`, then `git diff HEAD~1 HEAD`.
- Always run `git status --short`: untracked files (`??`) are not in any diff, so read them directly.
- Start large diffs with `git diff --stat` to plan the order (see Error Recovery).

## Step 2: Review

1. Read `.claude/skills/code-review/SKILL.md` (criteria, project checks, tests table, output format).
2. Read the guideline sources: root `CLAUDE.md` and the nearest module `CLAUDE.md` of every changed file.
3. For each changed file apply:
   - project guidelines compliance (root and module `CLAUDE.md`);
   - bug detection (logic, races, leaks, OWASP Top 10, performance);
   - code quality (duplication, complexity, missing tests);
   - the numbered project checks that match its path (sim determinism and version bump, CSP single source, origin
     allow-list, `.dockerignore` parity, Korean-first copy, no external assets, release safety).
4. Bash is limited to `git diff`, `git log` and `git status` here, so run the skill's `grep` checks with the Grep
   tool instead, for example the determinism pattern over `src/sim` with glob `*.ts` (expected hits: only the
   comment lines `src/sim/types.ts:5` and `src/sim/dmath.ts:5`).
5. For `src/sim` changes, check whether `package.json` `version` and `CHANGELOG.md` changed in the same diff:
   `git diff HEAD -- package.json CHANGELOG.md` (or the same range).

## Step 3: Score and Filter

Rate each issue 0-100 with the skill's confidence scale. Only report issues with confidence >= 75.

## Step 4: Output

Present the findings in the skill's format (`### [CRITICAL|IMPORTANT] <title> (confidence: XX)` with File, Issue,
Guideline, Fix), ordered by severity, then a **Tests to run** list for the touched areas from the skill's table
(`npm run typecheck` always). If no issue reaches 75, say the code meets the project standards, list the project
checks applied and the tests to run.

## Error Recovery

### If no changes found (Step 1)
No diff output means nothing to review. Inform the user:
- Check whether the changes are already committed: `git log -1 --oneline`.
- Check the branch: `git status --short --branch`.
- Suggest naming files or a range directly: `/review src/sim/race.ts` or `/review main...HEAD`.

### If a module CLAUDE.md is missing (Step 2)
Every directory under `src/` must have its own `CLAUDE.md`. Review against the root `CLAUDE.md`, and report the
missing file as an IMPORTANT finding (the doc-sync hook and `npm run test:harness` flag it too).

### If the diff is too large (>500 lines)
Review high-risk files first:
1. `src/sim/**` (determinism, step order, version bump) and `src/shared/**` (cross-tier contracts).
2. `src/server/**` (origin guard, rate limits, validation, error leakage) and `infra/**` (security groups,
   listener rule, IAM, construct ids, `IMAGE_CONTEXT_EXCLUDE`).
3. `.claude/hooks/**`, `scripts/**` and `test/harness/**` (they run on every session or commit).
4. `src/client/**` logic, then styles.
5. Documentation (lower priority; `npm run test:harness` checks its structure).
State in the report which files were reviewed in depth and which only skimmed.
