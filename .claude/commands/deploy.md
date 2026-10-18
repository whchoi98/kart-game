---
description: Deploy TurboPalsStack to production by following docs/runbooks/deploy-production.md, then verify the live site
allowed-tools: Read, Glob, Grep, Bash(git status *), Bash(git branch *), Bash(git log *), Bash(git diff *), Bash(git rev-parse *), Bash(node --version), Bash(aws sts get-caller-identity *), Bash(docker info *), Bash(npm run typecheck), Bash(npm test), Bash(npm run test:harness), Bash(npm run synth), Bash(npx cdk diff *), Bash(npx tsx tools/sim-report.ts *), Bash(npm run deploy), Bash(npm run verify:live), Bash(npm run verify:live *), Bash(node tools/verify-live-pwa.mjs), Bash(node tools/verify-live-pwa.mjs *), Bash(curl -s *), Bash(curl -sI *)
argument-hint: "[expected version, e.g. 1.1.0]"
---

# Deploy

Build and deploy TURBO PALS GRAND PRIX (stack `TurboPalsStack`, account `061525506239`, region `ap-northeast-2`).
The Docker image (linux/arm64) is built locally from the repository and the CDK app deploys CloudFront, the ALB,
ECS Fargate, DynamoDB and the origin secret together.

Expected version (optional): $ARGUMENTS

## Step 1: Pre-Deploy Checks

Read `docs/runbooks/deploy-production.md` first; it is authoritative. If it disagrees with this command, follow the
runbook and tell the user. Stop at the first failed check and report it.

1. Clean tree: `git status --short` prints nothing. The image and the CDK app are built from the working tree; a
   clean tree guarantees that what is deployed is a commit.
2. Branch: `git branch --show-current` is `main`. Record the commit: `git rev-parse --short HEAD`.
3. Version: read `package.json`; if an expected version was given above, it must equal `version`.
4. Toolchain: `node --version` should satisfy `engines` (>= 22.12.0; older Node prints an AWS SDK
   NodeVersionSupportWarning - warn, do not block). `docker info --format '{{.ServerVersion}}'` succeeds.
5. Account: `aws sts get-caller-identity --query Account --output text` prints `061525506239`. The stack env is
   pinned to that account and `ap-northeast-2` through `cdk.json` context (and `infra/lib/stack.ts` throws for
   any other value), so credentials for another account only fail later, at deploy time.
6. Tests:
   ```bash
   npm run typecheck
   npm test
   npm run test:harness
   ```
7. Simulation version gate. Read the live version: `curl -s https://my-kart.whchoi.net/healthz` returns
   `{"ok":true,"version":"X.Y.Z+<12 hex>"}`. If its core `X.Y.Z` equals `package.json` `version`, list sim changes
   since that version was set:
   `git log --oneline $(git log -1 --format=%h -G '"version"' -- package.json)..HEAD -- src/sim`.
   If any exist, stop unless the user shows they do not change trajectories (identical
   `npx tsx tools/sim-report.ts` output before and after, refactor skill); otherwise run the release skill first.
   Commits that only add a brand-new track alter no existing replay and do not force a bump: compare `sim-report`
   output for the existing track ids only. Shipping a trajectory change on the same version leaves stale clients
   with `REPLAY_INVALID` instead of the clear `VERSION_MISMATCH`.
8. Synth and diff:
   ```bash
   npm run synth                     # cdk synth --quiet; cdk-nag violations fail here
   npx cdk diff TurboPalsStack       # compares with the deployed template (read-only)
   ```
   A normal code release changes the image asset, the task definition and the ECS service. Stop and ask the user
   if the diff replaces or removes `DataRankings44FBEC0A` (table), `DataOriginVerify0E337E8C` (origin secret),
   `AccessLogsBucketCD784A59`, `EdgeDistribution0060737B` (a new distribution changes the CloudFront hostname that
   the custom domain's CNAME points to) or touches security groups, the listener or its rule unexpectedly.

## Step 2: Follow Runbook

Deploy exactly as `docs/runbooks/deploy-production.md` says. The command is:

```bash
npm run deploy    # cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

There is no approval prompt, which is why Step 1 must pass first. It builds the arm64 image, publishes it, and
updates the stack (about four minutes for the last release). ECS replaces tasks with 100 % minimum healthy; the
deployment circuit breaker rolls back a task set that fails its health checks. `cdk-outputs.json` (git-ignored) is
rewritten with `SiteUrl`, `NativeSiteUrl`, `DistributionId`, `AlbDnsName`, `ClusterName`, `ServiceName` and
`TableName`.

## Step 3: Verify

```bash
curl -s https://my-kart.whchoi.net/healthz                                  # version core = package.json version
npm run verify:live                                                         # 35 checks via the native CloudFront host
npm run verify:live -- --custom --out docs/quality/live-verify-custom.json  # same checks via https://my-kart.whchoi.net
node tools/verify-live-pwa.mjs https://my-kart.whchoi.net                   # 8 headless PWA/offline checks
```

- `verify:live` needs AWS credentials, `dig` and `curl`. It reads the stack, checks the topology, headers and API,
  submits a real verified time trial (re-simulated locally first, so run it only from the commit just deployed) and
  deletes its QA rows from the production table. Success ends with `35/35 checks passed` and the report path
  (default `docs/quality/live-verify.json`); any failure sets exit code 1.
- `verify-live-pwa.mjs` needs Playwright Chromium (`bash scripts/setup.sh --with-browsers`). It exits 1 on any
  failure and saves screenshots in `test-results/live-pwa/`. One check asserts the release has no `?debug` hook.

## Step 4: Summary

Display:
- What was deployed and where: commit, `package.json` version, `/healthz` version, `SiteUrl` and `NativeSiteUrl`.
- Deployment method: `npm run deploy` per `docs/runbooks/deploy-production.md`.
- Verification results: `verify:live` native and custom pass counts, PWA checks, report files written.
- Follow-ups: commit the refreshed `docs/quality/*.json` reports if the user wants them recorded.

## Error Recovery

### If pre-deploy checks fail (Step 1)
- Dirty tree or wrong branch: ask the user whether to commit, stash (`git stash`) or switch (`git checkout main`);
  do not do it silently.
- Wrong account: switch the AWS profile; never edit the guards in `infra/lib/stack.ts`.
- `domainName and certificateArn must be configured together.`: both context values in `cdk.json` must be set or
  both cleared (see `docs/runbooks/custom-domain.md`).
- cdk-nag error in synth: fix the resource or add `cdk.Validations.of(x).acknowledge({ id, reason })` with a real
  reason, then rerun `npx vitest run test/infra`.

### If deployment fails (Step 2)
CloudFormation rolls the stack back by itself. Inspect, read-only:

```bash
aws cloudformation describe-stack-events --stack-name TurboPalsStack --region ap-northeast-2 --max-items 25
aws ecs describe-services --cluster <ClusterName> --services <ServiceName> --region ap-northeast-2 --query 'services[0].events[:10]'
aws logs describe-log-groups --log-group-name-prefix TurboPalsStack-ComputeAppLogs --region ap-northeast-2
aws logs tail <logGroupName> --since 30m --region ap-northeast-2
```

`ClusterName` and `ServiceName` come from `cdk-outputs.json`. Fix the cause, then rerun from Step 1.

### If verification fails (Step 3)
- Honest run rejected (`REPLAY_INVALID`, `TIME_MISMATCH` or `LAP_MISMATCH`; `verify:live` submits the server's own
  `/healthz` version, so it never sees `VERSION_MISMATCH`): the local checkout differs from the deployed build.
  Redeploy this commit or check out the deployed one before rerunning `npm run verify:live`.
- Custom domain check fails while the native run passes: follow `docs/runbooks/custom-domain.md` (the DNS zone is
  in another AWS account). A user who cannot reach the site while checks pass usually has a stale local DNS cache:
  compare with `dig +short my-kart.whchoi.net @8.8.8.8`.
- Direct ALB access not blocked, missing security headers, or unhealthy targets: treat it as an incident,
  `docs/runbooks/incident-response.md`.

### If a bad deployment was published - rollback
Follow `docs/runbooks/rollback-production.md` after confirming with the user: check out the last good commit and
deploy it with this command, or, in an emergency, point the ECS service back at the previous task definition
revision. For a rollback the branch check in Step 1 does not apply (the checkout is detached) and the version gate
is skipped; every other check still runs. The Rankings table has point-in-time recovery enabled; restore data only
together with the user.

Never run `cdk destroy`, delete the stack, the Rankings table or the origin secret, force-push, or deploy a QA
build (`TURBO_DEBUG_HOOK=1`). `.claude/settings.json` denies the destructive commands; teardown is a separate,
explicit user decision (`docs/runbooks/teardown.md`).
