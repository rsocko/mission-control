import { and, eq, gt, inArray } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  githubIdentityControls,
  githubIdentityMigrations,
  githubIdentityModeEvents,
  taskSourceWriteLeases,
  connectorOperationLeases,
  syncJobs,
  dependencyReconciliationSnapshots,
  syncDeletionCandidates,
  syncDeletionSnapshots,
  type GitHubIdentityEffectiveMode,
  type GitHubIdentityPhase,
} from '@/db/schema';
import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityTransitionGateCode,
  GitHubIdentityTransitionRequest,
  GitHubIdentityTransitionResult,
} from './comparison-types';
import type { ExternalIdentityTransaction } from './service';

const TRANSITIONS: Readonly<Record<GitHubIdentityPhase, ReadonlySet<GitHubIdentityPhase>>> = {
  disabled: new Set(['schema_ready']),
  schema_ready: new Set(['disabled', 'shadow_write']),
  shadow_write: new Set(['schema_ready', 'backfilling']),
  backfilling: new Set(['paused', 'comparing']),
  comparing: new Set(['paused', 'stable_primary']),
  stable_primary: new Set(['compatibility', 'rollback_legacy']),
  compatibility: new Set(['complete', 'rollback_legacy']),
  complete: new Set(['rollback_legacy']),
  paused: new Set(['backfilling']),
  rollback_legacy: new Set(['comparing']),
};

const REQUIRED_GATES: Partial<Record<GitHubIdentityPhase, GitHubIdentityTransitionGateCode>> = {
  comparing: 'stage_one_ready',
  stable_primary: 'stage_two_ready',
  compatibility: 'stage_three_ready',
  complete: 'compatibility_ready',
  paused: 'pause',
  rollback_legacy: 'rollback',
};
const STABLE_AUTHORITATIVE_PHASES = new Set<GitHubIdentityPhase>([
  'stable_primary',
  'compatibility',
  'complete',
]);

export function deriveGitHubIdentityEffectiveMode(
  phase: GitHubIdentityPhase | null,
  stablePrimaryEnabled: boolean,
): GitHubIdentityEffectiveMode {
  if (phase === 'comparing') return 'comparison';
  if (
    stablePrimaryEnabled
    && (phase === 'stable_primary' || phase === 'compatibility' || phase === 'complete')
  ) {
    return 'stable';
  }
  return 'legacy';
}

export function getGitHubIdentityModeSnapshot(
  connectorInstanceId: string,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  return getGitHubIdentityModeSnapshotInTransaction(db, connectorInstanceId, capturedAt);
}

export function getGitHubIdentityModeSnapshotInTransaction(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  const migration = database.select({ phase: githubIdentityMigrations.phase })
    .from(githubIdentityMigrations)
    .where(eq(githubIdentityMigrations.connectorInstanceId, connectorInstanceId))
    .limit(1)
    .get();
  const control = database.select({
    stablePrimaryEnabled: githubIdentityControls.stablePrimaryEnabled,
    modeRevision: githubIdentityControls.modeRevision,
  }).from(githubIdentityControls)
    .where(eq(githubIdentityControls.connectorInstanceId, connectorInstanceId))
    .limit(1)
    .get();
  const stablePrimaryEnabled = control?.stablePrimaryEnabled ?? false;
  return Object.freeze({
    connectorInstanceId,
    phase: migration?.phase ?? null,
    effectiveMode: deriveGitHubIdentityEffectiveMode(
      migration?.phase ?? null,
      stablePrimaryEnabled,
    ),
    stablePrimaryEnabled,
    modeRevision: control?.modeRevision ?? 0,
    capturedAt,
  });
}

export function transitionGitHubIdentityMode(
  request: GitHubIdentityTransitionRequest,
): GitHubIdentityTransitionResult {
  return runTransaction((tx) => transitionGitHubIdentityModeInTransaction(tx, request));
}

export function transitionGitHubIdentityModeInTransaction(
  database: ExternalIdentityTransaction,
  request: GitHubIdentityTransitionRequest,
): GitHubIdentityTransitionResult {
  return transitionGitHubIdentityModeInternal(database, request, false);
}

export function transitionGitHubIdentityModeAuthoritativelyInTransaction(
  database: ExternalIdentityTransaction,
  request: GitHubIdentityTransitionRequest,
): GitHubIdentityTransitionResult {
  return transitionGitHubIdentityModeInternal(database, request, true);
}

function transitionGitHubIdentityModeInternal(
  database: ExternalIdentityTransaction,
  request: GitHubIdentityTransitionRequest,
  authoritativeCommand: boolean,
): GitHubIdentityTransitionResult {
  const now = request.now ?? new Date().toISOString();
  const current = getGitHubIdentityModeSnapshotInTransaction(
    database,
    request.connectorInstanceId,
    now,
  );
  const validationError = validateRequest(request);
  if (validationError) return { ok: false, code: 'invalid_request', message: validationError, snapshot: current };
  if (current.phase === null) {
    return {
      ok: false,
      code: 'missing_state',
      message: 'GitHub identity migration state is missing for this connector',
      snapshot: current,
    };
  }

  const existing = database.select().from(githubIdentityModeEvents)
    .where(and(
      eq(githubIdentityModeEvents.connectorInstanceId, request.connectorInstanceId),
      eq(githubIdentityModeEvents.idempotencyKey, request.idempotencyKey),
    ))
    .limit(1)
    .get();
  if (existing) {
    if (
      existing.newPhase !== request.targetPhase
      || existing.actor !== request.actor.trim()
      || existing.reason !== request.reason.trim()
      || (
        request.stablePrimaryEnabled !== undefined
        && existing.newStablePrimaryEnabled !== request.stablePrimaryEnabled
      )
    ) {
      return {
        ok: false,
        code: 'idempotency_conflict',
        message: 'The idempotency key was already used for a different transition',
        snapshot: current,
      };
    }
    if (request.expectedRevision !== existing.oldModeRevision) {
      return {
        ok: false,
        code: 'idempotency_conflict',
        message: 'Idempotent replay must use the transition original revision',
        snapshot: current,
      };
    }
    if (current.modeRevision > existing.newModeRevision) {
      return {
        ok: false,
        code: 'revision_conflict',
        message:
          `Transition replay was fenced by newer mode revision ${current.modeRevision}`,
        snapshot: current,
      };
    }
    return { ok: true, changed: false, eventId: existing.id, snapshot: current };
  }
  if (request.expectedRevision !== current.modeRevision) {
    return {
      ok: false,
      code: 'revision_conflict',
      message: `Expected mode revision ${request.expectedRevision}, found ${current.modeRevision}`,
      snapshot: current,
    };
  }
  if (
    !authoritativeCommand
    && (
      request.targetPhase === 'stable_primary'
      || request.targetPhase === 'rollback_legacy'
    )
  ) {
    return {
      ok: false,
      code: 'authoritative_command_required',
      message: `Transition to ${request.targetPhase} requires the connector-scoped operator command`,
      snapshot: current,
    };
  }
  const nextStableEnabled = request.stablePrimaryEnabled ?? current.stablePrimaryEnabled;
  if (
    request.targetPhase === current.phase
    && nextStableEnabled === current.stablePrimaryEnabled
  ) {
    return { ok: true, changed: false, eventId: null, snapshot: current };
  }
  if (!TRANSITIONS[current.phase].has(request.targetPhase)) {
    return {
      ok: false,
      code: 'invalid_transition',
      message: `GitHub identity phase cannot transition from ${current.phase} to ${request.targetPhase}`,
      snapshot: current,
    };
  }
  const requiredGate = (
    current.phase === 'rollback_legacy'
    && request.targetPhase === 'comparing'
  )
    ? 'rollback_verified'
    : REQUIRED_GATES[request.targetPhase];
  if (requiredGate && request.gate?.code !== requiredGate) {
    return {
      ok: false,
      code: 'gate_required',
      message: `Transition to ${request.targetPhase} requires the ${requiredGate} gate`,
      snapshot: current,
    };
  }
  if (requiredGate && request.gate?.passed !== true) {
    return {
      ok: false,
      code: 'gate_failed',
      message: `Transition gate ${requiredGate} did not pass`,
      snapshot: current,
    };
  }
  if (STABLE_AUTHORITATIVE_PHASES.has(request.targetPhase) && !nextStableEnabled) {
    return {
      ok: false,
      code: 'stable_flag_required',
      message: `${request.targetPhase} requires the connector stable flag to be enabled`,
      snapshot: current,
    };
  }
  if (
    (request.targetPhase === 'rollback_legacy' || request.targetPhase === 'comparing')
    && nextStableEnabled
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `${request.targetPhase} requires the stable flag to be disabled`,
      snapshot: current,
    };
  }
  if (request.targetPhase === 'comparing') {
    const unsafeLease = database.select({ id: taskSourceWriteLeases.id })
      .from(taskSourceWriteLeases)
      .where(and(
        eq(taskSourceWriteLeases.connectorInstanceId, request.connectorInstanceId),
        inArray(taskSourceWriteLeases.state, ['claimed', 'authorized', 'dispatched', 'unknown']),
      ))
      .limit(1)
      .get();
    if (unsafeLease) {
      return {
        ok: false,
        code: 'gate_failed',
        message: 'Comparison mode requires active and unknown GitHub write leases to be reconciled',
        snapshot: current,
      };
    }
    const unsafeWork = database.select({ id: connectorOperationLeases.connectorId })
      .from(connectorOperationLeases).where(and(
        eq(connectorOperationLeases.connectorId, request.connectorInstanceId),
        gt(connectorOperationLeases.leaseExpiresAt, now),
      )).limit(1).get()
      ?? database.select({ id: syncJobs.id }).from(syncJobs).where(and(
      eq(syncJobs.connectorId, request.connectorInstanceId),
      inArray(syncJobs.status, ['queued', 'running']),
    )).limit(1).get()
      ?? database.select({ id: dependencyReconciliationSnapshots.id })
        .from(dependencyReconciliationSnapshots)
        .where(and(
          eq(dependencyReconciliationSnapshots.connectorInstanceId, request.connectorInstanceId),
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
        )).limit(1).get()
      ?? database.select({ id: syncDeletionCandidates.id }).from(syncDeletionCandidates)
        .where(eq(syncDeletionCandidates.connectorId, request.connectorInstanceId)).limit(1).get()
      ?? database.select({ id: syncDeletionSnapshots.id }).from(syncDeletionSnapshots)
        .where(and(
          eq(syncDeletionSnapshots.connectorId, request.connectorInstanceId),
          inArray(syncDeletionSnapshots.recoveryState, ['restoring', 'pending']),
        )).limit(1).get();
    if (unsafeWork) {
      return {
        ok: false,
        code: 'gate_failed',
        message: 'Comparison mode requires queued work, dependency snapshots, deletion candidates, and recovery claims to be idle',
        snapshot: current,
      };
    }
  }

  const newModeRevision = current.modeRevision + 1;
  const newEffectiveMode = deriveGitHubIdentityEffectiveMode(
    request.targetPhase,
    nextStableEnabled,
  );
  database.update(githubIdentityMigrations).set({
    phase: request.targetPhase,
    updatedAt: now,
  }).where(eq(
    githubIdentityMigrations.connectorInstanceId,
    request.connectorInstanceId,
  )).run();
  const event = database.insert(githubIdentityModeEvents).values({
    connectorInstanceId: request.connectorInstanceId,
    idempotencyKey: request.idempotencyKey,
    oldPhase: current.phase,
    newPhase: request.targetPhase,
    oldEffectiveMode: current.effectiveMode,
    newEffectiveMode,
    oldStablePrimaryEnabled: current.stablePrimaryEnabled,
    newStablePrimaryEnabled: nextStableEnabled,
    oldModeRevision: current.modeRevision,
    newModeRevision,
    actor: request.actor.trim(),
    reason: request.reason.trim(),
    gateResultCode: request.gate?.code ?? 'not_required',
    createdAt: now,
  }).returning({ id: githubIdentityModeEvents.id }).get();
  database.insert(githubIdentityControls).values({
    connectorInstanceId: request.connectorInstanceId,
    stablePrimaryEnabled: nextStableEnabled,
    modeRevision: newModeRevision,
    lastModeEventId: event.id,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: githubIdentityControls.connectorInstanceId,
    set: {
      stablePrimaryEnabled: nextStableEnabled,
      modeRevision: newModeRevision,
      lastModeEventId: event.id,
      updatedAt: now,
    },
  }).run();
  return {
    ok: true,
    changed: true,
    eventId: event.id,
    snapshot: Object.freeze({
      connectorInstanceId: request.connectorInstanceId,
      phase: request.targetPhase,
      effectiveMode: newEffectiveMode,
      stablePrimaryEnabled: nextStableEnabled,
      modeRevision: newModeRevision,
      capturedAt: now,
    }),
  };
}

function validateRequest(request: GitHubIdentityTransitionRequest): string | null {
  if (!request.connectorInstanceId.trim()) return 'Connector instance ID is required';
  if (!request.actor.trim()) return 'Transition actor is required';
  if (request.actor.trim().length > 200) return 'Transition actor must not exceed 200 characters';
  if (!request.reason.trim()) return 'Transition reason is required';
  if (request.reason.trim().length > 500) return 'Transition reason must not exceed 500 characters';
  if (request.idempotencyKey.trim().length < 8) {
    return 'Transition idempotency key must be at least 8 characters';
  }
  if (request.idempotencyKey.trim().length > 200) {
    return 'Transition idempotency key must not exceed 200 characters';
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    return 'Expected mode revision must be a non-negative integer';
  }
  return null;
}
