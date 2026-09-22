import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  createPostgresConnectorExecutionRepositories,
} from '@/db/postgres/repositories/connector-execution-repositories';

const poison = vi.hoisted(() => ({ touched: vi.fn() }));

vi.mock('@/db', () => ({
  get default() {
    poison.touched();
    throw new Error('SQLite composition was evaluated');
  },
  get sqlite() {
    poison.touched();
    throw new Error('SQLite composition was evaluated');
  },
}));

describe('PostgreSQL connector-core route composition', () => {
  it('publishes connector management under execution.management', () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
    } as unknown as Pool;

    const repositories = createPostgresConnectorExecutionRepositories(pool);
    expect(repositories.management).toEqual(expect.objectContaining({
      getOverview: expect.any(Function),
      createConnector: expect.any(Function),
      updateConnector: expect.any(Function),
      listSyncHistory: expect.any(Function),
      getSyncWorkerHeartbeat: expect.any(Function),
    }));
    expect(poison.touched).not.toHaveBeenCalled();
  });

  it('runs GitHub recovery preflight before opening a database transaction', async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes('FROM sync_deletion_snapshots')) {
        return {
          rows: [{
            id: 'snapshot-1',
            originalTaskId: 'task-1',
            connectorId: 'github-1',
            taskData: { connectorType: 'github-issues' },
            relationshipData: {},
            restoredTaskId: null,
            recoveryState: 'pending',
            quarantineReason: null,
            identityMode: 'stable',
            identityModeRevision: 1,
            issueEntityId: 'issue-entity-1',
            repositoryEntityId: 'repository-entity-1',
            locatorRevision: 1,
            bindingRevision: '2026-09-04T04:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      if (statement.includes('FROM github_identity_controls')) {
        return { rows: [{ modeRevision: 1 }], rowCount: 1 };
      }
      if (statement.includes('FROM external_entity_bindings')) {
        return {
          rows: [{
            state: 'active',
            verifiedAt: '2026-09-04T04:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      if (
        statement.includes('FROM external_entity_locators')
        && statement.includes('INNER JOIN external_entities')
      ) {
        return {
          rows: [{
            owner: 'octo',
            repository: 'repo',
            issueNumber: 42,
            issueStableId: 'issue-node-1',
            repositoryStableId: 'repo-node-1',
          }],
          rowCount: 1,
        };
      }
      if (statement.includes('FROM external_entity_locators')) {
        return {
          rows: [{
            repositoryEntityId: 'repository-entity-1',
            locatorRevision: 1,
          }],
          rowCount: 1,
        };
      }
      if (statement.includes('FROM task_source_write_leases')) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes('UPDATE sync_deletion_snapshots')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const connect = vi.fn(() => {
      throw new Error('Transaction opened before remote preflight completed');
    });
    const pool = { query, connect } as unknown as Pool;
    const preflight = vi.fn(async () => ({
      targets: {
        primary_issue: {
          repositoryStableId: 'repo-node-1',
          issueStableId: 'different-issue-node',
        },
      },
    }));

    const repositories = createPostgresConnectorExecutionRepositories(pool);
    await expect(repositories.deletions.restoreDeletionSnapshot(
      'snapshot-1',
      'source',
      preflight,
    )).rejects.toThrow('remote_identity_disagreement');

    expect(preflight).toHaveBeenCalledWith({
      targets: [{
        role: 'primary_issue',
        owner: 'octo',
        repository: 'repo',
        issueNumber: 42,
      }],
    });
    expect(connect).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET recovery_state = 'quarantined'"),
      ['remote_identity_disagreement', 'snapshot-1'],
    );
    expect(poison.touched).not.toHaveBeenCalled();
  });

  it('imports all eight migrated route modules without evaluating @/db', async () => {
    const modules = await Promise.all([
      import('@/app/api/connectors/route'),
      import('@/app/api/source-lists/[id]/route'),
      import('@/app/api/source-lists/[id]/rename/route'),
      import('@/app/api/source-lists/rename/route'),
      import('@/app/api/source-lists/reorder/route'),
      import('@/app/api/source-rankings/route'),
      import('@/app/api/sync/deletions/[id]/route'),
      import('@/app/api/sync/route'),
    ]);

    expect(modules).toHaveLength(8);
    expect(poison.touched).not.toHaveBeenCalled();
  });
});
