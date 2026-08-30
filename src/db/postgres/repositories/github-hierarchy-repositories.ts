import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { UnsupportedGitHubWorkerOperationError } from '@/db/persistence/github-worker-errors';
import type {
  GitHubHierarchyApplyResult,
  GitHubHierarchyExceptionEventRow,
  GitHubHierarchyPersistence,
  GitHubHierarchyStableBindingRow,
  GitHubHierarchyTaskIdentityRow,
  GitHubHierarchyTaskRow,
} from '@/db/persistence/github-hierarchy';

type Client = Pool | PoolClient;

const HISTORICAL_SUCCESSION_REASON = 'GitHub historical task-transfer succession state';

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Fail closed if any historical task-transfer succession state exists for the
 * connector. That succession filtering (`provenSupersededGitHubTaskIds`) is a
 * legacy SQLite-only surface: rather than silently ignoring it and reconciling
 * the hierarchy from an incomplete population, PostgreSQL refuses the operation.
 */
async function assertNoHistoricalSuccession(
  client: Client,
  connectorInstanceId: string,
): Promise<void> {
  const rows = await query<{ exists: number }>(
    client,
    `SELECT 1 AS exists
     FROM github_identity_task_transfer_reconciliations
     WHERE connector_instance_id = $1
     LIMIT 1`,
    [connectorInstanceId],
  );
  if (rows.length > 0) {
    throw new UnsupportedGitHubWorkerOperationError(HISTORICAL_SUCCESSION_REASON);
  }
}

/**
 * PostgreSQL adapter for the GitHub sub-issue hierarchy reconciliation port.
 *
 * The hierarchy fences behave identically to SQLite, with one deliberate
 * exception: historical task-transfer succession state is not migrated, so any
 * such state makes this adapter fail closed with
 * `UnsupportedGitHubWorkerOperationError` instead of reconciling from a
 * population that omits proven-superseded tasks.
 */
export function createPostgresGitHubHierarchyRepositories(
  pool: Pool,
): GitHubHierarchyPersistence {
  return {
    async getIdentityModeSnapshot(connectorInstanceId) {
      const [row] = await query<{ modeRevision: number }>(
        pool,
        `SELECT mode_revision AS "modeRevision"
         FROM github_identity_controls
         WHERE connector_instance_id = $1
         LIMIT 1`,
        [connectorInstanceId],
      );
      return { connectorInstanceId, modeRevision: row?.modeRevision ?? 0 };
    },

    async listConnectorTaskIdentities(connectorInstanceId) {
      return query<GitHubHierarchyTaskIdentityRow & QueryResultRow>(
        pool,
        `SELECT
           id,
           source_id AS "sourceId",
           connector_instance_id AS "connectorInstanceId",
           connector_type AS "connectorType",
           is_checklist_item AS "isChecklistItem",
           metadata
         FROM tasks
         WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
    },

    async listTaskStableBindings(connectorInstanceId) {
      return query<GitHubHierarchyStableBindingRow & QueryResultRow>(
        pool,
        `SELECT
           binding.local_id AS "localTaskId",
           entity.provider,
           entity.host_key AS "hostKey",
           entity.entity_type AS "entityType",
           entity.stable_id AS "stableId"
         FROM external_entity_bindings AS binding
         INNER JOIN external_entities AS entity
           ON entity.id = binding.external_entity_id
         WHERE binding.connector_instance_id = $1
           AND binding.binding_type = 'task'
           AND binding.state != 'retired'`,
        [connectorInstanceId],
      );
    },

    async listTerminalInaccessibleExceptions(connectorInstanceId) {
      return query<GitHubHierarchyExceptionEventRow & QueryResultRow>(
        pool,
        `SELECT id, local_id AS "localId", action
         FROM github_identity_exception_events
         WHERE connector_instance_id = $1
           AND binding_type = 'task'
           AND category = 'terminal_inaccessible'
         ORDER BY id DESC`,
        [connectorInstanceId],
      );
    },

    async provenSupersededTaskIds(connectorInstanceId) {
      await assertNoHistoricalSuccession(pool, connectorInstanceId);
      return [];
    },

    async applyReconciliation({ connectorInstanceId, reconcile }) {
      return transaction(pool, async (client): Promise<GitHubHierarchyApplyResult> => {
        await assertNoHistoricalSuccession(client, connectorInstanceId);

        const [control] = await query<{ modeRevision: number }>(
          client,
          `SELECT mode_revision AS "modeRevision"
           FROM github_identity_controls
           WHERE connector_instance_id = $1
           LIMIT 1`,
          [connectorInstanceId],
        );
        const identitySnapshot = {
          connectorInstanceId,
          modeRevision: control?.modeRevision ?? 0,
        };

        const taskRows = await query<GitHubHierarchyTaskRow & QueryResultRow>(
          client,
          `SELECT
             id,
             source_id AS "sourceId",
             connector_instance_id AS "connectorInstanceId",
             connector_type AS "connectorType",
             is_checklist_item AS "isChecklistItem",
             parent_id AS "parentId",
             depth,
             metadata
           FROM tasks
           WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );

        const exceptionEvents = await query<GitHubHierarchyExceptionEventRow & QueryResultRow>(
          client,
          `SELECT id, local_id AS "localId", action
           FROM github_identity_exception_events
           WHERE connector_instance_id = $1
             AND binding_type = 'task'
             AND category = 'terminal_inaccessible'
           ORDER BY id DESC`,
          [connectorInstanceId],
        );

        const verdict = reconcile({
          identitySnapshot,
          tasks: taskRows,
          exceptionEvents,
          supersededHistoricalTaskIds: new Set<string>(),
        });
        if (verdict.fenced) {
          return { applied: false, updated: 0, fenced: true };
        }

        let updated = 0;
        for (const update of verdict.updates) {
          if (update.metadata !== undefined) {
            const result = await client.query(
              `UPDATE tasks SET parent_id = $1, depth = $2, metadata = $3 WHERE id = $4`,
              [update.parentId, update.depth, update.metadata, update.taskId],
            );
            updated += result.rowCount ?? 0;
          } else {
            const result = await client.query(
              `UPDATE tasks SET parent_id = $1, depth = $2 WHERE id = $3`,
              [update.parentId, update.depth, update.taskId],
            );
            updated += result.rowCount ?? 0;
          }
        }
        return { applied: true, updated, fenced: false };
      });
    },
  };
}
