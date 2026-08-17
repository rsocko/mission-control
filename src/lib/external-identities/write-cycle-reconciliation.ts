import db, { runTransaction, sqlite } from '@/db';
import { getGitHubIdentityModeSnapshotInTransaction } from './identity-mode';

export interface GitHubWriteCycleReconciliationCommand {
  connectorInstanceId: string;
  cycleId: string;
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
  confirmPreDispatch: true;
  now?: string;
}

export type GitHubWriteCycleReconciliationResult =
  | {
      ok: true;
      changed: boolean;
      cycleId: string;
      reconciliationState: 'pre_dispatch_retryable' | 'superseded';
      reasonCode: 'pre_dispatch_retryable' | 'superseded_by_succeeded_retry';
      observedRouteCount: number;
    }
  | {
      ok: false;
      changed: boolean;
      cycleId: string;
      code:
        | 'active_write_lease'
        | 'ambiguous_cycle_evidence'
        | 'idempotency_conflict'
        | 'invalid_cycle_state'
        | 'possible_post_dispatch_outcome'
        | 'revision_conflict'
        | 'stale_cycle_context'
        | 'write_cycle_not_found';
      message: string;
    };

interface CycleRow {
  id: string;
  modeRevision: number;
  pendingCandidateCount: number;
  state: string;
  reconciliationState: string;
  reconciliationReason: string | null;
  reconciliationCode: string | null;
  reconciledBy: string | null;
  reconciliationIdempotencyKey: string | null;
}

interface LeaseRow {
  id: string;
  writeCycleId: string | null;
  taskId: string;
  operation: string;
  taskVersion: string;
  idempotencyKey: string;
  state: string;
  dispatchedAt: string | null;
  expiresAt: string;
  finalizedAt: string | null;
}

export function reconcileInterruptedGitHubWriteCycle(
  command: GitHubWriteCycleReconciliationCommand,
): GitHubWriteCycleReconciliationResult {
  validateCommand(command);
  const now = command.now ?? new Date().toISOString();
  return runTransaction(() => {
    const cycle = loadCycle(command.connectorInstanceId, command.cycleId);
    if (!cycle) {
      return failure(command.cycleId, 'write_cycle_not_found', 'Write cycle was not found');
    }
    if (cycle.reconciliationIdempotencyKey === command.idempotencyKey) {
      if (
        cycle.reconciledBy !== command.actor
        || cycle.reconciliationReason !== command.reason
      ) {
        return failure(
          cycle.id,
          'idempotency_conflict',
          'Idempotency key was already used with different audit fields',
        );
      }
      if (
        cycle.reconciliationState === 'pre_dispatch_retryable'
        || cycle.reconciliationState === 'superseded'
      ) {
        return {
          ok: true,
          changed: false,
          cycleId: cycle.id,
          reconciliationState: cycle.reconciliationState,
          reasonCode: cycle.reconciliationState === 'superseded'
            ? 'superseded_by_succeeded_retry'
            : 'pre_dispatch_retryable',
          observedRouteCount: observedRouteCount(cycle.id),
        };
      }
      const code = cycle.reconciliationCode === 'possible_post_dispatch_outcome'
        ? 'possible_post_dispatch_outcome'
        : 'ambiguous_cycle_evidence';
      return failure(
        cycle.id,
        code,
        code === 'possible_post_dispatch_outcome'
          ? 'Cycle remains quarantined by dispatch evidence'
          : 'Cycle remains quarantined by ambiguous durable evidence',
        false,
      );
    }
    if (cycle.reconciliationIdempotencyKey) {
      return failure(
        cycle.id,
        'idempotency_conflict',
        'Write cycle was already reconciled with another idempotency key',
      );
    }
    const duplicateKey = sqlite.prepare(`
      SELECT 1
      FROM github_identity_write_cycles
      WHERE connector_instance_id = ?
        AND reconciliation_idempotency_key = ?
        AND id != ?
      LIMIT 1
    `).get(command.connectorInstanceId, command.idempotencyKey, cycle.id);
    if (duplicateKey) {
      return failure(
        cycle.id,
        'idempotency_conflict',
        'Idempotency key belongs to another write cycle',
      );
    }

    const current = getGitHubIdentityModeSnapshotInTransaction(
      db,
      command.connectorInstanceId,
      now,
    );
    if (current.modeRevision !== command.expectedRevision) {
      return failure(cycle.id, 'revision_conflict', 'Connector mode revision changed');
    }
    if (cycle.modeRevision !== current.modeRevision) {
      return failure(
        cycle.id,
        'stale_cycle_context',
        'Write cycle belongs to a different identity context',
      );
    }
    if (!['interrupted', 'completed'].includes(cycle.state)) {
      return failure(
        cycle.id,
        'invalid_cycle_state',
        'Only interrupted or completed write cycles can be reconciled',
      );
    }

    let leases = loadRelatedLeases(cycle);
    if (!leasesMatchCycleBudget(cycle, leases)) {
      quarantineCycle(cycle.id, command, now, 'ambiguous_cycle_evidence');
      return failure(
        cycle.id,
        'ambiguous_cycle_evidence',
        'Durable lease evidence does not identify one write cycle',
        true,
      );
    }
    if (leases.some((lease) =>
      ['claimed', 'authorized'].includes(lease.state) && lease.expiresAt > now)) {
      return failure(
        cycle.id,
        'active_write_lease',
        'An undispatched write lease is still active',
      );
    }
    expireRelatedUndispatchedLeases(cycle, now);
    leases = loadRelatedLeases(cycle);
    if (leases.some(hasPossibleDispatch)) {
      sqlite.prepare(`
        UPDATE task_source_write_leases
        SET state = 'unknown',
            unknown_reason = COALESCE(unknown_reason, 'interrupted_after_dispatch'),
            finalized_at = COALESCE(finalized_at, ?),
            updated_at = ?
        WHERE write_cycle_id = ?
          AND state = 'dispatched'
      `).run(now, now, cycle.id);
      refreshQuarantinedCycleCounts(cycle);
      quarantineCycle(cycle.id, command, now, 'possible_post_dispatch_outcome');
      return failure(
        cycle.id,
        'possible_post_dispatch_outcome',
        'Dispatch evidence is quarantined and requires outcome reconciliation',
        true,
      );
    }
    if (
      cycle.state === 'completed'
      && leases.some((lease) =>
        !['blocked', 'failed', 'expired'].includes(lease.state)
        || lease.finalizedAt === null)
    ) {
      quarantineCycle(cycle.id, command, now, 'ambiguous_cycle_evidence');
      return failure(
        cycle.id,
        'ambiguous_cycle_evidence',
        'Completed cycle lacks durable locally finalized pre-dispatch evidence',
        true,
      );
    }

    let superseded = leases.length > 0;
    for (const lease of leases) {
      if (lease.idempotencyKey !== expectedLeaseIdempotencyKey(lease)) {
        quarantineCycle(cycle.id, command, now, 'idempotency_evidence_mismatch');
        return failure(
          cycle.id,
          'ambiguous_cycle_evidence',
          'Write lease idempotency evidence is inconsistent',
          true,
        );
      }
      if (lease.taskId.startsWith('source-list:')) {
        superseded = false;
        continue;
      }
      const task = sqlite.prepare(`
        SELECT source_id AS sourceId, sync_status AS syncStatus, is_checklist_item AS isChecklistItem
        FROM tasks
        WHERE id = ? AND connector_instance_id = ?
        LIMIT 1
      `).get(lease.taskId, command.connectorInstanceId) as {
        sourceId: string;
        syncStatus: string | null;
        isChecklistItem: number;
      } | undefined;
      const pending = task && (
        task.syncStatus === 'pending_push'
        || task.syncStatus === 'push_error'
        || task.sourceId.startsWith('local:')
        || (Boolean(task.isChecklistItem) && task.sourceId === lease.taskId)
      );
      if (pending) {
        superseded = false;
        continue;
      }
      const laterSuccess = sqlite.prepare(`
        SELECT 1
        FROM task_source_write_leases
        WHERE connector_instance_id = ?
          AND idempotency_key = ?
          AND id != ?
          AND state = 'succeeded'
        LIMIT 1
      `).get(command.connectorInstanceId, lease.idempotencyKey, lease.id);
      if (!laterSuccess) {
        quarantineCycle(cycle.id, command, now, 'local_task_state_ambiguous');
        return failure(
          cycle.id,
          'ambiguous_cycle_evidence',
          'Local task state changed without a durable successful retry',
          true,
        );
      }
    }

    const reconciliationState = superseded ? 'superseded' : 'pre_dispatch_retryable';
    const reasonCode = superseded
      ? 'superseded_by_succeeded_retry'
      : 'pre_dispatch_retryable';
    const observedCount = observedRouteCount(cycle.id);
    const counts = leaseOutcomeCounts(leases);
    sqlite.prepare(`
      UPDATE github_identity_write_cycles
      SET observed_route_count = ?,
          applied_count = 0,
          blocked_count = ?,
          failed_count = ?,
          unknown_count = 0,
          reconciliation_state = ?,
          reconciliation_reason = ?,
          reconciliation_code = ?,
          reconciled_at = ?,
          reconciled_by = ?,
          reconciliation_idempotency_key = ?
      WHERE id = ?
    `).run(
      observedCount,
      counts.blocked,
      counts.failed,
      reconciliationState,
      command.reason,
      reasonCode,
      now,
      command.actor,
      command.idempotencyKey,
      cycle.id,
    );
    return {
      ok: true,
      changed: true,
      cycleId: cycle.id,
      reconciliationState,
      reasonCode,
      observedRouteCount: observedCount,
    };
  });
}

function validateCommand(command: GitHubWriteCycleReconciliationCommand): void {
  if (!command.confirmPreDispatch) {
    throw new Error('Pre-dispatch reconciliation requires explicit confirmation');
  }
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new Error('Expected revision must be a non-negative integer');
  }
  for (const [name, value, min, max] of [
    ['actor', command.actor, 1, 80],
    ['reason', command.reason, 3, 500],
    ['idempotency key', command.idempotencyKey, 8, 192],
  ] as const) {
    if (
      value.trim().length < min
      || value.length > max
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(`Write cycle ${name} is invalid`);
    }
  }
}

function loadCycle(connectorInstanceId: string, cycleId: string): CycleRow | undefined {
  return sqlite.prepare(`
    SELECT id,
      mode_revision AS modeRevision,
      pending_candidate_count AS pendingCandidateCount,
      state,
      reconciliation_state AS reconciliationState,
      reconciliation_reason AS reconciliationReason,
      reconciliation_code AS reconciliationCode,
      reconciled_by AS reconciledBy,
      reconciliation_idempotency_key AS reconciliationIdempotencyKey
    FROM github_identity_write_cycles
    WHERE id = ? AND connector_instance_id = ?
  `).get(cycleId, connectorInstanceId) as CycleRow | undefined;
}

function loadRelatedLeases(cycle: CycleRow): LeaseRow[] {
  return sqlite.prepare(`
    SELECT id,
      write_cycle_id AS writeCycleId,
      task_id AS taskId,
      operation,
      task_version AS taskVersion,
      idempotency_key AS idempotencyKey,
      state,
      dispatched_at AS dispatchedAt,
      expires_at AS expiresAt,
      finalized_at AS finalizedAt
    FROM task_source_write_leases
    WHERE write_cycle_id = ?
    ORDER BY created_at, id
  `).all(cycle.id) as LeaseRow[];
}

function expireRelatedUndispatchedLeases(cycle: CycleRow, now: string): void {
  sqlite.prepare(`
    UPDATE task_source_write_leases
    SET state = 'expired',
        finalized_at = COALESCE(finalized_at, ?),
        updated_at = ?
    WHERE write_cycle_id = ?
      AND state IN ('claimed', 'authorized')
      AND dispatched_at IS NULL
      AND expires_at <= ?
  `).run(now, now, cycle.id, now);
}

/**
 * Every lease that reached a route decision carries `cycle_observed_at`, so the
 * lease rows themselves bound the cycle. A cycle that collected more leases
 * than it planned candidates, or leases without a route observation, is
 * ambiguous and must be quarantined rather than reconciled.
 */
function leasesMatchCycleBudget(cycle: CycleRow, leases: readonly LeaseRow[]): boolean {
  return leases.length <= cycle.pendingCandidateCount
    && leases.every((lease) => lease.writeCycleId === cycle.id);
}

function observedRouteCount(cycleId: string): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS value
    FROM task_source_write_leases
    WHERE write_cycle_id = ? AND cycle_observed_at IS NOT NULL
  `).get(cycleId) as { value: number };
  return Number(row.value);
}

function refreshQuarantinedCycleCounts(cycle: CycleRow): void {
  const unknownCount = sqlite.prepare(`
    SELECT COUNT(*) AS value
    FROM task_source_write_leases
    WHERE write_cycle_id = ?
      AND state = 'unknown'
  `).get(cycle.id) as { value: number };
  sqlite.prepare(`
    UPDATE github_identity_write_cycles
    SET observed_route_count = ?,
        unknown_count = ?
    WHERE id = ?
  `).run(
    observedRouteCount(cycle.id),
    Number(unknownCount.value),
    cycle.id,
  );
}

function hasPossibleDispatch(lease: LeaseRow): boolean {
  return lease.dispatchedAt !== null
    || ['dispatched', 'unknown', 'succeeded'].includes(lease.state);
}

function expectedLeaseIdempotencyKey(lease: LeaseRow): string {
  return `${lease.taskId}:${lease.operation}:${lease.taskVersion}`;
}

function leaseOutcomeCounts(leases: readonly LeaseRow[]): { blocked: number; failed: number } {
  return {
    blocked: leases.filter((lease) => lease.state === 'blocked').length,
    failed: leases.filter((lease) => lease.state === 'failed').length,
  };
}

function quarantineCycle(
  cycleId: string,
  command: GitHubWriteCycleReconciliationCommand,
  now: string,
  reasonCode: string,
): void {
  sqlite.prepare(`
    UPDATE github_identity_write_cycles
    SET reconciliation_state = 'quarantined',
        reconciliation_reason = ?,
        reconciliation_code = ?,
        reconciled_at = ?,
        reconciled_by = ?,
        reconciliation_idempotency_key = ?
    WHERE id = ?
  `).run(
    command.reason,
    reasonCode,
    now,
    command.actor,
    command.idempotencyKey,
    cycleId,
  );
}

function failure(
  cycleId: string,
  code: Extract<GitHubWriteCycleReconciliationResult, { ok: false }>['code'],
  message: string,
  changed = false,
): GitHubWriteCycleReconciliationResult {
  return { ok: false, changed, cycleId, code, message };
}
