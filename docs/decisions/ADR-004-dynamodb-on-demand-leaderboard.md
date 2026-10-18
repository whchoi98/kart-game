# ADR-004: DynamoDB On-Demand Storage for Leaderboards and Ghosts

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Status
Accepted (2026-09-24)

## Context
- There is one board per track and speed class (8 tracks × 4 classes). A board keeps one best row per player and serves the top 50 (`API_LIMITS.leaderboardSize`), fastest first; on equal ticks the earlier run wins.
- Every run stored as a personal best keeps its input log as a ghost (up to 200 000 characters, `API_LIMITS.logMax`).
- Log ownership claims ([ADR-001](ADR-001-deterministic-simulation-server-verification.md)) must be permanent and must commit atomically with the replacement of a personal best.
- Two to six Fargate tasks write concurrently ([ADR-003](ADR-003-fargate-arm64-in-existing-vpc.md)), and one player can submit twice at the same moment.
- Traffic is low and unpredictable. Local development and the test suite must run without AWS.

## Options Considered

### Option 1: DynamoDB single table with on-demand capacity (chosen)
- **Pros**: No capacity planning; billed per request; conditional transactions give an atomic best replacement and log claim; tasks use IAM instead of database credentials or connection pools; point-in-time recovery and deletion protection are built in.
- **Cons**: Ranking needs a hand-written key design; a rank is computed with a COUNT query; no ad-hoc SQL.

### Option 2: DynamoDB with provisioned capacity and auto scaling
- **Pros**: Lower unit price at a steady, predictable load.
- **Cons**: The load is unknown; capacity has to be planned up front, and requests above it are throttled.

### Option 3: Relational database (Amazon RDS or Aurora PostgreSQL)
- **Pros**: Ordering and window functions make ranks trivial; flexible queries.
- **Cons**: An always-running instance (or minimum capacity) and connection management in every task; database credentials to store and rotate; more operations work for a three-endpoint API.

### Option 4: In-memory sorted sets (Amazon ElastiCache)
- **Pros**: Leaderboards map directly onto sorted-set commands.
- **Cons**: Memory-priced nodes running at all times; durability needs extra configuration; ghost logs of up to 200 KB each are a poor fit for memory.

## Decision
Adopt option 1.

### Table
- `Rankings` in `infra/lib/data.ts`: `pk` and `sk` strings, `PAY_PER_REQUEST`, AWS-managed encryption, point-in-time recovery, deletion protection, `RemovalPolicy.RETAIN`. No GSI, no TTL.
- The task role may call only `dynamodb:GetItem`, `PutItem`, `DeleteItem` and `Query`, on the table ARN only (`infra/lib/service.ts`).

### Key design
| pk | sk | Item |
|---|---|---|
| `LB#<track>#<cc>` | `<ticks, 9 digits>#<runId>` | Ranking row: entry fields plus `playerId` and `version`, no log |
| `PB#<track>#<cc>#<playerId>` | `PB` | Pointer to the player's best row (`id`, `rankSk`, `ticks`, `logHash`) |
| `GHOST#<runId>` | `GHOST` | Ghost: the input log and its display fields |
| `LOG#<logHash>` | `LOG` | Claim: the first player who registered this input sequence (permanent) |

- Ticks are zero-padded to 9 digits (`TICKS_WIDTH`), and a run id starts with a 9-character base-36 millisecond timestamp (`newRunId` in `src/server/validation.ts`). A plain ascending Query therefore returns the fastest run first and, on equal ticks, the earlier run first.
- Ghost logs live outside the board partition, so the top-50 Query stays small.

### Access patterns
- Submit (`DynamoRepository.submit` in `src/server/dynamo-repository.ts`): read the claim and the pointer with strongly consistent `GetItem`. If the stored best is the same log or is not slower, return it unchanged. Otherwise write one `TransactWriteItems`: put the pointer (conditioned on the previous id, or on absence), the ranking row and the ghost (conditioned on absence) and the claim (absent or owned by the same player), and, when replacing a best, delete the previous row and ghost. On a transaction conflict it re-reads and tries again, up to 5 attempts in total, with exponential backoff and jitter.
- Leaderboard: `Query` on `pk = LB#…`, ascending, consistent read, `Limit` 50, projection without `playerId`.
- Rank: `Query` with `Select: COUNT` over the rows ahead of the player's row, other players only, `Limit` top size + 1; outside the top 50 the rank is `null`.
- Ghost: consistent `GetItem` on `GHOST#<runId>`.

### Repository abstraction
- `Repository` (`src/server/repository.ts`) defines `kind`, `submit`, `leaderboard`, `ghost` and `close`. `buildApp` (`src/server/app.ts`) uses `DynamoRepository` when `TABLE_NAME` is set and `MemoryRepository` otherwise.
- `MemoryRepository` (`src/server/memory-repository.ts`) keeps sorted arrays in the process and searches them with binary search. Each mutation is synchronous (no `await` between read and write), so it follows the same consistency rules. It stores at most 5 000 runs and 50 000 claims. `npm run dev` runs it (`TABLE_NAME=''`), and so do the tests; a production server without `TABLE_NAME` logs `memory_repository`.
- `test/server/repository.test.ts` runs one `repositoryContract` against both implementations. The DynamoDB half needs DynamoDB Local:

```bash
docker run -d --rm --name ddb -p 127.0.0.1:18765:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 npx vitest run test/server/repository.test.ts
```

## Consequences

### Positive
- No capacity settings to manage; `docs/infra.md` estimates about $4 per month for DynamoDB at its assumed traffic.
- Concurrent submissions by the same player leave exactly one row (`repositoryContract`), and the best replacement and the log claim commit together.
- Point-in-time recovery restores the table into a new table (then switch `TABLE_NAME`); `RETAIN` and deletion protection keep the rankings through `cdk destroy`.
- Local development and the test suite need no AWS account.

### Negative
- All rows of one board share one partition key, so every read and write for that board goes to the same partition.
- A rank costs a COUNT Query that can evaluate up to 51 rows.
- `leaderboard` silently skips malformed rows, so a board can return fewer than 50 entries.
- Claims never expire (no TTL): `LOG#` items grow with every distinct accepted input sequence.
- A new access pattern (a GSI, `UpdateItem`, `Scan`) also needs an IAM change in `infra/lib/service.ts`.
- Tearing down the data takes manual steps: disable deletion protection, then delete the table.
- `MemoryRepository` is per process. With two or more tasks each would hold a different leaderboard, so it is only for development, tests and single-task demos.

## References
- [infra/lib/data.ts](../../infra/lib/data.ts), [infra/lib/service.ts](../../infra/lib/service.ts)
- [src/server/repository.ts](../../src/server/repository.ts), [src/server/dynamo-repository.ts](../../src/server/dynamo-repository.ts), [src/server/memory-repository.ts](../../src/server/memory-repository.ts), [src/server/app.ts](../../src/server/app.ts), [src/server/config.ts](../../src/server/config.ts), [src/server/validation.ts](../../src/server/validation.ts)
- [src/shared/api.ts](../../src/shared/api.ts)
- [test/server/repository.test.ts](../../test/server/repository.test.ts), [test/infra/stack.test.ts](../../test/infra/stack.test.ts) ("data")
- [docs/infra.md](../infra.md) (rollback with point-in-time recovery, teardown, cost estimate)
- [docs/reference/data.md](../reference/data.md), [docs/runbooks/rollback-production.md](../runbooks/rollback-production.md), [docs/runbooks/teardown.md](../runbooks/teardown.md)

---

<a id="korean"></a>

# 한국어

## 상태
승인됨 (2026-09-24)

## 배경
- 랭킹 보드는 트랙과 속도 클래스 조합마다 하나씩 있습니다(트랙 8개 × 클래스 4개). 보드는 플레이어마다 최고 기록 행 하나를 두고 상위 50개(`API_LIMITS.leaderboardSize`)를 빠른 순으로 보여 줍니다. tick이 같으면 먼저 달린 기록이 앞섭니다.
- 개인 최고 기록으로 저장된 주행은 모두 입력 로그를 고스트로 보관합니다(최대 200 000자, `API_LIMITS.logMax`).
- 로그 소유권([ADR-001](ADR-001-deterministic-simulation-server-verification.md))은 영구적이어야 하고, 개인 최고 기록 교체와 원자적으로 함께 기록되어야 합니다.
- Fargate 태스크 2~6개가 동시에 쓰고([ADR-003](ADR-003-fargate-arm64-in-existing-vpc.md)), 한 플레이어가 같은 순간에 두 번 제출할 수도 있습니다.
- 트래픽은 적고 예측하기 어렵습니다. 로컬 개발과 테스트는 AWS 없이 돌아가야 합니다.

## 검토한 옵션

### 옵션 1: 온디맨드 용량의 DynamoDB 단일 테이블 (채택)
- **장점**: 용량 계획이 필요 없고 요청 단위로 과금됩니다. 조건부 트랜잭션으로 최고 기록 교체와 로그 소유권을 원자적으로 처리합니다. 태스크는 DB 자격 증명이나 커넥션 풀 없이 IAM으로 접근합니다. 특정 시점 복구와 삭제 보호가 기본 기능입니다.
- **단점**: 순위를 위한 키 설계를 직접 해야 하고, 순위는 COUNT 쿼리로 계산합니다. 임의의 SQL 질의는 할 수 없습니다.

### 옵션 2: 프로비저닝 용량과 오토스케일링을 쓰는 DynamoDB
- **장점**: 부하가 일정하고 예측 가능하면 단가가 더 낮습니다.
- **단점**: 부하를 알 수 없습니다. 용량을 미리 정해야 하고, 이를 넘는 요청은 스로틀됩니다.

### 옵션 3: 관계형 데이터베이스(Amazon RDS 또는 Aurora PostgreSQL)
- **장점**: 정렬과 윈도 함수로 순위를 쉽게 구하고 질의가 유연합니다.
- **단점**: 상시 실행 인스턴스(또는 최소 용량)와 태스크마다 커넥션 관리가 필요합니다. DB 자격 증명을 보관하고 회전해야 하고, 엔드포인트 3개짜리 API에 비해 운영 부담이 큽니다.

### 옵션 4: 인메모리 sorted set(Amazon ElastiCache)
- **장점**: 리더보드를 sorted set 명령에 그대로 대응시킬 수 있습니다.
- **단점**: 메모리 단가로 과금되는 노드가 상시 실행됩니다. 내구성에는 추가 설정이 필요하고, 하나에 최대 200 KB인 고스트 로그는 메모리에 두기에 적합하지 않습니다.

## 결정
옵션 1을 채택합니다.

### 테이블
- `infra/lib/data.ts`의 `Rankings`: `pk`와 `sk` 문자열, `PAY_PER_REQUEST`, AWS 관리형 암호화, 특정 시점 복구, 삭제 보호, `RemovalPolicy.RETAIN`. GSI와 TTL은 없습니다.
- 태스크 역할은 테이블 ARN에 대해서만 `dynamodb:GetItem`, `PutItem`, `DeleteItem`, `Query`를 호출할 수 있습니다(`infra/lib/service.ts`).

### 키 설계
| pk | sk | 항목 |
|---|---|---|
| `LB#<track>#<cc>` | `<ticks, 9 digits>#<runId>` | 랭킹 행: 항목 필드와 `playerId`, `version`을 담고 로그는 담지 않음 |
| `PB#<track>#<cc>#<playerId>` | `PB` | 플레이어 최고 기록 행을 가리키는 포인터(`id`, `rankSk`, `ticks`, `logHash`) |
| `GHOST#<runId>` | `GHOST` | 고스트: 입력 로그와 표시용 필드 |
| `LOG#<logHash>` | `LOG` | 소유권: 이 입력 시퀀스를 처음 등록한 플레이어(영구 보존) |

- tick은 9자리로 0을 채우고(`TICKS_WIDTH`), run id는 9자리 base-36 밀리초 타임스탬프로 시작합니다(`src/server/validation.ts`의 `newRunId`). 그래서 단순 오름차순 Query가 가장 빠른 기록을 먼저, tick이 같으면 먼저 달린 기록을 먼저 돌려줍니다.
- 고스트 로그는 보드 파티션 밖에 두어 상위 50개 Query를 작게 유지합니다.

### 접근 패턴
- 제출(`src/server/dynamo-repository.ts`의 `DynamoRepository.submit`): 소유권 항목과 포인터를 강한 일관성 `GetItem`으로 읽습니다. 저장된 최고 기록이 같은 로그이거나 더 느리지 않으면 그대로 돌려줍니다. 아니면 `TransactWriteItems` 하나로 씁니다. 포인터는 이전 id(또는 부재)를 조건으로, 랭킹 행과 고스트는 부재를 조건으로, 소유권은 부재 또는 같은 플레이어를 조건으로 put하고, 최고 기록을 바꾸는 경우 이전 행과 고스트를 delete합니다. 트랜잭션 충돌이 나면 다시 읽고 지수 backoff와 jitter를 두어 재시도하며, 시도 횟수는 모두 합쳐 최대 5회입니다.
- 리더보드: `pk = LB#…`에 대한 `Query`, 오름차순, 일관된 읽기, `Limit` 50, `playerId`를 뺀 projection.
- 순위: 플레이어 행보다 앞선 다른 플레이어의 행을 `Select: COUNT` `Query`로 세고, `Limit`은 상위 크기 + 1입니다. 상위 50위 밖이면 순위는 `null`입니다.
- 고스트: `GHOST#<runId>`에 대한 일관된 `GetItem`.

### 저장소 추상화
- `Repository`(`src/server/repository.ts`)는 `kind`, `submit`, `leaderboard`, `ghost`, `close`를 정의합니다. `buildApp`(`src/server/app.ts`)은 `TABLE_NAME`이 있으면 `DynamoRepository`를, 없으면 `MemoryRepository`를 씁니다.
- `MemoryRepository`(`src/server/memory-repository.ts`)는 프로세스 안에 정렬된 배열을 두고 이진 탐색으로 찾습니다. 변경은 모두 동기적이어서(읽기와 쓰기 사이에 `await`가 없음) 같은 일관성 규칙을 따릅니다. 주행은 최대 5 000개, 소유권은 최대 50 000개까지 보관합니다. `npm run dev`(`TABLE_NAME=''`)와 테스트가 이 구현을 쓰고, `TABLE_NAME` 없이 뜬 프로덕션 서버는 `memory_repository` 경고를 남깁니다.
- `test/server/repository.test.ts`는 하나의 `repositoryContract`를 두 구현에 똑같이 돌립니다. DynamoDB 쪽은 DynamoDB Local이 필요합니다.

```bash
docker run -d --rm --name ddb -p 127.0.0.1:18765:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 npx vitest run test/server/repository.test.ts
```

## 영향

### 긍정적
- 관리할 용량 설정이 없습니다. `docs/infra.md`는 가정한 트래픽에서 DynamoDB 비용을 월 약 $4로 추정합니다.
- 같은 플레이어가 동시에 제출해도 행은 정확히 하나만 남고(`repositoryContract`), 최고 기록 교체와 로그 소유권은 함께 커밋됩니다.
- 특정 시점 복구로 테이블을 새 테이블에 복원할 수 있고(그다음 `TABLE_NAME` 전환), `RETAIN`과 삭제 보호 덕분에 `cdk destroy` 후에도 랭킹이 남습니다.
- 로컬 개발과 테스트 스위트에 AWS 계정이 필요 없습니다.

### 부정적
- 한 보드의 행은 모두 같은 파티션 키를 쓰므로, 그 보드의 읽기와 쓰기는 전부 한 파티션으로 갑니다.
- 순위 계산에 최대 51개 행을 평가하는 COUNT Query가 듭니다.
- `leaderboard`는 형식이 깨진 행을 조용히 건너뛰므로 보드가 50개보다 적게 돌아올 수 있습니다.
- 소유권 항목은 만료되지 않습니다(TTL 없음). 서로 다른 입력 시퀀스가 수락될 때마다 `LOG#` 항목이 늘어납니다.
- 새 접근 패턴(GSI, `UpdateItem`, `Scan`)을 쓰려면 `infra/lib/service.ts`의 IAM도 바꿔야 합니다.
- 데이터를 지우려면 수동 단계가 필요합니다. 삭제 보호를 끈 뒤 테이블을 삭제합니다.
- `MemoryRepository`는 프로세스마다 따로입니다. 태스크가 둘 이상이면 각자 다른 리더보드를 갖게 되므로 개발, 테스트, 단일 태스크 데모에만 씁니다.

## 참고 자료
- [infra/lib/data.ts](../../infra/lib/data.ts), [infra/lib/service.ts](../../infra/lib/service.ts)
- [src/server/repository.ts](../../src/server/repository.ts), [src/server/dynamo-repository.ts](../../src/server/dynamo-repository.ts), [src/server/memory-repository.ts](../../src/server/memory-repository.ts), [src/server/app.ts](../../src/server/app.ts), [src/server/config.ts](../../src/server/config.ts), [src/server/validation.ts](../../src/server/validation.ts)
- [src/shared/api.ts](../../src/shared/api.ts)
- [test/server/repository.test.ts](../../test/server/repository.test.ts), [test/infra/stack.test.ts](../../test/infra/stack.test.ts) ("data")
- [docs/infra.md](../infra.md) (특정 시점 복구를 이용한 롤백, 삭제, 비용 추정)
- [docs/reference/data.md](../reference/data.md), [docs/runbooks/rollback-production.md](../runbooks/rollback-production.md), [docs/runbooks/teardown.md](../runbooks/teardown.md)
