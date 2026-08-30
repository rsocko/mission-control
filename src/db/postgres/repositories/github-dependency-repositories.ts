import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import type {
  ApplyReconciliationBatchInput,
  ApplyTargetedReconciliationInput,
  ApplyTargetedReconciliationResult,
  CompleteCollectionInput,
  CompleteSnapshotPartialInput,
  CompleteSnapshotPartialResult,
  CreateGenerationInput,
  DependencyRecord,
  DependencySnapshotEdgeRecord,
  DependencySnapshotFence,
  DependencySnapshotInsert,
  DependencySnapshotItemEvidence,
  DependencySnapshotRecord,
  DependencyTaskRow,
  FailCollectionInput,
  FinalizeSnapshotGenerationInput,
  FinalizeSnapshotGenerationResult,
  GitHubDependencyPersistence,
  MarkSnapshotFailedInput,
  RecordResumeOutcomeInput,
  StageCollectionPageInput,
  UpdateDependencySyncInput,
} from '@/db/persistence/github-dependencies';

type Client = Pool | PoolClient;

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await client.query(text, [...params]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/** Aborts a transaction while carrying the caller-visible result to return. */
class RollbackSignal<R> extends Error {
  constructor(readonly result: R) {
    super('github-dependency-rollback');
    this.name = 'RollbackSignal';
  }
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
      if (error instanceof RollbackSignal) return error.result as T;
      throw error;
    }
  } finally {
    client.release();
  }
}

const SNAPSHOT_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  status,
  phase,
  read_mode AS "readMode",
  cursor,
  total,
  batch_size AS "batchSize",
  failure_count AS "failureCount",
  imported_count AS "importedCount",
  removed_count AS "removedCount",
  started_at AS "startedAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt",
  collection_completed_at AS "collectionCompletedAt",
  collection_page_count AS "collectionPageCount",
  overflow_fetch_count AS "overflowFetchCount",
  identity_mode AS "identityMode",
  identity_mode_revision AS "identityModeRevision",
  identity_evidence_source AS "identityEvidenceSource",
  identity_evidence_eligible AS "identityEvidenceEligible",
  identity_evidence_failure_reason AS "identityEvidenceFailureReason",
  failed_at AS "failedAt",
  next_attempt_at AS "nextAttemptAt",
  failure_reason AS "failureReason",
  last_resume_attempt_at AS "lastResumeAttemptAt",
  last_resume_outcome AS "lastResumeOutcome",
  last_resume_reason AS "lastResumeReason"
`;

const DEPENDENCY_COLUMNS = `
  id,
  task_id AS "taskId",
  depends_on_task_id AS "dependsOnTaskId",
  type,
  connector_instance_id AS "connectorInstanceId",
  sync_status AS "syncStatus",
  sync_action AS "syncAction",
  sync_error AS "syncError",
  last_synced_at AS "lastSyncedAt",
  created_at AS "createdAt"
`;

/** Builds `($1, $2, ...), ($n, ...)` placeholders for a multi-row insert. */
function valuesPlaceholders(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  let index = 1;
  for (let row = 0; row < rowCount; row += 1) {
    const cols: string[] = [];
    for (let col = 0; col < colCount; col += 1) {
      cols.push(`$${index}`);
      index += 1;
    }
    rows.push(`(${cols.join(', ')})`);
  }
  return rows.join(', ');
}

function jsonbParam(value: unknown): unknown {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * PostgreSQL adapter for GitHub dependency generation, reconciliation, resume,
 * and polling. Reproduces the fenced-write transactions from the legacy
 * `task-dependency-manager.ts` in raw SQL against the parallel PostgreSQL tables.
 */
export function createPostgresGitHubDependencyRepositories(
  pool: Pool,
): GitHubDependencyPersistence {
  async function readModeRevision(
    client: Client,
    connectorInstanceId: string,
  ): Promise<number> {
    const { rows } = await query<{ modeRevision: number }>(
      client,
      `
        SELECT mode_revision AS "modeRevision"
        FROM github_identity_controls
        WHERE connector_instance_id = $1
        LIMIT 1
      `,
      [connectorInstanceId],
    );
    return rows[0]?.modeRevision ?? 0;
  }

  /** The dependency snapshot write fence — see the SQLite adapter for parity. */
  async function validate(
    client: Client,
    snapshot: DependencySnapshotFence,
    options: {
      phase?: DependencySnapshotRecord['phase'];
      cursor?: number;
      now?: string;
    } = {},
  ): Promise<boolean> {
    const { rows } = await query<{
      status: string;
      phase: DependencySnapshotRecord['phase'];
      cursor: number;
      identityMode: string;
      identityModeRevision: number;
    }>(
      client,
      `
        SELECT
          status,
          phase,
          cursor,
          identity_mode AS "identityMode",
          identity_mode_revision AS "identityModeRevision"
        FROM dependency_reconciliation_snapshots
        WHERE id = $1
        LIMIT 1
      `,
      [snapshot.id],
    );
    const persisted = rows[0];
    if (
      !persisted
      || persisted.identityMode !== snapshot.identityMode
      || persisted.identityModeRevision !== snapshot.identityModeRevision
    ) {
      return false;
    }
    const currentRevision = await readModeRevision(client, snapshot.connectorInstanceId);
    if (currentRevision !== snapshot.identityModeRevision) {
      const now = options.now ?? new Date().toISOString();
      await query(
        client,
        `
          UPDATE dependency_reconciliation_snapshots
          SET status = 'partial',
              phase = 'completed',
              identity_evidence_eligible = false,
              identity_evidence_failure_reason = 'dependency_identity_context_changed',
              completed_at = $2,
              failed_at = $2,
              updated_at = $2,
              next_attempt_at = NULL,
              failure_reason = $3
          WHERE id = $1
            AND identity_mode = $4
            AND identity_mode_revision = $5
            AND status IN ('running', 'failed')
        `,
        [
          snapshot.id,
          now,
          `identity context changed from ${snapshot.identityMode}:${snapshot.identityModeRevision}`
            + ` to ${GITHUB_IDENTITY_MODE}:${currentRevision}`,
          snapshot.identityMode,
          snapshot.identityModeRevision,
        ],
      );
      return false;
    }
    return (options.phase === undefined || persisted.phase === options.phase)
      && (options.cursor === undefined || persisted.cursor === options.cursor);
  }

  async function insertSnapshot(
    client: Client,
    insert: DependencySnapshotInsert,
  ): Promise<void> {
    await query(
      client,
      `
        INSERT INTO dependency_reconciliation_snapshots (
          id, connector_instance_id, status, phase, read_mode, cursor, total,
          batch_size, failure_count, imported_count, removed_count, started_at,
          updated_at, completed_at, collection_completed_at, collection_page_count,
          overflow_fetch_count, identity_mode, identity_mode_revision,
          identity_evidence_source, identity_evidence_eligible,
          identity_evidence_failure_reason, failed_at, next_attempt_at, failure_reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24, $25
        )
      `,
      [
        insert.id,
        insert.connectorInstanceId,
        insert.status,
        insert.phase ?? 'reconciling',
        insert.readMode ?? null,
        insert.cursor ?? 0,
        insert.total,
        insert.batchSize,
        insert.failureCount ?? 0,
        insert.importedCount ?? 0,
        insert.removedCount ?? 0,
        insert.startedAt,
        insert.updatedAt,
        insert.completedAt ?? null,
        insert.collectionCompletedAt ?? null,
        insert.collectionPageCount ?? 0,
        insert.overflowFetchCount ?? 0,
        insert.identityMode,
        insert.identityModeRevision,
        insert.identityEvidenceSource ?? 'legacy-unavailable',
        insert.identityEvidenceEligible ?? false,
        insert.identityEvidenceFailureReason ?? null,
        insert.failedAt ?? null,
        insert.nextAttemptAt ?? null,
        insert.failureReason ?? null,
      ],
    );
  }

  async function insertItems(
    client: Client,
    snapshotId: string,
    items: CreateGenerationInput['items'] | StageCollectionPageInput['newItems'],
  ): Promise<void> {
    if (!items || items.length === 0) return;
    const params: unknown[] = [];
    for (const item of items) {
      params.push(
        snapshotId,
        item.position,
        item.sourceId,
        item.verified,
        jsonbParam(item.identityEvidence),
        item.identityEvidenceState,
      );
    }
    await query(
      client,
      `
        INSERT INTO dependency_reconciliation_items (
          snapshot_id, position, source_id, verified, identity_evidence,
          identity_evidence_state
        ) VALUES ${valuesPlaceholders(items.length, 6)}
      `,
      params,
    );
  }

  async function insertEdges(
    client: Client,
    snapshotId: string,
    edges: readonly DependencySnapshotEdgeRecord[],
  ): Promise<void> {
    if (edges.length === 0) return;
    const params: unknown[] = [];
    for (const edge of edges) {
      params.push(
        snapshotId,
        edge.blockerSourceId,
        edge.blockedSourceId,
        jsonbParam(edge.blockerIdentityEvidence),
        edge.blockerIdentityEvidenceState,
      );
    }
    await query(
      client,
      `
        INSERT INTO dependency_reconciliation_edges (
          snapshot_id, blocker_source_id, blocked_source_id,
          blocker_identity_evidence, blocker_identity_evidence_state
        ) VALUES ${valuesPlaceholders(edges.length, 5)}
        ON CONFLICT DO NOTHING
      `,
      params,
    );
  }

  async function insertTaskDependencies(
    client: Client,
    inserts: FinalizeSnapshotGenerationInput['insertableEdges'],
  ): Promise<number> {
    if (inserts.length === 0) return 0;
    const params: unknown[] = [];
    for (const insert of inserts) {
      params.push(
        insert.id,
        insert.taskId,
        insert.dependsOnTaskId,
        insert.type,
        insert.connectorInstanceId,
        insert.syncStatus,
        insert.syncAction,
        insert.syncError,
        insert.lastSyncedAt,
        insert.createdAt,
      );
    }
    const { rowCount } = await query(
      client,
      `
        INSERT INTO task_dependencies (
          id, task_id, depends_on_task_id, type, connector_instance_id,
          sync_status, sync_action, sync_error, last_synced_at, created_at
        ) VALUES ${valuesPlaceholders(inserts.length, 10)}
        ON CONFLICT DO NOTHING
      `,
      params,
    );
    return rowCount;
  }

  async function pruneTerminalSnapshots(
    client: Client,
    connectorInstanceId: string,
    retainedSnapshotIds: readonly string[],
  ): Promise<number> {
    const { rowCount } = await query(
      client,
      `
        DELETE FROM dependency_reconciliation_snapshots
        WHERE connector_instance_id = $1
          AND status IN ('completed', 'partial')
          AND NOT (id = ANY($2::text[]))
      `,
      [connectorInstanceId, [...retainedSnapshotIds]],
    );
    return rowCount;
  }

  function edgeRecord(row: {
    blockerSourceId: string;
    blockedSourceId: string;
    blockerIdentityEvidence: DependencySnapshotEdgeRecord['blockerIdentityEvidence'];
    blockerIdentityEvidenceState: DependencySnapshotEdgeRecord['blockerIdentityEvidenceState'];
  }): DependencySnapshotEdgeRecord {
    return {
      blockerSourceId: row.blockerSourceId,
      blockedSourceId: row.blockedSourceId,
      blockerIdentityEvidence: row.blockerIdentityEvidence ?? null,
      blockerIdentityEvidenceState: row.blockerIdentityEvidenceState,
    };
  }

  function itemEvidence(row: {
    sourceId: string;
    identityEvidence: DependencySnapshotItemEvidence['identityEvidence'];
    identityEvidenceState: DependencySnapshotItemEvidence['identityEvidenceState'];
  }): DependencySnapshotItemEvidence {
    return {
      sourceId: row.sourceId,
      identityEvidence: row.identityEvidence ?? null,
      identityEvidenceState: row.identityEvidenceState,
    };
  }

  return {
    async getDependencyById(id) {
      const { rows } = await query<DependencyRecord>(
        pool,
        `SELECT ${DEPENDENCY_COLUMNS} FROM task_dependencies WHERE id = $1 LIMIT 1`,
        [id],
      );
      return rows[0] ?? null;
    },

    async updateDependencySync(input: UpdateDependencySyncInput) {
      const assignments: string[] = [];
      const params: unknown[] = [];
      let index = 1;
      if (input.connectorInstanceId !== undefined) {
        assignments.push(`connector_instance_id = $${index}`);
        params.push(input.connectorInstanceId);
        index += 1;
      }
      if (input.syncStatus !== undefined) {
        assignments.push(`sync_status = $${index}`);
        params.push(input.syncStatus);
        index += 1;
      }
      if (input.syncAction !== undefined) {
        assignments.push(`sync_action = $${index}`);
        params.push(input.syncAction);
        index += 1;
      }
      if (input.syncError !== undefined) {
        assignments.push(`sync_error = $${index}`);
        params.push(input.syncError);
        index += 1;
      }
      if (input.lastSyncedAt !== undefined) {
        assignments.push(`last_synced_at = $${index}`);
        params.push(input.lastSyncedAt);
        index += 1;
      }
      if (assignments.length === 0) return;
      params.push(input.id);
      await query(
        pool,
        `UPDATE task_dependencies SET ${assignments.join(', ')} WHERE id = $${index}`,
        params,
      );
    },

    async deleteDependencyById(id) {
      await query(pool, 'DELETE FROM task_dependencies WHERE id = $1', [id]);
    },

    async listConnectorTasks(connectorInstanceId) {
      const { rows } = await query<DependencyTaskRow>(
        pool,
        `
          SELECT
            id,
            source_id AS "sourceId",
            connector_instance_id AS "connectorInstanceId",
            is_checklist_item AS "isChecklistItem",
            metadata
          FROM tasks
          WHERE connector_instance_id = $1
        `,
        [connectorInstanceId],
      );
      return rows;
    },

    async listBlocksDependenciesForTasks(taskIds) {
      if (taskIds.length === 0) return [];
      const { rows } = await query<DependencyRecord>(
        pool,
        `
          SELECT ${DEPENDENCY_COLUMNS}
          FROM task_dependencies
          WHERE task_id = ANY($1::text[]) AND type = 'blocks'
        `,
        [[...taskIds]],
      );
      return rows;
    },

    async getDeletionCandidateDependencyIds(connectorInstanceId) {
      const { rows } = await query<{ id: string }>(
        pool,
        `
          SELECT id FROM task_dependencies
          WHERE connector_instance_id = $1
            AND sync_status = 'synced'
            AND sync_action IS NULL
        `,
        [connectorInstanceId],
      );
      return rows.map(({ id }) => id);
    },

    async getSnapshotById(id) {
      const { rows } = await query<DependencySnapshotRecord>(
        pool,
        `SELECT ${SNAPSHOT_COLUMNS} FROM dependency_reconciliation_snapshots WHERE id = $1 LIMIT 1`,
        [id],
      );
      return rows[0] ?? null;
    },

    async loadActiveSnapshot(connectorInstanceId) {
      const { rows } = await query<DependencySnapshotRecord>(
        pool,
        `
          SELECT ${SNAPSHOT_COLUMNS}
          FROM dependency_reconciliation_snapshots
          WHERE connector_instance_id = $1 AND status IN ('running', 'failed')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [connectorInstanceId],
      );
      return rows[0] ?? null;
    },

    async getLastCompletedSnapshot(connectorInstanceId) {
      const { rows } = await query<DependencySnapshotRecord>(
        pool,
        `
          SELECT ${SNAPSHOT_COLUMNS}
          FROM dependency_reconciliation_snapshots
          WHERE connector_instance_id = $1 AND status = 'completed'
          ORDER BY completed_at DESC
          LIMIT 1
        `,
        [connectorInstanceId],
      );
      return rows[0] ?? null;
    },

    async getTerminalSnapshotIdsToRetain({
      connectorInstanceId,
      currentSnapshotId,
      maxHistory,
    }) {
      const recentSnapshots = await query<{ id: string }>(
        pool,
        `
          SELECT id FROM dependency_reconciliation_snapshots
          WHERE connector_instance_id = $1
            AND status IN ('completed', 'partial')
            AND id <> $2
          ORDER BY updated_at DESC, id DESC
          LIMIT $3
        `,
        [connectorInstanceId, currentSnapshotId, maxHistory - 1],
      );
      const lastCompletedSnapshots = await query<{ id: string }>(
        pool,
        `
          SELECT id FROM dependency_reconciliation_snapshots
          WHERE connector_instance_id = $1
            AND status = 'completed'
            AND id <> $2
          ORDER BY completed_at DESC, id DESC
          LIMIT 1
        `,
        [connectorInstanceId, currentSnapshotId],
      );
      const retainedIds = new Set<string>([
        currentSnapshotId,
        ...lastCompletedSnapshots.rows.map(({ id }) => id),
      ]);
      for (const { id } of recentSnapshots.rows) {
        if (retainedIds.size >= maxHistory) break;
        retainedIds.add(id);
      }
      return [...retainedIds];
    },

    async getHealthLatestSnapshots(connectorInstanceIds) {
      const params: unknown[] = [];
      let filter = '';
      if (connectorInstanceIds) {
        params.push([...connectorInstanceIds]);
        filter = `connector_instance_id = ANY($${params.length}::text[]) AND `;
      }
      const { rows } = await query<DependencySnapshotRecord>(
        pool,
        `
          SELECT ${SNAPSHOT_COLUMNS}
          FROM dependency_reconciliation_snapshots
          WHERE ${filter}id = (
            SELECT latest.id
            FROM dependency_reconciliation_snapshots AS latest
            WHERE latest.connector_instance_id =
              dependency_reconciliation_snapshots.connector_instance_id
            ORDER BY latest.started_at DESC
            LIMIT 1
          )
        `,
        params,
      );
      return rows;
    },

    async getHealthCompletedSnapshots(connectorInstanceIds) {
      const params: unknown[] = [];
      let filter = '';
      if (connectorInstanceIds) {
        params.push([...connectorInstanceIds]);
        filter = `connector_instance_id = ANY($${params.length}::text[]) AND `;
      }
      const { rows } = await query<DependencySnapshotRecord>(
        pool,
        `
          SELECT ${SNAPSHOT_COLUMNS}
          FROM dependency_reconciliation_snapshots
          WHERE ${filter}id = (
            SELECT completed.id
            FROM dependency_reconciliation_snapshots AS completed
            WHERE completed.connector_instance_id =
              dependency_reconciliation_snapshots.connector_instance_id
              AND completed.status = 'completed'
            ORDER BY completed.completed_at DESC
            LIMIT 1
          )
        `,
        params,
      );
      return rows;
    },

    async countEdgesBySnapshotIds(snapshotIds) {
      if (snapshotIds.length === 0) return [];
      const { rows } = await query<{ snapshotId: string; count: string | number }>(
        pool,
        `
          SELECT snapshot_id AS "snapshotId", COUNT(*) AS count
          FROM dependency_reconciliation_edges
          WHERE snapshot_id = ANY($1::text[])
          GROUP BY snapshot_id
        `,
        [[...snapshotIds]],
      );
      return rows.map((row) => ({ snapshotId: row.snapshotId, count: Number(row.count) }));
    },

    async getHealthTerminalStatuses(connectorInstanceIds) {
      const params: unknown[] = [];
      let filter = '';
      if (connectorInstanceIds) {
        params.push([...connectorInstanceIds]);
        filter = `connector_instance_id = ANY($${params.length}::text[]) AND `;
      }
      const { rows } = await query<{
        connectorInstanceId: string;
        status: DependencySnapshotRecord['status'];
        startedAt: string;
      }>(
        pool,
        `
          SELECT
            connector_instance_id AS "connectorInstanceId",
            status,
            started_at AS "startedAt"
          FROM dependency_reconciliation_snapshots
          WHERE ${filter}status IN ('completed', 'partial', 'failed')
          ORDER BY connector_instance_id, started_at DESC
        `,
        params,
      );
      return rows;
    },

    async countSnapshotEdges(snapshotId) {
      const { rows } = await query<{ count: string | number }>(
        pool,
        'SELECT COUNT(*) AS count FROM dependency_reconciliation_edges WHERE snapshot_id = $1',
        [snapshotId],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async getSnapshotStatus(snapshotId) {
      const { rows } = await query<{ status: DependencySnapshotRecord['status'] }>(
        pool,
        'SELECT status FROM dependency_reconciliation_snapshots WHERE id = $1 LIMIT 1',
        [snapshotId],
      );
      return rows[0]?.status ?? null;
    },

    async listGenerationEdgePage({ snapshotId, offset, limit }) {
      const { rows } = await query<{ blockerSourceId: string; blockedSourceId: string }>(
        pool,
        `
          SELECT
            blocker_source_id AS "blockerSourceId",
            blocked_source_id AS "blockedSourceId"
          FROM dependency_reconciliation_edges
          WHERE snapshot_id = $1
          ORDER BY blocked_source_id ASC, blocker_source_id ASC
          LIMIT $2 OFFSET $3
        `,
        [snapshotId, limit, offset],
      );
      return rows;
    },

    async getResumableReconciliations() {
      const { rows } = await query<{
        connectorId: string;
        generationId: string;
        status: 'running' | 'failed';
        processed: number;
        total: number;
        nextAttemptAt: string | null;
      }>(
        pool,
        `
          SELECT
            s.connector_instance_id AS "connectorId",
            s.id AS "generationId",
            s.status AS status,
            s.cursor AS processed,
            s.total AS total,
            s.next_attempt_at AS "nextAttemptAt"
          FROM dependency_reconciliation_snapshots s
          JOIN connector_configs c ON c.id = s.connector_instance_id
          WHERE s.status IN ('running', 'failed')
            AND s.phase <> 'collecting'
            AND c.enabled = true
            AND c.deleted_at IS NULL
        `,
      );
      return rows;
    },

    async listSnapshotItemsForSourceIds({ snapshotId, sourceIds }) {
      if (sourceIds.length === 0) return [];
      const { rows } = await query<{
        sourceId: string;
        identityEvidence: DependencySnapshotItemEvidence['identityEvidence'];
        identityEvidenceState: DependencySnapshotItemEvidence['identityEvidenceState'];
      }>(
        pool,
        `
          SELECT
            source_id AS "sourceId",
            identity_evidence AS "identityEvidence",
            identity_evidence_state AS "identityEvidenceState"
          FROM dependency_reconciliation_items
          WHERE snapshot_id = $1 AND source_id = ANY($2::text[])
        `,
        [snapshotId, [...sourceIds]],
      );
      return rows.map(itemEvidence);
    },

    async listVerifiedSnapshotItems(snapshotId) {
      const { rows } = await query<{
        sourceId: string;
        identityEvidence: DependencySnapshotItemEvidence['identityEvidence'];
        identityEvidenceState: DependencySnapshotItemEvidence['identityEvidenceState'];
      }>(
        pool,
        `
          SELECT
            source_id AS "sourceId",
            identity_evidence AS "identityEvidence",
            identity_evidence_state AS "identityEvidenceState"
          FROM dependency_reconciliation_items
          WHERE snapshot_id = $1 AND verified = true
        `,
        [snapshotId],
      );
      return rows.map(itemEvidence);
    },

    async listVerifiedItemsForSourceIds({ snapshotId, sourceIds }) {
      if (sourceIds.length === 0) return [];
      const { rows } = await query<{
        sourceId: string;
        identityEvidence: DependencySnapshotItemEvidence['identityEvidence'];
        identityEvidenceState: DependencySnapshotItemEvidence['identityEvidenceState'];
      }>(
        pool,
        `
          SELECT
            source_id AS "sourceId",
            identity_evidence AS "identityEvidence",
            identity_evidence_state AS "identityEvidenceState"
          FROM dependency_reconciliation_items
          WHERE snapshot_id = $1 AND source_id = ANY($2::text[]) AND verified = true
        `,
        [snapshotId, [...sourceIds]],
      );
      return rows.map(itemEvidence);
    },

    async listSnapshotItemsInWindow({ snapshotId, start, end }) {
      const { rows } = await query<{ position: number; sourceId: string }>(
        pool,
        `
          SELECT position, source_id AS "sourceId"
          FROM dependency_reconciliation_items
          WHERE snapshot_id = $1 AND position >= $2 AND position < $3
          ORDER BY position ASC
        `,
        [snapshotId, start, end],
      );
      return rows;
    },

    async listSnapshotEdges(snapshotId) {
      const { rows } = await query<{
        blockerSourceId: string;
        blockedSourceId: string;
        blockerIdentityEvidence: DependencySnapshotEdgeRecord['blockerIdentityEvidence'];
        blockerIdentityEvidenceState: DependencySnapshotEdgeRecord['blockerIdentityEvidenceState'];
      }>(
        pool,
        `
          SELECT
            blocker_source_id AS "blockerSourceId",
            blocked_source_id AS "blockedSourceId",
            blocker_identity_evidence AS "blockerIdentityEvidence",
            blocker_identity_evidence_state AS "blockerIdentityEvidenceState"
          FROM dependency_reconciliation_edges
          WHERE snapshot_id = $1
        `,
        [snapshotId],
      );
      return rows.map(edgeRecord);
    },

    async listStagedEdgesForSourceIds({ snapshotId, blockedSourceIds }) {
      if (blockedSourceIds.length === 0) return [];
      const { rows } = await query<{
        blockerSourceId: string;
        blockedSourceId: string;
        blockerIdentityEvidence: DependencySnapshotEdgeRecord['blockerIdentityEvidence'];
        blockerIdentityEvidenceState: DependencySnapshotEdgeRecord['blockerIdentityEvidenceState'];
      }>(
        pool,
        `
          SELECT
            blocker_source_id AS "blockerSourceId",
            blocked_source_id AS "blockedSourceId",
            blocker_identity_evidence AS "blockerIdentityEvidence",
            blocker_identity_evidence_state AS "blockerIdentityEvidenceState"
          FROM dependency_reconciliation_edges
          WHERE snapshot_id = $1 AND blocked_source_id = ANY($2::text[])
        `,
        [snapshotId, [...blockedSourceIds]],
      );
      return rows.map(edgeRecord);
    },

    async listSnapshotCandidateDependencyIds(snapshotId) {
      const { rows } = await query<{ dependencyId: string }>(
        pool,
        `
          SELECT dependency_id AS "dependencyId"
          FROM dependency_reconciliation_candidates
          WHERE snapshot_id = $1
        `,
        [snapshotId],
      );
      return rows.map(({ dependencyId }) => dependencyId);
    },

    async createGeneration(input: CreateGenerationInput) {
      return transaction(pool, async (client) => {
        const currentRevision = await readModeRevision(client, input.connectorInstanceId);
        const contextMatches = currentRevision === input.frozenModeRevision;
        await insertSnapshot(
          client,
          contextMatches ? input.matchInsert : input.mismatchInsert,
        );
        if (contextMatches) {
          await insertItems(client, input.matchInsert.id, input.items);
          if (input.deletionCandidateIds.length > 0) {
            const params: unknown[] = [];
            for (const dependencyId of input.deletionCandidateIds) {
              params.push(input.matchInsert.id, dependencyId);
            }
            await query(
              client,
              `
                INSERT INTO dependency_reconciliation_candidates (snapshot_id, dependency_id)
                VALUES ${valuesPlaceholders(input.deletionCandidateIds.length, 2)}
              `,
              params,
            );
          }
        }
        return contextMatches;
      });
    },

    async abandonInterruptedCollection({ fence, failedAt }) {
      return transaction(pool, async (client) => {
        if (!(await validate(client, fence, { phase: 'collecting', now: failedAt }))) {
          return false;
        }
        await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'partial',
                phase = 'completed',
                identity_evidence_eligible = false,
                identity_evidence_failure_reason = 'dependency_collection_incomplete',
                completed_at = $2,
                failed_at = $2,
                updated_at = $2,
                failure_reason = 'dependency collection was interrupted before completion'
            WHERE id = $1
              AND phase = 'collecting'
              AND identity_mode = $3
              AND identity_mode_revision = $4
          `,
          [fence.id, failedAt, fence.identityMode, fence.identityModeRevision],
        );
        return true;
      });
    },

    async stageCollectionPage(input: StageCollectionPageInput) {
      const { fence } = input;
      return transaction(pool, async (client) => {
        // Fence failure commits the identity-context-changed partial write
        // that `validate` performed (legacy `return false` semantics).
        if (!(await validate(client, fence, { phase: 'collecting', now: input.updatedAt }))) {
          return false;
        }
        const { rows } = await query<{ total: number }>(
          client,
          'SELECT total FROM dependency_reconciliation_snapshots WHERE id = $1 LIMIT 1',
          [fence.id],
        );
        const persisted = rows[0];
        if (!persisted || persisted.total !== input.expectedTotal) {
          return false;
        }
        await insertItems(client, fence.id, input.newItems);
        await insertEdges(client, fence.id, input.edges);
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET read_mode = $2,
                identity_evidence_source = $3,
                identity_evidence_eligible = false,
                identity_evidence_failure_reason = NULL,
                total = $4,
                collection_page_count = collection_page_count + 1,
                overflow_fetch_count = overflow_fetch_count + $5,
                updated_at = $6
            WHERE id = $1
              AND phase = 'collecting'
              AND total = $7
              AND identity_mode = $8
              AND identity_mode_revision = $9
          `,
          [
            fence.id,
            input.readMode,
            input.identityEvidenceSource,
            input.expectedTotal + input.newSourceIdCount,
            input.overflowFetchCount,
            input.updatedAt,
            input.expectedTotal,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        if (rowCount !== 1) {
          throw new Error('Dependency collection page CAS failed');
        }
        return true;
      });
    },

    async completeCollection(input: CompleteCollectionInput) {
      const { fence } = input;
      return transaction(pool, async (client) => {
        if (!(await validate(client, fence, { phase: 'collecting', now: input.completedAt }))) {
          return false;
        }
        const blockedEvidenceCounts = await query<{ incomplete: string | number | null }>(
          client,
          `
            SELECT SUM(CASE WHEN identity_evidence_state != 'verified' THEN 1 ELSE 0 END) AS incomplete
            FROM dependency_reconciliation_items
            WHERE snapshot_id = $1
          `,
          [fence.id],
        );
        const blockerEvidenceCounts = await query<{ incomplete: string | number | null }>(
          client,
          `
            SELECT SUM(CASE WHEN blocker_identity_evidence_state != 'verified' THEN 1 ELSE 0 END) AS incomplete
            FROM dependency_reconciliation_edges
            WHERE snapshot_id = $1
          `,
          [fence.id],
        );
        const incompleteEvidence = Number(blockedEvidenceCounts.rows[0]?.incomplete ?? 0)
          + Number(blockerEvidenceCounts.rows[0]?.incomplete ?? 0);
        const evidence = input.deriveEvidence(incompleteEvidence);
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET phase = 'ready',
                read_mode = $2,
                identity_evidence_source = $3,
                identity_evidence_eligible = $4,
                identity_evidence_failure_reason = $5,
                collection_completed_at = $6,
                updated_at = $6
            WHERE id = $1
              AND phase = 'collecting'
              AND identity_mode = $7
              AND identity_mode_revision = $8
          `,
          [
            fence.id,
            input.readMode,
            input.identityEvidenceSource,
            evidence.identityEvidenceEligible,
            evidence.identityEvidenceFailureReason,
            input.completedAt,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        return rowCount === 1;
      });
    },

    async failCollection(input: FailCollectionInput) {
      const { fence } = input;
      return transaction(pool, async (client) => {
        if (!(await validate(client, fence, { phase: 'collecting', now: input.failedAt }))) {
          return false;
        }
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'partial',
                identity_evidence_eligible = false,
                identity_evidence_failure_reason = 'dependency_collection_incomplete',
                failed_at = $2,
                updated_at = $2,
                failure_reason = $3
            WHERE id = $1
              AND status = 'running'
              AND phase = 'collecting'
              AND identity_mode = $4
              AND identity_mode_revision = $5
          `,
          [fence.id, input.failedAt, input.failureReason, fence.identityMode, fence.identityModeRevision],
        );
        return rowCount > 0;
      });
    },

    async recordResumeOutcome(input: RecordResumeOutcomeInput) {
      await transaction(pool, async (client) => {
        const { rows } = await query<DependencySnapshotRecord>(
          client,
          `SELECT ${SNAPSHOT_COLUMNS} FROM dependency_reconciliation_snapshots WHERE id = $1 LIMIT 1`,
          [input.generationId],
        );
        const snapshot = rows[0];
        if (!snapshot || !(await validate(client, snapshot, { now: input.attemptedAt }))) {
          return;
        }
        await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET last_resume_attempt_at = $2,
                last_resume_outcome = $3,
                last_resume_reason = $4
            WHERE id = $1
              AND identity_mode = $5
              AND identity_mode_revision = $6
          `,
          [
            input.generationId,
            input.attemptedAt,
            input.outcome,
            input.reason.slice(0, 120),
            snapshot.identityMode,
            snapshot.identityModeRevision,
          ],
        );
      });
    },

    async applyTargetedReconciliation(
      input: ApplyTargetedReconciliationInput,
    ): Promise<ApplyTargetedReconciliationResult> {
      return transaction<ApplyTargetedReconciliationResult>(pool, async (client) => {
        const currentRevision = await readModeRevision(client, input.connectorInstanceId);
        if (currentRevision !== input.expectedModeRevision) {
          throw new RollbackSignal<ApplyTargetedReconciliationResult>({
            status: 'identity-context-changed',
          });
        }
        for (const id of input.syncedUpdateIds) {
          await query(
            client,
            `
              UPDATE task_dependencies
              SET connector_instance_id = $2,
                  sync_status = 'synced',
                  sync_error = NULL,
                  last_synced_at = $3
              WHERE id = $1 AND sync_action IS NULL
            `,
            [id, input.connectorInstanceId, input.syncedAt],
          );
        }
        let imported = 0;
        for (const insert of input.inserts) {
          const { rowCount } = await query(
            client,
            `
              INSERT INTO task_dependencies (
                id, task_id, depends_on_task_id, type, connector_instance_id,
                sync_status, sync_action, sync_error, last_synced_at, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              ON CONFLICT DO NOTHING
            `,
            [
              insert.id,
              insert.taskId,
              insert.dependsOnTaskId,
              insert.type,
              insert.connectorInstanceId,
              insert.syncStatus,
              insert.syncAction,
              insert.syncError,
              insert.lastSyncedAt,
              insert.createdAt,
            ],
          );
          imported += rowCount;
        }
        let removed = 0;
        for (const id of input.deletionIds) {
          const { rowCount } = await query(
            client,
            `
              DELETE FROM task_dependencies
              WHERE id = $1
                AND connector_instance_id = $2
                AND sync_status = 'synced'
                AND sync_action IS NULL
            `,
            [id, input.connectorInstanceId],
          );
          removed += rowCount;
        }
        return { status: 'applied', imported, removed };
      });
    },

    async applyReconciliationBatch(input: ApplyReconciliationBatchInput) {
      const { fence } = input;
      return transaction(pool, async (client) => {
        if (!(await validate(client, fence, { cursor: input.batchStart, now: input.lastSyncedAt }))) {
          return false;
        }
        await insertEdges(client, fence.id, input.stagedEdges);
        for (const update of input.verifiedUpdates) {
          if (update.identityEvidenceState !== undefined) {
            await query(
              client,
              `
                UPDATE dependency_reconciliation_items
                SET verified = true,
                    identity_evidence = $3,
                    identity_evidence_state = $4
                WHERE snapshot_id = $1 AND source_id = $2
              `,
              [
                fence.id,
                update.sourceId,
                jsonbParam(update.identityEvidence),
                update.identityEvidenceState,
              ],
            );
          } else {
            await query(
              client,
              `
                UPDATE dependency_reconciliation_items
                SET verified = true
                WHERE snapshot_id = $1 AND source_id = $2
              `,
              [fence.id, update.sourceId],
            );
          }
        }
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'running',
                phase = 'reconciling',
                cursor = $2,
                failure_count = 0,
                failed_at = NULL,
                next_attempt_at = NULL,
                failure_reason = NULL,
                imported_count = imported_count + 0,
                updated_at = $3
            WHERE id = $1
              AND cursor = $4
              AND status IN ('running', 'failed')
              AND identity_mode = $5
              AND identity_mode_revision = $6
          `,
          [
            fence.id,
            input.batchEnd,
            input.lastSyncedAt,
            input.batchStart,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        if (rowCount !== 1) {
          throw new Error('Dependency snapshot cursor CAS failed');
        }
        return true;
      });
    },

    async markSnapshotFailed(input: MarkSnapshotFailedInput) {
      const { fence } = input;
      return transaction(pool, async (client) => {
        if (!(await validate(client, fence, { cursor: input.cursor, now: input.failedAt }))) {
          return false;
        }
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'failed',
                failure_count = $2,
                failed_at = $3,
                updated_at = $3,
                next_attempt_at = $4,
                failure_reason = $5
            WHERE id = $1
              AND cursor = $6
              AND identity_mode = $7
              AND identity_mode_revision = $8
          `,
          [
            fence.id,
            input.failureCount,
            input.failedAt,
            input.nextAttemptAt,
            input.failureReason,
            input.cursor,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        return rowCount === 1;
      });
    },

    async abandonSnapshotForIdentityContextChange(fence, now) {
      await transaction(pool, async (client) => {
        await validate(client, fence, { now });
      });
    },

    async completeSnapshotPartial(
      input: CompleteSnapshotPartialInput,
    ): Promise<CompleteSnapshotPartialResult> {
      const { fence } = input;
      return transaction<CompleteSnapshotPartialResult>(pool, async (client) => {
        // Fence failure commits the identity-context-changed partial write.
        if (!(await validate(client, fence, { cursor: input.cursor, now: input.completedAt }))) {
          return { status: 'fenced' };
        }
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'partial',
                phase = 'completed',
                updated_at = $2,
                failed_at = $2,
                next_attempt_at = NULL,
                failure_reason = $3,
                identity_evidence_eligible = false,
                identity_evidence_failure_reason = $4
            WHERE id = $1
              AND status IN ('running', 'failed')
              AND cursor >= $5
              AND identity_mode = $6
              AND identity_mode_revision = $7
          `,
          [
            fence.id,
            input.completedAt,
            input.failureReason,
            input.identityEvidenceFailureReason,
            input.total,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        if (rowCount !== 1) {
          throw new Error('Dependency partial completion CAS failed');
        }
        const prunedSnapshots = await pruneTerminalSnapshots(
          client,
          input.connectorInstanceId,
          input.retainedSnapshotIds,
        );
        return { status: 'applied', prunedSnapshots };
      });
    },

    async finalizeSnapshotGeneration(
      input: FinalizeSnapshotGenerationInput,
    ): Promise<FinalizeSnapshotGenerationResult> {
      const { fence } = input;
      return transaction<FinalizeSnapshotGenerationResult>(pool, async (client) => {
        // Fence failure commits the identity-context-changed partial write.
        if (!(await validate(client, fence, { cursor: input.cursor, now: input.completedAt }))) {
          return { status: 'fenced' };
        }
        let imported = 0;
        for (
          let index = 0;
          index < input.insertableEdges.length;
          index += input.insertChunkSize
        ) {
          imported += await insertTaskDependencies(
            client,
            input.insertableEdges.slice(index, index + input.insertChunkSize),
          );
        }
        let removed = 0;
        for (
          let index = 0;
          index < input.removableDependencyIds.length;
          index += input.deleteChunkSize
        ) {
          const chunk = input.removableDependencyIds.slice(
            index,
            index + input.deleteChunkSize,
          );
          const { rowCount } = await query(
            client,
            `
              DELETE FROM task_dependencies
              WHERE id = ANY($1::text[])
                AND connector_instance_id = $2
                AND sync_status = 'synced'
                AND sync_action IS NULL
            `,
            [chunk, input.connectorInstanceId],
          );
          removed += rowCount;
        }
        const { rowCount } = await query(
          client,
          `
            UPDATE dependency_reconciliation_snapshots
            SET status = 'completed',
                phase = 'completed',
                identity_evidence_eligible = $2,
                identity_evidence_failure_reason = $3,
                imported_count = imported_count + $4,
                removed_count = removed_count + $5,
                completed_at = $6,
                updated_at = $6,
                failed_at = NULL,
                next_attempt_at = NULL,
                failure_reason = NULL
            WHERE id = $1
              AND status IN ('running', 'failed')
              AND cursor >= $7
              AND identity_mode = $8
              AND identity_mode_revision = $9
          `,
          [
            fence.id,
            input.identityEvidenceEligible,
            input.identityEvidenceFailureReason,
            imported,
            removed,
            input.completedAt,
            input.total,
            fence.identityMode,
            fence.identityModeRevision,
          ],
        );
        if (rowCount !== 1) {
          throw new Error('Dependency finalization CAS failed');
        }
        const prunedSnapshots = await pruneTerminalSnapshots(
          client,
          input.connectorInstanceId,
          input.retainedSnapshotIds,
        );
        return { status: 'applied', imported, removed, prunedSnapshots };
      });
    },
  };
}
