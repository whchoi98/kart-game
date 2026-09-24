import { setTimeout as sleep } from 'node:timers/promises';
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { GhostResponse, LeaderboardEntry } from '../shared/api.js';
import { isCharacterId } from '../sim/characters.js';
import type { SpeedClass } from '../sim/types.js';
import {
  BEST_SORT_KEY, DuplicateRunError, GHOST_SORT_KEY, LOG_CLAIM_SORT_KEY, bestKey, boardKey, ghostKey, logClaimKey, rankKey,
  type Repository, type SubmitOutcome, type VerifiedRun,
} from './repository.js';
import { isSpeedClass } from './validation.js';

/** Raised for storage failures; the HTTP layer maps it to 503 and logs only `reason`. */
export class StorageError extends Error {
  constructor(readonly reason: string) {
    super(`Storage operation failed (${reason}).`);
    this.name = 'StorageError';
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.name) ? error.name : 'UnknownError';

const RETRYABLE_TRANSACTION_ERRORS = new Set([
  'TransactionCanceledException', 'TransactionConflictException', 'TransactionInProgressException',
]);
const MAX_ATTEMPTS = 5;

export function createDocumentClient(
  region?: string,
  connection: Pick<DynamoDBClientConfig, 'endpoint' | 'credentials'> = {},
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({
    ...connection,
    region,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000, throwOnRequestTimeout: true },
  }), { marshallOptions: { removeUndefinedValues: true } });
}

interface BestPointer { id: string; rankSk: string; ticks: number; logHash: string }

/**
 * Single-table layout (all access is GetItem / Query / TransactWriteItems):
 *   pk = LB#<track>#<cc>            sk = <ticks:9>#<runId>  ranking row (entry fields)
 *   pk = PB#<track>#<cc>#<playerId> sk = PB                 pointer to the player's best row
 *   pk = GHOST#<runId>              sk = GHOST              input log for the ranking row
 *   pk = LOG#<logDigest(log)>       sk = LOG                first player to register this input sequence (permanent)
 * Ghost logs (≤ 200 KB) live outside the board partition so a top-N Query stays small.
 * Replacing a personal best is one transaction guarded by the pointer's previous id,
 * so concurrent submissions from the same player can never leave two rows behind.
 * The log claim (keyed by the decoded input sequence, see logDigest) stops a downloaded
 * ghost from being re-registered by another player, re-encoded or not.
 */
export class DynamoRepository implements Repository {
  readonly kind = 'dynamodb' as const;

  constructor(
    private readonly tableName: string,
    private readonly client: DynamoDBDocumentClient = createDocumentClient(),
  ) {}

  async submit(run: VerifiedRun, topSize: number): Promise<SubmitOutcome> {
    const board = boardKey(run.trackId, run.cc);
    const pointerKey = { pk: bestKey(run.trackId, run.cc, run.playerId), sk: BEST_SORT_KEY };
    const claimKey = { pk: logClaimKey(run.logHash), sk: LOG_CLAIM_SORT_KEY };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const claim = await this.readClaimOwner(claimKey);
      if (claim !== undefined && claim !== run.playerId) throw new DuplicateRunError();
      const current = await this.readPointer(pointerKey);
      if (current && (current.logHash === run.logHash || current.ticks <= run.ticks)) {
        return {
          personalBest: current.logHash === run.logHash,
          id: current.id,
          rank: await this.rankOf(board, current.rankSk, topSize, run.playerId),
        };
      }

      const rankSk = rankKey(run.ticks, run.id);
      const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              ...pointerKey, id: run.id, rankSk, ticks: run.ticks, logHash: run.logHash, updatedAt: run.createdAt,
            },
            ...(current
              ? {
                ConditionExpression: '#id = :previous',
                ExpressionAttributeNames: { '#id': 'id' },
                ExpressionAttributeValues: { ':previous': current.id },
              }
              : { ConditionExpression: 'attribute_not_exists(pk)' }),
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: board, sk: rankSk, id: run.id, name: run.name, charId: run.charId, trackId: run.trackId,
              cc: run.cc, ticks: run.ticks, lapTicks: run.lapTicks, createdAt: run.createdAt,
              playerId: run.playerId, version: run.version,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: ghostKey(run.id), sk: GHOST_SORT_KEY, id: run.id, trackId: run.trackId, cc: run.cc,
              charId: run.charId, name: run.name, ticks: run.ticks, log: run.log, createdAt: run.createdAt,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: { ...claimKey, playerId: run.playerId, id: run.id, createdAt: run.createdAt },
            ConditionExpression: 'attribute_not_exists(pk) OR playerId = :player',
            ExpressionAttributeValues: { ':player': run.playerId },
          },
        },
      ];
      if (current) {
        items.push(
          { Delete: { TableName: this.tableName, Key: { pk: board, sk: current.rankSk } } },
          { Delete: { TableName: this.tableName, Key: { pk: ghostKey(current.id), sk: GHOST_SORT_KEY } } },
        );
      }

      try {
        // The SDK fills ClientRequestToken, so its own retries of this call are idempotent.
        await this.client.send(new TransactWriteCommand({ TransactItems: items }));
        return { personalBest: true, id: run.id, rank: await this.rankOf(board, rankSk, topSize, run.playerId) };
      } catch (error) {
        const name = errorName(error);
        if (!RETRYABLE_TRANSACTION_ERRORS.has(name)) throw new StorageError(name);
        // A concurrent submission for the same player moved the pointer: re-read and re-decide.
        if (attempt < MAX_ATTEMPTS - 1) await sleep(20 * 2 ** attempt + Math.floor(Math.random() * 20));
      }
    }
    throw new StorageError('TransactionRetriesExhausted');
  }

  async leaderboard(trackId: string, cc: SpeedClass, limit: number): Promise<LeaderboardEntry[]> {
    const result = await this.call(() => this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': boardKey(trackId, cc) },
      ProjectionExpression: 'id, #name, charId, trackId, cc, ticks, lapTicks, createdAt',
      ExpressionAttributeNames: { '#name': 'name' },
      ScanIndexForward: true,
      ConsistentRead: true,
      Limit: limit,
    })));
    const entries: LeaderboardEntry[] = [];
    for (const item of result.Items ?? []) {
      const entry = parseEntry(item, entries.length + 1);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async ghost(id: string): Promise<GhostResponse | undefined> {
    const result = await this.call(() => this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: ghostKey(id), sk: GHOST_SORT_KEY },
      ConsistentRead: true,
    })));
    const item = result.Item;
    if (!item) return undefined;
    const { trackId, cc, charId, name, ticks, log } = item as Record<string, unknown>;
    if (typeof trackId !== 'string' || !isSpeedClass(cc) || !isCharacterId(charId) || typeof name !== 'string' ||
        !Number.isSafeInteger(ticks) || typeof log !== 'string') {
      throw new StorageError('MalformedGhostItem');
    }
    return { id, trackId, cc, charId, name, ticks: ticks as number, log };
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private async readPointer(key: { pk: string; sk: string }): Promise<BestPointer | undefined> {
    const result = await this.call(() => this.client.send(new GetCommand({
      TableName: this.tableName, Key: key, ConsistentRead: true,
    })));
    const item = result.Item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    const { id, rankSk, ticks, logHash } = item;
    if (typeof id !== 'string' || typeof rankSk !== 'string' || !Number.isSafeInteger(ticks) || typeof logHash !== 'string') {
      throw new StorageError('MalformedBestPointer');
    }
    return { id, rankSk, ticks: ticks as number, logHash };
  }

  private async readClaimOwner(key: { pk: string; sk: string }): Promise<string | undefined> {
    const result = await this.call(() => this.client.send(new GetCommand({
      TableName: this.tableName, Key: key, ConsistentRead: true, ProjectionExpression: 'playerId',
    })));
    const owner = (result.Item as Record<string, unknown> | undefined)?.playerId;
    if (result.Item && typeof owner !== 'string') throw new StorageError('MalformedLogClaim');
    return owner as string | undefined;
  }

  /**
   * 1-based rank of `sk` among *other* players' bests, or null when `topSize`
   * of them precede it. Excluding the player's own row keeps the answer right
   * when two of their submissions race (the faster one may already have
   * replaced this row). At most one own row exists, hence Limit topSize + 1.
   */
  private async rankOf(board: string, sk: string, topSize: number, playerId: string): Promise<number | null> {
    const result = await this.call(() => this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND sk < :sk',
      FilterExpression: 'playerId <> :me',
      ExpressionAttributeValues: { ':pk': board, ':sk': sk, ':me': playerId },
      Select: 'COUNT',
      ConsistentRead: true,
      Limit: topSize + 1,
    })));
    const before = result.Count ?? 0;
    return before < topSize ? before + 1 : null;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(errorName(error));
    }
  }
}

function parseEntry(item: Record<string, unknown>, rank: number): LeaderboardEntry | undefined {
  const { id, name, charId, trackId, cc, ticks, lapTicks, createdAt } = item;
  if (typeof id !== 'string' || typeof name !== 'string' || !isCharacterId(charId) || typeof trackId !== 'string' ||
      !isSpeedClass(cc) || !Number.isSafeInteger(ticks) || !Array.isArray(lapTicks) ||
      !lapTicks.every(value => Number.isSafeInteger(value)) || typeof createdAt !== 'string') {
    return undefined;
  }
  return { rank, id, name, charId, trackId, cc, ticks: ticks as number, lapTicks: lapTicks as number[], createdAt };
}
