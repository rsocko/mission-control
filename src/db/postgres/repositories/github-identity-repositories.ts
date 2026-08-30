import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import type {
  GitHubAuthorizeSourceWriteResult,
  GitHubAuthorizeTaskWriteResult,
  GitHubBeginWriteCycleResult,
  GitHubBlockWriteResult,
  GitHubFenceTarget,
  GitHubFenceTaskRow,
  GitHubFinalizeWriteResult,
  GitHubIdentityExceptionSnapshot,
  GitHubIdentityPersistence,
  GitHubLinkedSourceLookupRow,
  GitHubLinkedSourcePersistResult,
  GitHubRecordCycleObservationResult,
  GitHubStableLookupRow,
  GitHubWriteFencePersistence,
} from '@/db/persistence/github-identity';

type Client = Pool | PoolClient;

async function query<T>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await client.query(text, [...params]);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

class RollbackSignal<R> extends Error {
  constructor(readonly result: R) {
    super('github-identity-rollback');
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

interface IdentityTargetRow {
  role: GitHubFenceTarget['role'];
  entityId: string;
  repositoryEntityId: string | null;
  hostKey: string;
  locatorRevision: number;
  owner: string;
  repository: string;
  issueNumber: number | null;
  bindingRevision: string;
  bindingState: string;
}

interface DbTaskRow {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId: string | null;
  updatedAt: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  effort: number | null;
  dueDate: string | null;
  microStatus: string | null;
  parentId: string | null;
  isChecklistItem: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
}

interface DbSourceListRow {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
}

interface DbLeaseRow {
  id: string;
  token: string;
  connectorInstanceId: string;
  taskId: string;
  operation: string;
  taskVersion: string;
  idempotencyKey: string;
  modeRevision: number;
  writeCycleId: string | null;
  state: string;
  cycleObservedAt: string | null;
  cycleOutcome: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
  expiresAt: string;
}

interface DbWriteCycleRow {
  id: string;
  connectorInstanceId: string;
  jobId: string | null;
  modeRevision: number;
  pendingCandidateCount: number;
  observedRouteCount: number;
  appliedCount: number;
  blockedCount: number;
  failedCount: number;
  unknownCount: number;
  state: string;
  reconciliationState: string;
  startedAt: string;
  completedAt: string | null;
}

const TASK_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  source_id AS "sourceId",
  source_list_id AS "sourceListId",
  updated_at AS "updatedAt",
  title,
  description,
  status,
  priority,
  effort,
  due_date AS "dueDate",
  micro_status AS "microStatus",
  parent_id AS "parentId",
  is_checklist_item AS "isChecklistItem",
  sync_status AS "syncStatus",
  last_synced_at AS "lastSyncedAt"
`;

const LEASE_COLUMNS = `
  id,
  token,
  connector_instance_id AS "connectorInstanceId",
  task_id AS "taskId",
  operation,
  task_version AS "taskVersion",
  idempotency_key AS "idempotencyKey",
  mode_revision AS "modeRevision",
  write_cycle_id AS "writeCycleId",
  state,
  cycle_observed_at AS "cycleObservedAt",
  cycle_outcome AS "cycleOutcome",
  dispatched_at AS "dispatchedAt",
  finalized_at AS "finalizedAt",
  expires_at AS "expiresAt"
`;

const WRITE_CYCLE_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  job_id AS "jobId",
  mode_revision AS "modeRevision",
  pending_candidate_count AS "pendingCandidateCount",
  observed_route_count AS "observedRouteCount",
  applied_count AS "appliedCount",
  blocked_count AS "blockedCount",
  failed_count AS "failedCount",
  unknown_count AS "unknownCount",
  state,
  reconciliation_state AS "reconciliationState",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`;

function digestLocator(...values: Array<string | number | null>): string {
  return createHash('sha256')
    .update(values.map((value) => value ?? '').join('\u0000'))
    .digest('hex');
}

export function createPostgresGitHubIdentityRepositories(
  pool: Pool,
): { identity: GitHubIdentityPersistence; writeFence: GitHubWriteFencePersistence } {
  async function readModeRevision(client: Client, connectorInstanceId: string): Promise<number> {
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

  async function identityForBinding(
    client: Client,
    connectorId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
    role: GitHubFenceTarget['role'],
  ): Promise<IdentityTargetRow | null> {
    const { rows } = await query<Omit<IdentityTargetRow, 'role'>>(
      client,
      `
        SELECT
          entity.id AS "entityId",
          entity.host_key AS "hostKey",
          locator.repository_entity_id AS "repositoryEntityId",
          locator.locator_revision AS "locatorRevision",
          locator.owner,
          locator.repository,
          locator.issue_number AS "issueNumber",
          binding.state AS "bindingState",
          binding.verified_at AS "bindingRevision"
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        JOIN external_entity_locators AS locator
          ON locator.external_entity_id = entity.id
          AND locator.valid_to IS NULL
        WHERE binding.connector_instance_id = $1
          AND binding.binding_type = $2
          AND binding.local_id = $3
          AND binding.state IN ('shadow', 'active')
          AND binding.verified_at IS NOT NULL
          AND entity.provider = 'github'
        LIMIT 1
      `,
      [connectorId, bindingType, localId],
    );
    const row = rows[0];
    if (!row || !['shadow', 'active'].includes(row.bindingState) || !row.bindingRevision) {
      return null;
    }
    return { role, ...row };
  }

  async function repositoryForIssue(
    client: Client,
    issue: IdentityTargetRow,
    role: GitHubFenceTarget['role'],
  ): Promise<IdentityTargetRow | null> {
    if (!issue.repositoryEntityId) return null;
    const { rows } = await query<{
      entityId: string;
      hostKey: string;
      locatorRevision: number;
      owner: string;
      repository: string;
    }>(
      client,
      `
        SELECT
          entity.id AS "entityId",
          entity.host_key AS "hostKey",
          locator.locator_revision AS "locatorRevision",
          locator.owner,
          locator.repository
        FROM external_entities AS entity
        JOIN external_entity_locators AS locator
          ON locator.external_entity_id = entity.id
          AND locator.valid_to IS NULL
        WHERE entity.id = $1
          AND entity.provider = 'github'
          AND entity.entity_type = 'repository'
        LIMIT 1
      `,
      [issue.repositoryEntityId],
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          role,
          repositoryEntityId: null,
          issueNumber: null,
          bindingRevision: '',
          bindingState: issue.bindingState,
        }
      : null;
  }

  async function resolveLocalSourceListId(
    client: Client,
    connectorId: string,
    sourceListId: string,
  ): Promise<string | null> {
    const { rows } = await query<{ id: string }>(
      client,
      `
        SELECT id
        FROM source_lists
        WHERE connector_instance_id = $1
          AND (id = $2 OR lower(source_id) = lower($2))
        ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [connectorId, sourceListId],
    );
    return rows[0]?.id ?? null;
  }

  async function loadTargets(
    client: Client,
    connectorId: string,
    taskId: string,
    sourceListId: string | null,
    sourceId: string,
    operation: string,
    targetSourceListId?: string | null,
    participants?: readonly { role: 'parent_issue' | 'blocker_issue' | 'blocked_issue'; taskId: string }[],
  ): Promise<IdentityTargetRow[] | null> {
    const result: IdentityTargetRow[] = [];
    const localCreation = sourceId.startsWith('local:') || sourceId === taskId;
    const issue = localCreation
      ? null
      : await identityForBinding(client, connectorId, 'task', taskId, 'primary_issue');
    if (!localCreation && !issue) return null;
    if (issue) result.push(issue);
    const localSourceListId = sourceListId
      ? await resolveLocalSourceListId(client, connectorId, sourceListId)
      : null;
    const sourceList = localSourceListId
      ? await identityForBinding(client, connectorId, 'source_list', localSourceListId, 'source_repository')
      : issue
        ? await repositoryForIssue(client, issue, 'source_repository')
        : null;
    if (!sourceList) return null;
    if (issue && sourceList.entityId !== issue.repositoryEntityId) return null;
    result.push(sourceList);
    if (targetSourceListId) {
      const localTargetSourceListId = await resolveLocalSourceListId(
        client,
        connectorId,
        targetSourceListId,
      );
      const target = localTargetSourceListId
        ? await identityForBinding(
            client,
            connectorId,
            'source_list',
            localTargetSourceListId,
            'target_repository',
          )
        : null;
      if (!target) return null;
      result.push(target);
    }
    for (const participant of participants ?? []) {
      const identity = await identityForBinding(
        client,
        connectorId,
        'task',
        participant.taskId,
        participant.role,
      );
      if (!identity) return null;
      result.push(identity);
    }
    if (operation === 'create' && !result.some((target) => target.role === 'source_repository')) {
      return null;
    }
    return result;
  }
  async function hasOpenStableIdentityCollision(
    client: Client,
    connectorInstanceId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
  ): Promise<boolean> {
    const { rows } = await query<{ value: number }>(
      client,
      `
        SELECT 1 AS value
        FROM github_identity_collisions AS collision
        WHERE collision.connector_instance_id = $1
          AND collision.binding_type = $2
          AND collision.state = 'open'
          AND (
            jsonb_typeof(collision.local_ids) IS DISTINCT FROM 'array'
            OR collision.local_ids @> jsonb_build_array($3::text)
          )
        LIMIT 1
      `,
      [connectorInstanceId, bindingType, localId],
    );
    return rows.length > 0;
  }

  async function currentLeaseTargetsMatch(
    client: Client,
    leaseId: string,
    requireTargets = false,
  ): Promise<boolean> {
    if (requireTargets) {
      const { rows } = await query<{ value: number }>(
        client,
        `
          SELECT 1 AS value
          FROM task_source_write_lease_targets
          WHERE lease_id = $1
          LIMIT 1
        `,
        [leaseId],
      );
      if (rows.length === 0) return false;
    }
    const { rows } = await query<{ value: number }>(
      client,
      `
        SELECT COUNT(*)::int AS value
        FROM task_source_write_lease_targets AS target
        LEFT JOIN external_entity_locators AS locator
          ON locator.external_entity_id = target.external_entity_id
          AND locator.valid_to IS NULL
        LEFT JOIN task_source_write_leases AS lease ON lease.id = target.lease_id
        LEFT JOIN external_entity_bindings AS binding
          ON binding.connector_instance_id = lease.connector_instance_id
          AND binding.external_entity_id = target.external_entity_id
          AND binding.state IN ('shadow', 'active')
        WHERE target.lease_id = $1
          AND (
            target.external_entity_id IS NULL
            OR locator.id IS NULL
            OR (
              COALESCE(target.binding_revision, '') <> ''
              AND (binding.id IS NULL OR binding.verified_at IS DISTINCT FROM target.binding_revision)
            )
            OR locator.locator_revision IS DISTINCT FROM target.locator_revision
            OR lower(locator.owner) <> lower(target.owner)
            OR lower(locator.repository) <> lower(target.repository)
            OR COALESCE(locator.issue_number, -1) <> COALESCE(target.issue_number, -1)
          )
      `,
      [leaseId],
    );
    return (rows[0]?.value ?? 0) === 0;
  }

  async function incrementCycleOutcome(
    client: Client,
    cycleId: string,
    outcome: 'succeeded' | 'failed' | 'blocked' | 'unknown',
  ): Promise<number> {
    const column = {
      succeeded: 'applied_count',
      failed: 'failed_count',
      blocked: 'blocked_count',
      unknown: 'unknown_count',
    }[outcome];
    const { rowCount } = await query(
      client,
      `
        UPDATE github_identity_write_cycles
        SET ${column} = ${column} + 1
        WHERE id = $1
          AND state = 'running'
          AND reconciliation_state = 'unresolved'
      `,
      [cycleId],
    );
    return rowCount;
  }

  function projectTaskRow(task: DbTaskRow): GitHubFenceTaskRow {
    return {
      id: task.id,
      sourceId: task.sourceId,
      sourceListId: task.sourceListId,
      updatedAt: task.updatedAt,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      effort: task.effort,
      dueDate: task.dueDate,
      microStatus: task.microStatus,
      parentId: task.parentId,
      isChecklistItem: task.isChecklistItem,
    };
  }

  function projectTargets(targets: readonly IdentityTargetRow[]): GitHubFenceTarget[] {
    return targets.map((target) => ({
      role: target.role,
      entityId: target.entityId,
      repositoryEntityId: target.repositoryEntityId,
      hostKey: target.hostKey,
      locatorRevision: target.locatorRevision,
      owner: target.owner,
      repository: target.repository,
      issueNumber: target.issueNumber,
      bindingRevision: target.bindingRevision,
      bindingState: target.bindingState,
    }));
  }

  const identity: GitHubIdentityPersistence = {
    async getModeSnapshot(connectorInstanceId, capturedAt = new Date().toISOString()) {
      const modeRevision = await readModeRevision(pool, connectorInstanceId);
      return Object.freeze({
        connectorInstanceId,
        effectiveMode: GITHUB_IDENTITY_MODE,
        modeRevision,
        capturedAt,
      });
    },

    async ensureControls({ connectorInstanceId, now }) {
      await query(
        pool,
        `
          INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
          VALUES ($1, 1, $2)
          ON CONFLICT (connector_instance_id) DO NOTHING
        `,
        [connectorInstanceId, now],
      );
    },

    async lookupStableIdentityBatch({ connectorInstanceId, namespace, rows }) {
      if (rows.length === 0) return [];
      const candidateKeys = rows.map((row) => row.candidateKey);
      const stableIds = rows.map((row) => row.stableId);
      const ownerKeys = rows.map((row) => row.ownerKey);
      const repositoryKeys = rows.map((row) => row.repositoryKey);
      const issueNumbers = rows.map((row) => row.issueNumber);
      const result = await query<GitHubStableLookupRow>(
        pool,
        `
          WITH incoming(candidate_key, stable_id, owner_key, repository_key, issue_number) AS (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
          )
          SELECT
            incoming.candidate_key AS "candidateKey",
            entity.id AS "externalEntityId",
            binding.local_id AS "bindingLocalId",
            CASE
              WHEN binding.binding_type = 'task' AND local_task.id IS NOT NULL
                THEN binding.local_id
              WHEN binding.binding_type = 'source_list' AND local_source_list.id IS NOT NULL
                THEN binding.local_id
              ELSE NULL
            END AS "localId",
            binding.state AS "bindingState",
            binding.verified_at AS "bindingRevision",
            current_locator.locator_revision AS "locatorRevision",
            current_locator.owner_key AS "currentOwnerKey",
            current_locator.repository_key AS "currentRepositoryKey",
            current_locator.issue_number AS "currentIssueNumber",
            path_locator.external_entity_id AS "pathEntityId"
          FROM incoming
          LEFT JOIN external_entities AS entity
            ON entity.provider = $6
            AND entity.host_key = $7
            AND entity.entity_type = $8
            AND entity.stable_id = incoming.stable_id
          LEFT JOIN external_entity_bindings AS binding
            ON binding.external_entity_id = entity.id
            AND binding.connector_instance_id = $9
            AND binding.binding_type = $10
            AND binding.state != 'retired'
          LEFT JOIN tasks AS local_task
            ON binding.binding_type = 'task'
            AND local_task.id = binding.local_id
            AND local_task.connector_instance_id = binding.connector_instance_id
          LEFT JOIN source_lists AS local_source_list
            ON binding.binding_type = 'source_list'
            AND local_source_list.id = binding.local_id
            AND local_source_list.connector_instance_id = binding.connector_instance_id
          LEFT JOIN external_entity_locators AS current_locator
            ON current_locator.external_entity_id = entity.id
            AND current_locator.valid_to IS NULL
          LEFT JOIN external_entity_locators AS path_locator
            ON path_locator.provider = $11
            AND path_locator.host_key = $12
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.valid_to IS NULL
            AND (
              path_locator.issue_number = incoming.issue_number
              OR (path_locator.issue_number IS NULL AND incoming.issue_number IS NULL)
            )
          ORDER BY incoming.candidate_key, binding.local_id NULLS FIRST
        `,
        [
          candidateKeys,
          stableIds,
          ownerKeys,
          repositoryKeys,
          issueNumbers,
          namespace.provider,
          namespace.hostKey,
          namespace.entityType,
          connectorInstanceId,
          namespace.bindingType,
          namespace.provider,
          namespace.hostKey,
        ],
      );
      return result.rows;
    },

    async lookupLinkedSourceIdentityBatch({ connectorInstanceId, hostKey, rows }) {
      if (rows.length === 0) return [];
      const candidateKeys = rows.map((row) => row.candidateKey);
      const linkedSourceIds = rows.map((row) => row.linkedSourceId);
      const stableIds = rows.map((row) => row.stableId);
      const ownerKeys = rows.map((row) => row.ownerKey);
      const repositoryKeys = rows.map((row) => row.repositoryKey);
      const issueNumbers = rows.map((row) => row.issueNumber);
      const result = await query<GitHubLinkedSourceLookupRow>(
        pool,
        `
          WITH incoming(
            candidate_key, linked_source_id, stable_id, owner_key, repository_key, issue_number
          ) AS (
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[])
          )
          SELECT
            incoming.candidate_key AS "candidateKey",
            legacy_link.task_id AS "linkedTaskId",
            linked_association.external_entity_id AS "linkedEntityId",
            stable_entity.id AS "stableEntityId",
            stable_association.linked_source_id AS "stableLinkedSourceId",
            stable_link.task_id AS "stableTaskId",
            current_locator.locator_revision AS "locatorRevision",
            current_locator.owner_key AS "currentOwnerKey",
            current_locator.repository_key AS "currentRepositoryKey",
            current_locator.issue_number AS "currentIssueNumber",
            path_locator.external_entity_id AS "pathEntityId"
          FROM incoming
          INNER JOIN task_linked_sources AS legacy_link
            ON legacy_link.id = incoming.linked_source_id
            AND legacy_link.connector_instance_id = $7
            AND legacy_link.connector_type = 'github-issues'
          LEFT JOIN task_linked_source_entities AS linked_association
            ON linked_association.linked_source_id = legacy_link.id
            AND linked_association.connector_instance_id = $8
          LEFT JOIN external_entities AS stable_entity
            ON stable_entity.provider = $9
            AND stable_entity.host_key = $10
            AND stable_entity.entity_type = $11
            AND stable_entity.stable_id = incoming.stable_id
          LEFT JOIN task_linked_source_entities AS stable_association
            ON stable_association.connector_instance_id = $12
            AND stable_association.external_entity_id = stable_entity.id
          LEFT JOIN task_linked_sources AS stable_link
            ON stable_link.id = stable_association.linked_source_id
            AND stable_link.connector_instance_id = $13
          LEFT JOIN external_entity_locators AS current_locator
            ON current_locator.external_entity_id = stable_entity.id
            AND current_locator.valid_to IS NULL
          LEFT JOIN external_entity_locators AS path_locator
            ON path_locator.provider = $14
            AND path_locator.host_key = $15
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.issue_number = incoming.issue_number
            AND path_locator.valid_to IS NULL
          ORDER BY incoming.candidate_key
        `,
        [
          candidateKeys,
          linkedSourceIds,
          stableIds,
          ownerKeys,
          repositoryKeys,
          issueNumbers,
          connectorInstanceId,
          connectorInstanceId,
          'github',
          hostKey,
          'issue',
          connectorInstanceId,
          connectorInstanceId,
          'github',
          hostKey,
        ],
      );
      return result.rows;
    },
    async persistLinkedSourceIdentityBatch({ connectorInstanceId, modeSnapshot, writes }) {
      if (writes.length === 0) return [];
      return transaction(pool, async (client) => {
        if (modeSnapshot) {
          const current = await readModeRevision(client, modeSnapshot.connectorInstanceId);
          if (current !== modeSnapshot.modeRevision) {
            throw new Error(
              `GitHub identity revision changed from ${modeSnapshot.modeRevision} to ${current}`,
            );
          }
        }
        const linkedIds = writes.map((write) => write.linkedSourceId);
        const linkedResult = await query<{
          id: string;
          connectorInstanceId: string;
          connectorType: string;
          sourceId: string;
        }>(
          client,
          `
            SELECT
              id,
              connector_instance_id AS "connectorInstanceId",
              connector_type AS "connectorType",
              source_id AS "sourceId"
            FROM task_linked_sources
            WHERE connector_instance_id = $1
              AND connector_type = 'github-issues'
              AND id = ANY($2::text[])
          `,
          [connectorInstanceId, linkedIds],
        );
        const linkedById = new Map(linkedResult.rows.map((row) => [row.id, row]));
        const results: GitHubLinkedSourcePersistResult[] = [];

        for (const write of writes) {
          const linked = linkedById.get(write.linkedSourceId);
          if (!linked || !write.hasEvidence) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
            continue;
          }
          if (!write.identityValid) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          const entityResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM external_entities
              WHERE provider = $1
                AND host_key = $2
                AND entity_type = $3
                AND stable_id = $4
              LIMIT 1
            `,
            [write.provider, write.hostKey, write.entityType, write.stableId],
          );
          const entity = entityResult.rows[0];
          if (!entity) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
            continue;
          }
          const locatorResult = await query<{
            ownerKey: string;
            repositoryKey: string;
            issueNumber: number | null;
          }>(
            client,
            `
              SELECT
                owner_key AS "ownerKey",
                repository_key AS "repositoryKey",
                issue_number AS "issueNumber"
              FROM external_entity_locators
              WHERE external_entity_id = $1
                AND valid_to IS NULL
              LIMIT 1
            `,
            [entity.id],
          );
          const locator = locatorResult.rows[0];
          if (
            !locator
            || locator.ownerKey !== write.ownerKey
            || locator.repositoryKey !== write.repositoryKey
            || locator.issueNumber !== write.issueNumber
          ) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          const existingForLinkedResult = await query<{
            linkedSourceId: string;
            connectorInstanceId: string;
            externalEntityId: string;
          }>(
            client,
            `
              SELECT
                linked_source_id AS "linkedSourceId",
                connector_instance_id AS "connectorInstanceId",
                external_entity_id AS "externalEntityId"
              FROM task_linked_source_entities
              WHERE linked_source_id = $1
              LIMIT 1
            `,
            [linked.id],
          );
          const existingForEntityResult = await query<{ linkedSourceId: string }>(
            client,
            `
              SELECT linked_source_id AS "linkedSourceId"
              FROM task_linked_source_entities
              WHERE connector_instance_id = $1
                AND external_entity_id = $2
              LIMIT 1
            `,
            [connectorInstanceId, entity.id],
          );
          const existingForLinked = existingForLinkedResult.rows[0];
          const existingForEntity = existingForEntityResult.rows[0];
          const locatorMatchesLegacy = write.canonicalSourceId.toLowerCase() === linked.sourceId.toLowerCase();
          if (
            (existingForLinked
              && (existingForLinked.externalEntityId !== entity.id
                || existingForLinked.connectorInstanceId !== connectorInstanceId))
            || (existingForEntity && existingForEntity.linkedSourceId !== linked.id)
            || (!existingForLinked && !locatorMatchesLegacy)
          ) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          if (linked.sourceId !== write.canonicalSourceId) {
            await query(
              client,
              `UPDATE task_linked_sources SET source_id = $1 WHERE id = $2`,
              [write.canonicalSourceId, linked.id],
            );
          }
          await query(
            client,
            `
              INSERT INTO task_linked_source_entities (
                linked_source_id, connector_instance_id, external_entity_id,
                verified_at, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $4, $4)
              ON CONFLICT (linked_source_id) DO UPDATE SET
                verified_at = EXCLUDED.verified_at,
                updated_at = EXCLUDED.updated_at
            `,
            [linked.id, connectorInstanceId, entity.id, write.observedAt],
          );
          results.push({ linkedSourceId: write.linkedSourceId, state: 'associated' });
        }
        return results;
      });
    },

    async checkDecisionsCurrent({ connectorInstanceId, checks }) {
      for (const check of checks) {
        const { rows } = await query<{ value: number }>(
          pool,
          `
            SELECT 1 AS value
            FROM external_entity_bindings AS binding
            INNER JOIN external_entity_locators AS locator
              ON locator.external_entity_id = binding.external_entity_id
              AND locator.valid_to IS NULL
            WHERE binding.connector_instance_id = $1
              AND binding.binding_type = $2
              AND binding.local_id = $3
              AND binding.external_entity_id = $4
              AND binding.state = 'active'
              AND binding.verified_at = $5
              AND locator.locator_revision = $6
            LIMIT 1
          `,
          [
            connectorInstanceId,
            check.bindingType,
            check.localId,
            check.externalEntityId,
            check.bindingRevision,
            check.locatorRevision,
          ],
        );
        if (rows.length === 0) return false;
      }
      return true;
    },

    async getLatestTerminalInaccessibleException({ connectorInstanceId, bindingType, localId }) {
      const { rows } = await query<GitHubIdentityExceptionSnapshot>(
        pool,
        `
          SELECT
            id AS "eventId",
            connector_instance_id AS "connectorInstanceId",
            binding_type AS "bindingType",
            local_id AS "localId",
            category,
            action,
            proof_type AS "proofType",
            created_at AS "createdAt"
          FROM github_identity_exception_events
          WHERE connector_instance_id = $1
            AND binding_type = $2
            AND local_id = $3
            AND category = 'terminal_inaccessible'
          ORDER BY id DESC
          LIMIT 1
        `,
        [connectorInstanceId, bindingType, localId],
      );
      return rows[0] ?? null;
    },
  };

  const writeFence: GitHubWriteFencePersistence = {
    async beginWriteCycle({
      id,
      connectorInstanceId,
      jobId,
      expectedModeRevision,
      pendingCandidateCount,
      now,
    }): Promise<GitHubBeginWriteCycleResult> {
      return transaction(pool, async (client): Promise<GitHubBeginWriteCycleResult> => {
        if (await readModeRevision(client, connectorInstanceId) !== expectedModeRevision) {
          return { ok: false, code: 'stale_write_cycle_mode' };
        }
        const runningResult = await query<DbWriteCycleRow>(
          client,
          `
            SELECT ${WRITE_CYCLE_COLUMNS}
            FROM github_identity_write_cycles
            WHERE connector_instance_id = $1
              AND state = 'running'
            LIMIT 1
            FOR UPDATE
          `,
          [connectorInstanceId],
        );
        const running = runningResult.rows[0];
        if (running) {
          if (running.reconciliationState !== 'unresolved') {
            return { ok: false, code: 'write_cycle_reconciliation_owned' };
          }
          const activeOperationResult = await query<{ createdAt: string }>(
            client,
            `
              SELECT created_at AS "createdAt"
              FROM connector_operation_leases
              WHERE connector_id = $1
                AND lease_expires_at > $2
              LIMIT 1
            `,
            [connectorInstanceId, now],
          );
          const activeOperation = activeOperationResult.rows[0];
          if (activeOperation && activeOperation.createdAt <= running.startedAt) {
            return { ok: false, code: 'active_write_cycle' };
          }
          await query(
            client,
            `
              UPDATE task_source_write_leases
              SET state = 'expired', finalized_at = $1, updated_at = $1
              WHERE write_cycle_id = $2
                AND connector_instance_id = $3
                AND mode_revision = $4
                AND state IN ('claimed', 'authorized')
                AND dispatched_at IS NULL
                AND expires_at <= $1
            `,
            [now, running.id, running.connectorInstanceId, running.modeRevision],
          );
          const leasesResult = await query<DbLeaseRow>(
            client,
            `
              SELECT ${LEASE_COLUMNS}
              FROM task_source_write_leases
              WHERE write_cycle_id = $1
              FOR UPDATE
            `,
            [running.id],
          );
          const leases = leasesResult.rows;
          if (
            leases.some(
              (lease) =>
                lease.state === 'dispatched'
                || lease.state === 'unknown'
                || (['claimed', 'authorized'].includes(lease.state) && lease.expiresAt > now),
            )
          ) {
            return { ok: false, code: 'active_write_cycle' };
          }
          const locallyFinalized =
            leases.length === running.pendingCandidateCount
            && leases.every(
              (lease) =>
                ['succeeded', 'failed', 'blocked'].includes(lease.state)
                && lease.cycleOutcome === lease.state
                && lease.finalizedAt !== null,
            );
          const updateResult = locallyFinalized
            ? await query(
                client,
                `
                  UPDATE github_identity_write_cycles
                  SET observed_route_count = $1,
                      applied_count = $2,
                      blocked_count = $3,
                      failed_count = $4,
                      unknown_count = 0,
                      state = 'completed',
                      completed_at = $5
                  WHERE id = $6
                    AND state = 'running'
                    AND reconciliation_state = 'unresolved'
                `,
                [
                  leases.filter((lease) => lease.cycleObservedAt !== null).length,
                  leases.filter((lease) => lease.cycleOutcome === 'succeeded').length,
                  leases.filter((lease) => lease.cycleOutcome === 'blocked').length,
                  leases.filter((lease) => lease.cycleOutcome === 'failed').length,
                  now,
                  running.id,
                ],
              )
            : await query(
                client,
                `
                  UPDATE github_identity_write_cycles
                  SET state = 'interrupted', completed_at = $1
                  WHERE id = $2
                    AND state = 'running'
                    AND reconciliation_state = 'unresolved'
                `,
                [now, running.id],
              );
          if (updateResult.rowCount !== 1) {
            throw new RollbackSignal<GitHubBeginWriteCycleResult>({
              ok: false,
              code: 'write_cycle_replacement_lost',
            });
          }
        }        await query(
          client,
          `
            INSERT INTO github_identity_write_cycles (
              id, connector_instance_id, job_id, mode_revision,
              pending_candidate_count, started_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [id, connectorInstanceId, jobId ?? null, expectedModeRevision, pendingCandidateCount, now],
        );
        return { ok: true };
      });
    },

    async finishWriteCycle({ id, outcome, now }) {
      const result = await transaction(pool, async (client) => {
        const cycleResult = await query<DbWriteCycleRow>(
          client,
          `
            SELECT ${WRITE_CYCLE_COLUMNS}
            FROM github_identity_write_cycles
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [id],
        );
        const cycle = cycleResult.rows[0];
        if (!cycle) return { changed: 0, complete: false };
        if (await readModeRevision(client, cycle.connectorInstanceId) !== cycle.modeRevision) {
          return { changed: 0, complete: false };
        }
        const complete =
          outcome.observed === cycle.pendingCandidateCount
          && outcome.applied + outcome.blocked + outcome.failed + outcome.unknown === outcome.observed;
        const updateResult = await query(
          client,
          `
            UPDATE github_identity_write_cycles
            SET observed_route_count = $1,
                applied_count = $2,
                blocked_count = $3,
                failed_count = $4,
                unknown_count = $5,
                state = $6,
                completed_at = $7
            WHERE id = $8
              AND connector_instance_id = $9
              AND mode_revision = $10
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
          `,
          [
            outcome.observed,
            outcome.applied,
            outcome.blocked,
            outcome.failed,
            outcome.unknown,
            complete ? 'completed' : 'interrupted',
            now,
            id,
            cycle.connectorInstanceId,
            cycle.modeRevision,
          ],
        );
        return { changed: updateResult.rowCount, complete };
      });
      return { committed: result.changed === 1 && result.complete };
    },

    async recordCycleObservation({ leaseId, now }): Promise<GitHubRecordCycleObservationResult> {
      return transaction(pool, async (client): Promise<GitHubRecordCycleObservationResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND state = 'claimed'
              AND cycle_outcome IS NULL
            LIMIT 1
            FOR UPDATE
          `,
          [leaseId],
        );
        const lease = leaseResult.rows[0];
        if (!lease?.writeCycleId) {
          return { ok: false, code: 'write_cycle_missing' };
        }
        if (lease.cycleObservedAt) return { ok: true };
        if (await readModeRevision(client, lease.connectorInstanceId) !== lease.modeRevision) {
          return { ok: false, code: 'write_cycle_observation_stale_mode' };
        }
        const cycleChanged = await query(
          client,
          `
            UPDATE github_identity_write_cycles
            SET observed_route_count = observed_route_count + 1
            WHERE id = $1
              AND connector_instance_id = $2
              AND mode_revision = $3
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
          `,
          [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
        );
        if (cycleChanged.rowCount !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        const leaseChanged = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET cycle_observed_at = $1,
                updated_at = $1
            WHERE id = $2
              AND token = $3
              AND state = 'claimed'
              AND cycle_observed_at IS NULL
          `,
          [now, lease.id, lease.token],
        );
        if (leaseChanged.rowCount !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        return { ok: true };
      });
    },

    async authorizeTaskWrite(input): Promise<GitHubAuthorizeTaskWriteResult> {
      return transaction(pool, async (client): Promise<GitHubAuthorizeTaskWriteResult> => {
        const taskResult = await query<DbTaskRow>(
          client,
          `
            SELECT ${TASK_COLUMNS}
            FROM tasks
            WHERE id = $1
              AND connector_instance_id = $2
            LIMIT 1
            FOR UPDATE
          `,
          [input.taskId, input.connectorInstanceId],
        );
        const task = taskResult.rows[0];
        if (!task) return { ok: false, code: 'missing_task' };
        if (
          (input.expectedTaskVersion && task.updatedAt !== input.expectedTaskVersion)
          || (input.taskPushLeaseToken
            && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== input.taskPushLeaseToken))
        ) {
          return { ok: false, code: 'stale_task_push_claim' };
        }
        const modeRevision = await readModeRevision(client, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [input.writeCycleId, input.connectorInstanceId],
            )).rows[0]
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (await hasOpenStableIdentityCollision(client, input.connectorInstanceId, 'task', task.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const targets = await loadTargets(
          client,
          input.connectorInstanceId,
          task.id,
          task.sourceListId,
          task.sourceId,
          input.operation,
          input.targetSourceListId,
          input.participantTaskIds,
        );
        if (!targets) return { ok: false, code: 'missing_or_inaccessible_identity' };
        if (targets.some((target) => target.bindingState !== 'active')) {
          return { ok: false, code: 'stable_binding_not_active' };
        }
        const { idempotencyKey, intent, initialCreate } = input.deriveWriteIdentity(projectTaskRow(task));
        let priorSuccess = false;
        if (intent) {
          const params: unknown[] = [
            input.connectorInstanceId,
            task.id,
            input.operation,
            modeRevision,
          ];
          const identityClause = initialCreate
            ? ''
            : `
              AND idempotency_key = $${params.push(idempotencyKey)}
              AND intent_kind = $${params.push(intent.kind)}
              AND intent_digest = $${params.push(intent.digest)}
            `;
          const priorResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM task_source_write_leases
              WHERE connector_instance_id = $1
                AND task_id = $2
                AND operation = $3
                AND mode_revision = $4
                ${identityClause}
                AND state = 'succeeded'
                AND cycle_outcome = 'succeeded'
              LIMIT 10
            `,
            params,
          );
          for (const lease of priorResult.rows) {
            if (await currentLeaseTargetsMatch(client, lease.id, true)) {
              priorSuccess = true;
              break;
            }
          }
        }        if (priorSuccess) return { ok: false, code: 'write_already_succeeded' };
        const insertResult = await query(
          client,
          `
            INSERT INTO task_source_write_leases (
              id, token, connector_instance_id, task_id, operation, task_version,
              idempotency_key, mode_revision, write_cycle_id, intent_kind, intent_digest,
              expires_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
            ON CONFLICT DO NOTHING
          `,
          [
            input.leaseId,
            input.token,
            input.connectorInstanceId,
            task.id,
            input.operation,
            task.updatedAt,
            idempotencyKey,
            modeRevision,
            input.writeCycleId,
            intent?.kind ?? null,
            intent?.digest ?? null,
            input.expiresAt,
            input.now,
          ],
        );
        if (insertResult.rowCount !== 1) {
          throw new RollbackSignal<GitHubAuthorizeTaskWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        for (const target of targets) {
          await query(
            client,
            `
              INSERT INTO task_source_write_lease_targets (
                lease_id, role, external_entity_id, repository_entity_id, host_key,
                locator_revision, binding_revision, legacy_locator_digest,
                owner, repository, issue_number
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
            [
              input.leaseId,
              target.role,
              target.entityId,
              target.repositoryEntityId,
              target.hostKey,
              target.locatorRevision,
              target.bindingRevision,
              digestLocator(target.owner, target.repository, target.issueNumber),
              target.owner,
              target.repository,
              target.issueNumber,
            ],
          );
        }
        return {
          ok: true,
          task: projectTaskRow(task),
          modeRevision,
          leaseId: input.leaseId,
          targets: projectTargets(targets),
        };
      });
    },

    async authorizeSourceWrite(input): Promise<GitHubAuthorizeSourceWriteResult> {
      return transaction(pool, async (client): Promise<GitHubAuthorizeSourceWriteResult> => {
        const sourceListResult = await query<DbSourceListRow>(
          client,
          `
            SELECT
              id,
              connector_instance_id AS "connectorInstanceId",
              source_id AS "sourceId"
            FROM source_lists
            WHERE connector_instance_id = $1
              AND id = $2
            LIMIT 1
            FOR UPDATE
          `,
          [input.connectorInstanceId, input.sourceListId],
        );
        const sourceList = sourceListResult.rows[0];
        if (!sourceList) return { ok: false, code: 'missing_source_list' };
        const modeRevision = await readModeRevision(client, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [input.writeCycleId, input.connectorInstanceId],
            )).rows[0]
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (await hasOpenStableIdentityCollision(client, input.connectorInstanceId, 'source_list', sourceList.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const target = await identityForBinding(
          client,
          input.connectorInstanceId,
          'source_list',
          sourceList.id,
          'source_repository',
        );
        if (!target) return { ok: false, code: 'missing_or_inaccessible_identity' };
        if (target.bindingState !== 'active') {
          return { ok: false, code: 'stable_binding_not_active' };
        }
        const idempotencyKey = `source-list:${sourceList.id}:${input.operation}:${sourceList.sourceId}`;
        const insertResult = await query(
          client,
          `
            INSERT INTO task_source_write_leases (
              id, token, connector_instance_id, task_id, operation, task_version,
              idempotency_key, mode_revision, write_cycle_id, expires_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
            ON CONFLICT DO NOTHING
          `,
          [
            input.leaseId,
            input.token,
            input.connectorInstanceId,
            `source-list:${sourceList.id}`,
            input.operation,
            sourceList.sourceId,
            idempotencyKey,
            modeRevision,
            input.writeCycleId,
            input.expiresAt,
            input.now,
          ],
        );
        if (insertResult.rowCount !== 1) {
          throw new RollbackSignal<GitHubAuthorizeSourceWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        await query(
          client,
          `
            INSERT INTO task_source_write_lease_targets (
              lease_id, role, external_entity_id, repository_entity_id, host_key,
              locator_revision, binding_revision, legacy_locator_digest,
              owner, repository, issue_number
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
          `,
          [
            input.leaseId,
            target.role,
            target.entityId,
            target.repositoryEntityId,
            target.hostKey,
            target.locatorRevision,
            target.bindingRevision,
            digestLocator(target.owner, target.repository, null),
            target.owner,
            target.repository,
          ],
        );
        return {
          ok: true,
          sourceList: { id: sourceList.id, sourceId: sourceList.sourceId },
          target: projectTargets([target])[0],
          leaseId: input.leaseId,
          modeRevision,
        };
      });
    },

    async hasSucceededWrite(input) {
      const taskResult = await query<DbTaskRow>(
        pool,
        `
          SELECT ${TASK_COLUMNS}
          FROM tasks
          WHERE id = $1
            AND connector_instance_id = $2
            AND updated_at = $3
            AND sync_status = 'pushing'
            AND last_synced_at = $4
          LIMIT 1
        `,
        [
          input.taskId,
          input.connectorInstanceId,
          input.expectedTaskVersion,
          input.taskPushLeaseToken,
        ],
      );
      const task = taskResult.rows[0];
      if (!task) return false;
      const { idempotencyKey, intent, initialCreate } = input.deriveWriteIdentity(projectTaskRow(task));
      if (!intent) return false;
      const modeRevision = await readModeRevision(pool, input.connectorInstanceId);
      const params: unknown[] = [
        input.connectorInstanceId,
        task.id,
        input.operation,
        modeRevision,
      ];
      const identityClause = initialCreate
        ? ''
        : `
          AND idempotency_key = $${params.push(idempotencyKey)}
          AND intent_kind = $${params.push(intent.kind)}
          AND intent_digest = $${params.push(intent.digest)}
        `;
      const priorResult = await query<{ id: string }>(
        pool,
        `
          SELECT id
          FROM task_source_write_leases
          WHERE connector_instance_id = $1
            AND task_id = $2
            AND operation = $3
            AND mode_revision = $4
            ${identityClause}
            AND state = 'succeeded'
            AND cycle_outcome = 'succeeded'
          LIMIT 10
        `,
        params,
      );
      for (const lease of priorResult.rows) {
        if (await currentLeaseTargetsMatch(pool, lease.id, true)) return true;
      }
      return false;
    },

    async assertCycleCurrent({ authorization }) {
      return transaction(pool, async (client) => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state IN ('claimed', 'authorized')
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return false;
        if (authorization.expectedTaskVersion || authorization.taskPushLeaseToken) {
          const taskResult = await query<DbTaskRow>(
            client,
            `
              SELECT ${TASK_COLUMNS}
              FROM tasks
              WHERE id = $1
                AND connector_instance_id = $2
              LIMIT 1
              FOR UPDATE
            `,
            [authorization.taskId, authorization.connectorInstanceId],
          );
          const task = taskResult.rows[0];
          if (
            !task
            || (authorization.expectedTaskVersion && task.updatedAt !== authorization.expectedTaskVersion)
            || (authorization.taskPushLeaseToken
              && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== authorization.taskPushLeaseToken))
          ) {
            return false;
          }
        }
        if (!lease.writeCycleId) return false;
        if (await readModeRevision(client, authorization.connectorInstanceId) !== lease.modeRevision) {
          return false;
        }
        const cycleResult = await query<{ id: string }>(
          client,
          `
            SELECT id
            FROM github_identity_write_cycles
            WHERE id = $1
              AND connector_instance_id = $2
              AND mode_revision = $3
              AND state = 'running'
              AND reconciliation_state = 'unresolved'
            LIMIT 1
            FOR UPDATE
          `,
          [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
        );
        return cycleResult.rows.length > 0;
      });
    },
    async confirmDispatch({ authorization, now }) {
      const changes = await transaction(pool, async (client) => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state = 'claimed'
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token],
        );
        const lease = leaseResult.rows[0];
        if (!lease || lease.expiresAt <= now) return 0;
        const cycle = lease.writeCycleId
          ? (await query<DbWriteCycleRow>(
              client,
              `
                SELECT ${WRITE_CYCLE_COLUMNS}
                FROM github_identity_write_cycles
                WHERE id = $1
                  AND connector_instance_id = $2
                  AND state = 'running'
                  AND reconciliation_state = 'unresolved'
                LIMIT 1
                FOR UPDATE
              `,
              [lease.writeCycleId, authorization.connectorInstanceId],
            )).rows[0]
          : null;
        const modeRevision = await readModeRevision(client, authorization.connectorInstanceId);
        const sourceListSubject = authorization.taskId.startsWith('source-list:')
          ? (await query<DbSourceListRow>(
              client,
              `
                SELECT
                  id,
                  connector_instance_id AS "connectorInstanceId",
                  source_id AS "sourceId"
                FROM source_lists
                WHERE id = $1
                  AND connector_instance_id = $2
                LIMIT 1
                FOR UPDATE
              `,
              [authorization.taskId.slice('source-list:'.length), authorization.connectorInstanceId],
            )).rows[0]
          : null;
        const task = sourceListSubject
          ? null
          : (await query<DbTaskRow>(
              client,
              `
                SELECT ${TASK_COLUMNS}
                FROM tasks
                WHERE id = $1
                LIMIT 1
                FOR UPDATE
              `,
              [authorization.taskId],
            )).rows[0];
        if (
          (!task && !sourceListSubject)
          || (task && task.connectorInstanceId !== authorization.connectorInstanceId)
          || (task && task.updatedAt !== lease.taskVersion)
          || (task
            && authorization.taskPushLeaseToken
            && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== authorization.taskPushLeaseToken))
          || (sourceListSubject && sourceListSubject.sourceId !== lease.taskVersion)
          || modeRevision !== lease.modeRevision
          || lease.cycleObservedAt === null
          || !cycle
          || cycle.modeRevision !== lease.modeRevision
          || !await currentLeaseTargetsMatch(client, authorization.leaseId)
        ) {
          return 0;
        }
        const updateResult = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = 'dispatched',
                dispatched_at = $1,
                updated_at = $1
            WHERE id = $2
              AND token = $3
              AND state = 'claimed'
          `,
          [now, authorization.leaseId, authorization.token],
        );
        return updateResult.rowCount;
      });
      return changes === 1;
    },

    async verifyPreflight({ leaseId, observed }) {
      const { rows } = await query<{
        role: string;
        entityType: 'issue' | 'repository';
        stableId: string;
        repositoryStableId: string | null;
      }>(
        pool,
        `
          SELECT
            target.role AS role,
            entity.entity_type AS "entityType",
            entity.stable_id AS "stableId",
            repository.stable_id AS "repositoryStableId"
          FROM task_source_write_lease_targets AS target
          JOIN external_entities AS entity ON entity.id = target.external_entity_id
          LEFT JOIN external_entities AS repository ON repository.id = target.repository_entity_id
          WHERE target.lease_id = $1
        `,
        [leaseId],
      );
      if (
        rows.length === 0
        || rows.some((row) => {
          const value = observed.targets[row.role];
          return (
            !value
            || (row.entityType === 'issue'
              ? value.issueStableId !== row.stableId || value.repositoryStableId !== row.repositoryStableId
              : value.repositoryStableId !== row.stableId)
          );
        })
      ) {
        return false;
      }
      return true;
    },

    async finalizeWrite({ authorization, outcome, safeReason, resultDigest, now }): Promise<GitHubFinalizeWriteResult> {
      const allowedStates = outcome === 'failed'
        ? ['claimed', 'authorized', 'dispatched']
        : ['dispatched', 'authorized'];
      return transaction(pool, async (client): Promise<GitHubFinalizeWriteResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state = ANY($3::text[])
            LIMIT 1
            FOR UPDATE
          `,
          [authorization.leaseId, authorization.token, allowedStates],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return { status: 'not_committed' };
        if (lease.writeCycleId && (outcome !== 'failed' || lease.dispatchedAt !== null)) {
          const cycleResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM github_identity_write_cycles
              WHERE id = $1
                AND connector_instance_id = $2
                AND mode_revision = $3
                AND state = 'running'
                AND reconciliation_state = 'unresolved'
              LIMIT 1
              FOR UPDATE
            `,
            [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
          );
          if (cycleResult.rows.length === 0) return { status: 'not_committed' };
        }
        const leaseUpdate = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = $1,
                cycle_outcome = $1,
                unknown_reason = $2,
                block_reason = $3,
                result_digest = $4,
                finalized_at = $5,
                updated_at = $5
            WHERE id = $6
              AND token = $7
              AND state = ANY($8::text[])
          `,
          [
            outcome,
            outcome === 'unknown' ? safeReason ?? 'unknown_post_dispatch_outcome' : null,
            outcome === 'failed' ? safeReason : null,
            outcome === 'succeeded' ? resultDigest : null,
            now,
            authorization.leaseId,
            authorization.token,
            allowedStates,
          ],
        );
        if (leaseUpdate.rowCount === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (await incrementCycleOutcome(client, lease.writeCycleId, outcome) !== 1) {
            throw new RollbackSignal<GitHubFinalizeWriteResult>({ status: 'outcome_lost' });
          }
        }
        if (leaseUpdate.rowCount === 1 && outcome === 'succeeded') {
          await query(
            client,
            `
              UPDATE github_identity_write_cycles
              SET reconciliation_state = 'superseded',
                  reconciliation_code = 'superseded_by_succeeded_retry',
                  reconciled_at = $1
              WHERE id IN (
                SELECT prior.write_cycle_id
                FROM task_source_write_leases AS prior
                JOIN github_write_outcome_events AS event ON event.lease_id = prior.id
                WHERE prior.connector_instance_id = $2
                  AND prior.idempotency_key = $3
                  AND prior.id != $4
                  AND prior.write_cycle_id IS NOT NULL
                  AND event.outcome = 'proven_not_applied_retryable'
              )
                AND state IN ('interrupted', 'completed')
                AND reconciliation_state = 'post_dispatch_retryable'
            `,
            [now, lease.connectorInstanceId, lease.idempotencyKey, lease.id],
          );
        }
        return { status: leaseUpdate.rowCount === 1 ? 'committed' : 'not_committed' };
      });
    },

    async blockWrite({ leaseId, token, code, now }): Promise<GitHubBlockWriteResult> {
      return transaction(pool, async (client): Promise<GitHubBlockWriteResult> => {
        const leaseResult = await query<DbLeaseRow>(
          client,
          `
            SELECT ${LEASE_COLUMNS}
            FROM task_source_write_leases
            WHERE id = $1
              AND token = $2
              AND state IN ('claimed', 'authorized')
            LIMIT 1
            FOR UPDATE
          `,
          [leaseId, token],
        );
        const lease = leaseResult.rows[0];
        if (!lease) return { status: 'unchanged' };
        if (lease.writeCycleId) {
          const cycleResult = await query<{ id: string }>(
            client,
            `
              SELECT id
              FROM github_identity_write_cycles
              WHERE id = $1
                AND connector_instance_id = $2
                AND mode_revision = $3
                AND state = 'running'
                AND reconciliation_state = 'unresolved'
              LIMIT 1
              FOR UPDATE
            `,
            [lease.writeCycleId, lease.connectorInstanceId, lease.modeRevision],
          );
          if (cycleResult.rows.length === 0) return { status: 'cycle_lost' };
        }
        const updateResult = await query(
          client,
          `
            UPDATE task_source_write_leases
            SET state = 'blocked',
                cycle_outcome = 'blocked',
                block_reason = $1,
                finalized_at = $2,
                updated_at = $2
            WHERE id = $3
              AND token = $4
              AND state IN ('claimed', 'authorized')
          `,
          [code.slice(0, 100), now, leaseId, token],
        );
        if (updateResult.rowCount === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (await incrementCycleOutcome(client, lease.writeCycleId, 'blocked') !== 1) {
            throw new RollbackSignal<GitHubBlockWriteResult>({ status: 'outcome_lost' });
          }
        }
        return { status: updateResult.rowCount === 1 ? 'blocked' : 'unchanged' };
      });
    },

    async expireUndispatchedLeases(now) {
      const { rowCount } = await query(
        pool,
        `
          UPDATE task_source_write_leases AS lease
          SET state = 'expired',
              finalized_at = $1,
              updated_at = $1
          WHERE lease.state IN ('claimed', 'authorized')
            AND lease.dispatched_at IS NULL
            AND lease.expires_at <= $1
            AND (
              lease.write_cycle_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM github_identity_write_cycles AS cycle
                WHERE cycle.id = lease.write_cycle_id
                  AND cycle.connector_instance_id = lease.connector_instance_id
                  AND cycle.mode_revision = lease.mode_revision
                  AND cycle.state = 'running'
                  AND cycle.reconciliation_state = 'unresolved'
              )
            )
        `,
        [now],
      );
      return rowCount;
    },
  };

  return { identity, writeFence };
}
