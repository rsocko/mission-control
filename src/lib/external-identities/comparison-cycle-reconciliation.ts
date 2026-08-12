import 'server-only';

import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { runTransaction } from '@/db';
import {
  connectorOperationLeases,
  githubIdentityCollisions,
  githubIdentityComparisonRecords,
  githubIdentityComparisonRuns,
  githubIdentityWriteCycles,
  syncJobs,
  taskSourceWriteLeases,
} from '@/db/schema';
import { getGitHubIdentityModeSnapshotInTransaction } from './mode-control';
import type { ExternalIdentityTransaction } from './service';
import { hasCompleteGitHubSubIssueAttestation } from './sub-issue-attestation';

const REPLACEABLE_SUCCEEDED_SUB_ISSUE_REASONS = new Set([
  'sub_issue_generation_incomplete',
  'sub_issue_child_unresolved',
]);

export interface GitHubComparisonCycleReconciliationCommand {
  connectorInstanceId: string;
  runId: string;
  expectedRevision: number;
  action: 'replacement' | 'retire_revision' | 'resolve_no_write';
  successorRunId?: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now?: string;
}

export interface GitHubComparisonCycleReconciliationResult {
  changed: boolean;
  runId: string;
  state: 'resolved' | 'retired';
  successorRunId: string | null;
}

export function reconcileGitHubComparisonCycle(
  command: GitHubComparisonCycleReconciliationCommand,
): GitHubComparisonCycleReconciliationResult {
  validateCommand(command);
  return runTransaction((tx) => reconcileInTransaction(tx, command));
}

function reconcileInTransaction(
  tx: ExternalIdentityTransaction,
  command: GitHubComparisonCycleReconciliationCommand,
): GitHubComparisonCycleReconciliationResult {
  const current = getGitHubIdentityModeSnapshotInTransaction(
    tx,
    command.connectorInstanceId,
  );
  if (current.modeRevision !== command.expectedRevision) {
    throw new Error(
      `GitHub identity mode revision conflict: expected ${command.expectedRevision}, found ${current.modeRevision}`,
    );
  }
  if (current.stablePrimaryEnabled) {
    throw new Error('Comparison cycle reconciliation requires stable-primary to be disabled');
  }

  const replay = tx.select().from(githubIdentityComparisonRuns).where(and(
    eq(githubIdentityComparisonRuns.connectorInstanceId, command.connectorInstanceId),
    eq(githubIdentityComparisonRuns.reconciliationKey, command.idempotencyKey),
  )).limit(1).get();
  if (replay) {
    const expectedState = command.action === 'retire_revision' ? 'retired' : 'resolved';
    const replaySuccessor = command.action === 'replacement' && command.successorRunId
      ? tx.select({
          id: githubIdentityComparisonRuns.id,
          predecessorRunId: githubIdentityComparisonRuns.predecessorRunId,
        }).from(githubIdentityComparisonRuns).where(and(
          eq(githubIdentityComparisonRuns.id, command.successorRunId),
          eq(
            githubIdentityComparisonRuns.connectorInstanceId,
            command.connectorInstanceId,
          ),
        )).limit(1).get()
      : null;
    const replayLineageMatches = Boolean(
      replaySuccessor
      && (
        replaySuccessor.predecessorRunId === command.runId
        || isReplaceableSucceededSubIssueRun(replay)
      ),
    );
    if (
      replay.id !== command.runId
      || replay.interruptionState !== expectedState
      || replay.resolvedByRunId !== (command.successorRunId ?? null)
      || replay.reconciledBy !== command.actor
      || replay.reconciliationReason !== command.reason
      || (
        command.action === 'replacement'
        && !replayLineageMatches
      )
    ) {
      throw new Error('Comparison cycle reconciliation idempotency conflict');
    }
    return {
      changed: false,
      runId: replay.id,
      state: expectedState,
      successorRunId: replay.resolvedByRunId,
    };
  }

  const run = tx.select().from(githubIdentityComparisonRuns).where(and(
    eq(githubIdentityComparisonRuns.id, command.runId),
    eq(githubIdentityComparisonRuns.connectorInstanceId, command.connectorInstanceId),
  )).limit(1).get();
  if (!run) throw new Error('GitHub comparison cycle was not found');
  if (run.interruptionState !== 'unresolved') {
    throw new Error('GitHub comparison cycle is not unresolved');
  }
  const now = command.now ?? new Date().toISOString();

  let resolvedByRunId: string | null = null;
  if (command.action === 'replacement') {
    if (!command.successorRunId) {
      throw new Error('Replacement reconciliation requires a successor run');
    }
    const successor = tx.select().from(githubIdentityComparisonRuns).where(and(
      eq(githubIdentityComparisonRuns.id, command.successorRunId),
      eq(
        githubIdentityComparisonRuns.connectorInstanceId,
        command.connectorInstanceId,
      ),
    )).limit(1).get();
    if (!successor) {
      throw new Error('Successor run is not a complete authoritative replacement');
    }
    const completeSuccessor = (
      successor.identityMode === run.identityMode
      && successor.identityModeRevision === run.identityModeRevision
      && successor.syncKind === 'full'
      && successor.state === 'succeeded'
      && successor.evidenceEligible
      && hasCompleteGitHubSubIssueAttestation(tx, successor)
    );
    const replaceableSucceededPredecessor = (
      isReplaceableSucceededSubIssueRun(run)
      && run.identityMode === current.effectiveMode
      && run.identityModeRevision === current.modeRevision
      && run.completedAt
      && run.interruptedAt
      && successor.completedAt
      && successor.startedAt > run.interruptedAt
      && !hasCompleteGitHubSubIssueAttestation(tx, run)
    );
    const ownerLinked = Boolean(
      completeSuccessor
      && successor.predecessorRunId === run.id
      && run.ownerId
      && successor.ownerId === run.ownerId
      && (run.state !== 'succeeded' || replaceableSucceededPredecessor)
    );
    const freshAuthoritative = Boolean(
      completeSuccessor
      && successor.predecessorRunId === null
      && successor.ownerId
      && run.identityMode === current.effectiveMode
      && run.identityModeRevision === current.modeRevision
      && run.syncKind === 'full'
      && ['failed', 'cancelled'].includes(run.state)
      && run.completedAt
      && run.interruptedAt
      && successor.completedAt
      && successor.startedAt > run.interruptedAt,
    );
    const succeededAuthoritative = Boolean(
      completeSuccessor
      && successor.predecessorRunId === null
      && successor.ownerId
      && replaceableSucceededPredecessor
    );
    if (!ownerLinked && !freshAuthoritative && !succeededAuthoritative) {
      throw new Error('Successor run is not a complete authoritative replacement');
    }
    if (replaceableSucceededPredecessor) {
      assertAuthoritativeReplacementEvidence(
        tx,
        run,
        successor,
        now,
      );
    }
    if (freshAuthoritative) {
      establishFreshAuthoritativeLineage(
        tx,
        run,
        successor,
        now,
      );
    }
    resolvedByRunId = successor.id;
  } else if (command.action === 'retire_revision') {
    if (run.identityModeRevision >= current.modeRevision) {
      throw new Error('Only a prior-revision comparison cycle can be retired');
    }
    const unresolvedWrites = tx.select({ id: githubIdentityWriteCycles.id })
      .from(githubIdentityWriteCycles)
      .where(and(
        eq(githubIdentityWriteCycles.connectorInstanceId, command.connectorInstanceId),
        eq(githubIdentityWriteCycles.comparisonRunId, run.id),
        eq(githubIdentityWriteCycles.state, 'interrupted'),
      ))
      .all()
      .some((cycle) => {
        const detail = tx.select({
          reconciliationState: githubIdentityWriteCycles.reconciliationState,
          pendingCandidateCount: githubIdentityWriteCycles.pendingCandidateCount,
          legacyAppliedCount: githubIdentityWriteCycles.legacyAppliedCount,
          blockedCount: githubIdentityWriteCycles.blockedCount,
          failedCount: githubIdentityWriteCycles.failedCount,
          unknownCount: githubIdentityWriteCycles.unknownCount,
        }).from(githubIdentityWriteCycles)
          .where(eq(githubIdentityWriteCycles.id, cycle.id)).limit(1).get();
        return !detail
          || !['pre_dispatch_retryable', 'superseded', 'resolved']
            .includes(detail.reconciliationState)
          || (
            detail.reconciliationState === 'resolved'
            && (
              detail.pendingCandidateCount !== detail.legacyAppliedCount
              || detail.blockedCount > 0
              || detail.failedCount > 0
              || detail.unknownCount > 0
            )
          );
      });
    if (unresolvedWrites) {
      throw new Error('Comparison cycle has unresolved write-cycle evidence');
    }
  } else {
    assertNoWriteResolutionEvidence(tx, run, current, now);
  }

  const state = command.action === 'retire_revision' ? 'retired' : 'resolved';
  const updated = tx.update(githubIdentityComparisonRuns).set({
    interruptionState: state,
    reconciledAt: now,
    reconciledBy: command.actor,
    reconciliationReason: command.reason,
    reconciliationKey: command.idempotencyKey,
    resolvedByRunId,
  }).where(and(
    eq(githubIdentityComparisonRuns.id, run.id),
    eq(githubIdentityComparisonRuns.connectorInstanceId, command.connectorInstanceId),
    eq(githubIdentityComparisonRuns.identityMode, run.identityMode),
    eq(githubIdentityComparisonRuns.identityModeRevision, run.identityModeRevision),
    eq(githubIdentityComparisonRuns.interruptionState, 'unresolved'),
  )).returning({ id: githubIdentityComparisonRuns.id }).get();
  if (!updated) throw new Error('Comparison cycle reconciliation lost ownership');
  return {
    changed: true,
    runId: updated.id,
    state,
    successorRunId: resolvedByRunId,
  };
}

function establishFreshAuthoritativeLineage(
  tx: ExternalIdentityTransaction,
  run: typeof githubIdentityComparisonRuns.$inferSelect,
  successor: typeof githubIdentityComparisonRuns.$inferSelect,
  now: string,
): void {
  assertAuthoritativeReplacementEvidence(tx, run, successor, now);
  const linked = tx.update(githubIdentityComparisonRuns).set({
    predecessorRunId: run.id,
  }).where(and(
    eq(githubIdentityComparisonRuns.id, successor.id),
    eq(githubIdentityComparisonRuns.connectorInstanceId, run.connectorInstanceId),
    eq(githubIdentityComparisonRuns.state, 'succeeded'),
    eq(githubIdentityComparisonRuns.evidenceEligible, true),
    eq(githubIdentityComparisonRuns.identityMode, run.identityMode),
    eq(githubIdentityComparisonRuns.identityModeRevision, run.identityModeRevision),
    eq(githubIdentityComparisonRuns.syncKind, 'full'),
    isNull(githubIdentityComparisonRuns.predecessorRunId),
  )).returning({ id: githubIdentityComparisonRuns.id }).get();
  if (!linked) throw new Error('Authoritative replacement lineage lost ownership');
}

function isReplaceableSucceededSubIssueRun(
  run: typeof githubIdentityComparisonRuns.$inferSelect,
): boolean {
  return run.state === 'succeeded'
    && !run.evidenceEligible
    && run.syncKind === 'full'
    && run.interruptionSurface === 'sub_issue'
    && Boolean(
      run.interruptionReason
      && REPLACEABLE_SUCCEEDED_SUB_ISSUE_REASONS.has(run.interruptionReason),
    );
}

function assertAuthoritativeReplacementEvidence(
  tx: ExternalIdentityTransaction,
  run: typeof githubIdentityComparisonRuns.$inferSelect,
  successor: typeof githubIdentityComparisonRuns.$inferSelect,
  now: string,
): void {
  if (
    !run.ownerId
    || !run.ownerHeartbeatAt
    || !run.ownerLeaseExpiresAt
    || run.ownerLeaseExpiresAt > now
  ) {
    throw new Error('Authoritative replacement requires an inactive predecessor owner');
  }
  const assignedSuccessors = tx.select({ id: githubIdentityComparisonRuns.id })
    .from(githubIdentityComparisonRuns)
    .where(eq(githubIdentityComparisonRuns.predecessorRunId, run.id))
    .all();
  const lineageAvailable = successor.predecessorRunId === run.id
    ? assignedSuccessors.length === 1 && assignedSuccessors[0]?.id === successor.id
    : assignedSuccessors.length === 0;
  if (!lineageAvailable) {
    throw new Error('Authoritative replacement lineage is already assigned');
  }
  const activeJob = tx.select({ id: syncJobs.id }).from(syncJobs).where(and(
    eq(syncJobs.connectorId, run.connectorInstanceId),
    inArray(syncJobs.status, ['queued', 'running']),
  )).limit(1).get();
  const activeOperation = tx.select({ connectorId: connectorOperationLeases.connectorId })
    .from(connectorOperationLeases)
    .where(and(
      eq(connectorOperationLeases.connectorId, run.connectorInstanceId),
      gt(connectorOperationLeases.leaseExpiresAt, now),
    ))
    .limit(1)
    .get();
  if (activeJob || activeOperation) {
    throw new Error('Authoritative replacement requires an inactive connector runtime');
  }
  const blockingRecord = tx.select({ id: githubIdentityComparisonRecords.id })
    .from(githubIdentityComparisonRecords)
    .where(and(
      inArray(
        githubIdentityComparisonRecords.runId,
        run.state === 'succeeded' ? [run.id, successor.id] : [successor.id],
      ),
      inArray(githubIdentityComparisonRecords.outcome, [
        'collision',
        'stable_legacy_disagree',
        'path_reuse',
        'partial_fetch',
      ]),
    ))
    .limit(1)
    .get();
  if (blockingRecord) {
    throw new Error('Authoritative replacement has blocking comparison evidence');
  }
  const linkedWriteLease = tx.select({ id: taskSourceWriteLeases.id })
    .from(taskSourceWriteLeases)
    .where(and(
      eq(taskSourceWriteLeases.connectorInstanceId, run.connectorInstanceId),
      inArray(taskSourceWriteLeases.comparisonRunId, [run.id, successor.id]),
    ))
    .limit(1)
    .get();
  const linkedWriteCycle = tx.select({ id: githubIdentityWriteCycles.id })
    .from(githubIdentityWriteCycles)
    .where(and(
      eq(githubIdentityWriteCycles.connectorInstanceId, run.connectorInstanceId),
      inArray(githubIdentityWriteCycles.comparisonRunId, [run.id, successor.id]),
    ))
    .limit(1)
    .get();
  const activeOrAmbiguousWrite = tx.select({ id: taskSourceWriteLeases.id })
    .from(taskSourceWriteLeases)
    .where(and(
      eq(taskSourceWriteLeases.connectorInstanceId, run.connectorInstanceId),
      inArray(taskSourceWriteLeases.state, [
        'claimed',
        'authorized',
        'dispatched',
        'unknown',
      ]),
    ))
    .limit(1)
    .get();
  if (linkedWriteLease || linkedWriteCycle || activeOrAmbiguousWrite) {
    throw new Error('Authoritative replacement requires zero linked or ambiguous writes');
  }
}

function assertNoWriteResolutionEvidence(
  tx: ExternalIdentityTransaction,
  run: typeof githubIdentityComparisonRuns.$inferSelect,
  current: ReturnType<typeof getGitHubIdentityModeSnapshotInTransaction>,
  now: string,
): void {
  if (
    run.identityModeRevision !== current.modeRevision
    || run.identityMode !== current.effectiveMode
  ) {
    throw new Error('No-write resolution requires a current-revision comparison cycle');
  }
  if (
    run.syncKind !== 'incremental'
    || !['failed', 'cancelled'].includes(run.state)
    || !run.completedAt
    || !run.interruptedAt
  ) {
    throw new Error('No-write resolution is limited to completed interrupted incremental runs');
  }
  if (
    !run.ownerId
    || !run.ownerHeartbeatAt
    || !run.ownerLeaseExpiresAt
    || run.ownerLeaseExpiresAt > now
  ) {
    throw new Error('No-write resolution requires durable proof that the run owner is inactive');
  }

  const successor = tx.select({ id: githubIdentityComparisonRuns.id })
    .from(githubIdentityComparisonRuns)
    .where(and(
      eq(githubIdentityComparisonRuns.connectorInstanceId, run.connectorInstanceId),
      eq(githubIdentityComparisonRuns.predecessorRunId, run.id),
    ))
    .limit(1)
    .get();
  if (successor) {
    throw new Error('No-write resolution is unavailable after a successor run has started');
  }

  const activeJob = tx.select({ id: syncJobs.id }).from(syncJobs).where(and(
    eq(syncJobs.connectorId, run.connectorInstanceId),
    inArray(syncJobs.status, ['queued', 'running']),
  )).limit(1).get();
  const activeOperation = tx.select({ connectorId: connectorOperationLeases.connectorId })
    .from(connectorOperationLeases)
    .where(and(
      eq(connectorOperationLeases.connectorId, run.connectorInstanceId),
      gt(connectorOperationLeases.leaseExpiresAt, now),
    ))
    .limit(1)
    .get();
  if (activeJob || activeOperation) {
    throw new Error('No-write resolution requires the connector and sync runtime to be inactive');
  }
  const linkedWriteLease = tx.select({ id: taskSourceWriteLeases.id })
    .from(taskSourceWriteLeases)
    .where(and(
      eq(taskSourceWriteLeases.connectorInstanceId, run.connectorInstanceId),
      eq(taskSourceWriteLeases.comparisonRunId, run.id),
    ))
    .limit(1)
    .get();
  if (linkedWriteLease) {
    throw new Error('No-write resolution requires zero linked write leases');
  }
  const activeWriteLease = tx.select({ id: taskSourceWriteLeases.id })
    .from(taskSourceWriteLeases)
    .where(and(
      eq(taskSourceWriteLeases.connectorInstanceId, run.connectorInstanceId),
      inArray(taskSourceWriteLeases.state, [
        'claimed',
        'authorized',
        'dispatched',
        'unknown',
      ]),
    ))
    .limit(1)
    .get();
  if (activeWriteLease) {
    throw new Error('No-write resolution requires zero active or ambiguous write leases');
  }

  const comparisonRecord = tx.select({ id: githubIdentityComparisonRecords.id })
    .from(githubIdentityComparisonRecords)
    .where(eq(githubIdentityComparisonRecords.runId, run.id))
    .limit(1)
    .get();
  if (comparisonRecord) {
    throw new Error('No-write resolution requires zero comparison records');
  }
  const writeCycle = tx.select({ id: githubIdentityWriteCycles.id })
    .from(githubIdentityWriteCycles)
    .where(and(
      eq(githubIdentityWriteCycles.connectorInstanceId, run.connectorInstanceId),
      eq(githubIdentityWriteCycles.comparisonRunId, run.id),
    ))
    .limit(1)
    .get();
  if (writeCycle) {
    throw new Error('No-write resolution requires zero linked write cycles');
  }
  const openCollision = tx.select({ id: githubIdentityCollisions.id })
    .from(githubIdentityCollisions)
    .where(and(
      eq(githubIdentityCollisions.connectorInstanceId, run.connectorInstanceId),
      eq(githubIdentityCollisions.state, 'open'),
    ))
    .limit(1)
    .get();
  if (openCollision) {
    throw new Error('No-write resolution is unavailable while identity collisions are open');
  }
}

function validateCommand(command: GitHubComparisonCycleReconciliationCommand): void {
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new Error('Expected mode revision must be a non-negative integer');
  }
  if (!/^[a-z0-9@._:-]{3,100}$/i.test(command.actor)) {
    throw new Error('Comparison reconciliation actor is invalid');
  }
  if (command.reason.trim().length < 10 || command.reason.length > 500) {
    throw new Error('Comparison reconciliation reason must be 10-500 characters');
  }
  if (command.idempotencyKey.length < 8 || command.idempotencyKey.length > 200) {
    throw new Error('Comparison reconciliation idempotency key must be 8-200 characters');
  }
  if (!['replacement', 'retire_revision', 'resolve_no_write'].includes(command.action)) {
    throw new Error('Comparison reconciliation action is invalid');
  }
  if (
    (command.action === 'replacement') !== Boolean(command.successorRunId)
  ) {
    throw new Error('Only replacement reconciliation accepts a successor run');
  }
  if (command.now !== undefined && !Number.isFinite(Date.parse(command.now))) {
    throw new Error('Comparison reconciliation timestamp is invalid');
  }
}
