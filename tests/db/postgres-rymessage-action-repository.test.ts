import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresRyMessageActionRepository } from '@/db/postgres/repositories/rymessage-action-repository';

function result(rows: unknown[] = []): QueryResult {
  return {
    rows,
    command: '',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  } as QueryResult;
}

describe('PostgreSQL RyMessage action repository query shape', () => {
  it('classifies and updates the bounded relation batch with one task lookup query', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM connector_configs')) {
        return result([{ type: 'rymessage', enabled: true, deletedAt: null }]);
      }
      return result();
    });
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    const repository = createPostgresRyMessageActionRepository(pool);
    await expect(repository.reconcileMaterializations({
      connectorId: 'connector-1',
      now: '2026-09-29T23:00:00.000Z',
    })).resolves.toEqual({
      linked: 0,
      pendingImport: 0,
      conflicts: 0,
      broken: 0,
      observationsQueued: 0,
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const taskLookups = statements.filter((sql) => sql.includes('FROM tasks'));
    expect(taskLookups).toHaveLength(1);
    expect(taskLookups[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(taskLookups[0]).toContain('UPDATE rymessage_action_materializations');
    expect(query).toHaveBeenCalledTimes(4);
  });
});
