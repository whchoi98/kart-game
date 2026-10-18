# Shared Contracts Module

## Role
- Constants and types that must agree across process boundaries. The Fastify server imports both files, the browser client imports `api.ts` and the CDK app imports `csp.ts`, so one edit reaches every side at the next build and deploy.
- `api.ts` imports only types from `src/sim/types.ts`; `csp.ts` imports nothing. Keep both free of Node, DOM and CDK imports so every side can bundle them.

## Key Files
- `api.ts` - HTTP contract: `API_LIMITS` (`nameMin` 1, `nameMax` 12, `logMax` 200000 base64 characters, `leaderboardSize` 50); `LeaderboardEntry`, `LeaderboardResponse`, `SubmitRunRequest`, `SubmitRunResponse`, `GhostResponse`, `ApiError`; the `RunRejectionCode` union (`REPLAY_INVALID`, `VERSION_MISMATCH`, `TIME_MISMATCH`, `LAP_MISMATCH`, `DUPLICATE_RUN`).
- `csp.ts` - browser security policy: `CSP_DIRECTIVES`, `contentSecurityPolicy({ upgradeInsecureRequests })`, `CONTENT_SECURITY_POLICY` (with `upgrade-insecure-requests`), `PERMISSIONS_POLICY` (only `autoplay`, `fullscreen`, `gamepad`, `screen-wake-lock` allowed, for self), `REFERRER_POLICY`, `FRAME_OPTIONS`, `CROSS_ORIGIN_OPENER_POLICY`, `CROSS_ORIGIN_RESOURCE_POLICY`, `HSTS_MAX_AGE_SECONDS`, `CLIENT_IP_HEADER` (`x-turbo-client-ip`).
- Importers: `api.ts` by `src/server/` (app, validation, repositories) and `src/client/` (`api.ts`, `storage.ts`, UI screens); `csp.ts` by `src/server/security.ts` and `infra/lib/edge.ts`.

## Rules
### api.ts (HTTP contract)
- The types are compile-time only. The server enforces the contract with JSON schemas in `src/server/validation.ts`; the client re-checks payloads in `src/client/api.ts`. Change these together:
  - Request field: `submitRunSchema` and `SubmitRunBody` (`additionalProperties: false`, so an unknown field is a 400), the `POST /api/runs` handler in `src/server/app.ts`, `isSubmitRequest` and `sanitizePending` in `src/client/storage.ts` (queued offline runs that fail `isSubmitRequest` are discarded; `sanitizePending` copies the request field by field, so a new optional field it does not list is silently dropped from queued runs) and `runBody` in `test/server/helpers.ts`.
  - Response field: the response schema (`entrySchema`/`leaderboardResponseSchema`, `ghostResponseSchema`, `submitResponseSchema`; allow-lists that silently drop unknown fields and keep `playerId` out), `toEntry`/`toGhost` in `src/server/repository.ts` and both repositories, and `submitRun` in `src/client/api.ts`, which rebuilds the response field by field (`fetchLeaderboard` spreads entries, `fetchGhost` returns the body).
  - Docs and mocks: `docs/api-reference.md`, `docs/reference/api.md` (the doc-sync hook reminds you), `src/client/ui/mock-api.ts`.
- Clients keep running a cached PWA build after a deploy, so evolve the contract additively: optional fields, no renames or removals. A new required request field turns every older client's submission into a 400.
- `API_LIMITS` is read on both sides: `logMax` is the schema `maxLength` of `log` and the bound in `isSubmitRequest`; `nameMin`/`nameMax` bound `normalizeName` (the raw schema allows 64 characters), the client name inputs and `src/client/ui/format.ts`; `leaderboardSize` is the server's board size and the client's row cap. Keep `logMax` below `BODY_LIMIT` (256 KiB, `src/server/validation.ts`); the replay decode limit `MAX_TT_TICKS` (`src/sim/replay.ts`) is separate.
- `RunRejectionCode` documents the codes but nothing imports it (`compareResult` in `src/server/app.ts` returns a plain string). To add a code: extend the union, emit it from `compareResult` (sent as 422) or the route, add a Korean message to `CODE_MESSAGES` in `src/client/api.ts` (otherwise `describeRejection` guesses from substrings), cover it in `test/server/runs.test.ts`, and document it.
- Rejection bodies are `SubmitRunResponse` plus `error` (the code) and `message`; only 200 responses have a response schema, so these extra fields pass.

### csp.ts (security headers)
- One source for both header layers. Origin: `SECURITY_HEADERS` in `src/server/security.ts` sends `contentSecurityPolicy()` without `upgrade-insecure-requests` (the server also runs over plain HTTP locally and in Docker) plus Permissions-Policy, Referrer-Policy, X-Frame-Options, COOP and CORP. Edge: the CloudFront response headers policy in `infra/lib/edge.ts` (attached to every behavior) sends `CONTENT_SECURITY_POLICY`, HSTS (`HSTS_MAX_AGE_SECONDS`, include subdomains), Permissions-Policy, COOP and CORP with `override: true`, so production browsers see the edge values.
- `infra/lib/edge.ts` uses CDK enums for frame options (`HeadersFrameOption.DENY`) and referrer policy (`HeadersReferrerPolicy.NO_REFERRER`) instead of `FRAME_OPTIONS`/`REFERRER_POLICY`: change those in both places by hand.
- Viewers see a change only after `npm run deploy` (CDK updates the response headers policy and the container image together). Check it first with `npm run synth` and the infra tests.
- Keep the policy self-only: no remote hosts, no `'unsafe-eval'`, no inline `<script>`. `style-src 'unsafe-inline'` exists only for the splash CSS inlined in `src/client/index.html`; `blob:`/`data:` cover generated textures and synthesized audio (rationale in the file header). Something the policy blocks fails only in the browser console, so load the game after any change.
- `CLIENT_IP_HEADER` is the edge-to-origin contract: the viewer-request function (`VIEWER_IP_FUNCTION_CODE`) overwrites it with the viewer IP, the `/assets/*` origin request policy allow-lists only this header, and `clientKey` in `src/server/security.ts` uses it as the rate-limit key (never logged or stored).
- After editing `csp.ts`, update `docs/reference/security.md` (the doc-sync hook reminds you).

## Testing
- `npx vitest run test/server test/infra`. `test/server/http.test.ts` checks that responses (health, API, 404) carry `contentSecurityPolicy()` and that the origin CSP has no `https?:`, `'unsafe-eval'`, `*` or `upgrade-insecure-requests`; it also hard-codes `DENY`, `no-referrer` and a few Permissions-Policy entries.
- `test/infra/stack.test.ts` synthesizes the stack locally and checks the response headers policy against `CONTENT_SECURITY_POLICY` and `PERMISSIONS_POLICY`, but hard-codes `DENY`, `no-referrer`, the HSTS max age `31_536_000` and the `x-turbo-client-ip` header; `test/server/rate-limit.test.ts` and `test/server/validation.test.ts` also hard-code the header name. Update those literals when you change the constants.
- `test/server/runs.test.ts` covers the request limits and every rejection code; run `npm run typecheck` after any type change (it covers `infra/` too).
