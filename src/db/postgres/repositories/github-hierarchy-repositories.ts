import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  GitHubHierarchyApplyResult,
  GitHubHierarchyExceptionEventRow,
  GitHubHierarchyPersistence,
  GitHubHierarchyStableBindingRow,
  GitHubHierarchyTaskIdentityRow,
  GitHubHierarchyTaskRow,
} from '@/db/persistence/github-hierarchy';
import {
  historicalProofDigestMatches,
  historicalProofMatchesBindings,
  type HistoricalTransferBinding,
} from '@/db/persistence/github-transfer-succession';
import { inspectTaskTransferBinding } from './github-recovery-support';

type Client = Pool | PoolClient;

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

interface HistoricalSuccessionRow {
  sourceTaskId: string;
  successorTaskId: string;
  sourceExternalEntityId: string;
  successorExternalEntityId: string;
  proof: unknown;
  proofDigest: string;
}

async function readProvenSupersededTaskIds(
  client: Client,
  connectorInstanceId: string,
  observedEndpointTaskIds: readonly string[],
): Promise<Set<string>> {
  if (observedEndpointTaskIds.length === 0) return new Set();
  const observed = new Set(observedEndpointTaskIds);
  const rows = await query<HistoricalSuccessionRow & QueryResultRow>(
    client,
    `SELECT
       source_task_id AS "sourceTaskId",
       successor_task_id AS "successorTaskId",
       source_external_entity_id AS "sourceExternalEntityId",
       successor_external_entity_id AS "successorExternalEntityId",
       proof,
       proof_digest AS "proofDigest"
     FROM github_identity_task_transfer_reconciliations
     WHERE connector_instance_id = $1
       AND successor_task_id = ANY($2::text[])`,
    [connectorInstanceId, observedEndpointTaskIds],
  );
  const superseded = new Set<string>();
  for (const row of rows) {
    if (observed.has(row.sourceTaskId) || !observed.has(row.successorTaskId)) continue;
    if (!historicalProofDigestMatches(row.proof, row.proofDigest)) continue;
    const [sourceResult, successorResult] = await Promise.all([
      inspectTaskTransferBinding(client, connectorInstanceId, row.sourceTaskId),
      inspectTaskTransferBinding(client, connectorInstanceId, row.successorTaskId),
    ]);
    if ('error' in sourceResult || 'error' in successorResult) continue;
    const source: HistoricalTransferBinding = sourceResult.binding;
    const successor: HistoricalTransferBinding = successorResult.binding;
    if (
      source.externalEntityId !== row.sourceExternalEntityId
      || successor.externalEntityId !== row.successorExternalEntityId
      || !historicalProofMatchesBindings(row.proof, source, successor)
    ) {
      continue;
    }
    superseded.add(source.taskId);
  }
  return superseded;
}

/**
 * PostgreSQL adapter for the GitHub sub-issue hierarchy reconciliation port.
 *
 * The hierarchy fences behave identically to SQLite, including revalidation of
 * historical task-transfer succession proofs against current bindings.
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

    async provenSupersededTaskIds(connectorInstanceId, observedEndpointTaskIds) {
      return [...await readProvenSupersededTaskIds(
        pool,
        connectorInstanceId,
        observedEndpointTaskIds,
      )];
    },

    async applyReconciliation({ connectorInstanceId, observedEndpointTaskIds, reconcile }) {
      return transaction(pool, async (client): Promise<GitHubHierarchyApplyResult> => {
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
        const supersededHistoricalTaskIds = await readProvenSupersededTaskIds(
          client,
          connectorInstanceId,
          observedEndpointTaskIds,
        );

        const verdict = reconcile({
          identitySnapshot,
          tasks: taskRows,
          exceptionEvents,
          supersededHistoricalTaskIds,
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
