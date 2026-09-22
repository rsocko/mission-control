import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubDependencyRepositories } from '@/db/postgres/repositories/github-dependency-repositories';
import type { DependencySnapshotRecord } from '@/db/persistence/github-dependencies';
import {
  DEP_CONNECTOR,
  describeGitHubDependencyRepositoriesContract,
  type GitHubDependencyHarness,
} from '../contracts/github-dependency-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-dependency-test',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function cleanupContractRows(): Promise<void> {
  const pool = backend.context.pool;
  await pool.query(
    `DELETE FROM dependency_reconciliation_candidates WHERE snapshot_id IN (
       SELECT id FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1
     )`,
    [DEP_CONNECTOR],
  );
  await pool.query(
    `DELETE FROM dependency_reconciliation_edges WHERE snapshot_id IN (
       SELECT id FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1
     )`,
    [DEP_CONNECTOR],
  );
  await pool.query(
    `DELETE FROM dependency_reconciliation_items WHERE snapshot_id IN (
       SELECT id FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1
     )`,
    [DEP_CONNECTOR],
  );
  await pool.query(
    'DELETE FROM dependency_reconciliation_snapshots WHERE connector_instance_id = $1',
    [DEP_CONNECTOR],
  );
  await pool.query('DELETE FROM task_dependencies WHERE connector_instance_id = $1', [DEP_CONNECTOR]);
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [DEP_CONNECTOR]);
  await pool.query('DELETE FROM github_identity_controls WHERE connector_instance_id = $1', [DEP_CONNECTOR]);
  await pool.query('DELETE FROM connector_configs WHERE id = $1', [DEP_CONNECTOR]);
}

async function seedSnapshotRow(record: DependencySnapshotRecord): Promise<void> {
  await backend.context.pool.query(
    `
      INSERT INTO dependency_reconciliation_snapshots (
        id, connector_instance_id, status, phase, read_mode, cursor, total,
        batch_size, failure_count, imported_count, removed_count, started_at,
        updated_at, completed_at, collection_completed_at, collection_page_count,
        overflow_fetch_count, identity_mode, identity_mode_revision,
        identity_evidence_source, identity_evidence_eligible,
        identity_evidence_failure_reason, failed_at, next_attempt_at, failure_reason,
        last_resume_attempt_at, last_resume_outcome, last_resume_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
      )
    `,
    [
      record.id,
      record.connectorInstanceId,
      record.status,
      record.phase,
      record.readMode,
      record.cursor,
      record.total,
      record.batchSize,
      record.failureCount,
      record.importedCount,
      record.removedCount,
      record.startedAt,
      record.updatedAt,
      record.completedAt,
      record.collectionCompletedAt,
      record.collectionPageCount,
      record.overflowFetchCount,
      record.identityMode,
      record.identityModeRevision,
      record.identityEvidenceSource,
      record.identityEvidenceEligible,
      record.identityEvidenceFailureReason,
      record.failedAt,
      record.nextAttemptAt,
      record.failureReason,
      record.lastResumeAttemptAt,
      record.lastResumeOutcome,
      record.lastResumeReason,
    ],
  );
}

if (connectionString) {
  describeGitHubDependencyRepositoriesContract(
    'PostgreSQL',
    async (): Promise<GitHubDependencyHarness> => {
      await initialize();
      await cleanupContractRows();
      const pool = backend.context.pool;
      const now = '2026-09-01T12:00:00.000Z';
      return {
        repositories: createPostgresGitHubDependencyRepositories(pool),
        setIdentityEpoch: async (connectorInstanceId, revision) => {
          await pool.query(
            `
              INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
              VALUES ($1, $2, $3)
              ON CONFLICT (connector_instance_id)
              DO UPDATE SET mode_revision = EXCLUDED.mode_revision, updated_at = EXCLUDED.updated_at
            `,
            [connectorInstanceId, revision, now],
          );
        },
        seedConnectorConfig: async (connectorId) => {
          await pool.query(
            `
              INSERT INTO connector_configs (id, type, name, enabled, capabilities, created_at, updated_at)
              VALUES ($1, 'github-issues', 'Portable dependency connector', true, '{}'::jsonb, $2, $2)
              ON CONFLICT (id) DO NOTHING
            `,
            [connectorId, now],
          );
        },
        seedSnapshot: seedSnapshotRow,
        seedTask: async (id, connectorInstanceId) => {
          await pool.query(
            `
              INSERT INTO tasks (
                id, source_id, connector_type, connector_instance_id, title,
                created_at, updated_at, last_synced_at
              ) VALUES ($1, $2, 'github-issues', $3, $1, $4, $4, $4)
              ON CONFLICT (id) DO NOTHING
            `,
            [id, `source:${id}`, connectorInstanceId, now],
          );
        },
        seedDependency: async (row) => {
          await pool.query(
            `
              INSERT INTO task_dependencies (
                id, task_id, depends_on_task_id, type, connector_instance_id,
                sync_status, sync_action, sync_error, last_synced_at, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [
              row.id,
              row.taskId,
              row.dependsOnTaskId,
              row.type,
              row.connectorInstanceId,
              row.syncStatus,
              row.syncAction,
              row.syncError,
              row.lastSyncedAt,
              row.createdAt,
            ],
          );
        },
        close: () => undefined,
      };
    },
  );
}

describe.skipIf(Boolean(connectionString))('GitHubDependencyPersistence (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await cleanupContractRows();
    await backend.shutdown();
    initialized = false;
  }
});
