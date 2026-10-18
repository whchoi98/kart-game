# API Reference

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

The TURBO PALS GRAND PRIX server (Fastify 5, `src/server/`) exposes a small JSON API for the time-trial leaderboard: read a board, download a ghost, submit a run. The same process also serves the built game client and a health check. Request and response types are defined once in `src/shared/api.ts` and shared by the server and the browser client (`src/client/api.ts`). Server internals are described in [docs/reference/api.md](reference/api.md).

## Base URL

| Environment | Base URL | Notes |
| --- | --- | --- |
| Production | `https://my-kart.whchoi.net` | Custom domain, same origin as the game |
| Production (native host) | `https://d374w2735k9eto.cloudfront.net` | Default CloudFront hostname of the same distribution and build |
| Local (`npm run dev`) | `http://localhost:8200` | Vite proxies `/api` and `/healthz` to Fastify on `127.0.0.1:8201` (in-memory leaderboard) |
| Local (`npm run build && npm start`) | `http://127.0.0.1:8080` | Production bundle; in-memory leaderboard unless `TABLE_NAME` is set |

There is no versioned prefix. API routes live under `/api/`, the health check is `/healthz`, and every other path belongs to the game client. Plain HTTP requests to the production hosts are redirected to HTTPS with 301.

## Authentication

The API has no authentication: no accounts, cookies, tokens or API keys. These mechanisms take their place:

- **Anonymous player id.** On first use the browser generates a UUID v4, keeps it in `localStorage` (`tpgp.v1.playerId`) and sends it as `playerId` with every run. The server uses it only to keep one leaderboard row per player and board and to record who first registered an input log. No response contains it.
- **Origin allow-list (POST only).** When a `POST /api/runs` request carries an `Origin` header, the value must exactly equal a configured origin (`PUBLIC_ORIGIN` plus `ALLOWED_ORIGINS`, at most 16). Production allows `https://my-kart.whchoi.net` and `https://d374w2735k9eto.cloudfront.net`. Without configuration (for example a local `npm start`) only same-host origins pass. Requests without `Origin` come from non-browser clients; they are accepted and rely on replay verification.
- **Replay verification.** A submitted time is stored only when the server re-simulates the input log to exactly the claimed `ticks` and `lapTicks`.
- **Rate limits** per client IP address (see Rate Limits below).
- **No CORS.** The server sends no `Access-Control-*` headers and answers `OPTIONS` with 404, so pages on other origins can neither read API responses nor send JSON POSTs from a browser.

## Conventions

- Request and response bodies are JSON (`application/json; charset=utf-8`).
- Times are integers in 60 Hz simulation ticks: seconds = `ticks / 60`. For example, 5608 ticks is 93.47 s.
- `cc` is the speed class: 50, 100, 150 or 200.
- Validation is strict: no type coercion, and unknown body fields or query parameters return 400.
- Every response carries the security headers listed in [docs/reference/security.md](reference/security.md).
- The server compresses responses of 1024 bytes or more with `br` or `gzip` when the request's `Accept-Encoding` allows it.

## Endpoints

| Method | Path | Purpose | Rate-limit budget | Cache-Control |
| --- | --- | --- | --- | --- |
| `GET`, `HEAD` | `/healthz` | Liveness and deployed version | exempt | `no-store` |
| `GET` | `/api/leaderboard` | Top 50 of one track and speed class | read | `no-store` |
| `GET` | `/api/ghost/:id` | Input log of a ranked run | read | `private, max-age=3600, immutable` |
| `POST` | `/api/runs` | Submit a time-trial run for verification | submit | `no-store` |
| `GET`, `HEAD` | `/`, `/assets/*`, other paths | Game client and SPA fallback | page | see Static files and SPA fallback |

Any other method or path under `/api/` returns 404 `NOT_FOUND` and is charged to the read budget.

### GET /healthz

Reports that the process is up and which build it runs. It does not touch DynamoDB or the verifier, so it returns 200 even while storage is failing.

#### Request

```http
GET /healthz HTTP/1.1
Host: my-kart.whchoi.net
```

#### Response

`200 OK`

```json
{ "ok": true, "version": "1.0.0+bc87c1a48e07" }
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | boolean | Always `true` |
| `version` | string | Server version (`APP_VERSION`). In production: the `package.json` version, `+`, then the first 12 hex characters of the container image asset hash. Only the part before `+` is compared with a submitted run's `version` |

Notes:

- `HEAD /healthz` is answered as well.
- Not rate limited. Successful responses are not written to the access log.
- Callers: the ALB target group health check (every 15 s), the ECS container health check (every 30 s) and the Dockerfile `HEALTHCHECK` (every 20 s, used by a local `docker run`).

```bash
curl -s https://my-kart.whchoi.net/healthz
```

### GET /api/leaderboard

Returns the fastest verified run of each player on one board (track and speed class), fastest first.

#### Query parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `track` | string | Yes | Track id: `sunny-meadow`, `palm-beach`, `canyon-rally`, `neon-city`, `frost-peak`, `jungle-ruins`, `lava-fortress`, `starlight-road` |
| `cc` | string | Yes | Speed class: `50`, `100`, `150` or `200` |

Any other query parameter returns 400.

#### Request

```http
GET /api/leaderboard?track=sunny-meadow&cc=150 HTTP/1.1
Host: my-kart.whchoi.net
Accept: application/json
```

#### Response

`200 OK` (`LeaderboardResponse`)

```json
{
  "trackId": "sunny-meadow",
  "cc": 150,
  "entries": [
    {
      "rank": 1,
      "id": "0mvdlxfk73c9e1a7b52d04f86",
      "name": "레이서",
      "charId": "kiki",
      "trackId": "sunny-meadow",
      "cc": 150,
      "ticks": 5608,
      "lapTicks": [1800, 1901, 1907],
      "createdAt": "2026-10-18T09:12:34.567Z"
    },
    {
      "rank": 2,
      "id": "0mvcvvd5c8f02b61d9e4a7c35",
      "name": "PipFan_07",
      "charId": "pip",
      "trackId": "sunny-meadow",
      "cc": 150,
      "ticks": 5731,
      "lapTicks": [1846, 1942, 1943],
      "createdAt": "2026-10-17T21:03:08.112Z"
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `trackId` | string | Echo of `track` |
| `cc` | integer | Echo of `cc`, as a number |
| `entries` | `LeaderboardEntry[]` | 0 to 50 rows (`API_LIMITS.leaderboardSize`), one per player |
| `entries[].rank` | integer | 1-based position |
| `entries[].id` | string | Run id: 9 base36 characters of the creation time in milliseconds, then 16 random hex characters. Pass it to `GET /api/ghost/:id` |
| `entries[].name` | string | Normalized player name (1 to 12 characters) |
| `entries[].charId` | string | Character id |
| `entries[].trackId`, `entries[].cc` | string, integer | Board of the run |
| `entries[].ticks` | integer | Verified finish time in ticks |
| `entries[].lapTicks` | integer[] | Verified lap times in ticks; their sum equals `ticks` |
| `entries[].createdAt` | string | ISO 8601 time the run was stored |

Notes:

- Rows sort by `ticks` ascending; on a tie the earlier run comes first.
- An empty board returns `"entries": []`.
- Player ids are never included: the response schema is an allow-list.

```bash
curl -s 'https://my-kart.whchoi.net/api/leaderboard?track=sunny-meadow&cc=150'
```

### GET /api/ghost/:id

Returns the input log of a ranked run so the client can race against it as a ghost.

#### Path parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Run id from a leaderboard entry, pattern `^[0-9a-z]{9}[0-9a-f]{16}$` (25 characters). A value longer than 100 characters gets 404 `NOT_FOUND` when the server serves the built client (production) and 414 when it runs API-only |

No query parameters are accepted.

#### Request

```http
GET /api/ghost/0mvdlxfk73c9e1a7b52d04f86 HTTP/1.1
Host: my-kart.whchoi.net
Accept: application/json
```

#### Response

`200 OK` (`GhostResponse`)

```json
{
  "id": "0mvdlxfk73c9e1a7b52d04f86",
  "trackId": "sunny-meadow",
  "cc": 150,
  "charId": "kiki",
  "name": "레이서",
  "ticks": 5608,
  "log": "AQA/AJIAvwAjAOQAAQDgAAEA3QABANoAAQDXAAEA1QABANIA..."
}
```

The `log` value is shortened here. The full log of this 5608-tick run is 10,312 base64 characters and decodes to 5788 input words: 180 countdown ticks plus 5608 race ticks (format: `src/sim/input-log.ts`).

| Field | Type | Description |
| --- | --- | --- |
| `id`, `trackId`, `cc`, `charId`, `name`, `ticks` | as in `LeaderboardEntry` | Same meaning as in the leaderboard |
| `log` | string | Base64 run-length encoded input log, one 16-bit input word per tick |

Notes:

- `cache-control: private, max-age=3600, immutable`: a run id always names the same log.
- When the player later sets a faster time, the old run and its ghost are deleted and the old id returns 404 `NOT_FOUND`.
- Errors: 400 `INVALID_REQUEST` (`params.id` or `querystring.<name>`), 404 `NOT_FOUND`, 414 `INVALID_REQUEST` (API-only server), 429 `RATE_LIMITED`, 503 `SERVICE_UNAVAILABLE`.

### POST /api/runs

Submits a finished time trial. The server re-simulates the input log and stores the run only when the result matches the claim exactly and beats the player's previous best on that board.

#### Headers

| Header | Required | Rule |
| --- | --- | --- |
| `Content-Type` | Yes | `application/json`, optionally followed by `; charset=utf-8`. Anything else returns 415 |
| `Origin` | No | Sent by browsers. When present it must be an allowed origin, otherwise 403 |

The body may be at most 262,144 bytes (256 KiB, `BODY_LIMIT`); larger bodies return 413.

#### Request body

`SubmitRunRequest`. All nine fields are required and no other field is allowed.

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `trackId` | string | Yes | One of the 8 track ids | Track raced |
| `cc` | integer | Yes | `50`, `100`, `150` or `200` as a JSON number; the string `"150"` is rejected | Speed class |
| `charId` | string | Yes | `pip`, `bruno`, `mochi`, `rex`, `kiki`, `taro`, `hana`, `bolt` | Character |
| `name` | string | Yes | 1 to 64 characters as sent; 1 to 12 after normalization | Player name, see below |
| `playerId` | string | Yes | UUID v4, case-insensitive | Anonymous player id, stored in lowercase |
| `ticks` | integer | Yes | 1 to 108,000 | Claimed finish time; must equal the re-simulation |
| `lapTicks` | integer[] | Yes | 1 to 9 items, each 1 to 108,000 | Claimed lap times; must equal the re-simulation |
| `log` | string | Yes | 1 to 200,000 characters (`API_LIMITS.logMax`), pattern `^[A-Za-z0-9+/_=-]+$` | Encoded input log (`src/sim/input-log.ts`) |
| `version` | string | Yes | 1 to 64 characters, pattern `^[0-9A-Za-z][0-9A-Za-z.+_-]*$` | Client version: the `package.json` version of the build that recorded the run |

Name normalization: the server applies Unicode NFC, collapses whitespace runs into one space and trims. The result must be 1 to 12 characters drawn from Hangul syllables, compatibility jamo (U+3131 to U+3163), ASCII letters and digits, space, `_` and `-`, and must contain at least one letter, digit or Hangul character. Otherwise the response is 400 `INVALID_NAME`. U+3164 HANGUL FILLER is excluded because it renders as blank space.

Verification limit: the verifier decodes at most 43,380 input words (180 countdown ticks plus 12 minutes of racing). A longer run passes the schema but is rejected with 422.

#### Request

```http
POST /api/runs HTTP/1.1
Host: my-kart.whchoi.net
Origin: https://my-kart.whchoi.net
Content-Type: application/json
Accept: application/json
```

```json
{
  "trackId": "sunny-meadow",
  "cc": 150,
  "charId": "kiki",
  "name": "레이서",
  "playerId": "5f0c2a9e-7b1d-4c3e-8a2b-1d4e6f8a0c2b",
  "ticks": 5608,
  "lapTicks": [1800, 1901, 1907],
  "log": "AQA/AJIAvwAjAOQAAQDgAAEA3QABANoAAQDXAAEA1QABANIA...",
  "version": "1.0.0"
}
```

The `log` value is shortened as in the ghost example; a real request carries the full log.

#### Processing order

1. Submit rate limit: 429 `RATE_LIMITED`.
2. Origin check: 403 `FORBIDDEN_ORIGIN`.
3. Content type: 415 `UNSUPPORTED_MEDIA_TYPE`.
4. Body parsing: 413 `PAYLOAD_TOO_LARGE`; malformed JSON or a `__proto__` or `constructor.prototype` key returns 400 `INVALID_REQUEST`.
5. Schema validation: 400 `INVALID_REQUEST` naming the first failing field (`body.<field>`, or `querystring.<name>` for any query parameter).
6. Name normalization: 400 `INVALID_NAME`.
7. Re-simulation on the verifier worker pool: 503 `VERIFIER_BUSY` when 32 runs are already waiting or the wait exceeds 6 s. A run that exceeds the 8 s CPU budget is rejected with 422.
8. Comparison with the claim: 422 `VERSION_MISMATCH`, `REPLAY_INVALID`, `TIME_MISMATCH` or `LAP_MISMATCH`.
9. Storage: 409 `DUPLICATE_RUN`; storage failures return 503 `SERVICE_UNAVAILABLE`.

Steps 1 to 3 run before the body is parsed, so malformed requests still consume the submit budget.

#### Response

`200 OK` (`SubmitRunResponse`) for a new personal best:

```json
{ "accepted": true, "id": "0mvdlxfk73c9e1a7b52d04f86", "rank": 1, "personalBest": true }
```

| Field | Type | Description |
| --- | --- | --- |
| `accepted` | boolean | `true` when the run was verified, even if it did not beat the previous best; `false` on 422 and 409 |
| `id` | string | Id of the player's current best run on this board; empty on rejection |
| `rank` | integer or null | 1-based rank of that best among other players' bests; `null` outside the top 50 or on rejection |
| `personalBest` | boolean | `true` when this run is now the player's best on this board |
| `reason` | string | Korean explanation, present only on rejection |

Behaviour to rely on:

- A verified run that is not faster than the player's stored best returns 200 with `personalBest: false` and the id and rank of the existing best. Nothing is written.
- Resubmitting the same log for the same player returns 200 with `personalBest: true` and the original id. Nothing is written, so retrying after a client timeout is safe.

Rejected run, `422 Unprocessable Entity`:

```json
{
  "accepted": false,
  "id": "",
  "rank": null,
  "personalBest": false,
  "reason": "제출한 완주 시간이 서버 재시뮬레이션 결과와 다릅니다.",
  "error": "TIME_MISMATCH",
  "message": "제출한 완주 시간이 서버 재시뮬레이션 결과와 다릅니다."
}
```

409 `DUPLICATE_RUN` uses the same shape.

### Static files and SPA fallback

When the built client is present (`STATIC_DIR`, default `dist/client`), the same server answers every non-API `GET` and `HEAD`:

| Path | Response | Cache-Control |
| --- | --- | --- |
| `/` | `index.html` | `no-cache` |
| `/assets/*` | Content-hashed bundle files | `public, max-age=31536000, immutable` |
| Other files: `/sw.js`, `/manifest.webmanifest`, `/build.json`, `/favicon.svg`, `/icon-maskable.svg`, `/icons/*` | The file | `no-cache` |
| Paths without a file extension outside `/api`, `/healthz` and `/assets/` | `index.html` (client-side route) | `no-cache` |
| Missing files, dotfiles such as `/.env`, missing assets such as `/assets/missing.js` | 404 `NOT_FOUND` as JSON, never HTML | `no-store` |

Static responses carry `ETag` and `Last-Modified`, support `Range` requests (206, or 416 `RANGE_NOT_SATISFIABLE`) and are charged to the page budget. In production the server refuses to start without `dist/client/index.html`.

## Rejection Codes

`RunRejectionCode` (`src/shared/api.ts`) lists the reasons a submitted run can be refused after parsing. `compareResult()` in `src/server/app.ts` checks them in this order; `DUPLICATE_RUN` comes from the storage step.

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `VERSION_MISMATCH` | 422 | Re-simulation failed and the semver core of `version` (the part before `+`) differs from the server's | Reload to get the current build, then race again |
| `REPLAY_INVALID` | 422 | Re-simulation failed with matching versions: malformed or truncated log, input after the finish, the run did not finish, more than 43,380 input words, the simulation threw, or the 8 s CPU budget ran out | Do not resubmit the same log |
| `TIME_MISMATCH` | 422 | The log finishes, but at a tick count different from `ticks` | Do not resubmit |
| `LAP_MISMATCH` | 422 | Lap count or lap times differ from `lapTicks` | Do not resubmit |
| `DUPLICATE_RUN` | 409 | Another player already registered this input sequence, for example a downloaded ghost (re-encoded or not) | Submit only your own runs |

`VERSION_MISMATCH` is reported only when re-simulation fails: a run from an older client that still re-simulates to its claimed result is accepted. Build metadata after `+` is ignored.

## Error Format

Every error the application produces has this body (`ApiError`):

```json
{ "error": "INVALID_REQUEST", "message": "요청 형식이 올바르지 않습니다: body.log" }
```

| Field | Type | Description |
| --- | --- | --- |
| `error` | string | Stable machine code, see Status Codes |
| `message` | string | Korean text that can be shown to players. Validation errors append the first failing field as `body.<field>`, `querystring.<field>` or `params.<field>` |

- Run rejections (422 and 409) use the `SubmitRunResponse` shape with `error` and `message` added.
- 429 and 503 responses include a `Retry-After` header in seconds.
- Internal details (exception messages, file paths, input values) never reach the client. Unexpected failures become 503 `SERVICE_UNAVAILABLE`.
- Two exceptions do not use this format. While a task drains after `SIGTERM`, Fastify answers requests that still arrive with its own 503 body (`{"error":"Service Unavailable","message":"Service Unavailable","statusCode":503}`). Errors generated by CloudFront or the ALB themselves, such as 502 or 504, carry their own bodies.

## Status Codes

| HTTP | `error` | Returned by | Cause | Retry-After |
| --- | --- | --- | --- | --- |
| 200 | none | all | Success | none |
| 206 | none | static files | Partial content for a `Range` request | none |
| 400 | `INVALID_REQUEST` | all | Schema violation, unknown parameter, malformed JSON, prototype-poisoning key, bad percent-encoding in the URL | none |
| 400 | `INVALID_NAME` | `POST /api/runs` | Name fails normalization | none |
| 403 | `FORBIDDEN_ORIGIN` | `POST /api/runs` | `Origin` is not allowed | none |
| 404 | `NOT_FOUND` | all | Unknown route or method, missing ghost, missing static file, route parameter longer than 100 characters while the built client is served | none |
| 409 | `DUPLICATE_RUN` | `POST /api/runs` | Input sequence owned by another player | none |
| 413 | `PAYLOAD_TOO_LARGE` | `POST /api/runs` | Body over 262,144 bytes | none |
| 414 | `INVALID_REQUEST` | `GET /api/ghost/:id` | Route parameter longer than 100 characters on an API-only server (no built client, so no wildcard route catches it) | none |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `POST /api/runs` | Body is not `application/json` | none |
| 416 | `RANGE_NOT_SATISFIABLE` | static files | Unsatisfiable `Range` | none |
| 422 | `REPLAY_INVALID`, `VERSION_MISMATCH`, `TIME_MISMATCH`, `LAP_MISMATCH` | `POST /api/runs` | See Rejection Codes | none |
| 429 | `RATE_LIMITED` | all except `/healthz` | Budget exhausted | Seconds until the window resets, at least 1 |
| 503 | `VERIFIER_BUSY` | `POST /api/runs` | 32 runs already waiting, or the 6 s queue wait exceeded | 3 |
| 503 | `SERVICE_UNAVAILABLE` | all | Storage failure, verifier unavailable, unexpected error; in in-memory mode also a full store (5000 runs) | 2 |

## Caching

| Response | `Cache-Control` | Reason |
| --- | --- | --- |
| `/healthz`, `/api/leaderboard`, `/api/runs` | `no-store` | Always fresh |
| `/api/ghost/:id` with 200 | `private, max-age=3600, immutable` | A run id names one immutable log |
| Any response with status 400 or higher | `no-store` | Errors are never cached |
| `/assets/*` | `public, max-age=31536000, immutable` | Content-hashed file names |
| `index.html`, `/sw.js` and other root files | `no-cache` | Revalidated so a deploy is picked up at once |

CloudFront caches only `/assets/*`, for up to 365 days. The default behavior and `/api/*` use the managed `CachingDisabled` policy, and error responses have an edge TTL of 0. The bundled client requests every API URL with `cache: 'no-store'`, and its service worker always sends `/api/*` and `/healthz` to the network.

## Rate Limits

| Budget | Limit per client per 60 s | Applies to |
| --- | --- | --- |
| submit | 12 | `POST /api/runs` |
| read | 120 | `GET /api/leaderboard` and `GET /api/ghost/:id` (one shared budget), plus any unmatched `/api/*` request regardless of method |
| page | 600 | `/`, static files, client-side routes, other non-API 404s |
| exempt | none | `GET` and `HEAD /healthz` |

- Response headers: `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds until the window resets). A 429 adds `retry-after`.
- Client key: the `x-turbo-client-ip` header when it holds a valid IP address, otherwise the TCP peer address. The CloudFront viewer-request function overwrites this header with the viewer IP, so a client cannot choose its own key. IPv6 addresses are grouped by /64, and IPv4-mapped IPv6 addresses count as IPv4.
- Requests are charged before validation, so malformed and rejected requests count too.
- Counters live in memory inside each Fargate task (`@fastify/rate-limit` default store, up to 20,000 keys). The service runs 2 to 6 tasks behind the ALB, so a client whose requests land on several tasks can get up to that many times these limits.
- The limits are constants (`DEFAULT_RATE_LIMITS` in `src/server/app.ts`), not environment variables.
- Requests the router rejects before any hook runs (bad percent-encoding, and on an API-only server a route parameter over 100 characters) are not counted and carry no rate-limit headers.

Example 429 response:

```http
HTTP/1.1 429 Too Many Requests
content-type: application/json; charset=utf-8
cache-control: no-store
retry-after: 37
x-ratelimit-limit: 12
x-ratelimit-remaining: 0
x-ratelimit-reset: 37
```

```json
{ "error": "RATE_LIMITED", "message": "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }
```

## Related Documents

- [docs/reference/api.md](reference/api.md): server internals (hooks, validation, verifier pool)
- [docs/reference/data.md](reference/data.md): storage layout behind the API
- [docs/reference/security.md](reference/security.md): headers, origin protection, anti-cheat
- [docs/architecture.md](architecture.md): system overview
- [src/shared/api.ts](../src/shared/api.ts): TypeScript contract

---

<a id="korean"></a>

# 한국어

TURBO PALS GRAND PRIX 서버(Fastify 5, `src/server/`)는 타임 어택 랭킹을 위한 작은 JSON API를 제공합니다. 순위를 조회하고, 고스트를 내려받고, 주행 기록을 제출하는 세 가지 기능입니다. 같은 프로세스가 빌드된 게임 클라이언트와 헬스 체크도 함께 서빙합니다. 요청·응답 타입은 `src/shared/api.ts` 한 곳에 정의되어 서버와 브라우저 클라이언트(`src/client/api.ts`)가 같이 씁니다. 서버 내부 구현은 [docs/reference/api.md](reference/api.md)에 정리되어 있습니다.

## 기본 URL

| 환경 | 기본 URL | 비고 |
| --- | --- | --- |
| 프로덕션 | `https://my-kart.whchoi.net` | 커스텀 도메인, 게임과 같은 origin |
| 프로덕션(기본 호스트) | `https://d374w2735k9eto.cloudfront.net` | 같은 배포·같은 빌드의 CloudFront 기본 호스트 이름 |
| 로컬(`npm run dev`) | `http://localhost:8200` | Vite가 `/api`와 `/healthz`를 `127.0.0.1:8201`의 Fastify로 프록시(메모리 랭킹) |
| 로컬(`npm run build && npm start`) | `http://127.0.0.1:8080` | 프로덕션 번들. `TABLE_NAME`을 지정하지 않으면 메모리 랭킹 |

버전 접두사는 없습니다. API 라우트는 `/api/` 아래에, 헬스 체크는 `/healthz`에 있고, 나머지 경로는 모두 게임 클라이언트 몫입니다. 프로덕션 호스트로 들어온 평문 HTTP 요청은 301로 HTTPS에 리디렉션됩니다.

## 인증

API에는 인증이 없습니다. 계정, 쿠키, 토큰, API 키 모두 쓰지 않으며 다음 장치가 그 역할을 대신합니다.

- **익명 플레이어 ID.** 브라우저가 처음 실행될 때 UUID v4를 만들어 `localStorage`(`tpgp.v1.playerId`)에 보관하고, 기록을 제출할 때마다 `playerId`로 보냅니다. 서버는 이 값을 보드마다 플레이어당 한 행만 남기고, 입력 로그를 처음 등록한 사람을 기록하는 데에만 씁니다. 어떤 응답에도 포함되지 않습니다.
- **Origin 허용 목록(POST 전용).** `POST /api/runs` 요청에 `Origin` 헤더가 있으면 설정된 origin(`PUBLIC_ORIGIN`과 `ALLOWED_ORIGINS`, 최대 16개) 중 하나와 정확히 일치해야 합니다. 프로덕션은 `https://my-kart.whchoi.net`과 `https://d374w2735k9eto.cloudfront.net`을 허용합니다. 설정이 없으면(예: 로컬 `npm start`) 같은 호스트의 origin만 통과합니다. `Origin`이 없는 요청은 브라우저가 아닌 클라이언트가 보낸 것으로 보고 받아들이며, 이때는 재시뮬레이션 검증에 기댑니다.
- **재시뮬레이션 검증.** 서버가 입력 로그를 다시 시뮬레이션해 주장한 `ticks`, `lapTicks`와 정확히 같은 결과가 나올 때만 기록을 저장합니다.
- **클라이언트 IP별 요청 한도**(아래 요청 한도 참고).
- **CORS 없음.** 서버는 `Access-Control-*` 헤더를 보내지 않고 `OPTIONS`에는 404로 답합니다. 따라서 다른 origin의 페이지는 브라우저에서 API 응답을 읽을 수도, JSON POST를 보낼 수도 없습니다.

## 공통 규칙

- 요청·응답 본문은 JSON(`application/json; charset=utf-8`)입니다.
- 시간은 60 Hz 시뮬레이션 tick 단위의 정수입니다. 초 = `ticks / 60`이며, 예를 들어 5608 tick은 93.47초입니다.
- `cc`는 속도 클래스로 50, 100, 150, 200 중 하나입니다.
- 검증은 엄격합니다. 타입을 자동 변환하지 않으며, 모르는 본문 필드나 쿼리 파라미터가 있으면 400을 돌려줍니다.
- 모든 응답에 [docs/reference/security.md](reference/security.md)에 나열된 보안 헤더가 붙습니다.
- 응답이 1024바이트 이상이고 요청의 `Accept-Encoding`이 허용하면 서버가 `br` 또는 `gzip`으로 압축합니다.

## 엔드포인트

| 메서드 | 경로 | 용도 | 요청 한도 예산 | Cache-Control |
| --- | --- | --- | --- | --- |
| `GET`, `HEAD` | `/healthz` | 생존 확인과 배포 버전 | 면제 | `no-store` |
| `GET` | `/api/leaderboard` | 트랙·속도 클래스별 상위 50위 | read | `no-store` |
| `GET` | `/api/ghost/:id` | 순위에 오른 기록의 입력 로그 | read | `private, max-age=3600, immutable` |
| `POST` | `/api/runs` | 타임 어택 기록 제출과 검증 | submit | `no-store` |
| `GET`, `HEAD` | `/`, `/assets/*`, 그 밖의 경로 | 게임 클라이언트와 SPA 폴백 | page | 정적 파일과 SPA 폴백 참고 |

`/api/` 아래의 그 밖의 메서드나 경로는 404 `NOT_FOUND`를 돌려주고 read 예산에서 차감됩니다.

### GET /healthz

프로세스가 살아 있는지와 어떤 빌드가 실행 중인지 알려 줍니다. DynamoDB나 검증기는 확인하지 않으므로 저장소에 장애가 있어도 200을 돌려줍니다.

#### 요청

```http
GET /healthz HTTP/1.1
Host: my-kart.whchoi.net
```

#### 응답

`200 OK`

```json
{ "ok": true, "version": "1.0.0+bc87c1a48e07" }
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `ok` | boolean | 항상 `true` |
| `version` | string | 서버 버전(`APP_VERSION`). 프로덕션에서는 `package.json` 버전, `+`, 컨테이너 이미지 asset 해시 앞 12자리 hex 순입니다. 제출된 기록의 `version`과는 `+` 앞부분만 비교합니다 |

참고:

- `HEAD /healthz`에도 응답합니다.
- 요청 한도 대상이 아니며, 성공 응답은 접근 로그에 남기지 않습니다.
- 호출하는 곳: ALB 대상 그룹 헬스 체크(15초 간격), ECS 컨테이너 헬스 체크(30초 간격), Dockerfile `HEALTHCHECK`(20초 간격, 로컬 `docker run`에서 사용).

```bash
curl -s https://my-kart.whchoi.net/healthz
```

### GET /api/leaderboard

보드 하나(트랙과 속도 클래스)에서 플레이어별로 가장 빠른 검증 기록을 빠른 순서대로 돌려줍니다.

#### 쿼리 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `track` | string | 예 | 트랙 ID: `sunny-meadow`, `palm-beach`, `canyon-rally`, `neon-city`, `frost-peak`, `jungle-ruins`, `lava-fortress`, `starlight-road` |
| `cc` | string | 예 | 속도 클래스: `50`, `100`, `150`, `200` |

이 밖의 쿼리 파라미터가 있으면 400을 돌려줍니다.

#### 요청

```http
GET /api/leaderboard?track=sunny-meadow&cc=150 HTTP/1.1
Host: my-kart.whchoi.net
Accept: application/json
```

#### 응답

`200 OK` (`LeaderboardResponse`)

```json
{
  "trackId": "sunny-meadow",
  "cc": 150,
  "entries": [
    {
      "rank": 1,
      "id": "0mvdlxfk73c9e1a7b52d04f86",
      "name": "레이서",
      "charId": "kiki",
      "trackId": "sunny-meadow",
      "cc": 150,
      "ticks": 5608,
      "lapTicks": [1800, 1901, 1907],
      "createdAt": "2026-10-18T09:12:34.567Z"
    },
    {
      "rank": 2,
      "id": "0mvcvvd5c8f02b61d9e4a7c35",
      "name": "PipFan_07",
      "charId": "pip",
      "trackId": "sunny-meadow",
      "cc": 150,
      "ticks": 5731,
      "lapTicks": [1846, 1942, 1943],
      "createdAt": "2026-10-17T21:03:08.112Z"
    }
  ]
}
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `trackId` | string | 요청한 `track` 값 |
| `cc` | integer | 요청한 `cc` 값(숫자) |
| `entries` | `LeaderboardEntry[]` | 0~50행(`API_LIMITS.leaderboardSize`), 플레이어당 1행 |
| `entries[].rank` | integer | 1부터 시작하는 순위 |
| `entries[].id` | string | 기록 ID. 생성 시각(밀리초)을 base36으로 적은 9자 뒤에 무작위 hex 16자가 붙습니다. `GET /api/ghost/:id`에 그대로 넘깁니다 |
| `entries[].name` | string | 정규화된 플레이어 이름(1~12자) |
| `entries[].charId` | string | 캐릭터 ID |
| `entries[].trackId`, `entries[].cc` | string, integer | 기록이 속한 보드 |
| `entries[].ticks` | integer | 검증된 완주 시간(tick) |
| `entries[].lapTicks` | integer[] | 검증된 랩 시간(tick). 합계가 `ticks`와 같습니다 |
| `entries[].createdAt` | string | 기록이 저장된 ISO 8601 시각 |

참고:

- `ticks` 오름차순으로 정렬하고, 같으면 먼저 등록된 기록이 앞섭니다.
- 비어 있는 보드는 `"entries": []`를 돌려줍니다.
- 응답 스키마가 허용 목록 역할을 하므로 플레이어 ID는 절대 포함되지 않습니다.

```bash
curl -s 'https://my-kart.whchoi.net/api/leaderboard?track=sunny-meadow&cc=150'
```

### GET /api/ghost/:id

순위에 오른 기록의 입력 로그를 돌려줍니다. 클라이언트는 이 로그로 고스트와 대결합니다.

#### 경로 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 랭킹 항목의 기록 ID. 패턴 `^[0-9a-z]{9}[0-9a-f]{16}$`(25자). 100자를 넘는 값은 서버가 빌드된 클라이언트를 서빙할 때(프로덕션) 404 `NOT_FOUND`, API만 실행할 때 414를 받습니다 |

쿼리 파라미터는 받지 않습니다.

#### 요청

```http
GET /api/ghost/0mvdlxfk73c9e1a7b52d04f86 HTTP/1.1
Host: my-kart.whchoi.net
Accept: application/json
```

#### 응답

`200 OK` (`GhostResponse`)

```json
{
  "id": "0mvdlxfk73c9e1a7b52d04f86",
  "trackId": "sunny-meadow",
  "cc": 150,
  "charId": "kiki",
  "name": "레이서",
  "ticks": 5608,
  "log": "AQA/AJIAvwAjAOQAAQDgAAEA3QABANoAAQDXAAEA1QABANIA..."
}
```

예시의 `log`는 줄인 값입니다. 이 5608 tick 기록의 실제 로그는 base64 10,312자이고, 디코딩하면 입력 word 5788개(카운트다운 180 tick + 주행 5608 tick)가 나옵니다(포맷: `src/sim/input-log.ts`).

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `id`, `trackId`, `cc`, `charId`, `name`, `ticks` | `LeaderboardEntry`와 같음 | 랭킹 항목과 같은 의미 |
| `log` | string | base64로 인코딩한 run-length 입력 로그. tick마다 16비트 입력 word 1개 |

참고:

- `cache-control: private, max-age=3600, immutable`. 같은 기록 ID는 언제나 같은 로그를 가리킵니다.
- 플레이어가 나중에 더 빠른 기록을 세우면 이전 기록과 고스트가 삭제되고, 이전 ID는 404 `NOT_FOUND`를 돌려줍니다.
- 오류: 400 `INVALID_REQUEST`(`params.id` 또는 `querystring.<name>`), 404 `NOT_FOUND`, 414 `INVALID_REQUEST`(API 전용 서버), 429 `RATE_LIMITED`, 503 `SERVICE_UNAVAILABLE`.

### POST /api/runs

완주한 타임 어택 기록을 제출합니다. 서버는 입력 로그를 다시 시뮬레이션해 결과가 주장과 정확히 같고, 그 보드에서 플레이어의 이전 최고 기록보다 빠를 때만 저장합니다.

#### 헤더

| 헤더 | 필수 | 규칙 |
| --- | --- | --- |
| `Content-Type` | 예 | `application/json`이며 뒤에 `; charset=utf-8`을 붙일 수 있습니다. 그 밖의 값이면 415 |
| `Origin` | 아니요 | 브라우저가 보냅니다. 있으면 허용된 origin이어야 하며, 아니면 403 |

본문은 최대 262,144바이트(256 KiB, `BODY_LIMIT`)이며, 이를 넘으면 413을 돌려줍니다.

#### 요청 본문

`SubmitRunRequest`입니다. 9개 필드가 모두 필수이고, 다른 필드는 허용하지 않습니다.

| 필드 | 타입 | 필수 | 제한 | 설명 |
| --- | --- | --- | --- | --- |
| `trackId` | string | 예 | 트랙 ID 8개 중 하나 | 주행한 트랙 |
| `cc` | integer | 예 | JSON 숫자 `50`, `100`, `150`, `200`. 문자열 `"150"`은 거부 | 속도 클래스 |
| `charId` | string | 예 | `pip`, `bruno`, `mochi`, `rex`, `kiki`, `taro`, `hana`, `bolt` | 캐릭터 |
| `name` | string | 예 | 원문 1~64자, 정규화 후 1~12자 | 플레이어 이름(아래 참고) |
| `playerId` | string | 예 | UUID v4, 대소문자 무관 | 익명 플레이어 ID. 소문자로 저장 |
| `ticks` | integer | 예 | 1~108,000 | 주장하는 완주 시간. 재시뮬레이션 결과와 같아야 함 |
| `lapTicks` | integer[] | 예 | 1~9개, 각 1~108,000 | 주장하는 랩 시간. 재시뮬레이션 결과와 같아야 함 |
| `log` | string | 예 | 1~200,000자(`API_LIMITS.logMax`), 패턴 `^[A-Za-z0-9+/_=-]+$` | 인코딩된 입력 로그(`src/sim/input-log.ts`) |
| `version` | string | 예 | 1~64자, 패턴 `^[0-9A-Za-z][0-9A-Za-z.+_-]*$` | 클라이언트 버전. 기록을 남긴 빌드의 `package.json` 버전 |

이름 정규화: 서버는 Unicode NFC를 적용하고, 연속된 공백을 한 칸으로 줄인 뒤 앞뒤 공백을 지웁니다. 결과는 한글 음절, 호환용 자모(U+3131~U+3163), ASCII 영문과 숫자, 공백, `_`, `-`로만 이루어진 1~12자여야 하고, 영문·숫자·한글이 한 글자 이상 있어야 합니다. 조건을 벗어나면 400 `INVALID_NAME`을 돌려줍니다. U+3164 HANGUL FILLER는 화면에 빈칸으로 보이므로 허용하지 않습니다.

검증 한도: 검증기는 입력 word를 최대 43,380개(카운트다운 180 tick + 주행 12분)까지만 디코딩합니다. 이보다 긴 기록은 스키마는 통과하지만 422로 거부됩니다.

#### 요청

```http
POST /api/runs HTTP/1.1
Host: my-kart.whchoi.net
Origin: https://my-kart.whchoi.net
Content-Type: application/json
Accept: application/json
```

```json
{
  "trackId": "sunny-meadow",
  "cc": 150,
  "charId": "kiki",
  "name": "레이서",
  "playerId": "5f0c2a9e-7b1d-4c3e-8a2b-1d4e6f8a0c2b",
  "ticks": 5608,
  "lapTicks": [1800, 1901, 1907],
  "log": "AQA/AJIAvwAjAOQAAQDgAAEA3QABANoAAQDXAAEA1QABANIA...",
  "version": "1.0.0"
}
```

고스트 예시와 마찬가지로 `log`는 줄인 값입니다. 실제 요청에는 전체 로그가 들어갑니다.

#### 처리 순서

1. submit 요청 한도: 429 `RATE_LIMITED`.
2. Origin 확인: 403 `FORBIDDEN_ORIGIN`.
3. Content-Type 확인: 415 `UNSUPPORTED_MEDIA_TYPE`.
4. 본문 파싱: 413 `PAYLOAD_TOO_LARGE`. 깨진 JSON이나 `__proto__`, `constructor.prototype` 키는 400 `INVALID_REQUEST`.
5. 스키마 검증: 처음 실패한 필드(`body.<field>`, 쿼리 파라미터가 있으면 `querystring.<name>`)를 담아 400 `INVALID_REQUEST`.
6. 이름 정규화: 400 `INVALID_NAME`.
7. 검증 worker pool에서 재시뮬레이션: 이미 32건이 대기 중이거나 6초 넘게 기다리면 503 `VERIFIER_BUSY`. CPU 예산 8초를 넘긴 기록은 422로 거부.
8. 주장과 비교: 422 `VERSION_MISMATCH`, `REPLAY_INVALID`, `TIME_MISMATCH`, `LAP_MISMATCH`.
9. 저장: 409 `DUPLICATE_RUN`. 저장소 장애는 503 `SERVICE_UNAVAILABLE`.

1~3단계는 본문을 파싱하기 전에 실행되므로, 형식이 잘못된 요청도 submit 예산을 소모합니다.

#### 응답

새 개인 최고 기록일 때 `200 OK` (`SubmitRunResponse`):

```json
{ "accepted": true, "id": "0mvdlxfk73c9e1a7b52d04f86", "rank": 1, "personalBest": true }
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `accepted` | boolean | 검증을 통과하면 `true`(이전 최고 기록보다 느려도 마찬가지). 422와 409에서는 `false` |
| `id` | string | 이 보드에서 플레이어의 현재 최고 기록 ID. 거부되면 빈 문자열 |
| `rank` | integer 또는 null | 그 최고 기록의 순위(다른 플레이어 기준, 1부터). 50위 밖이거나 거부되면 `null` |
| `personalBest` | boolean | 이번 기록이 이 보드에서 플레이어의 최고 기록이 되었으면 `true` |
| `reason` | string | 거부 사유(한국어). 거부될 때만 포함 |

알아 둘 동작:

- 검증은 통과했지만 저장된 최고 기록보다 빠르지 않으면 200과 함께 `personalBest: false`, 기존 최고 기록의 ID와 순위를 돌려줍니다. 아무것도 쓰지 않습니다.
- 같은 플레이어가 같은 로그를 다시 제출하면 200과 함께 `personalBest: true`, 처음 ID를 돌려줍니다. 역시 아무것도 쓰지 않으므로, 클라이언트 타임아웃 뒤 재시도해도 안전합니다.

거부된 기록, `422 Unprocessable Entity`:

```json
{
  "accepted": false,
  "id": "",
  "rank": null,
  "personalBest": false,
  "reason": "제출한 완주 시간이 서버 재시뮬레이션 결과와 다릅니다.",
  "error": "TIME_MISMATCH",
  "message": "제출한 완주 시간이 서버 재시뮬레이션 결과와 다릅니다."
}
```

409 `DUPLICATE_RUN`도 같은 형태입니다.

### 정적 파일과 SPA 폴백

빌드된 클라이언트(`STATIC_DIR`, 기본값 `dist/client`)가 있으면 같은 서버가 API가 아닌 모든 `GET`, `HEAD` 요청에 응답합니다.

| 경로 | 응답 | Cache-Control |
| --- | --- | --- |
| `/` | `index.html` | `no-cache` |
| `/assets/*` | 내용 해시가 붙은 번들 파일 | `public, max-age=31536000, immutable` |
| 그 밖의 파일: `/sw.js`, `/manifest.webmanifest`, `/build.json`, `/favicon.svg`, `/icon-maskable.svg`, `/icons/*` | 해당 파일 | `no-cache` |
| `/api`, `/healthz`, `/assets/` 밖에서 확장자가 없는 경로 | `index.html`(클라이언트 라우트) | `no-cache` |
| 없는 파일, `/.env` 같은 dotfile, `/assets/missing.js` 같은 없는 asset | JSON 404 `NOT_FOUND`(HTML로 답하지 않음) | `no-store` |

정적 응답에는 `ETag`와 `Last-Modified`가 붙고, `Range` 요청(206, 또는 416 `RANGE_NOT_SATISFIABLE`)을 지원하며, page 예산에서 차감됩니다. 프로덕션에서는 `dist/client/index.html`이 없으면 서버가 시작하지 않습니다.

## 거부 코드

`RunRejectionCode`(`src/shared/api.ts`)는 파싱이 끝난 제출 기록을 거부하는 사유입니다. `src/server/app.ts`의 `compareResult()`가 아래 순서로 판정하며, `DUPLICATE_RUN`은 저장 단계에서 나옵니다.

| 코드 | HTTP | 의미 | 클라이언트 대응 |
| --- | --- | --- | --- |
| `VERSION_MISMATCH` | 422 | 재시뮬레이션이 실패했고 `version`의 semver core(`+` 앞부분)가 서버와 다름 | 새로고침해 최신 빌드를 받은 뒤 다시 주행 |
| `REPLAY_INVALID` | 422 | 버전은 같은데 재시뮬레이션이 실패함. 로그가 깨졌거나 잘렸음, 완주 뒤에도 입력이 이어짐, 완주하지 못함, 입력 word가 43,380개를 넘음, 시뮬레이션 예외, CPU 예산 8초 초과 | 같은 로그를 다시 제출하지 않음 |
| `TIME_MISMATCH` | 422 | 로그는 완주하지만 완주 tick이 `ticks`와 다름 | 다시 제출하지 않음 |
| `LAP_MISMATCH` | 422 | 랩 수나 랩 시간이 `lapTicks`와 다름 | 다시 제출하지 않음 |
| `DUPLICATE_RUN` | 409 | 다른 플레이어가 이 입력 시퀀스를 이미 등록함(예: 내려받은 고스트를 그대로 또는 재인코딩해 제출) | 직접 달린 기록만 제출 |

`VERSION_MISMATCH`는 재시뮬레이션이 실패했을 때만 나옵니다. 이전 버전 클라이언트의 기록이라도 주장한 결과대로 재시뮬레이션되면 받아들입니다. `+` 뒤의 빌드 메타데이터는 비교하지 않습니다.

## 오류 형식

애플리케이션이 만드는 모든 오류는 다음 본문(`ApiError`)을 씁니다.

```json
{ "error": "INVALID_REQUEST", "message": "요청 형식이 올바르지 않습니다: body.log" }
```

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `error` | string | 변하지 않는 기계용 코드(상태 코드 표 참고) |
| `message` | string | 플레이어에게 그대로 보여 줄 수 있는 한국어 문장. 검증 오류는 처음 실패한 필드를 `body.<field>`, `querystring.<field>`, `params.<field>` 형태로 덧붙입니다 |

- 기록 거부(422, 409)는 `SubmitRunResponse` 형태에 `error`와 `message`를 더해 보냅니다.
- 429와 503 응답에는 초 단위 `Retry-After` 헤더가 붙습니다.
- 예외 메시지, 파일 경로, 입력값 같은 내부 정보는 클라이언트에 전달되지 않습니다. 예상하지 못한 실패는 503 `SERVICE_UNAVAILABLE`이 됩니다.
- 두 가지 예외는 이 형식을 따르지 않습니다. `SIGTERM`을 받은 태스크가 연결을 정리하는 동안 도착한 요청에는 Fastify가 자체 503 본문(`{"error":"Service Unavailable","message":"Service Unavailable","statusCode":503}`)으로 답합니다. CloudFront나 ALB가 직접 만드는 502, 504 같은 오류도 각자의 본문을 씁니다.

## 상태 코드

| HTTP | `error` | 반환하는 곳 | 원인 | Retry-After |
| --- | --- | --- | --- | --- |
| 200 | 없음 | 전체 | 성공 | 없음 |
| 206 | 없음 | 정적 파일 | `Range` 요청에 대한 부분 응답 | 없음 |
| 400 | `INVALID_REQUEST` | 전체 | 스키마 위반, 모르는 파라미터, 깨진 JSON, prototype poisoning 키, URL의 잘못된 percent-encoding | 없음 |
| 400 | `INVALID_NAME` | `POST /api/runs` | 이름 정규화 실패 | 없음 |
| 403 | `FORBIDDEN_ORIGIN` | `POST /api/runs` | 허용되지 않은 `Origin` | 없음 |
| 404 | `NOT_FOUND` | 전체 | 없는 라우트나 메서드, 없는 고스트, 없는 정적 파일, 빌드된 클라이언트를 서빙할 때 100자를 넘는 경로 파라미터 | 없음 |
| 409 | `DUPLICATE_RUN` | `POST /api/runs` | 다른 플레이어가 소유한 입력 시퀀스 | 없음 |
| 413 | `PAYLOAD_TOO_LARGE` | `POST /api/runs` | 본문이 262,144바이트 초과 | 없음 |
| 414 | `INVALID_REQUEST` | `GET /api/ghost/:id` | API 전용 서버에서 경로 파라미터가 100자 초과(빌드된 클라이언트가 없어 wildcard 라우트가 받아 주지 않음) | 없음 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `POST /api/runs` | 본문이 `application/json`이 아님 | 없음 |
| 416 | `RANGE_NOT_SATISFIABLE` | 정적 파일 | 만족할 수 없는 `Range` | 없음 |
| 422 | `REPLAY_INVALID`, `VERSION_MISMATCH`, `TIME_MISMATCH`, `LAP_MISMATCH` | `POST /api/runs` | 거부 코드 참고 | 없음 |
| 429 | `RATE_LIMITED` | `/healthz`를 뺀 전체 | 예산 소진 | 창이 초기화될 때까지 남은 초(최소 1) |
| 503 | `VERIFIER_BUSY` | `POST /api/runs` | 이미 32건 대기 중이거나 대기 6초 초과 | 3 |
| 503 | `SERVICE_UNAVAILABLE` | 전체 | 저장소 장애, 검증기 사용 불가, 예상하지 못한 오류. 메모리 모드에서는 저장 용량(5000건) 초과도 포함 | 2 |

## 캐싱

| 응답 | `Cache-Control` | 이유 |
| --- | --- | --- |
| `/healthz`, `/api/leaderboard`, `/api/runs` | `no-store` | 항상 최신 값 |
| `/api/ghost/:id`의 200 응답 | `private, max-age=3600, immutable` | 기록 ID 하나가 바뀌지 않는 로그 하나를 가리킴 |
| 상태 코드 400 이상인 모든 응답 | `no-store` | 오류는 캐시하지 않음 |
| `/assets/*` | `public, max-age=31536000, immutable` | 파일 이름에 내용 해시가 들어감 |
| `index.html`, `/sw.js` 등 루트 파일 | `no-cache` | 매번 재검증해 배포가 바로 반영되도록 함 |

CloudFront는 `/assets/*`만 최대 365일 캐시합니다. 기본 behavior와 `/api/*`는 관리형 `CachingDisabled` 정책을 쓰고, 오류 응답의 엣지 TTL은 0입니다. 번들 클라이언트는 모든 API 요청을 `cache: 'no-store'`로 보내며, 서비스 워커도 `/api/*`와 `/healthz`는 항상 네트워크로 보냅니다.

## 요청 한도

| 예산 | 클라이언트당 60초 한도 | 적용 대상 |
| --- | --- | --- |
| submit | 12 | `POST /api/runs` |
| read | 120 | `GET /api/leaderboard`와 `GET /api/ghost/:id`(예산 하나를 공유), 그리고 메서드와 관계없이 매칭되지 않은 모든 `/api/*` 요청 |
| page | 600 | `/`, 정적 파일, 클라이언트 라우트, API가 아닌 그 밖의 404 |
| 면제 | 없음 | `GET`, `HEAD /healthz` |

- 응답 헤더: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`(창이 초기화될 때까지 남은 초). 429에는 `retry-after`가 추가됩니다.
- 클라이언트 키: `x-turbo-client-ip` 헤더가 올바른 IP 주소이면 그 값을, 아니면 TCP 상대 주소를 씁니다. CloudFront viewer-request 함수가 이 헤더를 뷰어 IP로 덮어쓰므로 클라이언트가 키를 마음대로 정할 수 없습니다. IPv6 주소는 /64 단위로 묶고, IPv4-mapped IPv6 주소는 IPv4로 취급합니다.
- 검증보다 먼저 차감하므로 형식이 잘못되었거나 거부된 요청도 횟수에 들어갑니다.
- 카운터는 Fargate 태스크마다 메모리에 따로 둡니다(`@fastify/rate-limit` 기본 저장소, 키 최대 20,000개). 서비스는 ALB 뒤에서 태스크 2~6개로 실행되므로, 요청이 여러 태스크로 나뉘어 들어가는 클라이언트는 이 한도의 최대 태스크 수 배까지 요청할 수 있습니다.
- 한도는 환경 변수가 아니라 상수(`src/server/app.ts`의 `DEFAULT_RATE_LIMITS`)입니다.
- hook이 실행되기 전에 라우터가 거부하는 요청(잘못된 percent-encoding, API 전용 서버에서 100자를 넘는 경로 파라미터)은 차감되지 않고 요청 한도 헤더도 붙지 않습니다.

429 응답 예시:

```http
HTTP/1.1 429 Too Many Requests
content-type: application/json; charset=utf-8
cache-control: no-store
retry-after: 37
x-ratelimit-limit: 12
x-ratelimit-remaining: 0
x-ratelimit-reset: 37
```

```json
{ "error": "RATE_LIMITED", "message": "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }
```

## 관련 문서

- [docs/reference/api.md](reference/api.md): 서버 내부 구조(hook, 검증, 검증기 pool)
- [docs/reference/data.md](reference/data.md): API 뒤의 저장소 구조
- [docs/reference/security.md](reference/security.md): 보안 헤더, origin 보호, 치팅 방지
- [docs/architecture.md](architecture.md): 시스템 개요
- [src/shared/api.ts](../src/shared/api.ts): TypeScript 계약
