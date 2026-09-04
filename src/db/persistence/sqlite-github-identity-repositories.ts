import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  connectorOperationLeases,
  externalEntities,
  externalEntityLocators,
  githubIdentityControls,
  githubIdentityExceptionEvents,
  githubIdentityWriteCycles,
  sourceLists,
  taskLinkedSourceEntities,
  taskLinkedSources,
  taskSourceWriteLeaseTargets,
  taskSourceWriteLeases,
  tasks,
} from '@/db/schema';
import type { ExternalEntityType } from '@/db/schema/external-identities';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import {
  assertExternalIdentityBatchWithinLimit,
  getCurrentExternalEntityLocatorInTransaction,
  getExternalEntityByKeyInTransaction,
  listExternalEntityLocatorHistoryInTransaction,
  observeOperatorExternalEntityLocatorInTransaction,
  persistExternalIdentityBatchInTransaction,
  preflightExternalEntityLocatorInTransaction,
  recordExternalIdentityCollisionInTransaction,
  upsertExternalEntityInTransaction,
} from '@/lib/external-identities/service';
import {
  assertGitHubIdentityModeSnapshotInTransaction,
  getGitHubIdentityModeSnapshotInTransaction,
} from '@/lib/external-identities/identity-mode';
import {
  buildGitHubTransferIdentityWrites,
  sourceListIdsForGitHubTransferIdentity,
  type GitHubTransferIdentityPersistence,
} from './github-transfer-identity';
import {
  reconcileSqliteTaskTransferIdentityRefreshInTransaction,
  resolveSqliteTaskTransferIdentityTargetsInTransaction,
} from './sqlite-task-transfer-identity';
import type {
  GitHubAuthorizeSourceWriteResult,
  GitHubAuthorizeTaskWriteResult,
  GitHubBeginWriteCycleResult,
  GitHubBlockWriteResult,
  GitHubFenceTarget,
  GitHubFenceTaskRow,
  GitHubFinalizeWriteResult,
  GitHubIdentityPersistence,
  GitHubIdentityRepositories,
  GitHubLinkedSourceLookupRow,
  GitHubLinkedSourcePersistResult,
  GitHubRecordCycleObservationResult,
  GitHubStableLookupRow,
  GitHubWriteFencePersistence,
} from './github-identity';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;
type SqliteTransaction = Parameters<Parameters<SqliteDrizzle['transaction']>[0]>[0];

/** Aborts a transaction while carrying the caller-visible result to return. */
class RollbackSignal<R> extends Error {
  constructor(readonly result: R) {
    super('github-identity-rollback');
    this.name = 'RollbackSignal';
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

function digestLocator(...values: Array<string | number | null>): string {
  return createHash('sha256')
    .update(values.map((value) => value ?? '').join('\u0000'))
    .digest('hex');
}

export function createSqliteGitHubIdentityRepositories(
  sqlite: SqliteDatabase,
  db: SqliteDrizzle,
): GitHubIdentityRepositories & {
  transferIdentity: GitHubTransferIdentityPersistence;
} {
  function runTx<R>(fn: (tx: SqliteTransaction) => R): R {
    try {
      return db.transaction(fn, { behavior: 'immediate' });
    } catch (error) {
      if (error instanceof RollbackSignal) return error.result as R;
      throw error;
    }
  }

  function readModeRevision(tx: SqliteDrizzle, connectorInstanceId: string): number {
    const control = tx
      .select({ modeRevision: githubIdentityControls.modeRevision })
      .from(githubIdentityControls)
      .where(eq(githubIdentityControls.connectorInstanceId, connectorInstanceId))
      .limit(1)
      .get();
    return control?.modeRevision ?? 0;
  }

  // ── Identity: write-fence local helpers (share the transaction connection) ──

  function identityForBinding(
    connectorId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
    role: GitHubFenceTarget['role'],
  ): IdentityTargetRow | null {
    const row = sqlite
      .prepare(`
        SELECT entity.id AS entityId, entity.host_key AS hostKey, locator.repository_entity_id AS repositoryEntityId,
          locator.locator_revision AS locatorRevision, locator.owner, locator.repository, locator.issue_number AS issueNumber,
          binding.state AS bindingState, binding.verified_at AS bindingRevision
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        JOIN external_entity_locators AS locator ON locator.external_entity_id = entity.id AND locator.valid_to IS NULL
        WHERE binding.connector_instance_id = ? AND binding.binding_type = ? AND binding.local_id = ?
          AND binding.state IN ('shadow', 'active') AND binding.verified_at IS NOT NULL
          AND entity.provider = 'github'
        LIMIT 1
      `)
      .get(connectorId, bindingType, localId) as
      | {
          entityId: string;
          hostKey: string;
          repositoryEntityId: string | null;
          locatorRevision: number;
          owner: string;
          repository: string;
          issueNumber: number | null;
          bindingState: string;
          bindingRevision: string;
        }
      | undefined;
    if (!row || !['shadow', 'active'].includes(row.bindingState) || !row.bindingRevision) {
      return null;
    }
    return {
      role,
      entityId: row.entityId,
      repositoryEntityId: row.repositoryEntityId,
      hostKey: row.hostKey,
      locatorRevision: row.locatorRevision,
      owner: row.owner,
      repository: row.repository,
      issueNumber: row.issueNumber,
      bindingRevision: row.bindingRevision,
      bindingState: row.bindingState,
    };
  }

  function repositoryForIssue(
    issue: IdentityTargetRow,
    role: GitHubFenceTarget['role'],
  ): IdentityTargetRow | null {
    if (!issue.repositoryEntityId) return null;
    const row = sqlite
      .prepare(`
        SELECT entity.id AS entityId, entity.host_key AS hostKey, locator.locator_revision AS locatorRevision,
          locator.owner, locator.repository
        FROM external_entities AS entity
        JOIN external_entity_locators AS locator ON locator.external_entity_id = entity.id AND locator.valid_to IS NULL
        WHERE entity.id = ? AND entity.provider = 'github' AND entity.entity_type = 'repository'
      `)
      .get(issue.repositoryEntityId) as
      | { entityId: string; hostKey: string; locatorRevision: number; owner: string; repository: string }
      | undefined;
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

  function resolveLocalSourceListId(connectorId: string, sourceListId: string): string | null {
    const row = sqlite
      .prepare(`
        SELECT id
        FROM source_lists
        WHERE connector_instance_id = ?
          AND (id = ? OR lower(source_id) = lower(?))
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `)
      .get(connectorId, sourceListId, sourceListId, sourceListId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function loadTargets(
    connectorId: string,
    taskId: string,
    sourceListId: string | null,
    sourceId: string,
    operation: string,
    targetSourceListId?: string | null,
    participants?: readonly { role: 'parent_issue' | 'blocker_issue' | 'blocked_issue'; taskId: string }[],
  ): IdentityTargetRow[] | null {
    const result: IdentityTargetRow[] = [];
    const localCreation = sourceId.startsWith('local:') || sourceId === taskId;
    const issue = localCreation ? null : identityForBinding(connectorId, 'task', taskId, 'primary_issue');
    if (!localCreation && !issue) return null;
    if (issue) result.push(issue);
    const localSourceListId = sourceListId ? resolveLocalSourceListId(connectorId, sourceListId) : null;
    const sourceList = localSourceListId
      ? identityForBinding(connectorId, 'source_list', localSourceListId, 'source_repository')
      : issue
        ? repositoryForIssue(issue, 'source_repository')
        : null;
    if (!sourceList) return null;
    if (issue && sourceList.entityId !== issue.repositoryEntityId) return null;
    result.push(sourceList);
    if (targetSourceListId) {
      const localTargetSourceListId = resolveLocalSourceListId(connectorId, targetSourceListId);
      const target = localTargetSourceListId
        ? identityForBinding(connectorId, 'source_list', localTargetSourceListId, 'target_repository')
        : null;
      if (!target) return null;
      result.push(target);
    }
    for (const participant of participants ?? []) {
      const identity = identityForBinding(connectorId, 'task', participant.taskId, participant.role);
      if (!identity) return null;
      result.push(identity);
    }
    if (operation === 'create' && !result.some((target) => target.role === 'source_repository')) {
      return null;
    }
    return result;
  }

  function hasOpenStableIdentityCollision(
    connectorInstanceId: string,
    bindingType: 'task' | 'source_list',
    localId: string,
  ): boolean {
    const row = sqlite
      .prepare(`
        SELECT 1
        FROM github_identity_collisions AS collision
        WHERE collision.connector_instance_id = ?
          AND collision.binding_type = ?
          AND collision.state = 'open'
          AND (
            json_valid(collision.local_ids) = 0
            OR EXISTS (
              SELECT 1
              FROM json_each(collision.local_ids) AS member
              WHERE member.value = ?
            )
          )
        LIMIT 1
      `)
      .get(connectorInstanceId, bindingType, localId);
    return row !== undefined;
  }

  function currentLeaseTargetsMatch(leaseId: string, requireTargets = false): boolean {
    if (
      requireTargets
      && !sqlite
        .prepare(`
          SELECT 1
          FROM task_source_write_lease_targets
          WHERE lease_id = ?
          LIMIT 1
        `)
        .get(leaseId)
    ) {
      return false;
    }
    const mismatch = sqlite
      .prepare(`
        SELECT COUNT(*) AS value
        FROM task_source_write_lease_targets AS target
        LEFT JOIN external_entity_locators AS locator
          ON locator.external_entity_id = target.external_entity_id
          AND locator.valid_to IS NULL
        LEFT JOIN task_source_write_leases AS lease ON lease.id = target.lease_id
        LEFT JOIN external_entity_bindings AS binding
          ON binding.connector_instance_id = lease.connector_instance_id
          AND binding.external_entity_id = target.external_entity_id
          AND binding.state IN ('shadow', 'active')
        WHERE target.lease_id = ?
          AND (
            target.external_entity_id IS NULL
            OR locator.id IS NULL
            OR (
              COALESCE(target.binding_revision, '') != ''
              AND (binding.id IS NULL OR binding.verified_at != target.binding_revision)
            )
            OR locator.locator_revision != target.locator_revision
            OR lower(locator.owner) != lower(target.owner)
            OR lower(locator.repository) != lower(target.repository)
            OR COALESCE(locator.issue_number, -1) != COALESCE(target.issue_number, -1)
          )
      `)
      .get(leaseId) as { value: number };
    return mismatch.value === 0;
  }

  function incrementCycleOutcome(
    cycleId: string,
    outcome: 'succeeded' | 'failed' | 'blocked' | 'unknown',
  ): number {
    const column = {
      succeeded: 'applied_count',
      failed: 'failed_count',
      blocked: 'blocked_count',
      unknown: 'unknown_count',
    }[outcome];
    return sqlite
      .prepare(`
        UPDATE github_identity_write_cycles
        SET ${column} = ${column} + 1
        WHERE id = ?
          AND state = 'running'
          AND reconciliation_state = 'unresolved'
      `)
      .run(cycleId).changes;
  }

  function projectTaskRow(task: typeof tasks.$inferSelect): GitHubFenceTaskRow {
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
      const modeRevision = readModeRevision(db, connectorInstanceId);
      return Object.freeze({
        connectorInstanceId,
        effectiveMode: GITHUB_IDENTITY_MODE,
        modeRevision,
        capturedAt,
      });
    },

    async ensureControls({ connectorInstanceId, now }) {
      db.insert(githubIdentityControls)
        .values({ connectorInstanceId, modeRevision: 1, updatedAt: now })
        .onConflictDoNothing()
        .run();
    },

    async persistExternalIdentityBatch({ connectorInstanceId, modeSnapshot, writes }) {
      if (writes.length === 0) return [];
      assertExternalIdentityBatchWithinLimit([...writes]);
      if (writes.some((write) => (
        write.target.connectorInstanceId !== connectorInstanceId
      ))) {
        throw new Error('External identity batches must contain one connector instance');
      }
      return runTx((tx) => {
        if (modeSnapshot) {
          const current = readModeRevision(tx, modeSnapshot.connectorInstanceId);
          if (current < 1) {
            throw new Error(
              `GitHub identity controls are missing for ${modeSnapshot.connectorInstanceId}`,
            );
          }
          if (
            modeSnapshot.connectorInstanceId !== connectorInstanceId
            || current !== modeSnapshot.modeRevision
          ) {
            throw new Error(
              `GitHub identity revision changed from ${modeSnapshot.modeRevision} to ${current}`,
            );
          }
        }
        return persistExternalIdentityBatchInTransaction(
          tx,
          [...writes],
          false,
          'active',
        );
      });
    },

    async lookupStableIdentityBatch({ connectorInstanceId, namespace, rows }) {
      if (rows.length === 0) return [];
      const valuesSql = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params: Array<string | number | null> = [];
      for (const row of rows) {
        params.push(row.candidateKey, row.stableId, row.ownerKey, row.repositoryKey, row.issueNumber);
      }
      params.push(
        namespace.provider,
        namespace.hostKey,
        namespace.entityType,
        connectorInstanceId,
        namespace.bindingType,
        namespace.provider,
        namespace.hostKey,
      );
      return sqlite
        .prepare(`
          WITH incoming(candidate_key, stable_id, owner_key, repository_key, issue_number) AS (
            VALUES ${valuesSql}
          )
          SELECT
            incoming.candidate_key AS candidateKey,
            entity.id AS externalEntityId,
            binding.local_id AS bindingLocalId,
            CASE
              WHEN binding.binding_type = 'task' AND local_task.id IS NOT NULL
                THEN binding.local_id
              WHEN binding.binding_type = 'source_list' AND local_source_list.id IS NOT NULL
                THEN binding.local_id
              ELSE NULL
            END AS localId,
            binding.state AS bindingState,
            binding.verified_at AS bindingRevision,
            current_locator.locator_revision AS locatorRevision,
            current_locator.owner_key AS currentOwnerKey,
            current_locator.repository_key AS currentRepositoryKey,
            current_locator.issue_number AS currentIssueNumber,
            path_locator.external_entity_id AS pathEntityId
          FROM incoming
          LEFT JOIN external_entities AS entity
            ON entity.provider = ?
            AND entity.host_key = ?
            AND entity.entity_type = ?
            AND entity.stable_id = incoming.stable_id
          LEFT JOIN external_entity_bindings AS binding
            ON binding.external_entity_id = entity.id
            AND binding.connector_instance_id = ?
            AND binding.binding_type = ?
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
            ON path_locator.provider = ?
            AND path_locator.host_key = ?
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.valid_to IS NULL
            AND (
              path_locator.issue_number = incoming.issue_number
              OR (path_locator.issue_number IS NULL AND incoming.issue_number IS NULL)
            )
          ORDER BY incoming.candidate_key COLLATE BINARY, binding.local_id COLLATE BINARY
        `)
        .all(...params) as GitHubStableLookupRow[];
    },

    async lookupLinkedSourceIdentityBatch({ connectorInstanceId, hostKey, rows }) {
      if (rows.length === 0) return [];
      const valuesSql = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const params: Array<string | number | null> = [];
      for (const row of rows) {
        params.push(
          row.candidateKey,
          row.linkedSourceId,
          row.stableId,
          row.ownerKey,
          row.repositoryKey,
          row.issueNumber,
        );
      }
      params.push(
        connectorInstanceId,
        connectorInstanceId,
        'github',
        hostKey,
        'issue',
        connectorInstanceId,
        connectorInstanceId,
      );
      params.push('github', hostKey);
      return sqlite
        .prepare(`
          WITH incoming(
            candidate_key, linked_source_id, stable_id, owner_key, repository_key, issue_number
          ) AS (
            VALUES ${valuesSql}
          )
          SELECT
            incoming.candidate_key AS candidateKey,
            legacy_link.task_id AS linkedTaskId,
            linked_association.external_entity_id AS linkedEntityId,
            stable_entity.id AS stableEntityId,
            stable_association.linked_source_id AS stableLinkedSourceId,
            stable_link.task_id AS stableTaskId,
            current_locator.locator_revision AS locatorRevision,
            current_locator.owner_key AS currentOwnerKey,
            current_locator.repository_key AS currentRepositoryKey,
            current_locator.issue_number AS currentIssueNumber,
            path_locator.external_entity_id AS pathEntityId
          FROM incoming
          INNER JOIN task_linked_sources AS legacy_link
            ON legacy_link.id = incoming.linked_source_id
            AND legacy_link.connector_instance_id = ?
            AND legacy_link.connector_type = 'github-issues'
          LEFT JOIN task_linked_source_entities AS linked_association
            ON linked_association.linked_source_id = legacy_link.id
            AND linked_association.connector_instance_id = ?
          LEFT JOIN external_entities AS stable_entity
            ON stable_entity.provider = ?
            AND stable_entity.host_key = ?
            AND stable_entity.entity_type = ?
            AND stable_entity.stable_id = incoming.stable_id
          LEFT JOIN task_linked_source_entities AS stable_association
            ON stable_association.connector_instance_id = ?
            AND stable_association.external_entity_id = stable_entity.id
          LEFT JOIN task_linked_sources AS stable_link
            ON stable_link.id = stable_association.linked_source_id
            AND stable_link.connector_instance_id = ?
          LEFT JOIN external_entity_locators AS current_locator
            ON current_locator.external_entity_id = stable_entity.id
            AND current_locator.valid_to IS NULL
          LEFT JOIN external_entity_locators AS path_locator
            ON path_locator.provider = ?
            AND path_locator.host_key = ?
            AND path_locator.owner_key = incoming.owner_key
            AND path_locator.repository_key = incoming.repository_key
            AND path_locator.issue_number = incoming.issue_number
            AND path_locator.valid_to IS NULL
          ORDER BY incoming.candidate_key COLLATE BINARY
        `)
        .all(...params) as GitHubLinkedSourceLookupRow[];
    },

    async persistLinkedSourceIdentityBatch({ connectorInstanceId, modeSnapshot, writes }) {
      if (writes.length === 0) return [];
      return runTx((tx) => {
        if (modeSnapshot) {
          const current = readModeRevision(tx, modeSnapshot.connectorInstanceId);
          if (current !== modeSnapshot.modeRevision) {
            throw new Error(
              `GitHub identity revision changed from ${modeSnapshot.modeRevision} to ${current}`,
            );
          }
        }
        const linkedRows = tx
          .select()
          .from(taskLinkedSources)
          .where(
            and(
              eq(taskLinkedSources.connectorInstanceId, connectorInstanceId),
              eq(taskLinkedSources.connectorType, 'github-issues'),
              inArray(
                taskLinkedSources.id,
                writes.map((write) => write.linkedSourceId),
              ),
            ),
          )
          .all();
        const linkedById = new Map(linkedRows.map((row) => [row.id, row]));
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
          const entity = tx
            .select({ id: externalEntities.id })
            .from(externalEntities)
            .where(
              and(
                eq(externalEntities.provider, write.provider),
                eq(externalEntities.hostKey, write.hostKey),
                eq(externalEntities.entityType, write.entityType as ExternalEntityType),
                eq(externalEntities.stableId, write.stableId),
              ),
            )
            .limit(1)
            .get();
          if (!entity) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
            continue;
          }
          const locator = tx
            .select({
              ownerKey: externalEntityLocators.ownerKey,
              repositoryKey: externalEntityLocators.repositoryKey,
              issueNumber: externalEntityLocators.issueNumber,
            })
            .from(externalEntityLocators)
            .where(
              and(
                eq(externalEntityLocators.externalEntityId, entity.id),
                isNull(externalEntityLocators.validTo),
              ),
            )
            .limit(1)
            .get();
          if (
            !locator
            || locator.ownerKey !== write.ownerKey
            || locator.repositoryKey !== write.repositoryKey
            || locator.issueNumber !== write.issueNumber
          ) {
            results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
            continue;
          }
          const existingForLinked = tx
            .select()
            .from(taskLinkedSourceEntities)
            .where(eq(taskLinkedSourceEntities.linkedSourceId, linked.id))
            .limit(1)
            .get();
          const existingForEntity = tx
            .select()
            .from(taskLinkedSourceEntities)
            .where(
              and(
                eq(taskLinkedSourceEntities.connectorInstanceId, connectorInstanceId),
                eq(taskLinkedSourceEntities.externalEntityId, entity.id),
              ),
            )
            .limit(1)
            .get();
          const locatorMatchesLegacy =
            write.canonicalSourceId.toLowerCase() === linked.sourceId.toLowerCase();
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
            tx.update(taskLinkedSources)
              .set({ sourceId: write.canonicalSourceId })
              .where(eq(taskLinkedSources.id, linked.id))
              .run();
          }
          tx.insert(taskLinkedSourceEntities)
            .values({
              linkedSourceId: linked.id,
              connectorInstanceId,
              externalEntityId: entity.id,
              verifiedAt: write.observedAt,
              createdAt: write.observedAt,
              updatedAt: write.observedAt,
            })
            .onConflictDoUpdate({
              target: taskLinkedSourceEntities.linkedSourceId,
              set: { verifiedAt: write.observedAt, updatedAt: write.observedAt },
            })
            .run();
          results.push({ linkedSourceId: write.linkedSourceId, state: 'associated' });
        }
        return results;
      });
    },

    async checkDecisionsCurrent({ connectorInstanceId, checks }) {
      for (const check of checks) {
        const current = sqlite
          .prepare(`
            SELECT 1
            FROM external_entity_bindings AS binding
            INNER JOIN external_entity_locators AS locator
              ON locator.external_entity_id = binding.external_entity_id
              AND locator.valid_to IS NULL
            WHERE binding.connector_instance_id = ?
              AND binding.binding_type = ?
              AND binding.local_id = ?
              AND binding.external_entity_id = ?
              AND binding.state = 'active'
              AND binding.verified_at = ?
              AND locator.locator_revision = ?
            LIMIT 1
          `)
          .get(
            connectorInstanceId,
            check.bindingType,
            check.localId,
            check.externalEntityId,
            check.bindingRevision,
            check.locatorRevision,
          );
        if (!current) return false;
      }
      return true;
    },

    async getLatestTerminalInaccessibleException({ connectorInstanceId, bindingType, localId }) {
      const event = db
        .select()
        .from(githubIdentityExceptionEvents)
        .where(
          and(
            eq(githubIdentityExceptionEvents.connectorInstanceId, connectorInstanceId),
            eq(githubIdentityExceptionEvents.bindingType, bindingType),
            eq(githubIdentityExceptionEvents.localId, localId),
            eq(githubIdentityExceptionEvents.category, 'terminal_inaccessible'),
          ),
        )
        .orderBy(desc(githubIdentityExceptionEvents.id))
        .limit(1)
        .get();
      if (!event) return null;
      return {
        eventId: event.id,
        connectorInstanceId: event.connectorInstanceId,
        bindingType: event.bindingType,
        localId: event.localId,
        category: 'terminal_inaccessible',
        action: event.action,
        proofType: event.proofType,
        createdAt: event.createdAt,
      };
    },

    async getExternalEntityByKey(key) {
      return getExternalEntityByKeyInTransaction(db, key);
    },

    async upsertExternalEntity(input) {
      return runTx((tx) => upsertExternalEntityInTransaction(tx, input));
    },

    async getCurrentExternalEntityLocator(externalEntityId) {
      return getCurrentExternalEntityLocatorInTransaction(db, externalEntityId);
    },

    async listExternalEntityLocatorHistory(externalEntityId) {
      return listExternalEntityLocatorHistoryInTransaction(db, externalEntityId);
    },

    async preflightExternalEntityLocator(input) {
      return preflightExternalEntityLocatorInTransaction(db, input);
    },

    async observeExternalEntityLocator(input) {
      return runTx((tx) => observeOperatorExternalEntityLocatorInTransaction(tx, input));
    },

    async recordExternalIdentityCollision(input) {
      return runTx((tx) => recordExternalIdentityCollisionInTransaction(tx, input));
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
      return runTx((tx): GitHubBeginWriteCycleResult => {
        if (readModeRevision(tx, connectorInstanceId) !== expectedModeRevision) {
          return { ok: false, code: 'stale_write_cycle_mode' };
        }
        const running = tx
          .select()
          .from(githubIdentityWriteCycles)
          .where(
            and(
              eq(githubIdentityWriteCycles.connectorInstanceId, connectorInstanceId),
              eq(githubIdentityWriteCycles.state, 'running'),
            ),
          )
          .limit(1)
          .get();
        if (running) {
          if (running.reconciliationState !== 'unresolved') {
            return { ok: false, code: 'write_cycle_reconciliation_owned' };
          }
          const activeOperation = tx
            .select({ createdAt: connectorOperationLeases.createdAt })
            .from(connectorOperationLeases)
            .where(
              and(
                eq(connectorOperationLeases.connectorId, connectorInstanceId),
                sql`${connectorOperationLeases.leaseExpiresAt} > ${now}`,
              ),
            )
            .limit(1)
            .get();
          if (activeOperation && activeOperation.createdAt <= running.startedAt) {
            return { ok: false, code: 'active_write_cycle' };
          }
          tx.update(taskSourceWriteLeases)
            .set({ state: 'expired', finalizedAt: now, updatedAt: now })
            .where(
              and(
                eq(taskSourceWriteLeases.writeCycleId, running.id),
                eq(taskSourceWriteLeases.connectorInstanceId, running.connectorInstanceId),
                eq(taskSourceWriteLeases.modeRevision, running.modeRevision),
                inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
                isNull(taskSourceWriteLeases.dispatchedAt),
                sql`${taskSourceWriteLeases.expiresAt} <= ${now}`,
              ),
            )
            .run();
          const leases = tx
            .select()
            .from(taskSourceWriteLeases)
            .where(eq(taskSourceWriteLeases.writeCycleId, running.id))
            .all();
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
          const changed = locallyFinalized
            ? tx
                .update(githubIdentityWriteCycles)
                .set({
                  observedRouteCount: leases.filter((lease) => lease.cycleObservedAt !== null).length,
                  appliedCount: leases.filter((lease) => lease.cycleOutcome === 'succeeded').length,
                  blockedCount: leases.filter((lease) => lease.cycleOutcome === 'blocked').length,
                  failedCount: leases.filter((lease) => lease.cycleOutcome === 'failed').length,
                  unknownCount: 0,
                  state: 'completed',
                  completedAt: now,
                })
                .where(
                  and(
                    eq(githubIdentityWriteCycles.id, running.id),
                    eq(githubIdentityWriteCycles.state, 'running'),
                    eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
                  ),
                )
                .run().changes
            : tx
                .update(githubIdentityWriteCycles)
                .set({ state: 'interrupted', completedAt: now })
                .where(
                  and(
                    eq(githubIdentityWriteCycles.id, running.id),
                    eq(githubIdentityWriteCycles.state, 'running'),
                    eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
                  ),
                )
                .run().changes;
          if (changed !== 1) {
            throw new RollbackSignal<GitHubBeginWriteCycleResult>({
              ok: false,
              code: 'write_cycle_replacement_lost',
            });
          }
        }
        tx.insert(githubIdentityWriteCycles)
          .values({
            id,
            connectorInstanceId,
            jobId,
            modeRevision: expectedModeRevision,
            pendingCandidateCount,
            startedAt: now,
          })
          .run();
        return { ok: true };
      });
    },

    async finishWriteCycle({ id, outcome, now }) {
      const result = runTx((tx) => {
        const cycle = tx
          .select()
          .from(githubIdentityWriteCycles)
          .where(eq(githubIdentityWriteCycles.id, id))
          .limit(1)
          .get();
        if (!cycle) return { changed: 0, complete: false };
        if (readModeRevision(tx, cycle.connectorInstanceId) !== cycle.modeRevision) {
          return { changed: 0, complete: false };
        }
        const complete =
          outcome.observed === cycle.pendingCandidateCount
          && outcome.applied + outcome.blocked + outcome.failed + outcome.unknown === outcome.observed;
        const changed = tx
          .update(githubIdentityWriteCycles)
          .set({
            observedRouteCount: outcome.observed,
            appliedCount: outcome.applied,
            blockedCount: outcome.blocked,
            failedCount: outcome.failed,
            unknownCount: outcome.unknown,
            state: complete ? 'completed' : 'interrupted',
            completedAt: now,
          })
          .where(
            and(
              eq(githubIdentityWriteCycles.id, id),
              eq(githubIdentityWriteCycles.connectorInstanceId, cycle.connectorInstanceId),
              eq(githubIdentityWriteCycles.modeRevision, cycle.modeRevision),
              eq(githubIdentityWriteCycles.state, 'running'),
              eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
            ),
          )
          .run().changes;
        return { changed, complete };
      });
      return { committed: result.changed === 1 && result.complete };
    },

    async recordCycleObservation({ leaseId, now }): Promise<GitHubRecordCycleObservationResult> {
      return runTx((tx): GitHubRecordCycleObservationResult => {
        const lease = tx
          .select()
          .from(taskSourceWriteLeases)
          .where(
            and(
              eq(taskSourceWriteLeases.id, leaseId),
              eq(taskSourceWriteLeases.state, 'claimed'),
              isNull(taskSourceWriteLeases.cycleOutcome),
            ),
          )
          .limit(1)
          .get();
        if (!lease?.writeCycleId) {
          return { ok: false, code: 'write_cycle_missing' };
        }
        if (lease.cycleObservedAt) return { ok: true };
        if (readModeRevision(tx, lease.connectorInstanceId) !== lease.modeRevision) {
          return { ok: false, code: 'write_cycle_observation_stale_mode' };
        }
        const cycleChanged = tx
          .update(githubIdentityWriteCycles)
          .set({ observedRouteCount: sql`${githubIdentityWriteCycles.observedRouteCount} + 1` })
          .where(
            and(
              eq(githubIdentityWriteCycles.id, lease.writeCycleId),
              eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
              eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
              eq(githubIdentityWriteCycles.state, 'running'),
              eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
            ),
          )
          .run().changes;
        if (cycleChanged !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        const leaseChanged = tx
          .update(taskSourceWriteLeases)
          .set({ cycleObservedAt: now, updatedAt: now })
          .where(
            and(
              eq(taskSourceWriteLeases.id, lease.id),
              eq(taskSourceWriteLeases.token, lease.token),
              eq(taskSourceWriteLeases.state, 'claimed'),
              isNull(taskSourceWriteLeases.cycleObservedAt),
            ),
          )
          .run().changes;
        if (leaseChanged !== 1) {
          throw new RollbackSignal<GitHubRecordCycleObservationResult>({
            ok: false,
            code: 'write_cycle_observation_lost',
          });
        }
        return { ok: true };
      });
    },

    async authorizeTaskWrite(input): Promise<GitHubAuthorizeTaskWriteResult> {
      return runTx((tx): GitHubAuthorizeTaskWriteResult => {
        const task = tx
          .select()
          .from(tasks)
          .where(
            and(eq(tasks.id, input.taskId), eq(tasks.connectorInstanceId, input.connectorInstanceId)),
          )
          .limit(1)
          .get();
        if (!task) return { ok: false, code: 'missing_task' };
        if (
          (input.expectedTaskVersion && task.updatedAt !== input.expectedTaskVersion)
          || (input.taskPushLeaseToken
            && (task.syncStatus !== 'pushing' || task.lastSyncedAt !== input.taskPushLeaseToken))
        ) {
          return { ok: false, code: 'stale_task_push_claim' };
        }
        const modeRevision = readModeRevision(tx, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? tx
              .select()
              .from(githubIdentityWriteCycles)
              .where(
                and(
                  eq(githubIdentityWriteCycles.id, input.writeCycleId),
                  eq(githubIdentityWriteCycles.connectorInstanceId, input.connectorInstanceId),
                  eq(githubIdentityWriteCycles.state, 'running'),
                  eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
                ),
              )
              .limit(1)
              .get()
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (hasOpenStableIdentityCollision(input.connectorInstanceId, 'task', task.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const targets = loadTargets(
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
        const priorSuccess = intent
          ? tx
              .select({ id: taskSourceWriteLeases.id })
              .from(taskSourceWriteLeases)
              .where(
                and(
                  eq(taskSourceWriteLeases.connectorInstanceId, input.connectorInstanceId),
                  eq(taskSourceWriteLeases.taskId, task.id),
                  eq(taskSourceWriteLeases.operation, input.operation),
                  eq(taskSourceWriteLeases.modeRevision, modeRevision),
                  ...(initialCreate
                    ? []
                    : [
                        eq(taskSourceWriteLeases.idempotencyKey, idempotencyKey),
                        eq(taskSourceWriteLeases.intentKind, intent.kind),
                        eq(taskSourceWriteLeases.intentDigest, intent.digest),
                      ]),
                  eq(taskSourceWriteLeases.state, 'succeeded'),
                  eq(taskSourceWriteLeases.cycleOutcome, 'succeeded'),
                ),
              )
              .limit(10)
              .all()
              .find((lease) => currentLeaseTargetsMatch(lease.id, true))
          : null;
        if (priorSuccess) return { ok: false, code: 'write_already_succeeded' };
        try {
          tx.insert(taskSourceWriteLeases)
            .values({
              id: input.leaseId,
              token: input.token,
              connectorInstanceId: input.connectorInstanceId,
              taskId: task.id,
              operation: input.operation,
              taskVersion: task.updatedAt,
              idempotencyKey,
              modeRevision,
              writeCycleId: input.writeCycleId,
              intentKind: intent?.kind,
              intentDigest: intent?.digest,
              expiresAt: input.expiresAt,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .run();
        } catch {
          throw new RollbackSignal<GitHubAuthorizeTaskWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        tx.insert(taskSourceWriteLeaseTargets)
          .values(
            targets.map((target) => ({
              leaseId: input.leaseId,
              role: target.role,
              externalEntityId: target.entityId,
              repositoryEntityId: target.repositoryEntityId,
              hostKey: target.hostKey,
              locatorRevision: target.locatorRevision,
              bindingRevision: target.bindingRevision,
              legacyLocatorDigest: digestLocator(target.owner, target.repository, target.issueNumber),
              owner: target.owner,
              repository: target.repository,
              issueNumber: target.issueNumber,
            })),
          )
          .run();
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
      return runTx((tx): GitHubAuthorizeSourceWriteResult => {
        const sourceList = tx
          .select()
          .from(sourceLists)
          .where(
            and(
              eq(sourceLists.connectorInstanceId, input.connectorInstanceId),
              eq(sourceLists.id, input.sourceListId),
            ),
          )
          .limit(1)
          .get();
        if (!sourceList) return { ok: false, code: 'missing_source_list' };
        const modeRevision = readModeRevision(tx, input.connectorInstanceId);
        const cycle = input.writeCycleId
          ? tx
              .select()
              .from(githubIdentityWriteCycles)
              .where(
                and(
                  eq(githubIdentityWriteCycles.id, input.writeCycleId),
                  eq(githubIdentityWriteCycles.connectorInstanceId, input.connectorInstanceId),
                  eq(githubIdentityWriteCycles.state, 'running'),
                  eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
                ),
              )
              .limit(1)
              .get()
          : null;
        if (!cycle || cycle.modeRevision !== modeRevision) {
          return { ok: false, code: 'stale_write_cycle' };
        }
        if (hasOpenStableIdentityCollision(input.connectorInstanceId, 'source_list', sourceList.id)) {
          return { ok: false, code: 'stable_identity_evidence_blocked' };
        }
        const target = identityForBinding(
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
        try {
          tx.insert(taskSourceWriteLeases)
            .values({
              id: input.leaseId,
              token: input.token,
              connectorInstanceId: input.connectorInstanceId,
              taskId: `source-list:${sourceList.id}`,
              operation: input.operation,
              taskVersion: sourceList.sourceId,
              idempotencyKey,
              modeRevision,
              writeCycleId: input.writeCycleId,
              expiresAt: input.expiresAt,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .run();
        } catch {
          throw new RollbackSignal<GitHubAuthorizeSourceWriteResult>({
            ok: false,
            code: 'active_or_unknown_lease',
          });
        }
        tx.insert(taskSourceWriteLeaseTargets)
          .values({
            leaseId: input.leaseId,
            role: target.role,
            externalEntityId: target.entityId,
            repositoryEntityId: target.repositoryEntityId,
            hostKey: target.hostKey,
            locatorRevision: target.locatorRevision,
            bindingRevision: target.bindingRevision,
            legacyLocatorDigest: digestLocator(target.owner, target.repository, null),
            owner: target.owner,
            repository: target.repository,
            issueNumber: null,
          })
          .run();
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
      const task = db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.connectorInstanceId, input.connectorInstanceId),
            eq(tasks.updatedAt, input.expectedTaskVersion),
            eq(tasks.syncStatus, 'pushing'),
            eq(tasks.lastSyncedAt, input.taskPushLeaseToken),
          ),
        )
        .limit(1)
        .get();
      if (!task) return false;
      const { idempotencyKey, intent, initialCreate } = input.deriveWriteIdentity(projectTaskRow(task));
      if (!intent) return false;
      const modeRevision = readModeRevision(db, input.connectorInstanceId);
      return db
        .select({ id: taskSourceWriteLeases.id })
        .from(taskSourceWriteLeases)
        .where(
          and(
            eq(taskSourceWriteLeases.connectorInstanceId, input.connectorInstanceId),
            eq(taskSourceWriteLeases.taskId, task.id),
            eq(taskSourceWriteLeases.operation, input.operation),
            eq(taskSourceWriteLeases.modeRevision, modeRevision),
            ...(initialCreate
              ? []
              : [
                  eq(taskSourceWriteLeases.idempotencyKey, idempotencyKey),
                  eq(taskSourceWriteLeases.intentKind, intent.kind),
                  eq(taskSourceWriteLeases.intentDigest, intent.digest),
                ]),
            eq(taskSourceWriteLeases.state, 'succeeded'),
            eq(taskSourceWriteLeases.cycleOutcome, 'succeeded'),
          ),
        )
        .limit(10)
        .all()
        .some((lease) => currentLeaseTargetsMatch(lease.id, true));
    },

    async assertCycleCurrent({ authorization }) {
      return runTx((tx) => {
        const lease = tx
          .select()
          .from(taskSourceWriteLeases)
          .where(
            and(
              eq(taskSourceWriteLeases.id, authorization.leaseId),
              eq(taskSourceWriteLeases.token, authorization.token),
              inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
            ),
          )
          .limit(1)
          .get();
        if (!lease) return false;
        if (authorization.expectedTaskVersion || authorization.taskPushLeaseToken) {
          const task = tx
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.id, authorization.taskId),
                eq(tasks.connectorInstanceId, authorization.connectorInstanceId),
              ),
            )
            .limit(1)
            .get();
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
        if (readModeRevision(tx, authorization.connectorInstanceId) !== lease.modeRevision) {
          return false;
        }
        return Boolean(
          tx
            .select({ id: githubIdentityWriteCycles.id })
            .from(githubIdentityWriteCycles)
            .where(
              and(
                eq(githubIdentityWriteCycles.id, lease.writeCycleId),
                eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
                eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
                eq(githubIdentityWriteCycles.state, 'running'),
                eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
              ),
            )
            .limit(1)
            .get(),
        );
      });
    },

    async confirmDispatch({ authorization, now }) {
      const changes = runTx((tx) => {
        const lease = tx
          .select()
          .from(taskSourceWriteLeases)
          .where(
            and(
              eq(taskSourceWriteLeases.id, authorization.leaseId),
              eq(taskSourceWriteLeases.token, authorization.token),
              eq(taskSourceWriteLeases.state, 'claimed'),
            ),
          )
          .limit(1)
          .get();
        if (!lease || lease.expiresAt <= now) return 0;
        const cycle = lease.writeCycleId
          ? tx
              .select()
              .from(githubIdentityWriteCycles)
              .where(
                and(
                  eq(githubIdentityWriteCycles.id, lease.writeCycleId),
                  eq(githubIdentityWriteCycles.connectorInstanceId, authorization.connectorInstanceId),
                  eq(githubIdentityWriteCycles.state, 'running'),
                  eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
                ),
              )
              .limit(1)
              .get()
          : null;
        const modeRevision = readModeRevision(tx, authorization.connectorInstanceId);
        const sourceListSubject = authorization.taskId.startsWith('source-list:')
          ? tx
              .select()
              .from(sourceLists)
              .where(
                and(
                  eq(sourceLists.id, authorization.taskId.slice('source-list:'.length)),
                  eq(sourceLists.connectorInstanceId, authorization.connectorInstanceId),
                ),
              )
              .limit(1)
              .get()
          : null;
        const task = sourceListSubject
          ? null
          : tx.select().from(tasks).where(eq(tasks.id, authorization.taskId)).limit(1).get();
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
          || !currentLeaseTargetsMatch(authorization.leaseId)
        ) {
          return 0;
        }
        return tx
          .update(taskSourceWriteLeases)
          .set({ state: 'dispatched', dispatchedAt: now, updatedAt: now })
          .where(
            and(
              eq(taskSourceWriteLeases.id, authorization.leaseId),
              eq(taskSourceWriteLeases.token, authorization.token),
              eq(taskSourceWriteLeases.state, 'claimed'),
            ),
          )
          .run().changes;
      });
      return changes === 1;
    },

    async verifyPreflight({ leaseId, observed }) {
      const rows = sqlite
        .prepare(`
          SELECT target.role AS role, entity.entity_type AS entityType, entity.stable_id AS stableId,
            repository.stable_id AS repositoryStableId
          FROM task_source_write_lease_targets AS target
          JOIN external_entities AS entity ON entity.id = target.external_entity_id
          LEFT JOIN external_entities AS repository ON repository.id = target.repository_entity_id
          WHERE target.lease_id = ?
        `)
        .all(leaseId) as Array<{
        role: string;
        entityType: 'issue' | 'repository';
        stableId: string;
        repositoryStableId: string | null;
      }>;
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
      const allowedStates =
        outcome === 'failed'
          ? (['claimed', 'authorized', 'dispatched'] as const)
          : (['dispatched', 'authorized'] as const);
      return runTx((tx): GitHubFinalizeWriteResult => {
        const lease = tx
          .select()
          .from(taskSourceWriteLeases)
          .where(
            and(
              eq(taskSourceWriteLeases.id, authorization.leaseId),
              eq(taskSourceWriteLeases.token, authorization.token),
              inArray(taskSourceWriteLeases.state, [...allowedStates]),
            ),
          )
          .limit(1)
          .get();
        if (!lease) return { status: 'not_committed' };
        if (lease.writeCycleId && (outcome !== 'failed' || lease.dispatchedAt !== null)) {
          const cycle = tx
            .select({ id: githubIdentityWriteCycles.id })
            .from(githubIdentityWriteCycles)
            .where(
              and(
                eq(githubIdentityWriteCycles.id, lease.writeCycleId),
                eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
                eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
                eq(githubIdentityWriteCycles.state, 'running'),
                eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
              ),
            )
            .limit(1)
            .get();
          if (!cycle) return { status: 'not_committed' };
        }
        const leaseUpdate = tx
          .update(taskSourceWriteLeases)
          .set({
            state: outcome,
            cycleOutcome: outcome,
            unknownReason: outcome === 'unknown' ? safeReason ?? 'unknown_post_dispatch_outcome' : null,
            blockReason: outcome === 'failed' ? safeReason : null,
            resultDigest: outcome === 'succeeded' ? resultDigest : null,
            finalizedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskSourceWriteLeases.id, authorization.leaseId),
              eq(taskSourceWriteLeases.token, authorization.token),
              inArray(taskSourceWriteLeases.state, [...allowedStates]),
            ),
          )
          .run().changes;
        if (leaseUpdate === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (incrementCycleOutcome(lease.writeCycleId, outcome) !== 1) {
            throw new RollbackSignal<GitHubFinalizeWriteResult>({ status: 'outcome_lost' });
          }
        }
        if (leaseUpdate === 1 && outcome === 'succeeded') {
          sqlite
            .prepare(`
              UPDATE github_identity_write_cycles
              SET reconciliation_state = 'superseded',
                  reconciliation_code = 'superseded_by_succeeded_retry',
                  reconciled_at = ?
              WHERE id IN (
                SELECT prior.write_cycle_id
                FROM task_source_write_leases AS prior
                JOIN github_write_outcome_events AS event ON event.lease_id = prior.id
                WHERE prior.connector_instance_id = ?
                  AND prior.idempotency_key = ?
                  AND prior.id != ?
                  AND prior.write_cycle_id IS NOT NULL
                  AND event.outcome = 'proven_not_applied_retryable'
              )
                AND state IN ('interrupted', 'completed')
                AND reconciliation_state = 'post_dispatch_retryable'
            `)
            .run(now, lease.connectorInstanceId, lease.idempotencyKey, lease.id);
        }
        return { status: leaseUpdate === 1 ? 'committed' : 'not_committed' };
      });
    },

    async blockWrite({ leaseId, token, code, now }): Promise<GitHubBlockWriteResult> {
      return runTx((tx): GitHubBlockWriteResult => {
        const lease = tx
          .select()
          .from(taskSourceWriteLeases)
          .where(
            and(
              eq(taskSourceWriteLeases.id, leaseId),
              eq(taskSourceWriteLeases.token, token),
              inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
            ),
          )
          .limit(1)
          .get();
        if (!lease) return { status: 'unchanged' };
        if (lease.writeCycleId) {
          const cycle = tx
            .select({ id: githubIdentityWriteCycles.id })
            .from(githubIdentityWriteCycles)
            .where(
              and(
                eq(githubIdentityWriteCycles.id, lease.writeCycleId),
                eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
                eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
                eq(githubIdentityWriteCycles.state, 'running'),
                eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
              ),
            )
            .limit(1)
            .get();
          if (!cycle) return { status: 'cycle_lost' };
        }
        const changed = tx
          .update(taskSourceWriteLeases)
          .set({
            state: 'blocked',
            cycleOutcome: 'blocked',
            blockReason: code.slice(0, 100),
            finalizedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskSourceWriteLeases.id, leaseId),
              eq(taskSourceWriteLeases.token, token),
              inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
            ),
          )
          .run().changes;
        if (changed === 1 && lease.writeCycleId && !lease.cycleOutcome) {
          if (incrementCycleOutcome(lease.writeCycleId, 'blocked') !== 1) {
            throw new RollbackSignal<GitHubBlockWriteResult>({ status: 'outcome_lost' });
          }
        }
        return { status: changed === 1 ? 'blocked' : 'unchanged' };
      });
    },

    async expireUndispatchedLeases(now) {
      return sqlite
        .prepare(`
          UPDATE task_source_write_leases AS lease
          SET state = 'expired',
              finalized_at = ?,
              updated_at = ?
          WHERE lease.state IN ('claimed', 'authorized')
            AND lease.dispatched_at IS NULL
            AND lease.expires_at <= ?
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
        `)
        .run(now, now, now).changes;
    },
  };

  const transferIdentity: GitHubTransferIdentityPersistence = {
    async persist(input) {
      runTx((tx) => {
        const targets = resolveSqliteTaskTransferIdentityTargetsInTransaction(tx, {
          taskId: input.taskId,
          connectorInstanceId: input.connectorInstanceId,
          sourceListIds: sourceListIdsForGitHubTransferIdentity(input),
        });
        const writes = buildGitHubTransferIdentityWrites(input, targets.sourceLists);
        if (writes.length > 0 && !targets.taskExists) {
          throw new Error('Task transfer identity target was not found');
        }
        assertExternalIdentityBatchWithinLimit(writes);
        if (writes.length > 0) {
          const modeSnapshot = getGitHubIdentityModeSnapshotInTransaction(
            tx,
            input.connectorInstanceId,
            input.observedAt,
          );
          assertGitHubIdentityModeSnapshotInTransaction(tx, modeSnapshot);
          persistExternalIdentityBatchInTransaction(tx, writes, true, 'active');
        }
        if (input.reconcileTask && !reconcileSqliteTaskTransferIdentityRefreshInTransaction(tx, {
          taskId: input.taskId,
          connectorInstanceId: input.connectorInstanceId,
          task: input.reconcileTask,
          observedAt: input.observedAt,
        })) {
          throw new Error('Task transfer identity refresh target was not found');
        }
      });
    },
  };

  return { identity, writeFence, transferIdentity };
}
