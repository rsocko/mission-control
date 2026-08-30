import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  GitHubBulkTransferItemCounts,
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
} from '@/db/persistence/github-recovery';
import {
  asRecord,
  asStringArray,
  canonicalDigest,
  compareCanonical,
  readApiOrigin,
  repositoryPath,
  samePath,
  stringValue,
} from '@/db/persistence/github-recovery-values';
import {
  buildHistoricalTransferProof,
  digestHistoricalProof,
  historicalProofMatchesBindings,
  validateHistoricalAuditRequest,
} from '@/db/persistence/github-transfer-succession';
import {
  connectorSnapshot,
  evaluateLocatorPreflight,
  observeOperatorLocator,
  query,
  readConnectorRow,
  readModeRevision,
  recordCollision,
  requireTaskTransferBinding,
  transaction,
  upsertEntity,
  type RecoveryClient,
} from './github-recovery-support';

const MAX_DELETION_CANDIDATE_SAMPLES = 50;

/** `left(col, length($n)) = $n` avoids LIKE wildcard escaping on repo paths. */
const PREFIX_MATCH = (column: string, parameter: string) =>
  `left(${column}, length(${parameter})) = ${parameter}`;

interface RepointOperationDbRow {
  id: string;
  connectorInstanceId: string;
  idempotencyKey: string;
  phase: GitHubRepointOperationRecord['phase'];
  actor: string;
  hostKey: string;
  repositoryEntityId: string;
  repositoryStableId: string;
  fromOwner: string;
  fromRepository: string;
  toOwner: string;
  toRepository: string;
  connectorWasEnabled: boolean;
  backupProof: unknown;
  preflight: unknown;
  rollbackSnapshot: unknown;
  verification: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const REPOINT_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  idempotency_key AS "idempotencyKey",
  phase,
  actor,
  host_key AS "hostKey",
  repository_entity_id AS "repositoryEntityId",
  repository_stable_id AS "repositoryStableId",
  from_owner AS "fromOwner",
  from_repository AS "fromRepository",
  to_owner AS "toOwner",
  to_repository AS "toRepository",
  connector_was_enabled AS "connectorWasEnabled",
  backup_proof AS "backupProof",
  preflight,
  rollback_snapshot AS "rollbackSnapshot",
  verification,
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`;

const RUN_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  idempotency_key AS "idempotencyKey",
  phase,
  actor,
  source_repository AS "sourceRepository",
  target_repository AS "targetRepository",
  plan_hash AS "planHash",
  plan,
  connector_was_enabled AS "connectorWasEnabled",
  transferred_count AS "transferredCount",
  skipped_count AS "skippedCount",
  failed_count AS "failedCount",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`;

const ITEM_COLUMNS = `
  run_id AS "runId",
  task_id AS "taskId",
  issue_entity_id AS "issueEntityId",
  issue_stable_id AS "issueStableId",
  source_number AS "sourceNumber",
  target_number AS "targetNumber",
  state,
  before_digest AS "beforeDigest",
  new_source_id AS "newSourceId",
  last_error AS "lastError",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  updated_at AS "updatedAt"
`;

const SUCCESSION_COLUMNS = `
  id,
  run_id AS "runId",
  task_id AS "taskId",
  source_external_entity_id AS "sourceExternalEntityId",
  successor_external_entity_id AS "successorExternalEntityId",
  source_stable_id_digest AS "sourceStableIdDigest",
  successor_stable_id_digest AS "successorStableIdDigest",
  source_id AS "sourceId",
  successor_source_id AS "successorSourceId",
  target_repository_entity_id AS "targetRepositoryEntityId",
  target_number AS "targetNumber",
  proof,
  proof_digest AS "proofDigest",
  actor,
  reason,
  idempotency_key AS "idempotencyKey",
  observed_at AS "observedAt",
  created_at AS "createdAt"
`;

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * PostgreSQL adapter for the Layer 3B GitHub recovery ports.
 *
 * Every write path opens one explicit transaction, takes `FOR UPDATE` row locks
 * on the operation/run/item, connector, maintenance lock, task, binding, and
 * locator rows it fences on, and re-checks each frozen revision, phase, digest,
 * and ownership fact inside that transaction before committing. Constraint
 * conflicts are mapped to domain outcomes rather than surfaced as driver
 * errors, and there is no SQLite fallback anywhere in this file.
 */
export function createPostgresGitHubRecoveryRepositories(
  pool: Pool,
): GitHubRecoveryPersistence {
  const existingColumns = new Map<string, Promise<boolean>>();

  async function tableHasColumn(table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    let pending = existingColumns.get(key);
    if (!pending) {
      pending = query<{ exists: boolean }>(
        pool,
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = $1 AND column_name = $2
         ) AS exists`,
        [table, column],
      ).then((result) => result.rows[0]?.exists ?? false);
      existingColumns.set(key, pending);
    }
    return pending;
  }

  async function scalar(
    client: RecoveryClient,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<number> {
    const result = await query<{ value: string | number | null }>(client, text, params);
    return Number(result.rows[0]?.value ?? 0);
  }

  async function selectIssuePlanRows(
    client: RecoveryClient,
    connectorInstanceId: string,
    repository: string,
  ): Promise<GitHubRecoveryIssuePlanRow[]> {
    const prefix = `${repository}:`;
    const result = await query<GitHubRecoveryIssuePlanRow>(
      client,
      `SELECT
         task.id AS "taskId",
         task.source_id AS "sourceId",
         binding.external_entity_id AS "issueEntityId",
         entity.stable_id AS "issueStableId",
         locator.issue_number AS "issueNumber",
         locator.repository_entity_id AS "repositoryEntityId"
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
       WHERE task.connector_instance_id = $1
         AND ${PREFIX_MATCH('task.source_id', '$2')}
       ORDER BY task.id`,
      [connectorInstanceId, prefix],
    );
    return result.rows;
  }

  async function repositoryBindingRow(
    client: RecoveryClient,
    connectorInstanceId: string,
    repository: string,
    requireRepositoryLocator: boolean,
  ) {
    const [owner, name] = repository.split('/');
    const result = await query<{
      repositoryEntityId: string;
      repositoryStableId: string;
      localId: string;
    }>(
      client,
      `SELECT
         entities.id AS "repositoryEntityId",
         entities.stable_id AS "repositoryStableId",
         bindings.local_id AS "localId"
       FROM external_entity_bindings AS bindings
       INNER JOIN external_entities AS entities
         ON entities.id = bindings.external_entity_id
       INNER JOIN external_entity_locators AS locators
         ON locators.external_entity_id = entities.id
         AND locators.valid_to IS NULL
       WHERE bindings.connector_instance_id = $1
         AND bindings.binding_type = 'source_list'
         AND bindings.state IN ('shadow', 'active')
         AND entities.provider = 'github'
         AND entities.entity_type = 'repository'
         AND locators.owner_key = $2
         AND locators.repository_key = $3
         ${requireRepositoryLocator ? 'AND locators.issue_number IS NULL' : ''}`,
      [connectorInstanceId, owner.toLowerCase(), name.toLowerCase()],
    );
    return result.rows.length === 1 ? result.rows[0] : null;
  }

  async function assertNoConnectorActivity(
    client: PoolClient,
    connectorInstanceId: string,
  ): Promise<void> {
    const blocked = await scalar(
      client,
      `SELECT
         (SELECT COUNT(*) FROM sync_jobs
          WHERE connector_id = $1 AND status IN ('queued', 'running'))
         + (SELECT COUNT(*) FROM connector_operation_leases WHERE connector_id = $1)
         AS value`,
      [connectorInstanceId],
    );
    if (blocked > 0) {
      throw new Error('Connector activity started after repoint preflight');
    }
  }

  async function appendRepointEvent(
    client: PoolClient,
    operationId: string,
    phase: GitHubRepointOperationRecord['phase'],
    actor: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    await query(
      client,
      `INSERT INTO github_repository_repoint_events (operation_id, phase, actor, payload, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [operationId, phase, actor, json(payload), now],
    );
  }

  function mapOperation(
    row: RepointOperationDbRow,
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

  async function readOperation(
    client: RecoveryClient,
    where: string,
    params: readonly unknown[],
    forUpdate = false,
  ): Promise<GitHubRepointOperationRecord | null> {
    const result = await query<RepointOperationDbRow>(
      client,
      `SELECT ${REPOINT_COLUMNS} FROM github_repository_repoints WHERE ${where} LIMIT 1${
        forUpdate ? ' FOR UPDATE' : ''
      }`,
      params,
    );
    const row = result.rows[0];
    if (!row) return null;
    const locked = await scalar(
      client,
      `SELECT COUNT(*) AS value FROM connector_maintenance_locks
       WHERE connector_instance_id = $1 AND operation_id = $2`,
      [row.connectorInstanceId, row.id],
    );
    return mapOperation(row, locked > 0);
  }

  async function requireOperationLocked(
    client: PoolClient,
    operationId: string,
  ): Promise<GitHubRepointOperationRecord> {
    const operation = await readOperation(client, 'id = $1', [operationId], true);
    if (!operation) throw new Error('GitHub repository repoint operation was not found');
    return operation;
  }

  async function requireOwnedMaintenanceLock(
    client: PoolClient,
    operation: GitHubRepointOperationRecord,
  ): Promise<void> {
    const result = await query(
      client,
      `SELECT 1 FROM connector_maintenance_locks
       WHERE connector_instance_id = $1 AND operation_id = $2 LIMIT 1 FOR UPDATE`,
      [operation.connectorInstanceId, operation.id],
    );
    if (result.rowCount === 0) {
      throw new Error('Repoint operation lost its connector maintenance lock');
    }
  }

  async function markOperationFailed(
    client: PoolClient,
    operation: GitHubRepointOperationRecord,
    error: string,
    now: string,
  ): Promise<void> {
    await query(
      client,
      `UPDATE github_repository_repoints
       SET phase = 'failed', last_error = $2, updated_at = $3 WHERE id = $1`,
      [operation.id, error, now],
    );
    await appendRepointEvent(client, operation.id, 'failed', operation.actor, { error }, now);
  }

  async function replaceConnectorConfiguration(
    client: PoolClient,
    connectorInstanceId: string,
    from: string,
    to: string,
    now: string,
  ): Promise<void> {
    const connector = await readConnectorRow(client, connectorInstanceId, true);
    if (!connector) throw new Error('Connector disappeared during repoint');
    const settings = asRecord(connector.settings);
    const repos = asStringArray(settings.repos).map((repo) => samePath(repo, from) ? to : repo);
    const syncedLists = asStringArray(connector.syncedLists)
      .map((repo) => samePath(repo, from) ? to : repo);
    await query(
      client,
      `UPDATE connector_configs
       SET settings = $2::jsonb, synced_lists = $3::jsonb, updated_at = $4 WHERE id = $1`,
      [connectorInstanceId, json({ ...settings, repos }), json(syncedLists), now],
    );
    await query(
      client,
      `UPDATE source_lists SET source_id = $3, name = $3, last_known_remote_name = $3
       WHERE connector_instance_id = $1 AND source_id = $2`,
      [connectorInstanceId, from, to],
    );
  }

  async function replaceActiveReferences(
    client: PoolClient,
    connectorInstanceId: string,
    from: string,
    to: string,
    now: string,
  ): Promise<void> {
    const fromPrefix = `${from}:`;
    const toPrefix = `${to}:`;
    await query(
      client,
      `UPDATE task_linked_sources
       SET source_id = $3 || substring(source_id FROM length($2) + 1)
       WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`,
      [connectorInstanceId, fromPrefix, toPrefix],
    );
    await query(
      client,
      `UPDATE task_ingest_suppressions
       SET source_id = $3 || substring(source_id FROM length($2) + 1),
           created_at = COALESCE(NULLIF(created_at, ''), $4)
       WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`,
      [connectorInstanceId, fromPrefix, toPrefix, now],
    );
  }

  async function restoreSourceListSnapshot(
    client: PoolClient,
    operation: GitHubRepointOperationRecord,
    from: string,
    to: string,
  ): Promise<{ repaired: boolean; snapshotMode: 'captured' | 'legacy_derived' }> {
    const snapshot = asRecord(asRecord(operation.rollbackSnapshot).sourceList);
    const snapshotId = stringValue(snapshot.id);
    const snapshotMode = snapshotId ? 'captured' : 'legacy_derived';
    const rows = (await query<{
      id: string;
      sourceId: string;
      name: string;
      lastKnownRemoteName: string | null;
    }>(
      client,
      `SELECT id, source_id AS "sourceId", name,
              last_known_remote_name AS "lastKnownRemoteName"
       FROM source_lists WHERE connector_instance_id = $1 FOR UPDATE`,
      [operation.connectorInstanceId],
    )).rows;
    const row = snapshotId
      ? rows.find((candidate) => candidate.id === snapshotId)
      : rows.find((candidate) => (
        samePath(candidate.sourceId, from) || samePath(candidate.sourceId, to)
      ));
    if (!row || (!samePath(row.sourceId, from) && !samePath(row.sourceId, to))) {
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
    await query(
      client,
      `UPDATE source_lists SET source_id = $2, name = $3, last_known_remote_name = $4
       WHERE id = $1`,
      [row.id, desiredSourceId, desiredName, desiredLastKnownRemoteName],
    );
    return { repaired: true, snapshotMode };
  }

  async function restoreHistoricalLocator(
    client: PoolClient,
    entityId: string,
    identity: { provider: string; hostKey: string; entityType: 'repository' | 'issue'; stableId: string },
    repository: string,
    repositoryEntityId: string | null,
    observedAt: string,
    issueNumber?: number,
  ): Promise<void> {
    const [owner, name] = repository.split('/');
    const history = (await query<{
      owner: string;
      repository: string;
      issueNumber: number | null;
      apiUrl: string | null;
      webUrl: string | null;
    }>(
      client,
      `SELECT owner, repository, issue_number AS "issueNumber",
              api_url AS "apiUrl", web_url AS "webUrl"
       FROM external_entity_locators WHERE external_entity_id = $1
       ORDER BY locator_revision`,
      [entityId],
    )).rows;
    const previous = [...history].reverse().find((locator) => (
      samePath(`${locator.owner}/${locator.repository}`, repository)
      && locator.issueNumber === (issueNumber ?? null)
    ));
    const observed = await observeOperatorLocator(client, {
      entityId,
      identity,
      locator: {
        owner,
        repository: name,
        ...(issueNumber ? { issueNumber } : {}),
        ...(previous?.apiUrl ? { apiUrl: previous.apiUrl } : {}),
        ...(previous?.webUrl ? { webUrl: previous.webUrl } : {}),
      },
      repositoryEntityId,
      observedAt,
    });
    if (observed.state === 'collision') {
      throw new Error('Rollback locator conflicts with another stable entity');
    }
  }

  async function countTransferred(
    client: RecoveryClient,
    runId: string,
  ): Promise<number> {
    return scalar(
      client,
      `SELECT COUNT(*) AS value FROM github_bulk_transfer_items
       WHERE run_id = $1 AND state = 'transferred'`,
      [runId],
    );
  }

  function mapRun(row: GitHubBulkTransferRunRecord & { plan: unknown }): GitHubBulkTransferRunRecord {
    return { ...row, plan: asRecord(row.plan) };
  }

  function mapSuccession(
    row: GitHubBulkTransferSuccessionRecord & { proof: unknown },
  ): GitHubBulkTransferSuccessionRecord {
    return { ...row, proof: asRecord(row.proof) };
  }

  const transfer: GitHubTransferPersistence = {
    async getConnector(connectorInstanceId) {
      const row = await readConnectorRow(pool, connectorInstanceId);
      if (!row || row.deletedAt) return null;
      return connectorSnapshot(row);
    },

    async getConnectorCredentials(connectorInstanceId) {
      const row = await readConnectorRow(pool, connectorInstanceId);
      if (!row || row.deletedAt) return null;
      const credentials = asRecord(row.credentials);
      const settings = asRecord(row.settings);
      const token = stringValue(credentials.token)
        || stringValue(credentials.pat)
        || stringValue(settings.token);
      if (!token) return null;
      return { token, apiOrigin: readApiOrigin(settings) };
    },

    async disableConnector(connectorInstanceId, now) {
      await query(
        pool,
        'UPDATE connector_configs SET enabled = false, updated_at = $2 WHERE id = $1',
        [connectorInstanceId, now],
      );
    },

    async getIdentityModeSnapshot(connectorInstanceId) {
      return {
        connectorInstanceId,
        modeRevision: await readModeRevision(pool, connectorInstanceId),
      };
    },

    async getRepositoryBinding(connectorInstanceId, repository) {
      return repositoryBindingRow(pool, connectorInstanceId, repository, false);
    },

    async getRepositoryStableId(entityId) {
      const result = await query<{ stableId: string }>(
        pool,
        `SELECT stable_id AS "stableId" FROM external_entities
         WHERE id = $1 AND provider = 'github' AND entity_type = 'repository'`,
        [entityId],
      );
      return result.rows[0]?.stableId ?? null;
    },

    async listIssuePlanRows(connectorInstanceId, repository) {
      return selectIssuePlanRows(pool, connectorInstanceId, repository);
    },

    async readTaskTransferBinding(connectorInstanceId, taskId) {
      return requireTaskTransferBinding(pool, connectorInstanceId, taskId);
    },

    async applyNativeTransferRouting(input) {
      return transaction(pool, async (client) => {
        const observed = await observeOperatorLocator(client, {
          entityId: input.issueEntityId,
          identity: input.identity,
          locator: input.locator,
          repositoryEntityId: input.targetRepositoryEntityId,
          observedAt: input.observedAt,
        });
        if (observed.state === 'collision') {
          await recordCollision(client, {
            connectorInstanceId: input.connectorInstanceId,
            category: observed.collisionCategory,
            bindingType: 'task',
            localIds: [input.taskId],
            externalEntityIds: [input.issueEntityId, observed.conflictingEntityId],
            legacyIdentity: input.legacySourceId,
            observedAt: input.observedAt,
          });
          await query(
            client,
            'UPDATE connector_configs SET enabled = false, updated_at = $2 WHERE id = $1',
            [input.connectorInstanceId, input.now],
          );
          return { outcome: 'collision' as const };
        }
        const current = await query<{ metadata: unknown }>(
          client,
          'SELECT metadata FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE',
          [input.taskId],
        );
        if (current.rowCount === 0) {
          throw new Error('Native GitHub transfer task disappeared before routing update');
        }
        await query(
          client,
          `UPDATE tasks SET
             source_id = $2, source_list_id = $3, source_list_name = $3,
             metadata = $4::jsonb, updated_at = $5, sync_status = 'synced'
           WHERE id = $1`,
          [
            input.taskId,
            input.newSourceId,
            input.targetRepository,
            json(input.refreshMetadata(current.rows[0].metadata)),
            input.now,
          ],
        );
        return { outcome: 'applied' as const };
      });
    },

    async recordHistoricalTransferReconciliation(request) {
      validateHistoricalAuditRequest(request);
      return transaction(pool, async (client) => {
        const modeRevision = await readModeRevision(client, request.connectorInstanceId);
        if (modeRevision !== request.expectedRevision) {
          throw new Error(
            `GitHub identity mode revision changed: expected ${request.expectedRevision}, found ${modeRevision}`,
          );
        }
        const source = await requireTaskTransferBinding(
          client,
          request.connectorInstanceId,
          request.sourceTaskId,
        );
        const successor = await requireTaskTransferBinding(
          client,
          request.connectorInstanceId,
          request.successorTaskId,
        );
        const proof = buildHistoricalTransferProof(request, source, successor);
        const replayResult = await query<{
          id: string;
          sourceTaskId: string;
          successorTaskId: string;
          sourceExternalEntityId: string;
          successorExternalEntityId: string;
          expectedModeRevision: number;
          actor: string;
          reason: string;
          proof: unknown;
          proofKind: 'rest_historical_redirect';
        }>(
          client,
          `SELECT id, source_task_id AS "sourceTaskId", successor_task_id AS "successorTaskId",
                  source_external_entity_id AS "sourceExternalEntityId",
                  successor_external_entity_id AS "successorExternalEntityId",
                  expected_mode_revision AS "expectedModeRevision",
                  actor, reason, proof, proof_kind AS "proofKind"
           FROM github_identity_task_transfer_reconciliations
           WHERE connector_instance_id = $1 AND idempotency_key = $2
           LIMIT 1 FOR UPDATE`,
          [request.connectorInstanceId, request.idempotencyKey],
        );
        const replay = replayResult.rows[0];
        if (replay) {
          if (
            replay.sourceTaskId !== request.sourceTaskId
            || replay.successorTaskId !== request.successorTaskId
            || replay.sourceExternalEntityId !== source.externalEntityId
            || replay.successorExternalEntityId !== successor.externalEntityId
            || replay.expectedModeRevision !== request.expectedRevision
            || replay.actor !== request.actor
            || replay.reason !== request.reason
            || !historicalProofMatchesBindings(replay.proof, source, successor)
          ) {
            throw new Error('Historical transfer idempotency key belongs to another request');
          }
          return {
            changed: false,
            reconciliationId: replay.id,
            sourceTaskId: replay.sourceTaskId,
            successorTaskId: replay.successorTaskId,
            proofKind: 'rest_historical_redirect' as const,
          };
        }
        const existingSource = await query<{ id: string; successorTaskId: string }>(
          client,
          `SELECT id, successor_task_id AS "successorTaskId"
           FROM github_identity_task_transfer_reconciliations
           WHERE connector_instance_id = $1 AND source_task_id = $2 LIMIT 1`,
          [request.connectorInstanceId, request.sourceTaskId],
        );
        if (existingSource.rows[0]) {
          throw new Error(
            `Historical task is already reconciled to ${existingSource.rows[0].successorTaskId}`,
          );
        }
        const id = randomUUID();
        const inserted = await query<{ id: string }>(
          client,
          `INSERT INTO github_identity_task_transfer_reconciliations (
             id, connector_instance_id, source_task_id, successor_task_id,
             source_external_entity_id, successor_external_entity_id,
             expected_mode_revision, proof_kind, proof, proof_digest, observed_at,
             actor, reason, idempotency_key, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'rest_historical_redirect',$8::jsonb,$9,$10,$11,$12,$13,$14
           )
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            id,
            request.connectorInstanceId,
            source.taskId,
            successor.taskId,
            source.externalEntityId,
            successor.externalEntityId,
            request.expectedRevision,
            json(proof),
            digestHistoricalProof(proof),
            request.observation.evidence.entity.observedAt,
            request.actor,
            request.reason,
            request.idempotencyKey,
            request.now,
          ],
        );
        if (!inserted.rows[0]) {
          throw new Error('Failed to persist historical transfer reconciliation');
        }
        return {
          changed: true,
          reconciliationId: inserted.rows[0].id,
          sourceTaskId: source.taskId,
          successorTaskId: successor.taskId,
          proofKind: 'rest_historical_redirect' as const,
        };
      });
    },
  };

  const repoint: GitHubRepointPersistence = {
    async getRepositoryBinding(connectorInstanceId, repository) {
      return repositoryBindingRow(pool, connectorInstanceId, repository, false);
    },

    async listIssuePlanRows(connectorInstanceId, repository) {
      return selectIssuePlanRows(pool, connectorInstanceId, repository);
    },

    async collectInventory({ connectorInstanceId, from, to, ownedOperationId }) {
      const connector = await readConnectorRow(pool, connectorInstanceId);
      if (!connector) throw new Error('Active GitHub connector was not found');
      const settings = asRecord(connector.settings);
      const fromPrefix = `${from}:`;
      const toPrefix = `${to}:`;
      const affected = `
        SELECT id FROM tasks
        WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}
      `;
      const [
        sourceListCount, taskCount, linkedSources, ingestSuppressions, deletionCandidates,
        pendingPushes, failedPushes, dependencySnapshots, openIdentityCollisions,
        targetTaskConflicts, targetSourceListConflicts,
      ] = await Promise.all([
        scalar(pool, `SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = $1 AND lower(source_id) = lower($2)`, [connectorInstanceId, from]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_linked_sources
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_ingest_suppressions
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, fromPrefix]),
        scalar(pool, 'SELECT COUNT(*) AS value FROM sync_deletion_candidates WHERE connector_id = $1', [connectorInstanceId]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND sync_status = 'pending_push'`, [connectorInstanceId]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND sync_status IN ('push_error', 'push_failed', 'error')`, [connectorInstanceId]),
        scalar(pool, `SELECT COUNT(*) AS value FROM dependency_reconciliation_snapshots
          WHERE connector_instance_id = $1 AND status IN ('running', 'failed', 'partial')`, [connectorInstanceId]),
        scalar(pool, `SELECT COUNT(*) AS value FROM github_identity_collisions
          WHERE connector_instance_id = $1 AND state = 'open'`, [connectorInstanceId]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, toPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = $1 AND lower(source_id) = lower($2)`, [connectorInstanceId, to]),
      ]);
      const [
        projects, phases, schedules, tags, dependencies, history, myDay, focus, attachments,
      ] = await Promise.all([
        scalar(pool, `SELECT COUNT(*) AS value FROM task_projects WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM project_phase_items WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_schedules WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_tags WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_dependencies
          WHERE task_id IN (${affected}) OR depends_on_task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_history_events WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM my_day_items WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM focus_items WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
        scalar(pool, `SELECT COUNT(*) AS value FROM task_attachments WHERE task_id IN (${affected})`, [connectorInstanceId, fromPrefix]),
      ]);
      const [queuedSyncJobs, runningSyncJobs, operationLeases, maintenanceLocks] =
        await Promise.all([
          scalar(pool, `SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = $1 AND status = 'queued'`, [connectorInstanceId]),
          scalar(pool, `SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = $1 AND status = 'running'`, [connectorInstanceId]),
          scalar(pool, 'SELECT COUNT(*) AS value FROM connector_operation_leases WHERE connector_id = $1', [connectorInstanceId]),
          ownedOperationId
            ? scalar(pool, `SELECT COUNT(*) AS value FROM connector_maintenance_locks
                WHERE connector_instance_id = $1 AND operation_id <> $2`, [connectorInstanceId, ownedOperationId])
            : scalar(pool, 'SELECT COUNT(*) AS value FROM connector_maintenance_locks WHERE connector_instance_id = $1', [connectorInstanceId]),
        ]);
      const samples = await query<{ sourceId: string }>(
        pool,
        `SELECT source_id AS "sourceId" FROM sync_deletion_candidates
         WHERE connector_id = $1 ORDER BY source_id LIMIT ${MAX_DELETION_CANDIDATE_SAMPLES}`,
        [connectorInstanceId],
      );
      return {
        counts: {
          connectorSettings: asStringArray(settings.repos)
            .filter((repo) => samePath(repo, from)).length,
          connectorSyncedLists: asStringArray(connector.syncedLists)
            .filter((repo) => samePath(repo, from)).length,
          sourceLists: sourceListCount,
          tasks: taskCount,
          linkedSources,
          ingestSuppressions,
          deletionCandidates,
          pendingPushes,
          failedPushes,
          dependencySnapshots,
          openIdentityCollisions,
          targetTaskConflicts,
          targetSourceListConflicts,
        },
        relationships: {
          projects, phases, schedules, tags, dependencies, history, myDay, focus, attachments,
        },
        activity: { queuedSyncJobs, runningSyncJobs, operationLeases, maintenanceLocks },
        deletionCandidates: samples.rows.map((row) => row.sourceId),
      };
    },

    async preflightLocator(input) {
      return (await evaluateLocatorPreflight(pool, input)).state;
    },

    async findOperationByIdempotency(connectorInstanceId, idempotencyKey) {
      return readOperation(
        pool,
        'connector_instance_id = $1 AND idempotency_key = $2',
        [connectorInstanceId, idempotencyKey],
      );
    },

    async getOperation(operationId) {
      return readOperation(pool, 'id = $1', [operationId]);
    },

    async acquireOperation(input) {
      const [fromOwner, fromRepository] = input.from.split('/');
      const [toOwner, toRepository] = input.to.split('/');
      const operationId = randomUUID();
      await transaction(pool, async (client) => {
        const connector = await readConnectorRow(client, input.connectorInstanceId, true);
        if (!connector) throw new Error('Active GitHub connector was not found');
        await assertNoConnectorActivity(client, input.connectorInstanceId);
        const existingLock = await query(
          client,
          'SELECT 1 FROM connector_maintenance_locks WHERE connector_instance_id = $1 LIMIT 1 FOR UPDATE',
          [input.connectorInstanceId],
        );
        if (existingLock.rowCount > 0) throw new Error('Connector already has a maintenance lock');
        const snapshot = await query<{
          id: string;
          sourceId: string;
          name: string;
          lastKnownRemoteName: string | null;
        }>(
          client,
          `SELECT id, source_id AS "sourceId", name,
                  last_known_remote_name AS "lastKnownRemoteName"
           FROM source_lists WHERE connector_instance_id = $1 AND id = $2 LIMIT 1 FOR UPDATE`,
          [input.connectorInstanceId, input.sourceListId],
        );
        const sourceList = snapshot.rows[0];
        if (!sourceList) {
          throw new Error('Repository source list disappeared before repoint lock');
        }
        await query(
          client,
          `INSERT INTO github_repository_repoints (
             id, connector_instance_id, idempotency_key, phase, actor, host_key,
             repository_entity_id, repository_stable_id, from_owner, from_repository,
             to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
             rollback_snapshot, verification, last_error, created_at, updated_at, completed_at
           ) VALUES (
             $1,$2,$3,'locked',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
             $15::jsonb,NULL,NULL,$16,$16,NULL
           )`,
          [
            operationId,
            input.connectorInstanceId,
            input.idempotencyKey,
            input.actor,
            input.hostKey,
            input.repositoryEntityId,
            input.repositoryStableId,
            fromOwner,
            fromRepository,
            toOwner,
            toRepository,
            connector.enabled,
            json(input.backupProof),
            json(input.preflight),
            json({
              settings: asRecord(connector.settings),
              syncedLists: asStringArray(connector.syncedLists),
              relationships: input.relationships,
              taskIdDigest: input.taskIdDigest,
              sourceList: {
                id: sourceList.id,
                sourceId: sourceList.sourceId,
                name: sourceList.name,
                lastKnownRemoteName: sourceList.lastKnownRemoteName,
              },
            }),
            input.now,
          ],
        );
        await query(
          client,
          `INSERT INTO connector_maintenance_locks (
             connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
           ) VALUES ($1,$2,$3,'github_repository_repoint',$4,$4)`,
          [input.connectorInstanceId, operationId, input.actor, input.now],
        );
        await query(
          client,
          'UPDATE connector_configs SET enabled = false, updated_at = $2 WHERE id = $1',
          [input.connectorInstanceId, input.now],
        );
        await appendRepointEvent(client, operationId, 'locked', input.actor, {
          from: input.from,
          to: input.to,
          counts: input.counts,
          backupSha256: input.backupSha256,
        }, input.now);
      });
      const created = await readOperation(pool, 'id = $1', [operationId]);
      if (!created) throw new Error('GitHub repository repoint operation was not found');
      return created;
    },

    async applyOperation(input): Promise<GitHubRepointApplyResult> {
      return transaction(pool, async (client): Promise<GitHubRepointApplyResult> => {
        const current = await requireOperationLocked(client, input.operationId);
        await requireOwnedMaintenanceLock(client, current);
        if (current.phase !== 'locked') return { outcome: 'not-applicable' };
        await assertNoConnectorActivity(client, current.connectorInstanceId);
        await query(
          client,
          `UPDATE github_repository_repoints SET phase = 'applying', updated_at = $2 WHERE id = $1`,
          [current.id, input.now],
        );
        await appendRepointEvent(client, current.id, 'applying', current.actor, {}, input.now);

        const repositoryObservation = {
          entityId: current.repositoryEntityId,
          identity: input.repositoryIdentity,
          locator: input.repositoryLocator,
          repositoryEntityId: null,
          observedAt: input.repositoryObservedAt,
        };
        const repositoryPreflight = await evaluateLocatorPreflight(
          client,
          repositoryObservation,
          true,
        );
        if (repositoryPreflight.state === 'collision') {
          await recordCollision(client, {
            connectorInstanceId: current.connectorInstanceId,
            category: repositoryPreflight.collisionCategory,
            bindingType: 'source_list',
            localIds: [input.repositorySourceListId],
            externalEntityIds: [
              current.repositoryEntityId,
              repositoryPreflight.conflictingEntityId,
            ],
            legacyIdentity: repositoryPath(current.fromOwner, current.fromRepository),
            observedAt: input.now,
          });
          const error = 'Repository locator collision during apply';
          await markOperationFailed(client, current, error, input.now);
          return { outcome: 'collision', scope: 'repository', error };
        }

        for (const issue of input.issues) {
          const preflight = await evaluateLocatorPreflight(client, {
            entityId: issue.issueEntityId,
            identity: issue.identity,
            locator: issue.locator,
            repositoryEntityId: current.repositoryEntityId,
            observedAt: issue.observedAt,
          }, true);
          if (preflight.state === 'collision') {
            await recordCollision(client, {
              connectorInstanceId: current.connectorInstanceId,
              category: preflight.collisionCategory,
              bindingType: 'task',
              localIds: [issue.taskId],
              externalEntityIds: [issue.issueEntityId, preflight.conflictingEntityId],
              legacyIdentity: repositoryPath(current.fromOwner, current.fromRepository),
              observedAt: input.now,
            });
            const error = 'Issue locator collision during apply';
            await markOperationFailed(client, current, error, input.now);
            return { outcome: 'collision', scope: 'issue', error };
          }
        }

        await observeOperatorLocator(client, repositoryObservation);
        for (const issue of input.issues) {
          await observeOperatorLocator(client, {
            entityId: issue.issueEntityId,
            identity: issue.identity,
            locator: issue.locator,
            repositoryEntityId: current.repositoryEntityId,
            observedAt: issue.observedAt,
          });
        }

        const from = repositoryPath(current.fromOwner, current.fromRepository);
        const to = repositoryPath(current.toOwner, current.toRepository);
        await replaceConnectorConfiguration(client, current.connectorInstanceId, from, to, input.now);
        if (input.issues.length > 0) {
          await query(
            client,
            `UPDATE tasks AS task SET
               source_id = $1 || ':' || incoming.issue_number,
               source_list_id = $1,
               source_list_name = $1,
               updated_at = $2
             FROM unnest($3::text[], $4::int[]) AS incoming(task_id, issue_number)
             WHERE task.id = incoming.task_id`,
            [
              to,
              input.now,
              input.issues.map((issue) => issue.taskId),
              input.issues.map((issue) => issue.issueNumber),
            ],
          );
        }
        await replaceActiveReferences(client, current.connectorInstanceId, from, to, input.now);
        await query(
          client,
          `UPDATE github_repository_repoints
           SET phase = 'applied', last_error = NULL, updated_at = $2 WHERE id = $1`,
          [current.id, input.now],
        );
        await appendRepointEvent(client, current.id, 'applied', current.actor, {
          tasksUpdated: input.issues.length,
          sourceListsUpdated: input.sourceListsUpdated,
        }, input.now);
        return { outcome: 'applied', tasksUpdated: input.issues.length };
      });
    },

    async setOperationPhase({ operationId, phase, actor, payload, now }) {
      await transaction(pool, async (client) => {
        const operation = await requireOperationLocked(client, operationId);
        await requireOwnedMaintenanceLock(client, operation);
        await query(
          client,
          'UPDATE github_repository_repoints SET phase = $2, actor = $3, updated_at = $4 WHERE id = $1',
          [operationId, phase, actor, now],
        );
        await appendRepointEvent(client, operationId, phase, actor, payload, now);
      });
    },

    async readRoutingSnapshot({ connectorInstanceId, from, to }) {
      const connector = await readConnectorRow(pool, connectorInstanceId);
      if (!connector) throw new Error('Active GitHub connector was not found');
      const settings = asRecord(connector.settings);
      const configuredRepositories = asStringArray(settings.repos);
      const syncedLists = asStringArray(connector.syncedLists);
      const [targetSourceLists, sourceSourceLists, targetTasks, sourceTasks] = await Promise.all([
        scalar(pool, `SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = $1 AND lower(source_id) = lower($2)`, [connectorInstanceId, to]),
        scalar(pool, `SELECT COUNT(*) AS value FROM source_lists
          WHERE connector_instance_id = $1 AND lower(source_id) = lower($2)`, [connectorInstanceId, from]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, `${to}:`]),
        scalar(pool, `SELECT COUNT(*) AS value FROM tasks
          WHERE connector_instance_id = $1 AND ${PREFIX_MATCH('source_id', '$2')}`, [connectorInstanceId, `${from}:`]),
      ]);
      return {
        configuredRepositoryMatches: configuredRepositories
          .filter((repository) => samePath(repository, to)).length,
        configuredRepositorySourceMatches: configuredRepositories
          .filter((repository) => samePath(repository, from)).length,
        syncedListMatches: syncedLists.filter((repository) => samePath(repository, to)).length,
        syncedListSourceMatches: syncedLists
          .filter((repository) => samePath(repository, from)).length,
        targetSourceLists,
        sourceSourceLists,
        targetTasks,
        sourceTasks,
      };
    },

    async completeVerification({ operationId, verification, now }) {
      await transaction(pool, async (client) => {
        const current = await requireOperationLocked(client, operationId);
        await requireOwnedMaintenanceLock(client, current);
        await query(
          client,
          'UPDATE connector_configs SET enabled = $2, updated_at = $3 WHERE id = $1',
          [current.connectorInstanceId, current.connectorWasEnabled, now],
        );
        await query(
          client,
          'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = $1',
          [current.connectorInstanceId],
        );
        await query(
          client,
          `UPDATE github_repository_repoints SET
             phase = 'verified', verification = $2::jsonb, last_error = NULL,
             updated_at = $3, completed_at = $3
           WHERE id = $1`,
          [current.id, json(verification), now],
        );
        await appendRepointEvent(client, current.id, 'verified', current.actor, verification, now);
      });
    },

    async failVerification({ operationId, verification, error, now }) {
      await transaction(pool, async (client) => {
        const current = await requireOperationLocked(client, operationId);
        await requireOwnedMaintenanceLock(client, current);
        await query(
          client,
          `UPDATE github_repository_repoints SET
             phase = 'verification_failed', verification = $2::jsonb, last_error = $3,
             updated_at = $4
           WHERE id = $1`,
          [current.id, json(verification), error, now],
        );
        await appendRepointEvent(
          client,
          current.id,
          'verification_failed',
          current.actor,
          verification,
          now,
        );
      });
    },

    async rollbackOperation({ operationId, actor, from, to, now }) {
      return transaction(pool, async (client): Promise<GitHubRepointRollbackResult> => {
        const current = await requireOperationLocked(client, operationId);
        if (current.phase === 'rolled_back') {
          const connector = await readConnectorRow(client, current.connectorInstanceId, true);
          if (!connector || connector.enabled) {
            throw new Error('Rolled-back repoint repair requires a disabled connector');
          }
          const unexpectedLock = await query(
            client,
            'SELECT 1 FROM connector_maintenance_locks WHERE connector_instance_id = $1 LIMIT 1',
            [current.connectorInstanceId],
          );
          if (unexpectedLock.rowCount > 0) {
            throw new Error('Rolled-back repoint repair found an unexpected maintenance lock');
          }
          await assertNoConnectorActivity(client, current.connectorInstanceId);
          const settings = asRecord(connector.settings);
          const syncedLists = asStringArray(connector.syncedLists);
          if (
            !asStringArray(settings.repos).some((repository) => samePath(repository, from))
            || asStringArray(settings.repos).some((repository) => samePath(repository, to))
            || !syncedLists.some((repository) => samePath(repository, from))
            || syncedLists.some((repository) => samePath(repository, to))
          ) {
            throw new Error('Rolled-back repoint repair found unexpected connector routing');
          }
          const repair = await restoreSourceListSnapshot(client, current, from, to);
          if (!repair.repaired) return { outcome: 'already-rolled-back' };
          await query(
            client,
            'UPDATE github_repository_repoints SET updated_at = $2 WHERE id = $1',
            [current.id, now],
          );
          await appendRepointEvent(client, current.id, 'rolled_back', actor, {
            idempotentRepair: true,
            restoredSourceList: true,
            sourceListSnapshotMode: repair.snapshotMode,
          }, now);
          return { outcome: 'repaired', snapshotMode: repair.snapshotMode };
        }

        await requireOwnedMaintenanceLock(client, current);
        await assertNoConnectorActivity(client, current.connectorInstanceId);
        await query(
          client,
          `UPDATE github_repository_repoints
           SET phase = 'rolling_back', actor = $2, updated_at = $3 WHERE id = $1`,
          [current.id, actor, now],
        );
        await appendRepointEvent(client, current.id, 'rolling_back', actor, {}, now);

        await restoreHistoricalLocator(client, current.repositoryEntityId, {
          provider: 'github',
          hostKey: current.hostKey,
          entityType: 'repository',
          stableId: current.repositoryStableId,
        }, from, null, now);

        const issues = await selectIssuePlanRows(client, current.connectorInstanceId, to);
        for (const issue of issues) {
          if (!issue.issueEntityId || !issue.issueStableId || !issue.issueNumber) {
            throw new Error(`Task ${issue.taskId} lost its issue binding before rollback`);
          }
          await restoreHistoricalLocator(client, issue.issueEntityId, {
            provider: 'github',
            hostKey: current.hostKey,
            entityType: 'issue',
            stableId: issue.issueStableId,
          }, from, current.repositoryEntityId, now, issue.issueNumber);
          await query(
            client,
            `UPDATE tasks SET source_id = $2, source_list_id = $3, source_list_name = $3,
                    updated_at = $4
             WHERE id = $1`,
            [issue.taskId, `${from}:${issue.issueNumber}`, from, now],
          );
        }
        await replaceActiveReferences(client, current.connectorInstanceId, to, from, now);
        await restoreSourceListSnapshot(client, current, from, to);
        const snapshot = current.rollbackSnapshot;
        await query(
          client,
          `UPDATE connector_configs SET settings = $2::jsonb, synced_lists = $3::jsonb,
                  enabled = false, updated_at = $4
           WHERE id = $1`,
          [
            current.connectorInstanceId,
            json(snapshot.settings ?? {}),
            json(snapshot.syncedLists ?? []),
            now,
          ],
        );
        await query(
          client,
          'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = $1',
          [current.connectorInstanceId],
        );
        await query(
          client,
          `UPDATE github_repository_repoints SET
             phase = 'rolled_back', actor = $2, last_error = NULL,
             updated_at = $3, completed_at = $3
           WHERE id = $1`,
          [current.id, actor, now],
        );
        await appendRepointEvent(client, current.id, 'rolled_back', actor, {
          connectorRemainsDisabled: true,
          restoredPath: from,
        }, now);
        return { outcome: 'rolled-back' };
      });
    },
  };

  const bulkTransfer: GitHubBulkTransferPersistence = {
    async getRepositoryBinding(connectorInstanceId, repository) {
      const row = await repositoryBindingRow(pool, connectorInstanceId, repository, true);
      return row ? { entityId: row.repositoryEntityId, stableId: row.repositoryStableId } : null;
    },

    async countConnectorActivity({ connectorInstanceId, ignoreOwnedOperationLease }) {
      return scalar(
        pool,
        `SELECT
           (SELECT COUNT(*) FROM sync_jobs
            WHERE connector_id = $1 AND status IN ('queued', 'running'))
           + (SELECT COUNT(*) FROM connector_operation_leases
              WHERE connector_id = $1 AND $2 = 0)
           + (SELECT COUNT(*) FROM connector_maintenance_locks WHERE connector_instance_id = $1)
           AS value`,
        [connectorInstanceId, ignoreOwnedOperationLease ? 1 : 0],
      );
    },

    async countBlockingState(connectorInstanceId) {
      return scalar(
        pool,
        `SELECT
           (SELECT COUNT(*) FROM tasks
            WHERE connector_instance_id = $1
              AND sync_status IN ('pending_push', 'push_error', 'push_failed'))
           + (SELECT COUNT(*) FROM sync_deletion_candidates WHERE connector_id = $1)
           + (SELECT COUNT(*) FROM github_identity_collisions
              WHERE connector_instance_id = $1 AND state = 'open')
           + (SELECT COUNT(*) FROM github_identity_write_cycles
              WHERE connector_instance_id = $1
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
              WHERE connector_instance_id = $1 AND status <> 'completed')
           AS value`,
        [connectorInstanceId],
      );
    },

    async listAuthoritativeDeletedTaskIds(connectorInstanceId) {
      const result = await query<{ taskId: string }>(
        pool,
        `SELECT DISTINCT exception.local_id AS "taskId"
         FROM github_identity_exception_events AS exception
         INNER JOIN tasks AS task
           ON task.id = exception.local_id
           AND task.connector_instance_id = exception.connector_instance_id
           AND task.status = 'cancelled'
         WHERE exception.connector_instance_id = $1
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
           )`,
        [connectorInstanceId],
      );
      return result.rows.map((row) => row.taskId);
    },

    async listConnectorTasks(connectorInstanceId) {
      const result = await query<{ id: string; sourceId: string; status: string }>(
        pool,
        `SELECT id, source_id AS "sourceId", status FROM tasks
         WHERE connector_instance_id = $1 AND connector_type = 'github-issues'`,
        [connectorInstanceId],
      );
      return result.rows;
    },

    async taskMetadataDigest(taskId) {
      const taskResult = await query<Record<string, unknown>>(
        pool,
        `SELECT id, title, description, status, priority, due_date, effort,
                CASE WHEN jsonb_typeof(metadata) = 'object'
                     THEN metadata - 'issueNumber' - 'nodeId' - 'url'
                     ELSE metadata END AS metadata,
                local_disposition, completed_at, created_at
         FROM tasks WHERE id = $1`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new Error(`Task disappeared during bulk transfer: ${taskId}`);
      const relations: Record<string, unknown[]> = {};
      for (const table of [
        'task_projects', 'project_phase_items', 'task_tags', 'task_schedules',
        'task_field_states', 'task_linked_sources', 'task_history_events',
        'my_day_items', 'focus_items', 'task_attachments',
      ]) {
        if (!(await tableHasColumn(table, 'task_id'))) continue;
        const rows = await query<Record<string, unknown>>(
          pool,
          `SELECT * FROM ${table} WHERE task_id = $1`,
          [taskId],
        );
        relations[table] = rows.rows.sort(compareCanonical);
      }
      if (await tableHasColumn('task_dependencies', 'task_id')) {
        const rows = await query<Record<string, unknown>>(
          pool,
          'SELECT * FROM task_dependencies WHERE task_id = $1 OR depends_on_task_id = $1',
          [taskId],
        );
        relations.task_dependencies = rows.rows.sort(compareCanonical);
      }
      return canonicalDigest({ task, relations });
    },

    async connectorMetadataDigest(connectorInstanceId) {
      const connector = await query<Record<string, unknown>>(
        pool,
        `SELECT id, type, name, sync_mode, capabilities, settings, synced_lists, created_at
         FROM connector_configs WHERE id = $1`,
        [connectorInstanceId],
      );
      const lists = await query<Record<string, unknown>>(
        pool,
        'SELECT * FROM source_lists WHERE connector_instance_id = $1',
        [connectorInstanceId],
      );
      const suppressions = await query<Record<string, unknown>>(
        pool,
        'SELECT * FROM task_ingest_suppressions WHERE connector_instance_id = $1',
        [connectorInstanceId],
      );
      return canonicalDigest({
        connector: connector.rows[0] ?? null,
        sourceLists: lists.rows.sort(compareCanonical),
        suppressions: suppressions.rows.sort(compareCanonical),
      });
    },

    async findRun(connectorInstanceId, idempotencyKey) {
      const result = await query<GitHubBulkTransferRunRecord & { plan: unknown }>(
        pool,
        `SELECT ${RUN_COLUMNS} FROM github_bulk_transfer_runs
         WHERE connector_instance_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [connectorInstanceId, idempotencyKey],
      );
      return result.rows[0] ? mapRun(result.rows[0]) : null;
    },

    async getRun(runId) {
      const result = await query<GitHubBulkTransferRunRecord & { plan: unknown }>(
        pool,
        `SELECT ${RUN_COLUMNS} FROM github_bulk_transfer_runs WHERE id = $1 LIMIT 1`,
        [runId],
      );
      return result.rows[0] ? mapRun(result.rows[0]) : null;
    },

    async listItems(runId, states) {
      const result = states && states.length > 0
        ? await query<GitHubBulkTransferItemRecord>(
          pool,
          `SELECT ${ITEM_COLUMNS} FROM github_bulk_transfer_items
           WHERE run_id = $1 AND state = ANY($2::text[]) ORDER BY source_number`,
          [runId, [...states]],
        )
        : await query<GitHubBulkTransferItemRecord>(
          pool,
          `SELECT ${ITEM_COLUMNS} FROM github_bulk_transfer_items
           WHERE run_id = $1 ORDER BY source_number`,
          [runId],
        );
      return result.rows;
    },

    async getItem(runId, taskId) {
      const result = await query<GitHubBulkTransferItemRecord>(
        pool,
        `SELECT ${ITEM_COLUMNS} FROM github_bulk_transfer_items
         WHERE run_id = $1 AND task_id = $2 LIMIT 1`,
        [runId, taskId],
      );
      return result.rows[0] ?? null;
    },

    async countItems(runId): Promise<GitHubBulkTransferItemCounts> {
      const result = await query<Record<string, string | number | null>>(
        pool,
        `SELECT
           COUNT(*) AS "totalCount",
           COUNT(*) FILTER (WHERE state = 'transferred') AS "transferredCount",
           COUNT(*) FILTER (WHERE state = 'pending') AS "pendingCount",
           COUNT(*) FILTER (WHERE state = 'transferring') AS "ambiguousCount",
           COUNT(*) FILTER (WHERE state IN ('failed', 'transferring')) AS "failedCount"
         FROM github_bulk_transfer_items WHERE run_id = $1`,
        [runId],
      );
      const counts = result.rows[0] ?? {};
      return {
        totalCount: Number(counts.totalCount ?? 0),
        transferredCount: Number(counts.transferredCount ?? 0),
        pendingCount: Number(counts.pendingCount ?? 0),
        ambiguousCount: Number(counts.ambiguousCount ?? 0),
        failedCount: Number(counts.failedCount ?? 0),
      };
    },

    async listSuccessions(runId) {
      const result = await query<GitHubBulkTransferSuccessionRecord & { proof: unknown }>(
        pool,
        `SELECT ${SUCCESSION_COLUMNS} FROM github_bulk_transfer_successions WHERE run_id = $1`,
        [runId],
      );
      return result.rows.map(mapSuccession);
    },

    async getSuccession(runId, taskId) {
      const result = await query<GitHubBulkTransferSuccessionRecord & { proof: unknown }>(
        pool,
        `SELECT ${SUCCESSION_COLUMNS} FROM github_bulk_transfer_successions
         WHERE run_id = $1 AND task_id = $2 LIMIT 1`,
        [runId, taskId],
      );
      return result.rows[0] ? mapSuccession(result.rows[0]) : null;
    },

    async listAcceptedDispatchTargets(runId, taskId) {
      const result = await query<{ payload: unknown }>(
        pool,
        `SELECT payload FROM github_bulk_transfer_events
         WHERE run_id = $1 AND task_id = $2 AND event_type = 'dispatch_accepted'`,
        [runId, taskId],
      );
      return result.rows
        .map((row) => asRecord(row.payload).targetNumber)
        .filter((value): value is number => Number.isSafeInteger(value));
    },

    async createRun(input) {
      await transaction(pool, async (client) => {
        const connector = await readConnectorRow(client, input.connectorInstanceId, true);
        if (!connector || connector.type !== 'github-issues') {
          throw new Error('GitHub connector was not found');
        }
        await query(
          client,
          `INSERT INTO github_bulk_transfer_runs (
             id, connector_instance_id, idempotency_key, phase, actor,
             source_repository, target_repository, plan_hash, plan,
             connector_was_enabled, transferred_count, skipped_count, failed_count,
             last_error, created_at, updated_at, completed_at
           ) VALUES ($1,$2,$3,'running',$4,$5,$6,$7,$8::jsonb,$9,0,0,0,NULL,$10,$10,NULL)`,
          [
            input.runId,
            input.connectorInstanceId,
            input.idempotencyKey,
            input.actor,
            input.sourceRepository,
            input.targetRepository,
            input.planHash,
            json(input.plan),
            connector.enabled,
            input.now,
          ],
        );
        if (input.items.length > 0) {
          await query(
            client,
            `INSERT INTO github_bulk_transfer_items (
               run_id, task_id, issue_entity_id, issue_stable_id, source_number,
               state, before_digest, updated_at
             )
             SELECT $1, task_id, issue_entity_id, issue_stable_id, source_number,
                    'pending', before_digest, $6
             FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $7::text[])
               AS incoming(task_id, issue_entity_id, issue_stable_id, source_number, before_digest)`,
            [
              input.runId,
              input.items.map((item) => item.taskId),
              input.items.map((item) => item.issueEntityId),
              input.items.map((item) => item.issueStableId),
              input.items.map((item) => item.sourceNumber),
              input.now,
              input.items.map((item) => item.beforeDigest),
            ],
          );
        }
        await query(
          client,
          'UPDATE connector_configs SET enabled = false, updated_at = $2 WHERE id = $1',
          [input.connectorInstanceId, input.now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'started', $2::jsonb, $3)`,
          [
            input.runId,
            json({ planHash: input.planHash, totalCount: input.items.length }),
            input.now,
          ],
        );
      });
    },

    async markRunRunning(runId, now) {
      await query(
        pool,
        `UPDATE github_bulk_transfer_runs
         SET phase = 'running', last_error = NULL, updated_at = $2 WHERE id = $1`,
        [runId, now],
      );
    },

    async failRun(runId, error, now) {
      await transaction(pool, async (client) => {
        await query(
          client,
          `UPDATE github_bulk_transfer_runs SET
             phase = 'failed',
             failed_count = (
               SELECT COUNT(*) FROM github_bulk_transfer_items
               WHERE run_id = $1 AND state IN ('failed', 'transferring')
             ),
             last_error = $2,
             updated_at = $3
           WHERE id = $1`,
          [runId, error.slice(0, 1_000), now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'failed', $2::jsonb, $3)`,
          [runId, json({ error: error.slice(0, 1_000) }), now],
        );
      });
    },

    async abortRun(runId, actor, now) {
      await transaction(pool, async (client) => {
        await query(
          client,
          `UPDATE github_bulk_transfer_runs
           SET phase = 'aborted', actor = $2, completed_at = $3, updated_at = $3 WHERE id = $1`,
          [runId, actor, now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'aborted', $2::jsonb, $3)`,
          [runId, json({ actor }), now],
        );
      });
    },

    async completeRun(input) {
      await transaction(pool, async (client) => {
        await query(
          client,
          'UPDATE connector_configs SET enabled = $2, updated_at = $3 WHERE id = $1',
          [input.connectorInstanceId, input.connectorWasEnabled, input.now],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_runs SET
             phase = 'completed', transferred_count = $2, failed_count = 0,
             last_error = NULL, completed_at = $3, updated_at = $3
           WHERE id = $1`,
          [input.runId, input.transferredCount, input.now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'reconciled', $2::jsonb, $3)`,
          [
            input.runId,
            json({
              sourceCount: input.transferredCount,
              destinationBeforeCount: input.destinationBeforeCount,
              destinationAfterCount: input.destinationAfterCount,
              transferredCount: input.transferredCount,
              skippedCount: 0,
              failedCount: 0,
              reconciledCount: input.transferredCount,
              metadataDriftCount: 0,
            }),
            input.now,
          ],
        );
      });
    },

    async setItemState(input) {
      const assignments = ['state = $3', 'updated_at = $4'];
      const params: unknown[] = [input.runId, input.taskId, input.state, input.now];
      if (input.startedAt !== undefined) {
        params.push(input.startedAt);
        assignments.push(`started_at = $${params.length}`);
      }
      if (input.lastError !== undefined) {
        params.push(input.lastError);
        assignments.push(`last_error = $${params.length}`);
      }
      await query(
        pool,
        `UPDATE github_bulk_transfer_items SET ${assignments.join(', ')}
         WHERE run_id = $1 AND task_id = $2`,
        params,
      );
    },

    async completeItem(input) {
      await transaction(pool, async (client) => {
        await query(
          client,
          `UPDATE github_bulk_transfer_items SET
             state = 'transferred', target_number = $3, new_source_id = $4,
             completed_at = $5, updated_at = $5
           WHERE run_id = $1 AND task_id = $2`,
          [input.runId, input.taskId, input.targetNumber, input.newSourceId, input.now],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_runs SET transferred_count = $2, updated_at = $3
           WHERE id = $1`,
          [input.runId, await countTransferred(client, input.runId), input.now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, $2, 'verified', $3::jsonb, $4)`,
          [input.runId, input.taskId, json(input.eventPayload), input.now],
        );
      });
    },

    async appendEvent(input) {
      await query(
        pool,
        `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [input.runId, input.taskId, input.eventType, json(input.payload), input.createdAt],
      );
    },

    async reconcileItemRouting(input) {
      await transaction(pool, async (client) => {
        const observed = await observeOperatorLocator(client, {
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
        const current = await query<{ metadata: unknown }>(
          client,
          'SELECT metadata FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE',
          [input.taskId],
        );
        if (current.rowCount === 0) {
          throw new Error('Bulk transfer reconciliation task disappeared before routing update');
        }
        await query(
          client,
          `UPDATE tasks SET source_id = $2, source_list_id = $3, source_list_name = $3,
                  metadata = $4::jsonb, sync_status = 'synced', updated_at = $5
           WHERE id = $1`,
          [
            input.taskId,
            newSourceId,
            input.targetRepository,
            json(input.refreshMetadata(current.rows[0].metadata)),
            input.now,
          ],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_items SET
             state = 'transferred', target_number = $3, new_source_id = $4,
             last_error = NULL, completed_at = $5, updated_at = $5
           WHERE run_id = $1 AND task_id = $2`,
          [input.runId, input.taskId, input.targetNumber, newSourceId, input.now],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_runs SET
             actor = $2, transferred_count = $3, failed_count = 0, last_error = NULL,
             updated_at = $4
           WHERE id = $1`,
          [input.runId, input.actor, await countTransferred(client, input.runId), input.now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, $2, 'ambiguity_reconciled', $3::jsonb, $4)`,
          [
            input.runId,
            input.taskId,
            json({
              targetNumber: input.targetNumber,
              issueStableIdDigest: input.issueStableIdDigest,
              actor: input.actor,
            }),
            input.now,
          ],
        );
      });
    },

    async recordSuccession(input) {
      await transaction(pool, async (client) => {
        const itemResult = await query<{ state: string }>(
          client,
          `SELECT state FROM github_bulk_transfer_items
           WHERE run_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE`,
          [input.runId, input.taskId],
        );
        if (itemResult.rows[0]?.state !== 'transferring') {
          throw new Error('Bulk transfer successor reconciliation item state changed');
        }
        const modeRevision = await readModeRevision(client, input.connectorInstanceId);
        if (modeRevision !== input.expectedModeRevision) {
          throw new Error('Bulk transfer successor reconciliation identity mode changed');
        }
        const taskResult = await query<{ sourceId: string; metadata: unknown }>(
          client,
          `SELECT source_id AS "sourceId", metadata FROM tasks
           WHERE id = $1 AND connector_instance_id = $2 LIMIT 1 FOR UPDATE`,
          [input.taskId, input.connectorInstanceId],
        );
        const task = taskResult.rows[0];
        if (task?.sourceId.toLowerCase() !== input.sourceId.toLowerCase()) {
          throw new Error('Bulk transfer successor reconciliation task route changed');
        }
        const bindingResult = await query<{ id: string; externalEntityId: string }>(
          client,
          `SELECT id, external_entity_id AS "externalEntityId" FROM external_entity_bindings
           WHERE connector_instance_id = $1 AND binding_type = 'task' AND local_id = $2
             AND state IN ('shadow', 'active')
           LIMIT 1 FOR UPDATE`,
          [input.connectorInstanceId, input.taskId],
        );
        const binding = bindingResult.rows[0];
        if (!binding || binding.externalEntityId !== input.issueEntityId) {
          throw new Error('Bulk transfer successor reconciliation binding changed');
        }
        const successor = await upsertEntity(
          client,
          input.evidence.entity.identity,
          input.now,
        );
        if (successor.id === input.issueEntityId) {
          throw new Error('Bulk transfer successor reconciliation requires distinct identities');
        }
        const occupied = await query(
          client,
          `SELECT 1 FROM external_entity_bindings
           WHERE connector_instance_id = $1 AND external_entity_id = $2 LIMIT 1`,
          [input.connectorInstanceId, successor.id],
        );
        if (occupied.rowCount > 0) {
          throw new Error('Bulk transfer successor identity is already bound');
        }
        await query(
          client,
          `UPDATE external_entity_locators SET valid_to = $2
           WHERE external_entity_id = $1 AND valid_to IS NULL`,
          [input.issueEntityId, input.now],
        );
        const observed = await observeOperatorLocator(client, {
          entityId: successor.id,
          identity: input.evidence.entity.identity,
          locator: input.evidence.entity.locator,
          repositoryEntityId: input.targetRepositoryEntityId,
          observedAt: input.now,
        });
        if (observed.state === 'collision') {
          throw new Error('Bulk transfer successor target locator collision');
        }
        await query(
          client,
          `UPDATE external_entity_bindings SET external_entity_id = $2, verified_at = $3,
                  updated_at = $3
           WHERE id = $1`,
          [binding.id, successor.id, input.now],
        );
        await query(
          client,
          `UPDATE tasks SET source_id = $2, source_list_id = $3, source_list_name = $3,
                  metadata = $4::jsonb, sync_status = 'synced', updated_at = $5
           WHERE id = $1`,
          [
            input.taskId,
            input.successorSourceId,
            input.targetRepository,
            json(input.refreshMetadata(task.metadata)),
            input.now,
          ],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_successions (
             id, run_id, task_id, source_external_entity_id, successor_external_entity_id,
             source_stable_id_digest, successor_stable_id_digest, source_id,
             successor_source_id, target_repository_entity_id, target_number, proof,
             proof_digest, actor, reason, idempotency_key, observed_at, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18
           )`,
          [
            randomUUID(),
            input.runId,
            input.taskId,
            input.issueEntityId,
            successor.id,
            input.sourceStableIdDigest,
            input.successorStableIdDigest,
            input.sourceId,
            input.successorSourceId,
            input.targetRepositoryEntityId,
            input.targetNumber,
            json(input.proof),
            input.proofDigest,
            input.actor,
            input.reason,
            input.idempotencyKey,
            input.evidence.entity.observedAt,
            input.now,
          ],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_items SET
             state = 'transferred', target_number = $3, new_source_id = $4,
             last_error = NULL, completed_at = $5, updated_at = $5
           WHERE run_id = $1 AND task_id = $2`,
          [input.runId, input.taskId, input.targetNumber, input.successorSourceId, input.now],
        );
        await query(
          client,
          `UPDATE github_bulk_transfer_runs SET
             actor = $2, transferred_count = $3, failed_count = 0, last_error = NULL,
             updated_at = $4
           WHERE id = $1`,
          [input.runId, input.actor, await countTransferred(client, input.runId), input.now],
        );
        await query(
          client,
          `INSERT INTO github_bulk_transfer_events (run_id, task_id, event_type, payload, created_at)
           VALUES ($1, $2, 'identity_successor_reconciled', $3::jsonb, $4)`,
          [
            input.runId,
            input.taskId,
            json({
              targetNumber: input.targetNumber,
              sourceStableIdDigest: input.sourceStableIdDigest,
              successorStableIdDigest: input.successorStableIdDigest,
              proofDigest: input.proofDigest,
              actor: input.actor,
            }),
            input.now,
          ],
        );
      });
    },
  };

  return { transfer, bulkTransfer, repoint };
}
