---
description: Run the TURBO PALS test suite (typecheck, vitest, Claude Code harness; optional DynamoDB Local subset) and report totals
allowed-tools: Read, Glob, Grep, Bash(npm run typecheck), Bash(npm test), Bash(npm test *), Bash(npm run test:harness), Bash(npx vitest *), Bash(npx tsc *), Bash(bash test/harness/run-all.sh), Bash(bash test/harness/run-all.sh *), Bash(bash -n *), Bash(ls -l *), Bash(git log *), Bash(git diff *), Bash(git status *), Bash(docker info *), Bash(docker run -d --rm --name ddb *), Bash(docker stop ddb), Bash(DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 npx vitest *)
argument-hint: "[all | sim | client | server | infra | harness | ddb]"
---

# Test All

Execute the full test suite for this project and report the totals. Tests never touch AWS; nothing here deploys.

Arguments: $ARGUMENTS

## Step 1: Detect Test Framework

The suites are fixed (see `package.json` scripts and `vitest.config.ts`):
- `npm run typecheck`: `tsc --noEmit && tsc --noEmit -p infra/tsconfig.json` (app, then CDK app and `test/infra`).
- `npm test`: `vitest run` over `test/**/*.test.ts` (`test/sim`, `test/client`, `test/server`, `test/infra`;
  `testTimeout` 30 s, `hookTimeout` 120 s, `maxWorkers` 4).
- `npm run test:harness`: `bash test/harness/run-all.sh` (shell + node checks of hooks, secret patterns, project
  structure and documentation contracts; not vitest).

## Step 2: Run Tests

Pick the scope from the arguments (empty or `all` runs the first block):

```bash
# all (default), in this order
npm run typecheck
npm test
npm run test:harness

# one area
npx vitest run test/sim          # sim
npx vitest run test/client       # client
npx vitest run test/server       # server
npx vitest run test/infra        # infra (CDK synth + cdk-nag; slow hooks are normal)
bash test/harness/run-all.sh     # harness; add a filter: hooks | secret | structure
```

`ddb` runs the DynamoDB repository tests, which `npm test` skips (10 skipped) without an endpoint. It needs Docker
(`docker info`); the endpoint host must be `127.0.0.1`, `localhost` or `[::1]`:

```bash
docker run -d --rm --name ddb -p 127.0.0.1:18765:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 npx vitest run test/server/repository.test.ts
docker stop ddb
```

Always stop the container afterwards, also when the tests fail.

## Step 3: Report

Present:
- Typecheck: pass/fail, and which project failed (app `tsconfig.json` or `infra/tsconfig.json`).
- vitest: the `Test Files` and `Tests` summary lines (passed, failed, skipped) per run.
- Harness: the `=== Results ===` block (Total, Passed, Failed, Skipped) and every line under `=== Failures ===`.
- Expected skips: the 10 DynamoDB Local tests in `test/server/repository.test.ts` (unless `ddb` ran) and the
  harness `commit-msg hook behaviour` check when `bash scripts/install-hooks.sh` has not been run.
- Failed test details with file paths and error messages; suggest a fix when the cause is apparent.

## Error Recovery

### If the harness runner itself fails
```bash
bash -n test/harness/run-all.sh                               # syntax of the runner
bash -n test/harness/hooks/test-hooks.sh                      # and of each sourced suite
bash -n test/harness/hooks/test-secret-patterns.sh
bash -n test/harness/structure/test-project-structure.sh
ls -l test/harness/run-all.sh scripts/*.sh .claude/hooks/*.sh  # executable bits
```
Restore lost executable bits only after telling the user:
`chmod +x test/harness/run-all.sh scripts/setup.sh scripts/install-hooks.sh .claude/hooks/*.sh`.

### Common failure categories and fixes

| Failure pattern | Likely cause | Fix |
|---|---|---|
| `error TS...` | type error | rerun `npx tsc --noEmit` or `npx tsc --noEmit -p infra/tsconfig.json` to isolate the project |
| `Test timed out in 30000ms` | slow or hung test | rerun the file alone, `npx vitest run <file>`, or one case with `npx vitest run <file> -t "<test name>"` |
| `Hook timed out in 120000ms` in `test/infra` | CDK synth in `beforeAll` on a busy host | rerun `npx vitest run test/infra` alone |
| `AwsSolutions-...` in `test/infra/nag.test.ts` | a resource violates cdk-nag | fix the resource, or add `cdk.Validations.of(x).acknowledge({ id, reason })` with a real reason |
| `test/sim` lap/finish counts, lap-time bounds (12-90 s), determinism or bot verify fail | a sim change broke finishing, sanity or determinism (the suite records fresh runs and hard-codes no times) | inspect with `npx tsx tools/sim-report.ts <trackId>` and fix the sim; a version bump does not make these pass |
| `file not executable: <path>` | mode bit lost (git or copy) | `chmod +x <path>` after telling the user |
| `bash syntax error in: <path>` | bad edit in a script | `bash -n <path>` to locate the error |
| `invalid JSON: <path>` | malformed `.mcp.json` or example | `node -e 'JSON.parse(require("fs").readFileSync(".mcp.json","utf8"))'` |
| `.dockerignore matches IMAGE_CONTEXT_EXCLUDE` | lists diverged | edit `.dockerignore` and `infra/lib/service.ts` together, same order |
| `CHANGELOG.md: latest release matches package.json` | version bumped without a dated section | release skill, Step 3 |
| `relative links resolve` | broken Markdown link | fix the path relative to the file's own directory |
| `module doc: <dir>/CLAUDE.md` | new `src/` directory | create its `CLAUDE.md` (Role / Key Files / Rules) |
| `secret-scan: no project file matches a secret pattern` | secret-shaped text in a file | `bash .claude/hooks/secret-scan.sh --all` prints file and pattern label; remove the value |

### If many tests fail at once
Likely a structural change broke multiple assumptions:
1. `git log -1` - what was the last change?
2. `git diff HEAD~1 --stat` and `git status --short` - what specifically changed?
3. Fix the root cause, not individual tests.
