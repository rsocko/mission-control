import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  connectorMaintenanceLocks,
  connectorOperationLeases,
  externalEntities,
  externalEntityBindings,
  externalEntityLocators,
  githubBulkTransferEvents,
  githubBulkTransferItems,
  githubBulkTransferRuns,
  githubBulkTransferSuccessions,
  githubRepositoryRepointEvents,
  githubRepositoryRepoints,
  sourceLists,
  syncJobs,
  taskIngestSuppressions,
  taskLinkedSources,
  tasks,
} from '@/db/schema';
import {
  getCurrentExternalEntityLocatorInTransaction,
  getGitHubIdentityModeSnapshotInTransaction,
  listExternalEntityLocatorHistoryInTransaction,
  observeOperatorExternalEntityLocatorInTransaction,
  preflightExternalEntityLocatorInTransaction,
  readGitHubTaskTransferBinding,
  recordExternalIdentityCollisionInTransaction,
  recordGitHubTaskTransferReconciliation,
  upsertExternalEntityInTransaction,
  type ExternalIdentityTransaction,
} from '@/lib/external-identities';
import type {
  ExternalEntityIdentity,
  ExternalEntityLocatorEvidence,
} from '@/lib/external-identities/types';
import type {
  GitHubBulkTransferItemRecord,
  GitHubBulkTransferPersistence,
  GitHubBulkTransferRunRecord,
  GitHubBulkTransferSuccessionRecord,
  GitHubRecoveryIssuePlanRow,
  GitHubRecoveryPersistence,
  GitHubRepointApplyResult,
  GitHubRepointOperationRecord,
  GitHubRepointPersistence,
  GitHubRepointRollbackResult,
  GitHubTransferPersistence,
} from './github-recovery';
import {
  asRecord,
  asStringArray,
  canonicalDigest,
  compareCanonical,
  readApiOrigin,
  repositoryPath,
  samePath,
  stringValue,
} from './github-recovery-values';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

const ACTIVE_BINDING_STATES = ['shadow', 'active'] as const;
const ACTIVE_BINDING_STATE_SET = new Set<string>(ACTIVE_BINDING_STATES);
const MAX_DELETION_CANDIDATE_SAMPLES = 50;

/**
 * SQLite adapter for the Layer 3B GitHub recovery ports.
 *
 * Every transaction body moved here verbatim from
 * `@/lib/connectors/github-issues/repoint-service`,
 * `@/lib/connectors/github-issues/bulk-transfer-service`, and
 * `@/lib/external-identities/task-transfer-reconciliation`, so the existing
 * SQLite characterization suites observe byte-identical behaviour: the same
 * fences, the same error strings, the same event payloads, and the same
 * bounded writes. Remote calls never reach this file.
 */
export function createSqliteGitHubRecoveryRepositories(
  sqlite: SqliteDatabase,
  db: SqliteDrizzle,
): GitHubRecoveryPersistence {
  function runTransaction<T>(work: (tx: ExternalIdentityTransaction) => T): T {
    return db.transaction(work, { behavior: 'immediate' });
  }

  function scalar(query: string, ...parameters: unknown[]): number {
    const row = sqlite.prepare(query).get(...parameters) as { value?: number } | undefined;
    return Number(row?.value ?? 0);
  }

  function readConnector(connectorInstanceId: string) {
    return db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorInstanceId)).limit(1).get() ?? null;
  }

  function selectIssuePlanRows(
    connectorInstanceId: string,
    repository: string,
  ): GitHubRecoveryIssuePlanRow[] {
    const prefix = `${repository}:`;
    return sqlite.prepare(`
      SELECT
        task.id AS taskId,
        task.source_id AS sourceId,
        binding.external_entity_id AS issueEntityId,
        entity.stable_id AS issueStableId,
        locator.issue_number AS issueNumber,
        locator.repository_entity_id AS repositoryEntityId
      FROM tasks AS task
      LEFT JOIN external_entity_bindings AS binding
        ON binding.connector_instance_id = task.connector_instance_id
        AND binding.binding_type = 'task'
        AND binding.local_id = task.id
        AND binding.state IN ('shadow', 'active')
      LEFT JOIN external_entities AS entity
        ON entity.id = binding.external_entity_id
        AND entity.provider = 'github'
        AND entity.entity_type = 'issue'
      LEFT JOIN external_entity_locators AS locator
        ON locator.external_entity_id = entity.id
        AND locator.valid_to IS NULL
      WHERE task.connector_instance_id = ?
        AND substr(task.source_id, 1, length(?)) = ?
      ORDER BY task.id COLLATE BINARY
    `).all(connectorInstanceId, prefix, prefix) as GitHubRecoveryIssuePlanRow[];
  }

  function selectIssuePlanRowsInTransaction(
    tx: ExternalIdentityTransaction,
    connectorInstanceId: string,
    repository: string,
  ): GitHubRecoveryIssuePlanRow[] {
    const taskRows = tx.select({
      taskId: tasks.id,
      sourceId: tasks.sourceId,
    }).from(tasks).where(eq(tasks.connectorInstanceId, connectorInstanceId)).all()
      .filter((row) => row.sourceId.startsWith(`${repository}:`));
    if (taskRows.length === 0) return [];
    const bindings = tx.select().from(externalEntityBindings).where(and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      inArray(externalEntityBindings.localId, taskRows.map((row) => row.taskId)),
    )).all();
    return taskRows.map((task) => {
      const binding = bindings.find((candidate) => (
        candidate.bindingType === 'task'
        && candidate.localId === task.taskId
        && ACTIVE_BINDING_STATE_SET.has(candidate.state)
      ));
      if (!binding) {
        return {
          ...task,
          issueEntityId: null,
          issueStableId: null,
          issueNumber: null,
          repositoryEntityId: null,
        };
      }
      const entity = tx.select().from(externalEntities)
        .where(eq(externalEntities.id, binding.externalEntityId)).limit(1).get();
      const locator = getCurrentExternalEntityLocatorInTransaction(tx, binding.externalEntityId);
      return {
        ...task,
        issueEntityId: binding.externalEntityId,
        issueStableId: entity?.stableId ?? null,
        issueNumber: locator?.issueNumber ?? null,
        repositoryEntityId: locator?.repositoryEntityId ?? null,
      };
    });
  }

  function assertNoConnectorActivityInTransaction(
    tx: ExternalIdentityTransaction,
    connectorInstanceId: string,
  ): void {
    const activeJob = tx.select({ id: syncJobs.id }).from(syncJobs).where(and(
      eq(syncJobs.connectorId, connectorInstanceId),
      inArray(syncJobs.status, ['queued', 'running']),
    )).limit(1).get();
    const activeLease = tx.select({ connectorId: connectorOperationLeases.connectorId })
      .from(connectorOperationLeases)
      .where(eq(connectorOperationLeases.connectorId, connectorInstanceId))
      .limit(1).get();
    if (activeJob || activeLease) {
      throw new Error('Connector activity started after repoint preflight');
    }
  }

  function appendRepointEvent(
    tx: ExternalIdentityTransaction,
    operationId: string,
    phase: GitHubRepointOperationRecord['phase'],
    actor: string,
    payload: Record<string, unknown>,
    now: string,
  ): void {
    tx.insert(githubRepositoryRepointEvents).values({
      operationId,
      phase,
      actor,
      payload,
      createdAt: now,
    }).run();
  }

  function mapOperation(
    row: typeof githubRepositoryRepoints.$inferSelect,
    connectorLocked: boolean,
  ): GitHubRepointOperationRecord {
    return {
      ...row,
      backupProof: asRecord(row.backupProof),
      preflight: asRecord(row.preflight),
      rollbackSnapshot: asRecord(row.rollbackSnapshot),
      verification: row.verification ? asRecord(row.verification) : null,
      connectorLocked,
    };
  }

  function operationWithLock(
    row: typeof githubRepositoryRepoints.$inferSelect,
  ): GitHubRepointOperationRecord {
    const lock = sqlite.prepare(`
      SELECT 1 AS value FROM connector_maintenance_locks
      WHERE connector_instance_id = ? AND operation_id = ?
    `).get(row.connectorInstanceId, row.id);
    return mapOperation(row, Boolean(lock));
  }

  function requireOperationInTransaction(
    tx: ExternalIdentityTransaction,
    operationId: string,
  ): GitHubRepointOperationRecord {
    const row = tx.select().from(githubRepositoryRepoints)
      .where(eq(githubRepositoryRepoints.id, operationId)).limit(1).get();
    if (!row) throw new Error('GitHub repository repoint operation was not found');
    return mapOperation(row, true);
  }

  function requireOwnedMaintenanceLock(
    tx: ExternalIdentityTransaction,
    operation: GitHubRepointOperationRecord,
  ): void {
    const lock = tx.select().from(connectorMaintenanceLocks).where(and(
      eq(connectorMaintenanceLocks.connectorInstanceId, operation.connectorInstanceId),
      eq(connectorMaintenanceLocks.operationId, operation.id),
    )).limit(1).get();
    if (!lock) throw new Error('Repoint operation lost its connector maintenance lock');
  }

  function recordLocatorCollision(
    tx: ExternalIdentityTransaction,
    operation: GitHubRepointOperationRecord,
    bindingType: 'task' | 'source_list',
    localId: string,
    externalEntityId: string,
    observation: { collisionCategory?: string; conflictingEntityId?: string },
    now: string,
  ): void {
    recordExternalIdentityCollisionInTransaction(tx, {
      connectorInstanceId: operation.connectorInstanceId,
      category: (observation.collisionCategory ?? 'stable_legacy_disagree') as never,
      bindingType,
      localIds: [localId],
      externalEntityIds: [
        externalEntityId,
        ...(observation.conflictingEntityId ? [observation.conflictingEntityId] : []),
      ].filter(Boolean),
      legacyIdentity: repositoryPath(operation.fromOwner, operation.fromRepository),
      observedAt: now,
    });
  }

  function markOperationFailed(
    tx: ExternalIdentityTransaction,
    operation: GitHubRepointOperationRecord,
    error: string,
    now: string,
  ): void {
    tx.update(githubRepositoryRepoints).set({
      phase: 'failed',
      lastError: error,
      updatedAt: now,
    }).where(eq(githubRepositoryRepoints.id, operation.id)).run();
    appendRepointEvent(tx, operation.id, 'failed', operation.actor, { error }, now);
  }

  function replaceConnectorConfiguration(
    tx: ExternalIdentityTransaction,
    connectorInstanceId: string,
    from: string,
    to: string,
    now: string,
  ): void {
    const connector = tx.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorInstanceId)).limit(1).get();
    if (!connector) throw new Error('Connector disappeared during repoint');
    const settings = asRecord(connector.settings);
    const repos = asStringArray(settings.repos).map((repo) => samePath(repo, from) ? to : repo);
    const syncedLists = asStringArray(connector.syncedLists)
      .map((repo) => samePath(repo, from) ? to : repo);
    tx.update(connectorConfigs).set({
      settings: { ...settings, repos },
      syncedLists,
      updatedAt: now,
    }).where(eq(connectorConfigs.id, connectorInstanceId)).run();
    tx.update(sourceLists).set({
      sourceId: to,
      name: to,
      lastKnownRemoteName: to,
    }).where(and(
      eq(sourceLists.connectorInstanceId, connectorInstanceId),
      eq(sourceLists.sourceId, from),
    )).run();
  }

  function replaceActiveReferences(
    tx: ExternalIdentityTransaction,
    connectorInstanceId: string,
    from: string,
    to: string,
    now: string,
  ): void {
    const fromPrefix = `${from}:`;
    const toPrefix = `${to}:`;
    const linked = tx.select().from(taskLinkedSources)
      .where(eq(taskLinkedSources.connectorInstanceId, connectorInstanceId)).all();
    for (const row of linked) {
      if (!row.sourceId.startsWith(fromPrefix)) continue;
      tx.update(taskLinkedSources).set({
        sourceId: `${toPrefix}${row.sourceId.slice(fromPrefix.length)}`,
      }).where(eq(taskLinkedSources.id, row.id)).run();
    }
    const suppressions = tx.select().from(taskIngestSuppressions)
      .where(eq(taskIngestSuppressions.connectorInstanceId, connectorInstanceId)).all();
    for (const row of suppressions) {
      if (!row.sourceId.startsWith(fromPrefix)) continue;
      tx.delete(taskIngestSuppressions).where(and(
        eq(taskIngestSuppressions.connectorInstanceId, connectorInstanceId),
        eq(taskIngestSuppressions.sourceId, row.sourceId),
      )).run();
      tx.insert(taskIngestSuppressions).values({
        ...row,
        sourceId: `${toPrefix}${row.sourceId.slice(fromPrefix.length)}`,
        createdAt: row.createdAt || now,
      }).run();
    }
  }

  function restoreSourceListSnapshot(
    tx: ExternalIdentityTransaction,
    operation: GitHubRepointOperationRecord,
    from: string,
    to: string,
  ): { repaired: boolean; snapshotMode: 'captured' | 'legacy_derived' } {
    const snapshot = asRecord(asRecord(operation.rollbackSnapshot).sourceList);
    const snapshotId = stringValue(snapshot.id);
    const snapshotMode = snapshotId ? 'captured' : 'legacy_derived';
    const rows = tx.select().from(sourceLists)
      .where(eq(sourceLists.connectorInstanceId, operation.connectorInstanceId))
      .all();
    const row = snapshotId
      ? rows.find((candidate) => candidate.id === snapshotId)
      : rows.find((candidate) => samePath(candidate.sourceId, from) || samePath(candidate.sourceId, to));
    if (
      !row
      || (!samePath(row.sourceId, from) && !samePath(row.sourceId, to))
    ) {
      throw new Error('Rollback source list identity verification failed');
    }
    if (!snapshotId) {
      const candidates = rows.filter(
        (candidate) => samePath(candidate.sourceId, from) || samePath(candidate.sourceId, to),
      );
      if (candidates.length !== 1) {
        throw new Error('Legacy rollback source list repair is ambiguous');
      }
    }
    const desiredSourceId = snapshotId ? stringValue(snapshot.sourceId) : from;
    const desiredName = snapshotId ? stringValue(snapshot.name) : from;
    const desiredLastKnownRemoteName = snapshotId
      ? (snapshot.lastKnownRemoteName === null ? null : stringValue(snapshot.lastKnownRemoteName))
      : from;
    if (
      !samePath(desiredSourceId, from)
      || !desiredName
      || (snapshotId && snapshot.lastKnownRemoteName !== null && !desiredLastKnownRemoteName)
    ) {
      throw new Error('Rollback source list snapshot is invalid');
    }
    if (
      row.sourceId === desiredSourceId
      && row.name === desiredName
      && row.lastKnownRemoteName === desiredLastKnownRemoteName
    ) {
      return { repaired: false, snapshotMode };
    }
    tx.update(sourceLists).set({
      sourceId: desiredSourceId,
      name: desiredName,
      lastKnownRemoteName: desiredLastKnownRemoteName,
    }).where(eq(sourceLists.id, row.id)).run();
    return { repaired: true, snapshotMode };
  }

  function restoreHistoricalLocator(
    tx: ExternalIdentityTransaction,
    entityId: string,
    identity: ExternalEntityIdentity,
    repository: string,
    repositoryEntityId: string | null,
    observedAt: string,
    issueNumber?: number,
  ): void {
    const [owner, name] = repository.split('/');
    const history = listExternalEntityLocatorHistoryInTransaction(tx, entityId);
    const previous = [...history].reverse().find((locator) => (
      samePath(`${locator.owner}/${locator.repository}`, repository)
      && locator.issueNumber === (issueNumber ?? null)
    ));
    const locator: ExternalEntityLocatorEvidence = {
      owner,
      repository: name,
      ...(issueNumber ? { issueNumber } : {}),
      ...(previous?.apiUrl ? { apiUrl: previous.apiUrl } : {}),
      ...(previous?.webUrl ? { webUrl: previous.webUrl } : {}),
    };
    const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
      entityId,
      identity,
      locator,
      repositoryEntityId,
      observedAt,
    });
    if (observed.state === 'collision') {
      throw new Error('Rollback locator conflicts with another stable entity');
    }
  }

  /* ---------------------------------------------------------------- *
   * Bulk-transfer helpers
   * ---------------------------------------------------------------- */

  function tableHasColumn(table: string, column: string): boolean {
    return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((entry) => entry.name === column);
  }

  function taskMetadataDigest(taskId: string): string {
    const task = sqlite.prepare(`
      SELECT id, title, description, status, priority, due_date, effort,
             CASE
               WHEN json_valid(metadata)
                 THEN json_remove(metadata, '$.issueNumber', '$.nodeId', '$.url')
               ELSE metadata
             END AS metadata,
             local_disposition, completed_at, created_at
      FROM tasks WHERE id = ?
    `).get(taskId);
    if (!task) throw new Error(`Task disappeared during bulk transfer: ${taskId}`);
    const relations: Record<string, unknown[]> = {};
    for (const [table, column] of [
      ['task_projects', 'task_id'],
      ['project_phase_items', 'task_id'],
      ['task_tags', 'task_id'],
      ['task_schedules', 'task_id'],
      ['task_field_states', 'task_id'],
      ['task_linked_sources', 'task_id'],
      ['task_history_events', 'task_id'],
      ['my_day_items', 'task_id'],
      ['focus_items', 'task_id'],
      ['task_attachments', 'task_id'],
    ] as const) {
      if (!tableHasColumn(table, column)) continue;
      relations[table] = sqlite.prepare(
        `SELECT * FROM ${table} WHERE ${column} = ?`,
      ).all(taskId).sort(compareCanonical);
    }

    if (tableHasColumn('task_dependencies', 'task_id')) {
      relations.task_dependencies = sqlite.prepare(`
        SELECT * FROM task_dependencies
        WHERE task_id = ? OR depends_on_task_id = ?
      `).all(taskId, taskId).sort(compareCanonical);
    }
    return canonicalDigest({ task, relations });
  }

  function connectorMetadataDigest(connectorInstanceId: string): string {
    const connector = sqlite.prepare(`
      SELECT id, type, name, sync_mode, capabilities, settings, synced_lists, created_at
      FROM connector_configs WHERE id = ?
    `).get(connectorInstanceId);
    const lists = sqlite.prepare(`
      SELECT * FROM source_lists WHERE connector_instance_id = ?
    `).all(connectorInstanceId).sort(compareCanonical);
    const suppressions = sqlite.prepare(`
      SELECT * FROM task_ingest_suppressions WHERE connector_instance_id = ?
    `).all(connectorInstanceId).sort(compareCanonical);
    return canonicalDigest({ connector, sourceLists: lists, suppressions });
  }

  function countTransferred(runId: string): number {
    return scalar(
      `SELECT COUNT(*) AS value FROM github_bulk_transfer_items
       WHERE run_id = ? AND state = 'transferred'`,
      runId,
    );
  }

  function mapRun(
    row: typeof githubBulkTransferRuns.$inferSelect,
  ): GitHubBulkTransferRunRecord {
    return { ...row, plan: asRecord(row.plan) };
  }

  function mapSuccession(
    row: typeof githubBulkTransferSuccessions.$inferSelect,
  ): GitHubBulkTransferSuccessionRecord {
    return { ...row, proof: asRecord(row.proof) };
  }

  const transfer: GitHubTransferPersistence = {
    async getConnector(connectorInstanceId) {
      const connector = readConnector(connectorInstanceId);
      if (!connector || connector.deletedAt) return null;
      return {
        id: connector.id,
        type: connector.type,
        enabled: connector.enabled,
        settings: asRecord(connector.settings),
        syncedLists: asStringArray(connector.syncedLists),
        apiOrigin: readApiOrigin(connector.settings),
      };
    },

    async getConnectorCredentials(connectorInstanceId) {
      const connector = readConnector(connectorInstanceId);
      if (!connector || connector.deletedAt) return null;
      const credentials = asRecord(connector.credentials);
      const settings = asRecord(connector.settings);
      const token = stringValue(credentials.token)
        || stringValue(credentials.pat)
        || stringValue(settings.token);
      if (!token) return null;
      return { token, apiOrigin: readApiOrigin(settings) };
    },

    async disableConnector(connectorInstanceId, now) {
      db.update(connectorConfigs).set({ enabled: false, updatedAt: now })
        .where(eq(connectorConfigs.id, connectorInstanceId)).run();
    },

    async getIdentityModeSnapshot(connectorInstanceId) {
      const snapshot = getGitHubIdentityModeSnapshotInTransaction(db, connectorInstanceId);
      return {
        connectorInstanceId,
        modeRevision: snapshot.modeRevision,
      };
    },

    async getRepositoryBinding(connectorInstanceId, repository) {
      return repointRepositoryBinding(connectorInstanceId, repository);
    },

    async getRepositoryStableId(entityId) {
      const row = sqlite.prepare(`
        SELECT stable_id AS stableId
        FROM external_entities
        WHERE id = ? AND provider = 'github' AND entity_type = 'repository'
      `).get(entityId) as { stableId: string } | undefined;
      return row?.stableId ?? null;
    },

    async listIssuePlanRows(connectorInstanceId, repository) {
      return selectIssuePlanRows(connectorInstanceId, repository);
    },

    async readTaskTransferBinding(connectorInstanceId, taskId) {
      return readGitHubTaskTransferBinding(db, connectorInstanceId, taskId);
    },

    async applyNativeTransferRouting(input) {
      let collision = false;
      runTransaction((tx) => {
        const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
          entityId: input.issueEntityId,
          identity: input.identity,
          locator: input.locator,
          repositoryEntityId: input.targetRepositoryEntityId,
          observedAt: input.observedAt,
        });
        if (observed.state === 'collision') {
          recordExternalIdentityCollisionInTransaction(tx, {
            connectorInstanceId: input.connectorInstanceId,
            category: observed.collisionCategory ?? 'stable_legacy_disagree',
            bindingType: 'task',
            localIds: [input.taskId],
            externalEntityIds: [
              input.issueEntityId,
              ...(observed.conflictingEntityId ? [observed.conflictingEntityId] : []),
            ],
            legacyIdentity: input.legacySourceId,
            observedAt: input.observedAt,
          });
          tx.update(connectorConfigs).set({ enabled: false, updatedAt: input.now })
            .where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
          collision = true;
          return;
        }
        const currentTask = tx.select({ metadata: tasks.metadata }).from(tasks)
          .where(eq(tasks.id, input.taskId)).limit(1).get();
        if (!currentTask) {
          throw new Error('Native GitHub transfer task disappeared before routing update');
        }
        tx.update(tasks).set({
          sourceId: input.newSourceId,
          sourceListId: input.targetRepository,
          sourceListName: input.targetRepository,
          metadata: input.refreshMetadata(currentTask.metadata) as never,
          updatedAt: input.now,
          syncStatus: 'synced',
        }).where(eq(tasks.id, input.taskId)).run();
      });
      return collision ? { outcome: 'collision' } : { outcome: 'applied' };
    },

    async recordHistoricalTransferReconciliation(request) {
      // Surgical adapter compatibility `await`: `recordGitHubTaskTransferReconciliation`
      // now takes an injected SQLite handle (see task-transfer-reconciliation.ts) but
      // remains synchronous; awaiting its plain return value is harmless and keeps this
      // call site future-proof if it ever needs to become genuinely async.
      return await recordGitHubTaskTransferReconciliation(db, {
        connectorInstanceId: request.connectorInstanceId,
        sourceTaskId: request.sourceTaskId,
        successorTaskId: request.successorTaskId,
        expectedRevision: request.expectedRevision,
        requestedSourceId: request.requestedSourceId,
        observation: request.observation,
        actor: request.actor,
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
        now: new Date(request.now),
      });
    },
  };

  function repointRepositoryBinding(connectorInstanceId: string, repository: string) {
    const [owner, name] = repository.split('/');
    const rows = sqlite.prepare(`
      SELECT
        entities.id AS repositoryEntityId,
        entities.stable_id AS repositoryStableId,
        bindings.local_id AS localId
      FROM external_entity_bindings AS bindings
      INNER JOIN external_entities AS entities
        ON entities.id = bindings.external_entity_id
      INNER JOIN external_entity_locators AS locators
        ON locators.external_entity_id = entities.id
        AND locators.valid_to IS NULL
      WHERE bindings.connector_instance_id = ?
        AND bindings.binding_type = 'source_list'
        AND bindings.state IN ('shadow', 'active')
        AND entities.provider = 'github'
        AND entities.entity_type = 'repository'
        AND locators.owner_key = ?
        AND locators.repository_key = ?
    `).all(connectorInstanceId, owner.toLowerCase(), name.toLowerCase()) as Array<{
      repositoryEntityId: string;
      repositoryStableId: string;
      localId: string;
    }>;
    return rows.length === 1 ? rows[0] : null;
  }

  const repoint: GitHubRepointPersistence = {
    async getRepositoryBinding(connectorInstanceId, repository) {
      return repointRepositoryBinding(connectorInstanceId, repository);
    },

    async listIssuePlanRows(connectorInstanceId, repository) {
      return selectIssuePlanRows(connectorInstanceId, repository);
    },

    async collectInventory({ connectorInstanceId, from, to, ownedOperationId }) {
      const connector = readConnector(connectorInstanceId);
      if (!connector) throw new Error('Active GitHub connector was not found');
      const settings = asRecord(connector.settings);
      const fromPrefix = `${from}:`;
      const toPrefix = `${to}:`;
      const affected = `
        SELECT id FROM tasks
        WHERE connector_instance_id = ?
          AND substr(source_id, 1, length(?)) = ?
      `;
      return {
        counts: {
          connectorSettings: asStringArray(settings.repos)
            .filter((repo) => samePath(repo, from)).length,
          connectorSyncedLists: asStringArray(connector.syncedLists)
            .filter((repo) => samePath(repo, from)).length,
          sourceLists: scalar(`
            SELECT COUNT(*) AS value FROM source_lists
            WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
          `, connectorInstanceId, from),
          tasks: scalar(`
            SELECT COUNT(*) AS value FROM tasks
            WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
          `, connectorInstanceId, fromPrefix, fromPrefix),
          linkedSources: scalar(`
            SELECT COUNT(*) AS value FROM task_linked_sources
            WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
          `, connectorInstanceId, fromPrefix, fromPrefix),
          ingestSuppressions: scalar(`
            SELECT COUNT(*) AS value FROM task_ingest_suppressions
            WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
          `, connectorInstanceId, fromPrefix, fromPrefix),
          deletionCandidates: scalar(`
            SELECT COUNT(*) AS value FROM sync_deletion_candidates WHERE connector_id = ?
          `, connectorInstanceId),
          pendingPushes: scalar(`
            SELECT COUNT(*) AS value FROM tasks
            WHERE connector_instance_id = ? AND sync_status = 'pending_push'
          `, connectorInstanceId),
          failedPushes: scalar(`
            SELECT COUNT(*) AS value FROM tasks
            WHERE connector_instance_id = ?
              AND sync_status IN ('push_error', 'push_failed', 'error')
          `, connectorInstanceId),
          dependencySnapshots: scalar(`
            SELECT COUNT(*) AS value FROM dependency_reconciliation_snapshots
            WHERE connector_instance_id = ? AND status IN ('running', 'failed', 'partial')
          `, connectorInstanceId),
          openIdentityCollisions: scalar(`
            SELECT COUNT(*) AS value FROM github_identity_collisions
            WHERE connector_instance_id = ? AND state = 'open'
          `, connectorInstanceId),
          targetTaskConflicts: scalar(`
            SELECT COUNT(*) AS value FROM tasks
            WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
          `, connectorInstanceId, toPrefix, toPrefix),
          targetSourceListConflicts: scalar(`
            SELECT COUNT(*) AS value FROM source_lists
            WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
          `, connectorInstanceId, to),
        },
        relationships: {
          projects: scalar(`SELECT COUNT(*) AS value FROM task_projects WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          phases: scalar(`SELECT COUNT(*) AS value FROM project_phase_items WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          schedules: scalar(`SELECT COUNT(*) AS value FROM task_schedules WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          tags: scalar(`SELECT COUNT(*) AS value FROM task_tags WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          dependencies: scalar(`
            SELECT COUNT(*) AS value FROM task_dependencies
            WHERE task_id IN (${affected}) OR depends_on_task_id IN (${affected})
          `, connectorInstanceId, fromPrefix, fromPrefix, connectorInstanceId, fromPrefix, fromPrefix),
          history: scalar(`SELECT COUNT(*) AS value FROM task_history_events WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          myDay: scalar(`SELECT COUNT(*) AS value FROM my_day_items WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          focus: scalar(`SELECT COUNT(*) AS value FROM focus_items WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
          attachments: scalar(`SELECT COUNT(*) AS value FROM task_attachments WHERE task_id IN (${affected})`, connectorInstanceId, fromPrefix, fromPrefix),
        },
        activity: {
          queuedSyncJobs: scalar(`SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = ? AND status = 'queued'`, connectorInstanceId),
          runningSyncJobs: scalar(`SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = ? AND status = 'running'`, connectorInstanceId),
          operationLeases: scalar(`SELECT COUNT(*) AS value FROM connector_operation_leases WHERE connector_id = ?`, connectorInstanceId),
          maintenanceLocks: ownedOperationId
            ? scalar(`
              SELECT COUNT(*) AS value FROM connector_maintenance_locks
              WHERE connector_instance_id = ? AND operation_id <> ?
            `, connectorInstanceId, ownedOperationId)
            : scalar(`
              SELECT COUNT(*) AS value FROM connector_maintenance_locks
              WHERE connector_instance_id = ?
            `, connectorInstanceId),
        },
        deletionCandidates: (sqlite.prepare(`
          SELECT source_id AS sourceId
          FROM sync_deletion_candidates
          WHERE connector_id = ?
          ORDER BY source_id
          LIMIT ${MAX_DELETION_CANDIDATE_SAMPLES}
        `).all(connectorInstanceId) as Array<{ sourceId: string }>).map((row) => row.sourceId),
      };
    },

    async preflightLocator(input) {
      return preflightExternalEntityLocatorInTransaction(db, input).state;
    },

    async findOperationByIdempotency(connectorInstanceId, idempotencyKey) {
      const row = db.select().from(githubRepositoryRepoints).where(and(
        eq(githubRepositoryRepoints.connectorInstanceId, connectorInstanceId),
        eq(githubRepositoryRepoints.idempotencyKey, idempotencyKey),
      )).limit(1).get();
      return row ? operationWithLock(row) : null;
    },

    async getOperation(operationId) {
      const row = db.select().from(githubRepositoryRepoints)
        .where(eq(githubRepositoryRepoints.id, operationId)).limit(1).get();
      return row ? operationWithLock(row) : null;
    },

    async acquireOperation(input) {
      const [fromOwner, fromRepository] = input.from.split('/');
      const [toOwner, toRepository] = input.to.split('/');
      const operationId = randomUUID();
      const connector = readConnector(input.connectorInstanceId);
      if (!connector) throw new Error('Active GitHub connector was not found');
      runTransaction((tx) => {
        assertNoConnectorActivityInTransaction(tx, input.connectorInstanceId);
        const existingLock = tx.select().from(connectorMaintenanceLocks)
          .where(eq(connectorMaintenanceLocks.connectorInstanceId, input.connectorInstanceId))
          .limit(1).get();
        if (existingLock) throw new Error('Connector already has a maintenance lock');
        const sourceListSnapshot = tx.select().from(sourceLists).where(and(
          eq(sourceLists.connectorInstanceId, input.connectorInstanceId),
          eq(sourceLists.id, input.sourceListId),
        )).limit(1).get();
        if (!sourceListSnapshot) {
          throw new Error('Repository source list disappeared before repoint lock');
        }
        tx.insert(githubRepositoryRepoints).values({
          id: operationId,
          connectorInstanceId: input.connectorInstanceId,
          idempotencyKey: input.idempotencyKey,
          phase: 'locked',
          actor: input.actor,
          hostKey: input.hostKey,
          repositoryEntityId: input.repositoryEntityId,
          repositoryStableId: input.repositoryStableId,
          fromOwner,
          fromRepository,
          toOwner,
          toRepository,
          connectorWasEnabled: connector.enabled,
          backupProof: input.backupProof,
          preflight: input.preflight,
          rollbackSnapshot: {
            settings: connector.settings,
            syncedLists: connector.syncedLists,
            relationships: input.relationships,
            taskIdDigest: input.taskIdDigest,
            sourceList: {
              id: sourceListSnapshot.id,
              sourceId: sourceListSnapshot.sourceId,
              name: sourceListSnapshot.name,
              lastKnownRemoteName: sourceListSnapshot.lastKnownRemoteName,
            },
          },
          verification: null,
          lastError: null,
          createdAt: input.now,
          updatedAt: input.now,
          completedAt: null,
        }).run();
        tx.insert(connectorMaintenanceLocks).values({
          connectorInstanceId: input.connectorInstanceId,
          operationId,
          actor: input.actor,
          reason: 'github_repository_repoint',
          acquiredAt: input.now,
          updatedAt: input.now,
        }).run();
        tx.update(connectorConfigs).set({
          enabled: false,
          updatedAt: input.now,
        }).where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
        appendRepointEvent(tx, operationId, 'locked', input.actor, {
          from: input.from,
          to: input.to,
          counts: input.counts,
          backupSha256: input.backupSha256,
        }, input.now);
      });
      const created = await repoint.getOperation(operationId);
      if (!created) throw new Error('GitHub repository repoint operation was not found');
      return created;
    },

    async applyOperation(input): Promise<GitHubRepointApplyResult> {
      let result: GitHubRepointApplyResult = { outcome: 'not-applicable' };
      runTransaction((tx) => {
        const current = requireOperationInTransaction(tx, input.operationId);
        requireOwnedMaintenanceLock(tx, current);
        if (current.phase !== 'locked') return;
        assertNoConnectorActivityInTransaction(tx, current.connectorInstanceId);
        tx.update(githubRepositoryRepoints).set({
          phase: 'applying',
          updatedAt: input.now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(tx, current.id, 'applying', current.actor, {}, input.now);

        const repositoryInput = {
          entityId: current.repositoryEntityId,
          identity: input.repositoryIdentity,
          locator: input.repositoryLocator,
          repositoryEntityId: null,
          observedAt: input.repositoryObservedAt,
        };
        const repositoryPreflight = preflightExternalEntityLocatorInTransaction(
          tx,
          repositoryInput,
        );
        if (repositoryPreflight.state === 'collision') {
          recordLocatorCollision(
            tx,
            current,
            'source_list',
            input.repositorySourceListId,
            current.repositoryEntityId,
            repositoryPreflight,
            input.now,
          );
          markOperationFailed(tx, current, 'Repository locator collision during apply', input.now);
          result = {
            outcome: 'collision',
            scope: 'repository',
            error: 'Repository locator collision during apply',
          };
          return;
        }

        for (const issue of input.issues) {
          const preflight = preflightExternalEntityLocatorInTransaction(tx, {
            entityId: issue.issueEntityId,
            identity: issue.identity,
            locator: issue.locator,
            repositoryEntityId: current.repositoryEntityId,
            observedAt: issue.observedAt,
          });
          if (preflight.state === 'collision') {
            recordLocatorCollision(
              tx,
              current,
              'task',
              issue.taskId,
              issue.issueEntityId,
              preflight,
              input.now,
            );
            markOperationFailed(tx, current, 'Issue locator collision during apply', input.now);
            result = {
              outcome: 'collision',
              scope: 'issue',
              error: 'Issue locator collision during apply',
            };
            return;
          }
        }
        observeOperatorExternalEntityLocatorInTransaction(tx, repositoryInput);
        for (const issue of input.issues) {
          observeOperatorExternalEntityLocatorInTransaction(tx, {
            entityId: issue.issueEntityId,
            identity: issue.identity,
            locator: issue.locator,
            repositoryEntityId: current.repositoryEntityId,
            observedAt: issue.observedAt,
          });
        }

        const from = repositoryPath(current.fromOwner, current.fromRepository);
        const to = repositoryPath(current.toOwner, current.toRepository);
        replaceConnectorConfiguration(tx, current.connectorInstanceId, from, to, input.now);
        for (const issue of input.issues) {
          tx.update(tasks).set({
            sourceId: `${to}:${issue.issueNumber}`,
            sourceListId: to,
            sourceListName: to,
            updatedAt: input.now,
          }).where(eq(tasks.id, issue.taskId)).run();
        }
        replaceActiveReferences(tx, current.connectorInstanceId, from, to, input.now);
        tx.update(githubRepositoryRepoints).set({
          phase: 'applied',
          lastError: null,
          updatedAt: input.now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(tx, current.id, 'applied', current.actor, {
          tasksUpdated: input.issues.length,
          sourceListsUpdated: input.sourceListsUpdated,
        }, input.now);
        result = { outcome: 'applied', tasksUpdated: input.issues.length };
      });
      return result;
    },

    async setOperationPhase({ operationId, phase, actor, payload, now }) {
      runTransaction((tx) => {
        const operation = requireOperationInTransaction(tx, operationId);
        requireOwnedMaintenanceLock(tx, operation);
        tx.update(githubRepositoryRepoints).set({
          phase,
          actor,
          updatedAt: now,
        }).where(eq(githubRepositoryRepoints.id, operationId)).run();
        appendRepointEvent(tx, operationId, phase, actor, payload, now);
      });
    },

    async readRoutingSnapshot({ connectorInstanceId, from, to }) {
      const connector = readConnector(connectorInstanceId);
      if (!connector) throw new Error('Active GitHub connector was not found');
      const settings = asRecord(connector.settings);
      const configuredRepositories = asStringArray(settings.repos);
      const syncedLists = asStringArray(connector.syncedLists);
      const sourcePrefix = `${from}:`;
      const targetPrefix = `${to}:`;
      return {
        configuredRepositoryMatches: configuredRepositories
          .filter((repository) => samePath(repository, to)).length,
        configuredRepositorySourceMatches: configuredRepositories
          .filter((repository) => samePath(repository, from)).length,
        syncedListMatches: syncedLists.filter((repository) => samePath(repository, to)).length,
        syncedListSourceMatches: syncedLists
          .filter((repository) => samePath(repository, from)).length,
        targetSourceLists: scalar(`
          SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
        `, connectorInstanceId, to),
        sourceSourceLists: scalar(`
          SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
        `, connectorInstanceId, from),
        targetTasks: scalar(`
          SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
        `, connectorInstanceId, targetPrefix, targetPrefix),
        sourceTasks: scalar(`
          SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
        `, connectorInstanceId, sourcePrefix, sourcePrefix),
      };
    },

    async completeVerification({ operationId, verification, now }) {
      runTransaction((tx) => {
        const current = requireOperationInTransaction(tx, operationId);
        requireOwnedMaintenanceLock(tx, current);
        tx.update(connectorConfigs).set({
          enabled: current.connectorWasEnabled,
          updatedAt: now,
        }).where(eq(connectorConfigs.id, current.connectorInstanceId)).run();
        tx.delete(connectorMaintenanceLocks)
          .where(eq(connectorMaintenanceLocks.connectorInstanceId, current.connectorInstanceId))
          .run();
        tx.update(githubRepositoryRepoints).set({
          phase: 'verified',
          verification,
          lastError: null,
          updatedAt: now,
          completedAt: now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(tx, current.id, 'verified', current.actor, verification, now);
      });
    },

    async failVerification({ operationId, verification, error, now }) {
      runTransaction((tx) => {
        const current = requireOperationInTransaction(tx, operationId);
        requireOwnedMaintenanceLock(tx, current);
        tx.update(githubRepositoryRepoints).set({
          phase: 'verification_failed',
          verification,
          lastError: error,
          updatedAt: now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(
          tx,
          current.id,
          'verification_failed',
          current.actor,
          verification,
          now,
        );
      });
    },

    async rollbackOperation({ operationId, actor, from, to, now }) {
      let result: GitHubRepointRollbackResult = { outcome: 'rolled-back' };
      runTransaction((tx) => {
        const current = requireOperationInTransaction(tx, operationId);
        if (current.phase === 'rolled_back') {
          const currentConnector = tx.select().from(connectorConfigs)
            .where(eq(connectorConfigs.id, current.connectorInstanceId)).limit(1).get();
          if (!currentConnector || currentConnector.enabled) {
            throw new Error('Rolled-back repoint repair requires a disabled connector');
          }
          const unexpectedLock = tx.select().from(connectorMaintenanceLocks)
            .where(eq(connectorMaintenanceLocks.connectorInstanceId, current.connectorInstanceId))
            .limit(1).get();
          if (unexpectedLock) {
            throw new Error('Rolled-back repoint repair found an unexpected maintenance lock');
          }
          assertNoConnectorActivityInTransaction(tx, current.connectorInstanceId);
          const settings = asRecord(currentConnector.settings);
          if (
            !asStringArray(settings.repos).some((repository) => samePath(repository, from))
            || asStringArray(settings.repos).some((repository) => samePath(repository, to))
            || !asStringArray(currentConnector.syncedLists)
              .some((repository) => samePath(repository, from))
            || asStringArray(currentConnector.syncedLists)
              .some((repository) => samePath(repository, to))
          ) {
            throw new Error('Rolled-back repoint repair found unexpected connector routing');
          }
          const repair = restoreSourceListSnapshot(tx, current, from, to);
          if (repair.repaired) {
            tx.update(githubRepositoryRepoints).set({
              updatedAt: now,
            }).where(eq(githubRepositoryRepoints.id, current.id)).run();
            appendRepointEvent(tx, current.id, 'rolled_back', actor, {
              idempotentRepair: true,
              restoredSourceList: true,
              sourceListSnapshotMode: repair.snapshotMode,
            }, now);
            result = { outcome: 'repaired', snapshotMode: repair.snapshotMode };
            return;
          }
          result = { outcome: 'already-rolled-back' };
          return;
        }
        requireOwnedMaintenanceLock(tx, current);
        assertNoConnectorActivityInTransaction(tx, current.connectorInstanceId);
        tx.update(githubRepositoryRepoints).set({
          phase: 'rolling_back',
          actor,
          updatedAt: now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(tx, current.id, 'rolling_back', actor, {}, now);

        restoreHistoricalLocator(tx, current.repositoryEntityId, {
          provider: 'github',
          hostKey: current.hostKey,
          entityType: 'repository',
          stableId: current.repositoryStableId,
        }, from, null, now);

        const issues = selectIssuePlanRowsInTransaction(tx, current.connectorInstanceId, to);
        for (const issue of issues) {
          if (!issue.issueEntityId || !issue.issueStableId || !issue.issueNumber) {
            throw new Error(`Task ${issue.taskId} lost its issue binding before rollback`);
          }
          restoreHistoricalLocator(tx, issue.issueEntityId, {
            provider: 'github',
            hostKey: current.hostKey,
            entityType: 'issue',
            stableId: issue.issueStableId,
          }, from, current.repositoryEntityId, now, issue.issueNumber);
          tx.update(tasks).set({
            sourceId: `${from}:${issue.issueNumber}`,
            sourceListId: from,
            sourceListName: from,
            updatedAt: now,
          }).where(eq(tasks.id, issue.taskId)).run();
        }
        replaceActiveReferences(tx, current.connectorInstanceId, to, from, now);
        restoreSourceListSnapshot(tx, current, from, to);
        const snapshot = current.rollbackSnapshot;
        tx.update(connectorConfigs).set({
          settings: (snapshot.settings ?? {}) as never,
          syncedLists: (snapshot.syncedLists ?? []) as never,
          enabled: false,
          updatedAt: now,
        }).where(eq(connectorConfigs.id, current.connectorInstanceId)).run();
        tx.delete(connectorMaintenanceLocks)
          .where(eq(connectorMaintenanceLocks.connectorInstanceId, current.connectorInstanceId))
          .run();
        tx.update(githubRepositoryRepoints).set({
          phase: 'rolled_back',
          actor,
          lastError: null,
          updatedAt: now,
          completedAt: now,
        }).where(eq(githubRepositoryRepoints.id, current.id)).run();
        appendRepointEvent(tx, current.id, 'rolled_back', actor, {
          connectorRemainsDisabled: true,
          restoredPath: from,
        }, now);
        result = { outcome: 'rolled-back' };
      });
      return result;
    },
  };

  const bulkTransfer: GitHubBulkTransferPersistence = {
    async getRepositoryBinding(connectorInstanceId, repository) {
      const [owner, name] = repository.toLowerCase().split('/');
      const rows = sqlite.prepare(`
        SELECT e.id AS entityId, e.stable_id AS stableId
        FROM external_entity_bindings b
        JOIN external_entities e ON e.id = b.external_entity_id
        JOIN external_entity_locators l ON l.external_entity_id = e.id
        WHERE b.connector_instance_id = ?
          AND b.binding_type = 'source_list'
          AND b.state IN ('shadow', 'active')
          AND e.provider = 'github'
          AND e.entity_type = 'repository'
          AND l.valid_to IS NULL
          AND l.issue_number IS NULL
          AND l.owner_key = ?
          AND l.repository_key = ?
      `).all(connectorInstanceId, owner, name) as Array<{ entityId: string; stableId: string }>;
      return rows.length === 1 ? rows[0] : null;
    },

    async countConnectorActivity({ connectorInstanceId, ignoreOwnedOperationLease }) {
      return scalar(`
        SELECT
          (SELECT COUNT(*) FROM sync_jobs
           WHERE connector_id = ? AND status IN ('queued', 'running'))
          + (SELECT COUNT(*) FROM connector_operation_leases
             WHERE connector_id = ? AND ? = 0)
          + (SELECT COUNT(*) FROM connector_maintenance_locks WHERE connector_instance_id = ?)
          AS value
      `, connectorInstanceId, connectorInstanceId, ignoreOwnedOperationLease ? 1 : 0,
      connectorInstanceId);
    },

    async countBlockingState(connectorInstanceId) {
      return scalar(`
        SELECT
          (SELECT COUNT(*) FROM tasks
           WHERE connector_instance_id = ?
             AND sync_status IN ('pending_push', 'push_error', 'push_failed'))
          + (SELECT COUNT(*) FROM sync_deletion_candidates WHERE connector_id = ?)
          + (SELECT COUNT(*) FROM github_identity_collisions
             WHERE connector_instance_id = ? AND state = 'open')
          + (SELECT COUNT(*) FROM github_identity_write_cycles
             WHERE connector_instance_id = ?
               AND (
                 reconciliation_state = 'quarantined'
                 OR state = 'running'
                 OR (
                   state = 'interrupted'
                   AND reconciliation_state NOT IN
                     ('pre_dispatch_retryable', 'resolved', 'superseded')
                 )
                 OR (
                   state = 'completed'
                   AND reconciliation_state NOT IN
                     ('pre_dispatch_retryable', 'resolved', 'superseded')
                   AND (
                     pending_candidate_count > observed_route_count
                     OR blocked_count > 0
                     OR failed_count > 0
                     OR unknown_count > 0
                   )
                 )
               ))
          + (SELECT COUNT(*) FROM dependency_reconciliation_snapshots
             WHERE connector_instance_id = ? AND status != 'completed')
          AS value
      `, connectorInstanceId, connectorInstanceId, connectorInstanceId, connectorInstanceId,
      connectorInstanceId);
    },

    async listAuthoritativeDeletedTaskIds(connectorInstanceId) {
      const rows = sqlite.prepare(`
        SELECT DISTINCT exception.local_id AS taskId
        FROM github_identity_exception_events AS exception
        INNER JOIN tasks AS task
          ON task.id = exception.local_id
          AND task.connector_instance_id = exception.connector_instance_id
          AND task.status = 'cancelled'
        WHERE exception.connector_instance_id = ?
          AND exception.binding_type = 'task'
          AND exception.category = 'terminal_inaccessible'
          AND exception.action = 'accept'
          AND exception.proof_type = 'post_backfill_authoritative_deletion'
          AND exception.id = (
            SELECT MAX(latest.id)
            FROM github_identity_exception_events AS latest
            WHERE latest.connector_instance_id = exception.connector_instance_id
              AND latest.binding_type = exception.binding_type
              AND latest.local_id = exception.local_id
              AND latest.category = exception.category
          )
      `).all(connectorInstanceId) as Array<{ taskId: string }>;
      return rows.map((row) => row.taskId);
    },

    async listConnectorTasks(connectorInstanceId) {
      return db.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        status: tasks.status,
      }).from(tasks).where(and(
        eq(tasks.connectorInstanceId, connectorInstanceId),
        eq(tasks.connectorType, 'github-issues'),
      )).all();
    },

    async taskMetadataDigest(taskId) {
      return taskMetadataDigest(taskId);
    },

    async connectorMetadataDigest(connectorInstanceId) {
      return connectorMetadataDigest(connectorInstanceId);
    },

    async findRun(connectorInstanceId, idempotencyKey) {
      const row = db.select().from(githubBulkTransferRuns).where(and(
        eq(githubBulkTransferRuns.connectorInstanceId, connectorInstanceId),
        eq(githubBulkTransferRuns.idempotencyKey, idempotencyKey),
      )).limit(1).get();
      return row ? mapRun(row) : null;
    },

    async getRun(runId) {
      const row = db.select().from(githubBulkTransferRuns)
        .where(eq(githubBulkTransferRuns.id, runId)).limit(1).get();
      return row ? mapRun(row) : null;
    },

    async listItems(runId, states) {
      const rows = states && states.length > 0
        ? db.select().from(githubBulkTransferItems).where(and(
          eq(githubBulkTransferItems.runId, runId),
          inArray(githubBulkTransferItems.state, [...states]),
        )).orderBy(githubBulkTransferItems.sourceNumber).all()
        : db.select().from(githubBulkTransferItems)
          .where(eq(githubBulkTransferItems.runId, runId))
          .orderBy(githubBulkTransferItems.sourceNumber).all();
      return rows as GitHubBulkTransferItemRecord[];
    },

    async getItem(runId, taskId) {
      const row = db.select().from(githubBulkTransferItems).where(and(
        eq(githubBulkTransferItems.runId, runId),
        eq(githubBulkTransferItems.taskId, taskId),
      )).limit(1).get();
      return (row as GitHubBulkTransferItemRecord | undefined) ?? null;
    },

    async countItems(runId) {
      const counts = sqlite.prepare(`
        SELECT
          COUNT(*) AS totalCount,
          SUM(CASE WHEN state = 'transferred' THEN 1 ELSE 0 END) AS transferredCount,
          SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
          SUM(CASE WHEN state = 'transferring' THEN 1 ELSE 0 END) AS ambiguousCount,
          SUM(CASE WHEN state IN ('failed', 'transferring') THEN 1 ELSE 0 END) AS failedCount
        FROM github_bulk_transfer_items WHERE run_id = ?
      `).get(runId) as Record<string, number | null>;
      return {
        totalCount: counts.totalCount ?? 0,
        transferredCount: counts.transferredCount ?? 0,
        pendingCount: counts.pendingCount ?? 0,
        ambiguousCount: counts.ambiguousCount ?? 0,
        failedCount: counts.failedCount ?? 0,
      };
    },

    async listSuccessions(runId) {
      return db.select().from(githubBulkTransferSuccessions)
        .where(eq(githubBulkTransferSuccessions.runId, runId)).all().map(mapSuccession);
    },

    async getSuccession(runId, taskId) {
      const row = db.select().from(githubBulkTransferSuccessions).where(and(
        eq(githubBulkTransferSuccessions.runId, runId),
        eq(githubBulkTransferSuccessions.taskId, taskId),
      )).limit(1).get();
      return row ? mapSuccession(row) : null;
    },

    async listAcceptedDispatchTargets(runId, taskId) {
      return db.select({ payload: githubBulkTransferEvents.payload })
        .from(githubBulkTransferEvents).where(and(
          eq(githubBulkTransferEvents.runId, runId),
          eq(githubBulkTransferEvents.taskId, taskId),
          eq(githubBulkTransferEvents.eventType, 'dispatch_accepted'),
        )).all()
        .map((event) => asRecord(event.payload).targetNumber)
        .filter((value): value is number => Number.isSafeInteger(value));
    },

    async createRun(input) {
      const connector = readConnector(input.connectorInstanceId);
      if (!connector || connector.type !== 'github-issues') {
        throw new Error('GitHub connector was not found');
      }
      runTransaction((tx) => {
        tx.insert(githubBulkTransferRuns).values({
          id: input.runId,
          connectorInstanceId: input.connectorInstanceId,
          idempotencyKey: input.idempotencyKey,
          phase: 'running',
          actor: input.actor,
          sourceRepository: input.sourceRepository,
          targetRepository: input.targetRepository,
          planHash: input.planHash,
          plan: input.plan,
          connectorWasEnabled: connector.enabled,
          transferredCount: 0,
          skippedCount: 0,
          failedCount: 0,
          createdAt: input.now,
          updatedAt: input.now,
        }).run();
        if (input.items.length > 0) {
          tx.insert(githubBulkTransferItems).values(input.items.map((item) => ({
            runId: input.runId,
            taskId: item.taskId,
            issueEntityId: item.issueEntityId,
            issueStableId: item.issueStableId,
            sourceNumber: item.sourceNumber,
            state: 'pending' as const,
            beforeDigest: item.beforeDigest,
            updatedAt: input.now,
          }))).run();
        }
        tx.update(connectorConfigs).set({
          enabled: false,
          updatedAt: input.now,
        }).where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
        tx.insert(githubBulkTransferEvents).values({
          runId: input.runId,
          taskId: null,
          eventType: 'started',
          payload: { planHash: input.planHash, totalCount: input.items.length },
          createdAt: input.now,
        }).run();
      });
    },

    async markRunRunning(runId, now) {
      db.update(githubBulkTransferRuns).set({
        phase: 'running',
        lastError: null,
        updatedAt: now,
      }).where(eq(githubBulkTransferRuns.id, runId)).run();
    },

    async failRun(runId, error, now) {
      db.update(githubBulkTransferRuns).set({
        phase: 'failed',
        failedCount: scalar(`
          SELECT COUNT(*) AS value FROM github_bulk_transfer_items
          WHERE run_id = ? AND state IN ('failed', 'transferring')
        `, runId),
        lastError: error.slice(0, 1_000),
        updatedAt: now,
      }).where(eq(githubBulkTransferRuns.id, runId)).run();
      db.insert(githubBulkTransferEvents).values({
        runId,
        taskId: null,
        eventType: 'failed',
        payload: { error: error.slice(0, 1_000) },
        createdAt: now,
      }).run();
    },

    async abortRun(runId, actor, now) {
      db.update(githubBulkTransferRuns).set({
        phase: 'aborted',
        actor,
        completedAt: now,
        updatedAt: now,
      }).where(eq(githubBulkTransferRuns.id, runId)).run();
      db.insert(githubBulkTransferEvents).values({
        runId,
        taskId: null,
        eventType: 'aborted',
        payload: { actor },
        createdAt: now,
      }).run();
    },

    async completeRun(input) {
      runTransaction((tx) => {
        tx.update(connectorConfigs).set({
          enabled: input.connectorWasEnabled,
          updatedAt: input.now,
        }).where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
        tx.update(githubBulkTransferRuns).set({
          phase: 'completed',
          transferredCount: input.transferredCount,
          failedCount: 0,
          lastError: null,
          completedAt: input.now,
          updatedAt: input.now,
        }).where(eq(githubBulkTransferRuns.id, input.runId)).run();
        tx.insert(githubBulkTransferEvents).values({
          runId: input.runId,
          taskId: null,
          eventType: 'reconciled',
          payload: {
            sourceCount: input.transferredCount,
            destinationBeforeCount: input.destinationBeforeCount,
            destinationAfterCount: input.destinationAfterCount,
            transferredCount: input.transferredCount,
            skippedCount: 0,
            failedCount: 0,
            reconciledCount: input.transferredCount,
            metadataDriftCount: 0,
          },
          createdAt: input.now,
        }).run();
      });
    },

    async setItemState(input) {
      const set: Record<string, unknown> = {
        state: input.state,
        updatedAt: input.now,
      };
      if (input.startedAt !== undefined) set.startedAt = input.startedAt;
      if (input.lastError !== undefined) set.lastError = input.lastError;
      db.update(githubBulkTransferItems).set(set as never).where(and(
        eq(githubBulkTransferItems.runId, input.runId),
        eq(githubBulkTransferItems.taskId, input.taskId),
      )).run();
    },

    async completeItem(input) {
      runTransaction((tx) => {
        tx.update(githubBulkTransferItems).set({
          state: 'transferred',
          targetNumber: input.targetNumber,
          newSourceId: input.newSourceId,
          completedAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(githubBulkTransferItems.runId, input.runId),
          eq(githubBulkTransferItems.taskId, input.taskId),
        )).run();
        tx.update(githubBulkTransferRuns).set({
          transferredCount: countTransferred(input.runId),
          updatedAt: input.now,
        }).where(eq(githubBulkTransferRuns.id, input.runId)).run();
        tx.insert(githubBulkTransferEvents).values({
          runId: input.runId,
          taskId: input.taskId,
          eventType: 'verified',
          payload: input.eventPayload,
          createdAt: input.now,
        }).run();
      });
    },

    async appendEvent(input) {
      db.insert(githubBulkTransferEvents).values({
        runId: input.runId,
        taskId: input.taskId,
        eventType: input.eventType,
        payload: input.payload,
        createdAt: input.createdAt,
      }).run();
    },

    async reconcileItemRouting(input) {
      runTransaction((tx) => {
        const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
          entityId: input.issueEntityId,
          identity: input.identity,
          locator: input.locator,
          repositoryEntityId: input.targetRepositoryEntityId,
          observedAt: input.observedAt,
        });
        if (observed.state === 'collision') {
          throw new Error('Bulk transfer reconciliation target locator collision');
        }
        const newSourceId = `${input.targetRepository}:${input.targetNumber}`;
        const currentTask = tx.select({ metadata: tasks.metadata }).from(tasks)
          .where(eq(tasks.id, input.taskId)).limit(1).get();
        if (!currentTask) {
          throw new Error('Bulk transfer reconciliation task disappeared before routing update');
        }
        tx.update(tasks).set({
          sourceId: newSourceId,
          sourceListId: input.targetRepository,
          sourceListName: input.targetRepository,
          metadata: input.refreshMetadata(currentTask.metadata) as never,
          syncStatus: 'synced',
          updatedAt: input.now,
        }).where(eq(tasks.id, input.taskId)).run();
        tx.update(githubBulkTransferItems).set({
          state: 'transferred',
          targetNumber: input.targetNumber,
          newSourceId,
          lastError: null,
          completedAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(githubBulkTransferItems.runId, input.runId),
          eq(githubBulkTransferItems.taskId, input.taskId),
        )).run();
        tx.update(githubBulkTransferRuns).set({
          actor: input.actor,
          transferredCount: countTransferred(input.runId),
          failedCount: 0,
          lastError: null,
          updatedAt: input.now,
        }).where(eq(githubBulkTransferRuns.id, input.runId)).run();
        tx.insert(githubBulkTransferEvents).values({
          runId: input.runId,
          taskId: input.taskId,
          eventType: 'ambiguity_reconciled',
          payload: {
            targetNumber: input.targetNumber,
            issueStableIdDigest: input.issueStableIdDigest,
            actor: input.actor,
          },
          createdAt: input.now,
        }).run();
      });
    },

    async recordSuccession(input) {
      runTransaction((tx) => {
        const currentItem = tx.select().from(githubBulkTransferItems).where(and(
          eq(githubBulkTransferItems.runId, input.runId),
          eq(githubBulkTransferItems.taskId, input.taskId),
        )).limit(1).get();
        if (!currentItem || currentItem.state !== 'transferring') {
          throw new Error('Bulk transfer successor reconciliation item state changed');
        }
        const currentMode = getGitHubIdentityModeSnapshotInTransaction(
          tx,
          input.connectorInstanceId,
        );
        if (currentMode.modeRevision !== input.expectedModeRevision) {
          throw new Error('Bulk transfer successor reconciliation identity mode changed');
        }
        const currentTask = tx.select({
          sourceId: tasks.sourceId,
          metadata: tasks.metadata,
        }).from(tasks).where(and(
          eq(tasks.id, input.taskId),
          eq(tasks.connectorInstanceId, input.connectorInstanceId),
        )).limit(1).get();
        if (currentTask?.sourceId.toLowerCase() !== input.sourceId.toLowerCase()) {
          throw new Error('Bulk transfer successor reconciliation task route changed');
        }
        const binding = tx.select().from(externalEntityBindings).where(and(
          eq(externalEntityBindings.connectorInstanceId, input.connectorInstanceId),
          eq(externalEntityBindings.bindingType, 'task'),
          eq(externalEntityBindings.localId, input.taskId),
          inArray(externalEntityBindings.state, [...ACTIVE_BINDING_STATES]),
        )).limit(1).get();
        if (!binding || binding.externalEntityId !== input.issueEntityId) {
          throw new Error('Bulk transfer successor reconciliation binding changed');
        }
        const successor = upsertExternalEntityInTransaction(tx, {
          identity: input.evidence.entity.identity,
          observedAt: input.now,
        });
        if (successor.id === input.issueEntityId) {
          throw new Error('Bulk transfer successor reconciliation requires distinct identities');
        }
        const occupied = tx.select().from(externalEntityBindings).where(and(
          eq(externalEntityBindings.connectorInstanceId, input.connectorInstanceId),
          eq(externalEntityBindings.externalEntityId, successor.id),
        )).limit(1).get();
        if (occupied) {
          throw new Error('Bulk transfer successor identity is already bound');
        }
        tx.update(externalEntityLocators).set({
          validTo: input.now,
        }).where(and(
          eq(externalEntityLocators.externalEntityId, input.issueEntityId),
          isNull(externalEntityLocators.validTo),
        )).run();
        const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
          entityId: successor.id,
          identity: input.evidence.entity.identity,
          locator: input.evidence.entity.locator,
          repositoryEntityId: input.targetRepositoryEntityId,
          observedAt: input.now,
        });
        if (observed.state === 'collision') {
          throw new Error('Bulk transfer successor target locator collision');
        }
        tx.update(externalEntityBindings).set({
          externalEntityId: successor.id,
          verifiedAt: input.now,
          updatedAt: input.now,
        }).where(eq(externalEntityBindings.id, binding.id)).run();
        tx.update(tasks).set({
          sourceId: input.successorSourceId,
          sourceListId: input.targetRepository,
          sourceListName: input.targetRepository,
          metadata: input.refreshMetadata(currentTask.metadata) as never,
          syncStatus: 'synced',
          updatedAt: input.now,
        }).where(eq(tasks.id, input.taskId)).run();
        tx.insert(githubBulkTransferSuccessions).values({
          id: randomUUID(),
          runId: input.runId,
          taskId: input.taskId,
          sourceExternalEntityId: input.issueEntityId,
          successorExternalEntityId: successor.id,
          sourceStableIdDigest: input.sourceStableIdDigest,
          successorStableIdDigest: input.successorStableIdDigest,
          sourceId: input.sourceId,
          successorSourceId: input.successorSourceId,
          targetRepositoryEntityId: input.targetRepositoryEntityId,
          targetNumber: input.targetNumber,
          proof: input.proof,
          proofDigest: input.proofDigest,
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          observedAt: input.evidence.entity.observedAt,
          createdAt: input.now,
        }).run();
        tx.update(githubBulkTransferItems).set({
          state: 'transferred',
          targetNumber: input.targetNumber,
          newSourceId: input.successorSourceId,
          lastError: null,
          completedAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(githubBulkTransferItems.runId, input.runId),
          eq(githubBulkTransferItems.taskId, input.taskId),
        )).run();
        tx.update(githubBulkTransferRuns).set({
          actor: input.actor,
          transferredCount: countTransferred(input.runId),
          failedCount: 0,
          lastError: null,
          updatedAt: input.now,
        }).where(eq(githubBulkTransferRuns.id, input.runId)).run();
        tx.insert(githubBulkTransferEvents).values({
          runId: input.runId,
          taskId: input.taskId,
          eventType: 'identity_successor_reconciled',
          payload: {
            targetNumber: input.targetNumber,
            sourceStableIdDigest: input.sourceStableIdDigest,
            successorStableIdDigest: input.successorStableIdDigest,
            proofDigest: input.proofDigest,
            actor: input.actor,
          },
          createdAt: input.now,
        }).run();
      });
    },
  };

  return { transfer, bulkTransfer, repoint };
}
