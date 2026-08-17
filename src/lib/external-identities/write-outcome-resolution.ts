import { createHash, randomUUID } from 'crypto';
import db, { runTransaction, sqlite } from '@/db';
import { getGitHubIdentityModeSnapshotInTransaction } from './identity-mode';

const DEFAULT_INSPECTION_LIMIT = 20;
const MAX_INSPECTION_LIMIT = 50;

export interface GitHubWriteOutcomeReadRequest {
  owner: string;
  repository: string;
  issueNumber: number;
  operation: 'complete';
}

export type GitHubWriteOutcomeReadResult =
  | {
      availability: 'present';
      repositoryStableId: string;
      issueStableId: string;
      state: 'open' | 'closed';
    }
  | {
      availability: 'authoritative_absent';
      repositoryStableId: string;
    };

export interface GitHubWriteOutcomeReader {
  readGitHubWriteOutcome(
    request: GitHubWriteOutcomeReadRequest,
  ): Promise<GitHubWriteOutcomeReadResult>;
}

export interface GitHubWriteOutcomeResolutionCommand {
  connectorInstanceId: string;
  cycleId: string;
  leaseId: string;
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
  confirmOwnerStopped?: boolean;
  now?: string;
}

export type GitHubWriteOutcomeResolutionResult =
  | {
      ok: true;
      changed: boolean;
      cycleId: string;
      leaseId: string;
      outcome: 'proven_applied' | 'proven_not_applied_retryable';
      proofKind: 'issue_state' | 'local_finalization';
      cycleFinalized: boolean;
      reconciliationState: 'resolved' | 'post_dispatch_retryable' | 'quarantined';
    }
  | {
      ok: false;
      changed: boolean;
      cycleId: string;
      leaseId: string;
      code:
        | 'active_dispatch'
        | 'binding_or_locator_changed'
        | 'idempotency_conflict'
        | 'lease_not_found'
        | 'remote_outcome_ambiguous'
        | 'revision_conflict'
        | 'stale_cycle_context'
        | 'task_version_changed'
        | 'unsupported_outcome_proof'
        | 'write_cycle_not_found';
      message: string;
      remediation?: string;
    };

interface PreparedResolution {
  connectorInstanceId: string;
  cycleId: string;
  leaseId: string;
  taskId: string;
  operation: string;
  taskVersion: string;
  idempotencyKey: string;
  modeRevision: number;
  leaseState: string;
  cycleOutcome: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
  cycleInterrupted: boolean;
  proof:
    | {
        kind: 'local_finalization';
        outcome: 'proven_applied' | 'proven_not_applied_retryable';
        remoteState: 'locally_succeeded' | 'locally_failed_pre_dispatch';
      }
    | {
        kind: 'issue_state';
        request: GitHubWriteOutcomeReadRequest;
      };
}

interface CycleLeaseRow {
  connectorInstanceId: string;
  cycleId: string;
  cycleState: string;
  reconciliationState: string;
  jobId: string | null;
  modeRevision: number;
  leaseId: string;
  taskId: string;
  operation: string;
  taskVersion: string;
  idempotencyKey: string;
  leaseState: string;
  cycleOutcome: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
  expiresAt: string;
}

export function inspectGitHubWriteOutcomes(options: {
  connectorInstanceId: string;
  cycleId?: string;
  leaseId?: string;
  limit?: number;
}): Record<string, unknown> {
  const limit = validateLimit(options.limit ?? DEFAULT_INSPECTION_LIMIT);
  const filters = ['cycle.connector_instance_id = ?'];
  const values: Array<string | number> = [options.connectorInstanceId];
  if (options.cycleId) {
    filters.push('cycle.id = ?');
    values.push(options.cycleId);
  }
  if (options.leaseId) {
    filters.push('lease.id = ?');
    values.push(options.leaseId);
  }
  values.push(limit);
  const rows = sqlite.prepare(`
    SELECT cycle.id AS cycleId,
      cycle.state AS cycleState,
      cycle.mode_revision AS modeRevision,
      cycle.reconciliation_state AS reconciliationState,
      cycle.reconciliation_code AS reconciliationCode,
      cycle.pending_candidate_count AS pendingCandidateCount,
      cycle.observed_route_count AS observedRouteCount,
      cycle.started_at AS cycleStartedAt,
      cycle.completed_at AS cycleCompletedAt,
      lease.id AS leaseId,
      lease.task_id AS taskId,
      lease.operation,
      lease.task_version AS taskVersion,
      lease.idempotency_key AS idempotencyKey,
      lease.state AS leaseState,
      lease.cycle_outcome AS cycleOutcome,
      lease.intent_kind AS intentKind,
      lease.intent_digest AS intentDigest,
      lease.result_digest AS resultDigest,
      lease.cycle_observed_at AS cycleObservedAt,
      lease.dispatched_at AS dispatchedAt,
      lease.finalized_at AS finalizedAt,
      lease.expires_at AS expiresAt,
      lease.created_at AS leaseCreatedAt,
      lease.updated_at AS leaseUpdatedAt
    FROM github_identity_write_cycles AS cycle
    JOIN task_source_write_leases AS lease ON lease.write_cycle_id = cycle.id
    WHERE ${filters.join(' AND ')}
      AND (
        lease.state IN ('dispatched', 'unknown')
        OR lease.dispatched_at IS NOT NULL
        OR cycle.reconciliation_state = 'quarantined'
      )
    ORDER BY cycle.started_at DESC, lease.created_at, lease.id
    LIMIT ?
  `).all(...values) as Array<Record<string, unknown>>;

  return {
    connectorInstanceId: options.connectorInstanceId,
    bounded: true,
    limit,
    returnedCount: rows.length,
    outcomes: rows.map((row) => {
      const targets = sqlite.prepare(`
        SELECT role,
          locator_revision AS locatorRevision,
          binding_revision AS bindingRevision,
          legacy_locator_digest AS legacyLocatorDigest
        FROM task_source_write_lease_targets
        WHERE lease_id = ?
        ORDER BY role
        LIMIT 12
      `).all(row.leaseId) as Array<Record<string, unknown>>;
      const event = sqlite.prepare(`
        SELECT outcome,
          proof_kind AS proofKind,
          proof_digest AS proofDigest,
          remote_state AS remoteState,
          actor,
          reason,
          idempotency_key AS resolutionIdempotencyKey,
          created_at AS createdAt
        FROM github_write_outcome_events
        WHERE lease_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(row.leaseId) as Record<string, unknown> | undefined;
      const support = resolutionSupport({
        operation: String(row.operation),
        leaseState: String(row.leaseState),
        cycleOutcome: nullableString(row.cycleOutcome),
        dispatchedAt: nullableString(row.dispatchedAt),
        finalizedAt: nullableString(row.finalizedAt),
      });
      return {
        connectorInstanceId: options.connectorInstanceId,
        cycle: {
          id: row.cycleId,
          state: row.cycleState,
          modeRevision: row.modeRevision,
          reconciliationState: row.reconciliationState,
          reconciliationCode: row.reconciliationCode,
          pendingCandidateCount: row.pendingCandidateCount,
          observedRouteCount: row.observedRouteCount,
          startedAt: row.cycleStartedAt,
          completedAt: row.cycleCompletedAt,
        },
        lease: {
          id: row.leaseId,
          taskId: row.taskId,
          operation: row.operation,
          taskVersion: bounded(String(row.taskVersion), 192),
          idempotencyKey: bounded(String(row.idempotencyKey), 192),
          state: row.leaseState,
          cycleOutcome: row.cycleOutcome,
          intentKind: row.intentKind,
          intentDigest: row.intentDigest,
          resultDigest: row.resultDigest,
          cycleObservedAt: row.cycleObservedAt,
          dispatchedAt: row.dispatchedAt,
          finalizedAt: row.finalizedAt,
          expiresAt: row.expiresAt,
          createdAt: row.leaseCreatedAt,
          updatedAt: row.leaseUpdatedAt,
        },
        frozenTargets: targets,
        resolutionSupport: support,
        resolution: event
          ? {
              outcome: event.outcome,
              proofKind: event.proofKind,
              proofDigest: event.proofDigest,
              remoteState: event.remoteState,
              actor: boundedAuditActor(event.actor),
              reasonDigest: digest(String(event.reason ?? '')),
              idempotencyKeyDigest: digest(String(event.resolutionIdempotencyKey ?? '')),
              createdAt: event.createdAt,
            }
          : null,
      };
    }),
  };
}

export async function resolveGitHubWriteOutcome(
  command: GitHubWriteOutcomeResolutionCommand,
  reader: GitHubWriteOutcomeReader,
): Promise<GitHubWriteOutcomeResolutionResult> {
  validateCommand(command);
  const now = command.now ?? new Date().toISOString();
  const prepared = prepareResolution(command, now);
  if (!prepared.ok) return prepared.result;

  let outcome: 'proven_applied' | 'proven_not_applied_retryable';
  let proofKind: 'issue_state' | 'local_finalization';
  let remoteState: string;
  let proofDigest: string;
  let readResult: GitHubWriteOutcomeReadResult | undefined;
  if (prepared.value.proof.kind === 'local_finalization') {
    outcome = prepared.value.proof.outcome;
    proofKind = 'local_finalization';
    remoteState = prepared.value.proof.remoteState;
    proofDigest = digest(JSON.stringify({
      leaseId: prepared.value.leaseId,
      state: prepared.value.leaseState,
      cycleOutcome: prepared.value.cycleOutcome,
      dispatchedAt: prepared.value.dispatchedAt,
      finalizedAt: prepared.value.finalizedAt,
    }));
  } else {
    try {
      readResult = await reader.readGitHubWriteOutcome(prepared.value.proof.request);
    } catch (error) {
      return failure(
        command,
        'remote_outcome_ambiguous',
        `Authoritative GitHub readback failed: ${boundedError(error)}`,
        prepared.value.cycleInterrupted,
        'Keep the lease quarantined. Retry this same read-only-backed command after connectivity and repository access are restored; never enqueue the write blindly.',
      );
    }
    outcome = readResult.availability === 'authoritative_absent'
      || readResult.state === 'closed'
      ? 'proven_applied'
      : 'proven_not_applied_retryable';
    proofKind = 'issue_state';
    remoteState = readResult.availability === 'authoritative_absent'
      ? 'authoritative_absent'
      : readResult.state;
    proofDigest = digest(JSON.stringify({
      availability: readResult.availability,
      repositoryStableIdDigest: digest(readResult.repositoryStableId),
      issueStableIdDigest: readResult.availability === 'present'
        ? digest(readResult.issueStableId)
        : null,
      state: remoteState,
    }));
  }

  const committed = commitResolution(
    command,
    prepared.value,
    { outcome, proofKind, proofDigest, remoteState, readResult },
    now,
  );
  return !committed.ok && prepared.value.cycleInterrupted
    ? { ...committed, changed: true }
    : committed;
}

function prepareResolution(
  command: GitHubWriteOutcomeResolutionCommand,
  now: string,
): { ok: true; value: PreparedResolution } | {
  ok: false;
  result: Extract<GitHubWriteOutcomeResolutionResult, { ok: false }>;
} {
  return runTransaction(() => {
    const row = loadCycleLease(command.connectorInstanceId, command.cycleId, command.leaseId);
    if (!row) {
      const cycle = sqlite.prepare(`
        SELECT 1 FROM github_identity_write_cycles
        WHERE connector_instance_id = ? AND id = ?
      `).get(command.connectorInstanceId, command.cycleId);
      return {
        ok: false,
        result: failure(
          command,
          cycle ? 'lease_not_found' : 'write_cycle_not_found',
          cycle ? 'Write lease was not found in the requested cycle' : 'Write cycle was not found',
        ),
      };
    }
    const support = resolutionSupport(row);
    const immutableLocalSuccess = support.supported
      && support.proofKind === 'local_finalization'
      && support.outcome === 'proven_applied'
      && support.remoteState === 'locally_succeeded';
    const contextFailure = validateCurrentContext(
      command,
      row,
      now,
      immutableLocalSuccess,
    );
    if (contextFailure) return { ok: false, result: contextFailure };
    const cycleInterrupted = row.cycleState === 'running';
    if (cycleInterrupted) {
      const interruptionFailure = interruptStoppedOwnerCycle(command, row, now);
      if (interruptionFailure) {
        return { ok: false, result: interruptionFailure };
      }
    }
    if (!support.supported) {
      return {
        ok: false,
        result: failure(
          command,
          'unsupported_outcome_proof',
          support.reason,
          cycleInterrupted,
          support.remediation,
        ),
      };
    }
    const proof = support.proofKind === 'local_finalization'
      ? {
          kind: 'local_finalization' as const,
          outcome: support.outcome,
          remoteState: support.remoteState,
        }
      : {
          kind: 'issue_state' as const,
          request: loadIssueReadRequest(row),
        };
    if (proof.kind === 'issue_state' && !proof.request) {
      return {
        ok: false,
        result: failure(
          command,
          'binding_or_locator_changed',
          'The frozen issue target is missing or no longer current',
          cycleInterrupted,
          'Refresh identity evidence through normal comparison. Do not edit the lease target or task/source IDs.',
        ),
      };
    }
    return {
      ok: true,
      value: {
        connectorInstanceId: command.connectorInstanceId,
        cycleId: command.cycleId,
        leaseId: command.leaseId,
        taskId: row.taskId,
        operation: row.operation,
        taskVersion: row.taskVersion,
        idempotencyKey: row.idempotencyKey,
        modeRevision: row.modeRevision,
        leaseState: row.leaseState,
        cycleOutcome: row.cycleOutcome,
        dispatchedAt: row.dispatchedAt,
        finalizedAt: row.finalizedAt,
        cycleInterrupted,
        proof,
      } as PreparedResolution,
    };
  });
}

function commitResolution(
  command: GitHubWriteOutcomeResolutionCommand,
  prepared: PreparedResolution,
  proof: {
    outcome: 'proven_applied' | 'proven_not_applied_retryable';
    proofKind: 'issue_state' | 'local_finalization';
    proofDigest: string;
    remoteState: string;
    readResult?: GitHubWriteOutcomeReadResult;
  },
  now: string,
): GitHubWriteOutcomeResolutionResult {
  return runTransaction(() => {
    const existing = sqlite.prepare(`
      SELECT lease_id AS leaseId,
        actor,
        reason,
        outcome,
        proof_kind AS proofKind
      FROM github_write_outcome_events
      WHERE connector_instance_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(command.connectorInstanceId, command.idempotencyKey) as {
      leaseId: string;
      actor: string;
      reason: string;
      outcome: 'proven_applied' | 'proven_not_applied_retryable';
      proofKind: 'issue_state' | 'local_finalization';
    } | undefined;
    if (existing) {
      if (
        existing.leaseId !== command.leaseId
        || existing.actor !== command.actor
        || existing.reason !== command.reason
      ) {
        return failure(command, 'idempotency_conflict', 'Idempotency key was reused with different audit fields');
      }
      const cycle = sqlite.prepare(`
        SELECT reconciliation_state AS reconciliationState
        FROM github_identity_write_cycles
        WHERE id = ?
      `).get(command.cycleId) as { reconciliationState: string };
      return {
        ok: true,
        changed: false,
        cycleId: command.cycleId,
        leaseId: command.leaseId,
        outcome: existing.outcome,
        proofKind: existing.proofKind,
        cycleFinalized: cycle.reconciliationState !== 'quarantined',
        reconciliationState: normalizeReconciliationState(cycle.reconciliationState),
      };
    }
    const existingLeaseEvent = sqlite.prepare(`
      SELECT idempotency_key AS idempotencyKey
      FROM github_write_outcome_events
      WHERE connector_instance_id = ? AND lease_id = ?
      LIMIT 1
    `).get(command.connectorInstanceId, command.leaseId) as {
      idempotencyKey: string;
    } | undefined;
    if (existingLeaseEvent) {
      return failure(
        command,
        'idempotency_conflict',
        'Write lease was already resolved with another idempotency key',
      );
    }
    const row = loadCycleLease(command.connectorInstanceId, command.cycleId, command.leaseId);
    if (!row) return failure(command, 'lease_not_found', 'Write lease changed before resolution commit');
    const contextFailure = validateCurrentContext(
      command,
      row,
      now,
      proof.proofKind === 'local_finalization'
        && proof.outcome === 'proven_applied'
        && proof.remoteState === 'locally_succeeded',
    );
    if (contextFailure) return contextFailure;
    if (
      row.taskId !== prepared.taskId
      || row.operation !== prepared.operation
      || row.taskVersion !== prepared.taskVersion
      || row.idempotencyKey !== prepared.idempotencyKey
      || row.modeRevision !== prepared.modeRevision
      || row.leaseState !== prepared.leaseState
      || row.cycleOutcome !== prepared.cycleOutcome
    ) {
      return failure(command, 'stale_cycle_context', 'Lease or cycle changed during GitHub readback');
    }
    if (proof.readResult && !remoteIdentityMatches(command.leaseId, proof.readResult)) {
      return failure(
        command,
        'binding_or_locator_changed',
        'GitHub readback identity does not match the frozen and current binding',
      );
    }

    const nextLeaseState = proof.outcome === 'proven_applied' ? 'succeeded' : 'failed';
    const changed = sqlite.prepare(`
      UPDATE task_source_write_leases
      SET state = ?,
          cycle_outcome = ?,
          unknown_reason = NULL,
          block_reason = ?,
          finalized_at = COALESCE(finalized_at, ?),
          updated_at = ?
      WHERE connector_instance_id = ?
        AND write_cycle_id = ?
        AND id = ?
        AND state = ?
    `).run(
      nextLeaseState,
      nextLeaseState,
      proof.outcome === 'proven_not_applied_retryable'
        ? 'proven_not_applied_retryable'
        : null,
      now,
      now,
      command.connectorInstanceId,
      command.cycleId,
      command.leaseId,
      prepared.leaseState,
    ).changes;
    if (changed !== 1) {
      return failure(command, 'stale_cycle_context', 'Lease finalization lost a concurrent race');
    }

    sqlite.prepare(`
      INSERT INTO github_write_outcome_events (
        id, connector_instance_id, cycle_id, lease_id, task_id, operation,
        task_version, expected_mode_revision, outcome, proof_kind, proof_digest,
        remote_state, actor, reason, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      command.connectorInstanceId,
      command.cycleId,
      command.leaseId,
      prepared.taskId,
      prepared.operation,
      prepared.taskVersion,
      command.expectedRevision,
      proof.outcome,
      proof.proofKind,
      proof.proofDigest,
      proof.remoteState,
      command.actor,
      command.reason,
      command.idempotencyKey,
      now,
    );

    if (
      !prepared.taskId.startsWith('source-list:')
      && ['update', 'complete', 'delete'].includes(prepared.operation)
    ) {
      if (proof.outcome === 'proven_applied') {
        sqlite.prepare(`
          UPDATE tasks
          SET sync_status = 'synced',
              push_retry_count = 0,
              last_synced_at = ?
          WHERE connector_instance_id = ? AND id = ? AND updated_at = ?
        `).run(
          now,
          command.connectorInstanceId,
          prepared.taskId,
          prepared.taskVersion,
        );
      } else {
        sqlite.prepare(`
          UPDATE tasks
          SET sync_status = 'pending_push',
              push_retry_count = 0
          WHERE connector_instance_id = ? AND id = ? AND updated_at = ?
        `).run(
          command.connectorInstanceId,
          prepared.taskId,
          prepared.taskVersion,
        );
      }
    }

    const cycle = finalizeCycleAfterResolution(command, now);
    return {
      ok: true,
      changed: true,
      cycleId: command.cycleId,
      leaseId: command.leaseId,
      outcome: proof.outcome,
      proofKind: proof.proofKind,
      cycleFinalized: cycle.finalized,
      reconciliationState: cycle.state,
    };
  });
}

function finalizeCycleAfterResolution(
  command: GitHubWriteOutcomeResolutionCommand,
  now: string,
): {
  finalized: boolean;
  state: 'resolved' | 'post_dispatch_retryable' | 'quarantined';
} {
  const cycle = sqlite.prepare(`
    SELECT pending_candidate_count AS pendingCandidateCount
    FROM github_identity_write_cycles
    WHERE connector_instance_id = ? AND id = ?
  `).get(command.connectorInstanceId, command.cycleId) as {
    pendingCandidateCount: number;
  };
  const leases = sqlite.prepare(`
    SELECT id, state, cycle_outcome AS cycleOutcome, cycle_observed_at AS cycleObservedAt
    FROM task_source_write_leases
    WHERE connector_instance_id = ? AND write_cycle_id = ?
    ORDER BY id
  `).all(command.connectorInstanceId, command.cycleId) as Array<{
    id: string;
    state: string;
    cycleOutcome: string | null;
    cycleObservedAt: string | null;
  }>;
  // Every lease that received a NodeID route carries `cycle_observed_at`, so
  // the lease rows alone prove the cycle is durably accounted for.
  const observedLeases = leases.filter((lease) => lease.cycleObservedAt !== null);
  const durable = leases.length <= cycle.pendingCandidateCount
    && leases.every((lease) =>
      ['succeeded', 'failed', 'blocked', 'expired'].includes(lease.state)
      && (
        lease.state === 'expired'
        || lease.cycleOutcome === lease.state
      ))
    && observedLeases.length === leases.length;
  if (!durable) {
    sqlite.prepare(`
      UPDATE github_identity_write_cycles
      SET reconciliation_state = 'quarantined',
          reconciliation_code = 'outcome_resolution_incomplete'
      WHERE connector_instance_id = ? AND id = ?
    `).run(
      command.connectorInstanceId,
      command.cycleId,
    );
    return { finalized: false, state: 'quarantined' };
  }
  const failedCount = leases.filter((lease) => lease.cycleOutcome === 'failed').length;
  const state = failedCount > 0 ? 'post_dispatch_retryable' : 'resolved';
  sqlite.prepare(`
    UPDATE github_identity_write_cycles
    SET observed_route_count = ?,
        applied_count = ?,
        blocked_count = ?,
        failed_count = ?,
        unknown_count = 0,
        state = 'completed',
        reconciliation_state = ?,
        reconciliation_code = ?,
        completed_at = COALESCE(completed_at, ?)
    WHERE connector_instance_id = ? AND id = ?
  `).run(
    observedLeases.length,
    leases.filter((lease) => lease.cycleOutcome === 'succeeded').length,
    leases.filter((lease) => lease.cycleOutcome === 'blocked').length,
    failedCount,
    state,
    state === 'resolved'
      ? 'post_dispatch_outcomes_resolved'
      : 'proven_not_applied_retryable',
    now,
    command.connectorInstanceId,
    command.cycleId,
  );
  return { finalized: true, state };
}

function validateCurrentContext(
  command: GitHubWriteOutcomeResolutionCommand,
  row: CycleLeaseRow,
  now: string,
  immutableLocalSuccess: boolean,
): Extract<GitHubWriteOutcomeResolutionResult, { ok: false }> | null {
  const mode = getGitHubIdentityModeSnapshotInTransaction(
    db,
    command.connectorInstanceId,
    now,
  );
  if (mode.modeRevision !== command.expectedRevision) {
    return failure(command, 'revision_conflict', 'Connector mode revision changed');
  }
  if (row.modeRevision !== mode.modeRevision) {
    return failure(command, 'stale_cycle_context', 'Write cycle belongs to a different identity context');
  }
  if (immutableLocalSuccess) return null;
  const taskVersion = row.taskId.startsWith('source-list:')
    ? sqlite.prepare(`
        SELECT source_id AS version
        FROM source_lists
        WHERE connector_instance_id = ? AND id = ?
      `).get(
        command.connectorInstanceId,
        row.taskId.slice('source-list:'.length),
      ) as { version: string } | undefined
    : sqlite.prepare(`
        SELECT updated_at AS version
        FROM tasks
        WHERE connector_instance_id = ? AND id = ?
      `).get(command.connectorInstanceId, row.taskId) as { version: string } | undefined;
  if (!taskVersion || taskVersion.version !== row.taskVersion) {
    return failure(command, 'task_version_changed', 'Task or source-list version changed');
  }
  if (!currentTargetsMatch(row.leaseId)) {
    return failure(command, 'binding_or_locator_changed', 'Frozen binding or locator no longer matches');
  }
  return null;
}

function loadCycleLease(
  connectorInstanceId: string,
  cycleId: string,
  leaseId: string,
): CycleLeaseRow | undefined {
  return sqlite.prepare(`
    SELECT cycle.connector_instance_id AS connectorInstanceId,
      cycle.id AS cycleId,
      cycle.state AS cycleState,
      cycle.reconciliation_state AS reconciliationState,
      cycle.job_id AS jobId,
      cycle.mode_revision AS modeRevision,
      lease.id AS leaseId,
      lease.task_id AS taskId,
      lease.operation,
      lease.task_version AS taskVersion,
      lease.idempotency_key AS idempotencyKey,
      lease.state AS leaseState,
      lease.cycle_outcome AS cycleOutcome,
      lease.dispatched_at AS dispatchedAt,
      lease.finalized_at AS finalizedAt,
      lease.expires_at AS expiresAt
    FROM github_identity_write_cycles AS cycle
    JOIN task_source_write_leases AS lease ON lease.write_cycle_id = cycle.id
    WHERE cycle.connector_instance_id = ?
      AND cycle.id = ?
      AND lease.connector_instance_id = cycle.connector_instance_id
      AND lease.id = ?
    LIMIT 1
  `).get(connectorInstanceId, cycleId, leaseId) as CycleLeaseRow | undefined;
}

function interruptStoppedOwnerCycle(
  command: GitHubWriteOutcomeResolutionCommand,
  row: CycleLeaseRow,
  now: string,
): Extract<GitHubWriteOutcomeResolutionResult, { ok: false }> | null {
  if (!command.confirmOwnerStopped) {
    return failure(
      command,
      'active_dispatch',
      'A running cycle may still own this post-dispatch lease',
      false,
      'Stop every app and worker process that can use this connector, wait for durable leases to expire, then rerun with --confirm-owner-stopped. Lease expiry alone is not proof that an in-flight GitHub request ended.',
    );
  }
  const live = sqlite.prepare(`
    SELECT
      EXISTS (
        SELECT 1
        FROM task_source_write_leases AS active_lease
        WHERE active_lease.connector_instance_id = ?
          AND active_lease.write_cycle_id = ?
          AND active_lease.state IN ('claimed', 'authorized', 'dispatched', 'unknown')
          AND active_lease.expires_at > ?
      ) AS writeLease,
      EXISTS (
        SELECT 1
        FROM connector_operation_leases AS operation_lease
        WHERE operation_lease.connector_id = ?
          AND operation_lease.lease_expires_at > ?
      ) AS connectorLease,
      EXISTS (
        SELECT 1
        FROM sync_jobs AS job
        WHERE job.id = ?
          AND job.connector_id = ?
          AND job.status = 'running'
          AND job.lease_expires_at > ?
      ) AS jobLease
  `).get(
    command.connectorInstanceId,
    command.cycleId,
    now,
    command.connectorInstanceId,
    now,
    row.jobId,
    command.connectorInstanceId,
    now,
  ) as { writeLease: number; connectorLease: number; jobLease: number };
  if (live.writeLease || live.connectorLease || live.jobLease) {
    return failure(
      command,
      'active_dispatch',
      'Durable owner or write leases are still active',
      false,
      'Keep all connector-capable app and worker processes stopped, wait for every reported lease to expire, and retry. Do not infer owner death from a single expired lease.',
    );
  }
  const changed = sqlite.prepare(`
    UPDATE github_identity_write_cycles
    SET state = 'interrupted',
        reconciliation_state = 'quarantined',
        reconciliation_code = 'possible_post_dispatch_outcome',
        completed_at = ?,
        reconciled_at = ?,
        reconciled_by = ?,
        reconciliation_reason = ?,
        reconciliation_idempotency_key = ?
    WHERE connector_instance_id = ?
      AND id = ?
      AND state = 'running'
      AND mode_revision = ?
  `).run(
    now,
    now,
    command.actor,
    command.reason,
    command.idempotencyKey,
    command.connectorInstanceId,
    command.cycleId,
    row.modeRevision,
  ).changes;
  if (changed !== 1) {
    return failure(
      command,
      'stale_cycle_context',
      'Running cycle quarantine lost a concurrent race',
    );
  }
  row.cycleState = 'interrupted';
  row.reconciliationState = 'quarantined';
  return null;
}

function loadIssueReadRequest(row: CycleLeaseRow): GitHubWriteOutcomeReadRequest | null {
  if (row.operation !== 'complete') return null;
  const target = sqlite.prepare(`
    SELECT target.owner, target.repository, target.issue_number AS issueNumber
    FROM task_source_write_lease_targets AS target
    WHERE target.lease_id = ? AND target.role = 'primary_issue'
    LIMIT 1
  `).get(row.leaseId) as {
    owner: string | null;
    repository: string | null;
    issueNumber: number | null;
  } | undefined;
  return target?.owner && target.repository && target.issueNumber !== null
    ? {
        owner: target.owner,
        repository: target.repository,
        issueNumber: target.issueNumber,
        operation: 'complete',
      }
    : null;
}

function currentTargetsMatch(leaseId: string): boolean {
  const result = sqlite.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE
        WHEN target.external_entity_id IS NOT NULL
          AND locator.id IS NOT NULL
          AND binding.id IS NOT NULL
          AND binding.verified_at = target.binding_revision
          AND locator.locator_revision = target.locator_revision
          AND lower(locator.owner) = lower(target.owner)
          AND lower(locator.repository) = lower(target.repository)
          AND COALESCE(locator.issue_number, -1) = COALESCE(target.issue_number, -1)
        THEN 1 ELSE 0 END
      ), 0) AS matching
    FROM task_source_write_lease_targets AS target
    JOIN task_source_write_leases AS lease ON lease.id = target.lease_id
    LEFT JOIN external_entity_locators AS locator
      ON locator.external_entity_id = target.external_entity_id
      AND locator.valid_to IS NULL
    LEFT JOIN external_entity_bindings AS binding
      ON binding.connector_instance_id = lease.connector_instance_id
      AND binding.external_entity_id = target.external_entity_id
      AND binding.state IN ('shadow', 'active')
    WHERE target.lease_id = ?
  `).get(leaseId) as { total: number; matching: number };
  return Number(result.total) > 0 && Number(result.total) === Number(result.matching);
}

function remoteIdentityMatches(
  leaseId: string,
  readResult: GitHubWriteOutcomeReadResult,
): boolean {
  const expected = sqlite.prepare(`
    SELECT issue.stable_id AS issueStableId,
      repository.stable_id AS repositoryStableId
    FROM task_source_write_lease_targets AS target
    JOIN external_entities AS issue ON issue.id = target.external_entity_id
    JOIN external_entities AS repository ON repository.id = target.repository_entity_id
    WHERE target.lease_id = ? AND target.role = 'primary_issue'
    LIMIT 1
  `).get(leaseId) as {
    issueStableId: string;
    repositoryStableId: string;
  } | undefined;
  return Boolean(
    expected
    && expected.repositoryStableId === readResult.repositoryStableId
    && (
      readResult.availability === 'authoritative_absent'
      || expected.issueStableId === readResult.issueStableId
    ),
  );
}

function resolutionSupport(input: {
  operation: string;
  leaseState: string;
  cycleOutcome: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
}): {
  supported: true;
  proofKind: 'local_finalization';
  outcome: 'proven_applied' | 'proven_not_applied_retryable';
  remoteState: 'locally_succeeded' | 'locally_failed_pre_dispatch';
} | {
  supported: true;
  proofKind: 'issue_state';
} | {
  supported: false;
  reason: string;
  remediation: string;
} {
  if (
    input.leaseState === 'succeeded'
    && input.cycleOutcome === 'succeeded'
    && input.finalizedAt
  ) {
    if (['create', 'sub_issue', 'transfer'].includes(input.operation)) {
      return {
        supported: false,
        reason: 'Local success lacks the immutable returned locator/binding needed to repair this operation',
        remediation: 'Keep the lease quarantined. Preserve the authenticated GitHub response or audit evidence that identifies the exact created/transferred issue and its repository; a dedicated non-ID-rewriting recovery flow is required.',
      };
    }
    return {
      supported: true,
      proofKind: 'local_finalization',
      outcome: 'proven_applied',
      remoteState: 'locally_succeeded',
    };
  }
  if (
    input.leaseState === 'failed'
    && input.cycleOutcome === 'failed'
    && input.finalizedAt
    && input.dispatchedAt === null
  ) {
    return {
      supported: true,
      proofKind: 'local_finalization',
      outcome: 'proven_not_applied_retryable',
      remoteState: 'locally_failed_pre_dispatch',
    };
  }
  if (
    ['unknown', 'dispatched'].includes(input.leaseState)
    && input.operation === 'complete'
  ) {
    return { supported: true, proofKind: 'issue_state' };
  }
  return {
    supported: false,
    reason: 'This operation has no authoritative persisted-effect readback proof',
    remediation: 'Keep the lease quarantined and do not retry. A non-mutating investigation must preserve the exact authenticated GitHub request/result or audit record correlated to this lease idempotency key; manual observation alone cannot be asserted through this tool.',
  };
}

function validateCommand(command: GitHubWriteOutcomeResolutionCommand): void {
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
      throw new Error(`Write outcome ${name} is invalid`);
    }
  }
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INSPECTION_LIMIT) {
    throw new Error(`Write outcome inspection limit must be between 1 and ${MAX_INSPECTION_LIMIT}`);
  }
  return limit;
}

function failure(
  command: Pick<GitHubWriteOutcomeResolutionCommand, 'cycleId' | 'leaseId'>,
  code: Extract<GitHubWriteOutcomeResolutionResult, { ok: false }>['code'],
  message: string,
  changed = false,
  remediation?: string,
): Extract<GitHubWriteOutcomeResolutionResult, { ok: false }> {
  return {
    ok: false,
    changed,
    cycleId: command.cycleId,
    leaseId: command.leaseId,
    code,
    message,
    ...(remediation ? { remediation } : {}),
  };
}

function normalizeReconciliationState(
  value: string,
): 'resolved' | 'post_dispatch_retryable' | 'quarantined' {
  return value === 'resolved' || value === 'post_dispatch_retryable'
    ? value
    : 'quarantined';
}

function bounded(value: string, max: number): string {
  return value.slice(0, max);
}

function boundedAuditActor(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[^a-z0-9@._:-]/gi, '_').slice(0, 80)
    : 'unknown';
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 160);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
