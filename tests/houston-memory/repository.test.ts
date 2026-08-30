import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteHoustonMemoryRepository } from '@/db/persistence/sqlite-core-repositories';

function createRepository() {
  const database = new Database(':memory:');
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle', '0123_houston_summary_memory.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) database.exec(statement);
  }
  return { database, repository: new SqliteHoustonMemoryRepository(database) };
}

const write = {
  id: '11111111-1111-4111-8111-111111111111',
  authorizationScope: 'installation',
  title: 'Release planning',
  summary: 'Chose a staged rollout.',
  decisions: ['Use a staged rollout'],
  commitments: ['Review results Friday'],
  topics: ['release'],
  linkedEntities: [{ type: 'project' as const, id: 'project-1', label: 'Launch' }],
  sensitivity: 'restricted' as const,
  retainUntil: '2026-06-01T00:00:00.000Z',
  now: '2026-03-01T00:00:00.000Z',
};

describe('Houston memory SQLite repository', () => {
  it('authorizes before reads and filters expired memories', async () => {
    const { database, repository } = createRepository();
    await repository.upsert(write);

    await expect(repository.get(write.id, 'other-scope')).resolves.toBeNull();
    await expect(repository.list({
      authorizationScope: 'other-scope',
      limit: 20,
      now: '2026-03-02T00:00:00.000Z',
    })).resolves.toEqual([]);
    await expect(repository.list({
      authorizationScope: 'installation',
      limit: 20,
      now: '2026-06-01T00:00:00.000Z',
    })).resolves.toEqual([]);
    database.close();
  });

  it('keeps exclusions sticky and supports explicit deletion', async () => {
    const { database, repository } = createRepository();
    await repository.upsert(write);
    await expect(repository.exclude(
      write.id,
      'installation',
      '2026-03-02T00:00:00.000Z',
    )).resolves.toBe(true);

    await repository.upsert({ ...write, summary: 'A later transcript summary.', now: '2026-03-03T00:00:00.000Z' });
    const excluded = await repository.get(write.id, 'installation');
    expect(excluded?.summary).toBe(write.summary);
    expect(excluded?.excludedAt).toBe('2026-03-02T00:00:00.000Z');
    await expect(repository.list({
      authorizationScope: 'installation',
      limit: 20,
      now: '2026-03-03T00:00:00.000Z',
    })).resolves.toEqual([]);

    await expect(repository.delete(write.id, 'installation')).resolves.toBe(true);
    await expect(repository.get(write.id, 'installation')).resolves.toBeNull();
    database.close();
  });

  it('contains no transcript or message columns', () => {
    const { database } = createRepository();
    const columns = database.prepare(
      "SELECT name FROM pragma_table_info('houston_conversation_memories')",
    ).all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['transcript', 'messages', 'tool_output', 'reasoning']),
    );
    database.close();
  });

  it('physically deletes expired memories in bounded batches', async () => {
    const { database, repository } = createRepository();
    await repository.upsert(write);
    await repository.upsert({ ...write, id: '22222222-2222-4222-8222-222222222222' });

    await expect(repository.deleteExpired('2026-06-01T00:00:00.000Z', 1))
      .resolves.toHaveLength(1);
    await expect(repository.deleteExpired('2026-06-01T00:00:00.000Z', 100))
      .resolves.toHaveLength(1);
    expect(database.prepare('SELECT COUNT(*) AS count FROM houston_conversation_memories').get())
      .toEqual({ count: 0 });
    database.close();
  });
});
