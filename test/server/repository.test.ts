import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, DynamoRepository } from '../../src/server/dynamo-repository.js';
import { MemoryRepository } from '../../src/server/memory-repository.js';
import { DuplicateRunError, boardKey, type Repository, type VerifiedRun } from '../../src/server/repository.js';
import { logDigest, newRunId } from '../../src/server/validation.js';
import { playerId, splitLaps } from './helpers.js';

let clock = Date.UTC(2026, 8, 23, 12, 0, 0);

function run(player: number, ticks: number, extra: Partial<VerifiedRun> = {}): VerifiedRun {
  clock += 1_000;
  const log = extra.log ?? `LOG${player}x${ticks}x${clock}`;
  return {
    id: newRunId(clock),
    playerId: playerId(player),
    name: `드라이버${player}`,
    charId: 'pip',
    trackId: 'canyon-rally',
    cc: 100,
    ticks,
    lapTicks: splitLaps(ticks),
    log,
    logHash: logDigest(log),
    version: '1.0.0',
    createdAt: new Date(clock).toISOString(),
    ...extra,
  };
}

function repositoryContract(label: string, open: () => Promise<Repository>) {
  describe(`${label} repository contract`, () => {
    let repo: Repository;
    beforeAll(async () => { repo = await open(); });
    afterAll(() => repo.close());

    it('starts with empty boards and no ghosts', async () => {
      expect(await repo.leaderboard('lava-fortress', 200, 50)).toEqual([]);
      expect(await repo.ghost(newRunId())).toBeUndefined();
    });

    it('ranks fastest first with ties broken by the earlier run, one row per player', async () => {
      const results = [];
      for (const [player, ticks] of [[1, 7000], [2, 6500], [3, 6500], [4, 8000]] as const) {
        results.push(await repo.submit(run(player, ticks, { trackId: 'palm-beach' }), 50));
      }
      expect(results.map(r => r.rank)).toEqual([1, 1, 2, 4]);
      const board = await repo.leaderboard('palm-beach', 100, 50);
      expect(board.map(e => [e.rank, e.name, e.ticks])).toEqual([
        [1, '드라이버2', 6500], [2, '드라이버3', 6500], [3, '드라이버1', 7000], [4, '드라이버4', 8000],
      ]);
      expect(await repo.leaderboard('palm-beach', 100, 2)).toHaveLength(2);
    });

    it('replaces a personal best atomically and removes the previous ghost', async () => {
      const first = run(10, 9000);
      expect(await repo.submit(first, 50)).toEqual({ personalBest: true, id: first.id, rank: 1 });
      const better = run(10, 8500, { name: '새이름' });
      expect(await repo.submit(better, 50)).toEqual({ personalBest: true, id: better.id, rank: 1 });
      expect(await repo.ghost(first.id)).toBeUndefined();
      expect(await repo.ghost(better.id)).toEqual({
        id: better.id, trackId: 'canyon-rally', cc: 100, charId: 'pip', name: '새이름', ticks: 8500, log: better.log,
      });
      const slower = run(10, 8600);
      expect(await repo.submit(slower, 50)).toEqual({ personalBest: false, id: better.id, rank: 1 });
      expect(await repo.ghost(slower.id)).toBeUndefined();
      const board = await repo.leaderboard('canyon-rally', 100, 50);
      expect(board.filter(e => e.id === better.id)).toHaveLength(1);
      expect(board.some(e => e.id === first.id || e.id === slower.id)).toBe(false);
    });

    it('is idempotent for an identical re-submission', async () => {
      const original = run(20, 7777, { trackId: 'neon-city' });
      const outcome = await repo.submit(original, 50);
      const retry = await repo.submit({ ...original, id: newRunId(clock + 5) }, 50);
      expect(retry).toEqual(outcome);
      expect(await repo.leaderboard('neon-city', 100, 50)).toHaveLength(1);
    });

    it('lets only the first player register a given input log (no ghost theft)', async () => {
      const original = run(70, 6400, { trackId: 'lava-fortress' });
      await repo.submit(original, 50);
      const stolen = run(71, 6400, { trackId: 'lava-fortress', log: original.log, logHash: original.logHash });
      await expect(repo.submit(stolen, 50)).rejects.toBeInstanceOf(DuplicateRunError);
      // Even as a different character (a copied log re-simulated with other stats).
      await expect(repo.submit({ ...stolen, id: newRunId(clock + 7), charId: 'bolt' }, 50)).rejects.toBeInstanceOf(DuplicateRunError);
      // The claim survives the original player's next personal best.
      await repo.submit(run(70, 6300, { trackId: 'lava-fortress' }), 50);
      await expect(repo.submit({ ...stolen, id: newRunId(clock + 9) }, 50)).rejects.toBeInstanceOf(DuplicateRunError);
      const board = await repo.leaderboard('lava-fortress', 100, 50);
      expect(board.map(e => e.name)).toEqual(['드라이버70']);
    });

    it('reports a null rank outside the top list', async () => {
      for (let i = 0; i < 3; i++) await repo.submit(run(30 + i, 5000 + i, { trackId: 'jungle-ruins' }), 3);
      expect((await repo.submit(run(40, 6000, { trackId: 'jungle-ruins' }), 3)).rank).toBeNull();
      // Ties with an existing 5001 rank behind it (earlier run first).
      expect((await repo.submit(run(41, 5001, { trackId: 'jungle-ruins' }), 3)).rank).toBe(3);
      // The slow row is kept (it is the player's best), it is just not in the top 3.
      expect((await repo.leaderboard('jungle-ruins', 100, 10)).map(e => e.ticks)).toEqual([5000, 5001, 5001, 5002, 6000]);
    });

    it('keeps exactly one row per player under concurrent submissions', async () => {
      const attempts = [9100, 8800, 9400, 8700, 9000, 8900].map(ticks => run(50, ticks, { trackId: 'starlight-road' }));
      const outcomes = await Promise.all(attempts.map(attempt => repo.submit(attempt, 50)));
      expect(outcomes.every(o => o.rank === 1)).toBe(true);
      const board = await repo.leaderboard('starlight-road', 100, 50);
      expect(board).toHaveLength(1);
      expect(board[0]!.ticks).toBe(8700);
      const best = attempts.find(a => a.ticks === 8700)!;
      expect(board[0]!.id).toBe(best.id);
      for (const attempt of attempts) {
        expect(Boolean(await repo.ghost(attempt.id)), `ghost of ${attempt.ticks}`).toBe(attempt === best);
      }
    });

    it('accepts concurrent submissions from different players', async () => {
      const runs = Array.from({ length: 8 }, (_, i) => run(60 + i, 6000 + i * 7, { trackId: 'frost-peak', cc: 50 }));
      await Promise.all(runs.map(r => repo.submit(r, 50)));
      const board = await repo.leaderboard('frost-peak', 50, 50);
      expect(board.map(e => e.ticks)).toEqual(runs.map(r => r.ticks));
      expect(board.map(e => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('never exposes the player id in public shapes', async () => {
      const board = await repo.leaderboard('frost-peak', 50, 50);
      expect(JSON.stringify(board)).not.toContain('5f0c2a9e');
      expect(JSON.stringify(await repo.ghost(board[0]!.id))).not.toContain('5f0c2a9e');
    });
  });
}

repositoryContract('memory', async () => new MemoryRepository());

// DynamoDB Local: DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:18765 (docker run -p 18765:8000 amazon/dynamodb-local)
const endpoint = process.env.DYNAMODB_TEST_ENDPOINT;
if (endpoint && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)) {
  throw new Error('DynamoDB repository tests only run against a loopback DynamoDB Local endpoint.');
}
const connection = {
  endpoint: endpoint ?? 'http://127.0.0.1:1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
};
const tableName = `turbo-pals-test-${randomUUID()}`;
const admin = new DynamoDBClient({ region: 'ap-northeast-2', ...connection });

describe.skipIf(!endpoint)('DynamoDB Local', () => {
  beforeAll(async () => {
    await admin.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    }));
  });
  afterAll(async () => {
    await admin.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
    admin.destroy();
  });

  repositoryContract('dynamodb', async () => new DynamoRepository(tableName, createDocumentClient('ap-northeast-2', connection)));

  it('stores ghosts outside the board partition and keeps ranking rows small', async () => {
    const inspector = DynamoDBDocumentClient.from(admin);
    const rows = await inspector.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': boardKey('canyon-rally', 100) }, ConsistentRead: true,
    }));
    expect(rows.Items?.length).toBeGreaterThan(0);
    for (const item of rows.Items ?? []) {
      expect(item.sk).toMatch(/^\d{9}#[0-9a-z]{9}[0-9a-f]{16}$/);
      expect(item.log).toBeUndefined();
    }
  });
});
