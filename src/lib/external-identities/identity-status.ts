import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/db/schema';
import { getGitHubIdentityModeSnapshotInTransaction } from './identity-mode';
import { getGitHubIdentityOperatorRepository } from './worker-persistence';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface GitHubIdentityStatusOptions {
  limit?: number;
  now?: string;
  /** Accepted for operator-command compatibility; the status is always bounded. */
  includeEvidence?: boolean;
}

interface ConnectorRow {
  id: string;
  type: string;
  name: string;
}

/**
 * Operational status for a permanently NodeID-first GitHub connector.
 *
 * There is no cutover gate, comparison evidence, or rollback readiness to
 * report any more. What matters operationally is NodeID coverage, unresolved
 * collisions, write cycles that still need reconciliation, and accepted
 * terminal exceptions.
 *
 * This is one of the five pre-existing, previously audited GitHub worker
 * operator/recovery surfaces (see `github-worker-errors.ts`): a read-only,
 * operator-only reporting query with no normal HTTP/application caller.
 * PostgreSQL does not implement it and fails closed via
 * `UnsupportedGitHubWorkerOperationError` before any SQLite import,
 * transaction, or durable mutation. The exact logic is preserved bit-for-bit
 * in `getGitHubIdentityStatusSync` below, which is the SQLite adapter's
 * implementation (`sqlite-github-identity-operator-repositories.ts`); only the
 * database handle sourcing changed from a module-level singleton import to an
 * injected parameter so this file carries no SQLite/`@/db` import of its own.
 */
export async function getGitHubIdentityStatus(
  connectorInstanceId: string,
  options: GitHubIdentityStatusOptions = {},
): Promise<Record<string, unknown>> {
  return (await getGitHubIdentityOperatorRepository())
    .getIdentityStatus(connectorInstanceId, options);
}

/**
 * SQLite-only synchronous implementation reused directly by
 * `sqlite-github-identity-operator-repositories.ts`. Must never be selected or
 * imported under PostgreSQL.
 */
export function getGitHubIdentityStatusSync(
  deps: { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> },
  connectorInstanceId: string,
  options: GitHubIdentityStatusOptions = {},
): Record<string, unknown> {
  const { sqlite, db } = deps;

  function count(statement: string, ...values: Array<string | number>): number {
    const row = sqlite.prepare(statement).get(...values) as { value: number };
    return Number(row.value);
  }

  function validateLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`Limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return limit;
  }

  function boundedAuditActor(value: unknown): string {
    return typeof value === 'string'
      ? value.replace(/[^\w.@:-]/g, '_').slice(0, 80)
      : '';
  }

  function auditDigest(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex');
  }

  function parseJsonRecord(value: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }

  function backfillStatus(connId: string): Record<string, unknown> {
    const migration = sqlite.prepare(`
      SELECT phase,
        started_at AS startedAt,
        updated_at AS updatedAt,
        completed_at AS completedAt,
        last_error AS lastError,
        counters
      FROM github_identity_migrations
      WHERE connector_instance_id = ?
    `).get(connId) as {
      phase: string;
      startedAt: string | null;
      updatedAt: string;
      completedAt: string | null;
      lastError: string | null;
      counters: string;
    } | undefined;
    const dispositions = sqlite.prepare(`
      SELECT state, COUNT(*) AS value
      FROM github_identity_backfill_items
      WHERE connector_instance_id = ?
      GROUP BY state
    `).all(connId) as Array<{ state: string; value: number }>;
    return {
      phase: migration?.phase ?? null,
      startedAt: migration?.startedAt ?? null,
      updatedAt: migration?.updatedAt ?? null,
      completedAt: migration?.completedAt ?? null,
      lastErrorDigest: migration?.lastError ? auditDigest(migration.lastError) : null,
      counters: migration ? parseJsonRecord(migration.counters) : {},
      dispositions: Object.fromEntries(
        dispositions.map((row) => [row.state, Number(row.value)]),
      ),
    };
  }

  /**
   * NodeID coverage for the rows that writes depend on. A local row without an
   * active binding cannot be written: the fence blocks instead of falling back to
   * the locator.
   */
  function bindingCoverage(connId: string): Record<string, unknown> {
    const taskCoverage = sqlite.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE
          WHEN binding.id IS NOT NULL AND binding.state = 'active' AND binding.verified_at IS NOT NULL
          THEN 1 ELSE 0 END), 0) AS bound
      FROM tasks AS task
      LEFT JOIN external_entity_bindings AS binding
        ON binding.connector_instance_id = task.connector_instance_id
        AND binding.binding_type = 'task'
        AND binding.local_id = task.id
      WHERE task.connector_instance_id = ?
    `).get(connId) as { total: number; bound: number };
    const sourceListCoverage = sqlite.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE
          WHEN binding.id IS NOT NULL AND binding.state = 'active' AND binding.verified_at IS NOT NULL
          THEN 1 ELSE 0 END), 0) AS bound
      FROM source_lists AS list
      LEFT JOIN external_entity_bindings AS binding
        ON binding.connector_instance_id = list.connector_instance_id
        AND binding.binding_type = 'source_list'
        AND binding.local_id = list.id
      WHERE list.connector_instance_id = ?
    `).get(connId) as { total: number; bound: number };
    return {
      tasks: {
        total: Number(taskCoverage.total),
        activeBindings: Number(taskCoverage.bound),
        unbound: Number(taskCoverage.total) - Number(taskCoverage.bound),
      },
      sourceLists: {
        total: Number(sourceListCoverage.total),
        activeBindings: Number(sourceListCoverage.bound),
        unbound: Number(sourceListCoverage.total) - Number(sourceListCoverage.bound),
      },
    };
  }

  function collisionStatus(connId: string, limit: number): Record<string, unknown> {
    const openCount = count(`
      SELECT COUNT(*) AS value
      FROM github_identity_collisions
      WHERE connector_instance_id = ? AND state = 'open'
    `, connId);
    const rows = sqlite.prepare(`
      SELECT id, category, binding_type AS bindingType, state,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM github_identity_collisions
      WHERE connector_instance_id = ? AND state = 'open'
      ORDER BY last_seen_at DESC, id DESC
      LIMIT ?
    `).all(connId, limit) as Array<Record<string, unknown>>;
    return { openCount, open: rows };
  }

  function writeLeaseStatus(connId: string): {
    byState: Record<string, number>;
    activeOrUnknownCount: number;
  } {
    const rows = sqlite.prepare(`
      SELECT state, COUNT(*) AS value
      FROM task_source_write_leases
      WHERE connector_instance_id = ?
      GROUP BY state
    `).all(connId) as Array<{ state: string; value: number }>;
    const byState = Object.fromEntries(rows.map((row) => [row.state, Number(row.value)]));
    return {
      byState,
      activeOrUnknownCount: ['claimed', 'authorized', 'dispatched', 'unknown']
        .reduce((total, state) => total + (byState[state] ?? 0), 0),
    };
  }

  function getWriteCycleReconciliationStatus(
    connId: string,
    limit: number,
  ): {
    unresolvedCount: number;
    preDispatchRetryableCount: number;
    postDispatchRetryableCount: number;
    resolvedCount: number;
    supersededCount: number;
    quarantinedCount: number;
    cycles: Array<Record<string, unknown>>;
  } {
    const counts = sqlite.prepare(`
      SELECT
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'quarantined'
            OR state = 'running'
            OR (state = 'interrupted' AND reconciliation_state NOT IN (
              'pre_dispatch_retryable', 'resolved', 'superseded'
            ))
            OR (
              state = 'completed'
              AND reconciliation_state NOT IN (
                'pre_dispatch_retryable', 'resolved', 'superseded'
              )
              AND (
                pending_candidate_count > observed_route_count
                OR blocked_count > 0
                OR failed_count > 0
                OR unknown_count > 0
              )
            )
          THEN 1 ELSE 0 END), 0) AS unresolvedCount,
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'pre_dispatch_retryable' THEN 1 ELSE 0 END
        ), 0) AS preDispatchRetryableCount,
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'post_dispatch_retryable' THEN 1 ELSE 0 END
        ), 0) AS postDispatchRetryableCount,
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'resolved' THEN 1 ELSE 0 END
        ), 0) AS resolvedCount,
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'superseded' THEN 1 ELSE 0 END
        ), 0) AS supersededCount,
        COALESCE(SUM(CASE
          WHEN reconciliation_state = 'quarantined' THEN 1 ELSE 0 END
        ), 0) AS quarantinedCount
      FROM github_identity_write_cycles
      WHERE connector_instance_id = ?
    `).get(connId) as {
      unresolvedCount: number;
      preDispatchRetryableCount: number;
      postDispatchRetryableCount: number;
      resolvedCount: number;
      supersededCount: number;
      quarantinedCount: number;
    };
    const rows = sqlite.prepare(`
      SELECT cycle.id,
        cycle.state,
        cycle.mode_revision AS modeRevision,
        cycle.pending_candidate_count AS pendingCandidateCount,
        cycle.observed_route_count AS observedRouteCount,
        cycle.applied_count AS appliedCount,
        cycle.blocked_count AS blockedCount,
        cycle.failed_count AS failedCount,
        cycle.unknown_count AS unknownCount,
        cycle.reconciliation_state AS reconciliationState,
        cycle.reconciliation_reason AS reconciliationReason,
        cycle.reconciliation_code AS reconciliationCode,
        cycle.reconciled_at AS reconciledAt,
        cycle.reconciled_by AS reconciledBy,
        cycle.reconciliation_idempotency_key AS reconciliationIdempotencyKey,
        cycle.started_at AS startedAt,
        cycle.completed_at AS completedAt,
        COALESCE(SUM(CASE
          WHEN lease.state IN ('claimed', 'authorized') THEN 1 ELSE 0 END
        ), 0) AS activeLeaseCount,
        COALESCE(SUM(CASE
          WHEN lease.state IN ('dispatched', 'unknown') OR lease.dispatched_at IS NOT NULL
          THEN 1 ELSE 0 END
        ), 0) AS dispatchEvidenceCount
      FROM github_identity_write_cycles AS cycle
      LEFT JOIN task_source_write_leases AS lease
        ON lease.connector_instance_id = cycle.connector_instance_id
        AND lease.write_cycle_id = cycle.id
      WHERE cycle.connector_instance_id = ?
        AND (
          cycle.state != 'completed'
          OR cycle.pending_candidate_count > cycle.observed_route_count
          OR cycle.blocked_count > 0
          OR cycle.failed_count > 0
          OR cycle.unknown_count > 0
          OR cycle.reconciliation_state != 'unresolved'
        )
      GROUP BY cycle.id
      ORDER BY cycle.started_at DESC, cycle.id DESC
      LIMIT ?
    `).all(connId, limit) as Array<{
      id: string;
      state: string;
      modeRevision: number;
      pendingCandidateCount: number;
      observedRouteCount: number;
      appliedCount: number;
      blockedCount: number;
      failedCount: number;
      unknownCount: number;
      reconciliationState: string;
      reconciliationReason: string | null;
      reconciliationCode: string | null;
      reconciledAt: string | null;
      reconciledBy: string | null;
      reconciliationIdempotencyKey: string | null;
      startedAt: string;
      completedAt: string | null;
      activeLeaseCount: number;
      dispatchEvidenceCount: number;
    }>;
    return {
      unresolvedCount: Number(counts.unresolvedCount),
      preDispatchRetryableCount: Number(counts.preDispatchRetryableCount),
      postDispatchRetryableCount: Number(counts.postDispatchRetryableCount),
      resolvedCount: Number(counts.resolvedCount),
      supersededCount: Number(counts.supersededCount),
      quarantinedCount: Number(counts.quarantinedCount),
      cycles: rows.map((row) => ({
        id: row.id,
        state: row.state,
        modeRevision: row.modeRevision,
        pendingCandidateCount: Number(row.pendingCandidateCount),
        observedRouteCount: Number(row.observedRouteCount),
        appliedCount: Number(row.appliedCount),
        blockedCount: Number(row.blockedCount),
        failedCount: Number(row.failedCount),
        unknownCount: Number(row.unknownCount),
        reconciliationState: row.reconciliationState,
        reconciliationReasonCode: row.reconciliationCode,
        reconciledAt: row.reconciledAt,
        reconciledBy: row.reconciledBy ? boundedAuditActor(row.reconciledBy) : null,
        reconciliationReasonDigest: row.reconciliationReason
          ? auditDigest(row.reconciliationReason)
          : null,
        reconciliationIdempotencyKeyDigest: row.reconciliationIdempotencyKey
          ? auditDigest(row.reconciliationIdempotencyKey)
          : null,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        activeLeaseCount: Number(row.activeLeaseCount),
        dispatchEvidenceCount: Number(row.dispatchEvidenceCount),
      })),
    };
  }

  /**
   * Durable write-fence state an operator must act on: cycles that did not close
   * cleanly and leases that are still active or of unknown outcome.
   */
  function operationalState(connId: string, limit: number): Record<string, unknown> {
    const leases = writeLeaseStatus(connId);
    const writeCycleReconciliation = getWriteCycleReconciliationStatus(connId, limit);
    return {
      incompleteWriteCycles: count(`
        SELECT COUNT(*) AS value
        FROM github_identity_write_cycles
        WHERE connector_instance_id = ?
          AND (
            state != 'completed'
            OR pending_candidate_count > observed_route_count
            OR blocked_count > 0
            OR failed_count > 0
            OR unknown_count > 0
          )
          AND reconciliation_state NOT IN ('pre_dispatch_retryable', 'resolved', 'superseded')
      `, connId),
      activeWriteLeases: leases.activeOrUnknownCount,
      writeLeasesByState: leases.byState,
      writeCycleReconciliation,
    };
  }

  /** Read-only history of the one-way cutover; nothing writes this table now. */
  function recentModeAudit(connId: string, limit: number): unknown[] {
    const rows = sqlite.prepare(`
      SELECT id,
        old_phase AS oldPhase,
        new_phase AS newPhase,
        old_mode_revision AS oldModeRevision,
        new_mode_revision AS newModeRevision,
        actor,
        gate_result_code AS gateResultCode,
        created_at AS createdAt
      FROM github_identity_mode_events
      WHERE connector_instance_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(connId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      actor: boundedAuditActor(row.actor),
    }));
  }

  function latestAcceptedExceptions(connId: string, limit: number): unknown[] {
    return sqlite.prepare(`
      SELECT event.id,
        event.binding_type AS bindingType,
        event.local_id AS localId,
        event.category,
        event.proof_type AS proofType,
        event.created_at AS createdAt
      FROM github_identity_exception_events AS event
      WHERE event.connector_instance_id = ?
        AND event.action = 'accept'
        AND event.id = (
          SELECT MAX(latest.id)
          FROM github_identity_exception_events AS latest
          WHERE latest.connector_instance_id = event.connector_instance_id
            AND latest.binding_type = event.binding_type
            AND latest.local_id = event.local_id
            AND latest.category = event.category
        )
      ORDER BY event.id DESC
      LIMIT ?
    `).all(connId, limit) as unknown[];
  }

  function countLatestAcceptedExceptions(connId: string): number {
    return count(`
      SELECT COUNT(*) AS value
      FROM github_identity_exception_events AS event
      WHERE event.connector_instance_id = ?
        AND event.action = 'accept'
        AND event.id = (
          SELECT MAX(latest.id)
          FROM github_identity_exception_events AS latest
          WHERE latest.connector_instance_id = event.connector_instance_id
            AND latest.binding_type = event.binding_type
            AND latest.local_id = event.local_id
            AND latest.category = event.category
        )
    `, connId);
  }

  const limit = validateLimit(options.limit ?? DEFAULT_LIMIT);
  const now = options.now ?? new Date().toISOString();
  const connector = sqlite.prepare(`
    SELECT id, type, name
    FROM connector_configs
    WHERE id = ?
  `).get(connectorInstanceId) as ConnectorRow | undefined;
  if (!connector || connector.type !== 'github-issues') {
    throw new Error('GitHub connector instance was not found');
  }
  const mode = getGitHubIdentityModeSnapshotInTransaction(db, connectorInstanceId, now);

  return {
    connectorInstanceId,
    generatedAt: now,
    identity: {
      model: 'github_node_id',
      permanent: true,
      effectiveMode: mode.effectiveMode,
      modeRevision: mode.modeRevision,
      note: 'source_id is a mutable locator for API addressing and display; it is not identity.',
    },
    backfill: backfillStatus(connectorInstanceId),
    bindings: bindingCoverage(connectorInstanceId),
    collisions: collisionStatus(connectorInstanceId, limit),
    operationalState: operationalState(connectorInstanceId, limit),
    exceptions: {
      acceptedCount: countLatestAcceptedExceptions(connectorInstanceId),
      latest: latestAcceptedExceptions(connectorInstanceId, limit),
    },
    cutoverHistory: recentModeAudit(connectorInstanceId, limit),
  };
}
