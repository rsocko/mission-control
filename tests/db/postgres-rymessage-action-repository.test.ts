import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresRyMessageActionRepository } from '@/db/postgres/repositories/rymessage-action-repository';
import type { CompanionActionMutationRequestV2 } from '@/lib/connectors/rymessage/action-contract-v2';

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
  it('uses canonical mutation digests for duplicate and changed-content detection', async () => {
    let storedDigest: string | null = null;
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('FROM connector_configs')) {
        return result([{ type: 'rymessage', enabled: true, deletedAt: null }]);
      }
      if (sql.includes('SELECT mutation_digest AS digest')) {
        return result(storedDigest ? [{ digest: storedDigest }] : []);
      }
      if (sql.includes('INSERT INTO rymessage_action_v2_outbound_mutations')) {
        storedDigest = String(parameters?.[4]);
      }
      return result();
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = createPostgresRyMessageActionRepository(pool);
    const request: CompanionActionMutationRequestV2 = {
      contractVersion: '2.0',
      operationId: '00000000-0000-4000-8000-000000000021',
      actionId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 1,
      mutation: {
        kind: 'creation-intent.register',
        intentId: '00000000-0000-4000-8000-000000000011',
        draft: { title: 'Create task', notes: 'Portable', priority: true },
      },
    };
    await expect(repository.enqueueV2Mutation({
      connectorId: 'connector-1',
      request,
      now: '2026-09-29T23:00:00.000Z',
    })).resolves.toBe('queued');
    const reordered: CompanionActionMutationRequestV2 = {
      mutation: {
        draft: { priority: true, notes: 'Portable', title: 'Create task' },
        intentId: '00000000-0000-4000-8000-000000000011',
        kind: 'creation-intent.register',
      },
      expectedRevision: 1,
      actionId: '00000000-0000-4000-8000-000000000001',
      operationId: '00000000-0000-4000-8000-000000000021',
      contractVersion: '2.0',
    };
    await expect(repository.enqueueV2Mutation({
      connectorId: 'connector-1',
      request: reordered,
      now: '2026-09-29T23:00:00.000Z',
    })).resolves.toBe('duplicate');
    await expect(repository.enqueueV2Mutation({
      connectorId: 'connector-1',
      request: {
        ...reordered,
        mutation: {
          kind: 'creation-intent.register',
          intentId: '00000000-0000-4000-8000-000000000011',
          draft: { title: 'Changed content' },
        },
      },
      now: '2026-09-29T23:00:00.000Z',
    })).rejects.toMatchObject({ code: 'OPERATION_DIGEST_CONFLICT' });
  });

  it('rejects receipts whose action identity does not match the leased operation', async () => {
    const operationId = '00000000-0000-4000-8000-000000000021';
    const actionId = '00000000-0000-4000-8000-000000000001';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT attempt_count AS "attemptCount"')) {
        return result([{ attemptCount: 1, actionId }]);
      }
      return result();
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = createPostgresRyMessageActionRepository(pool);
    await expect(repository.settleV2Mutation({
      connectorId: 'connector-1',
      operationId,
      leaseId: '00000000-0000-4000-8000-000000000099',
      now: '2026-09-29T23:00:00.000Z',
      receipt: {
        operationId,
        actionId: '00000000-0000-4000-8000-000000000002',
        outcome: 'applied',
        revision: 2,
      },
    })).rejects.toMatchObject({ code: 'RECEIPT_IDENTITY_MISMATCH' });
    expect(query.mock.calls.some(([sql]) => (
      String(sql).includes('UPDATE rymessage_action_v2_outbound_mutations')
    ))).toBe(false);
  });
});
