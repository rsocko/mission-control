import { createHash, randomUUID } from 'crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import db, { runTransaction, sqlite } from '@/db';
import { syncLogger } from '@/lib/logger';
import {
  connectorOperationLeases,
  githubIdentityWriteCycles,
  sourceLists,
  taskSourceWriteLeaseTargets,
  taskSourceWriteLeases,
  tasks,
  type GitHubTaskWriteOperation,
} from '@/db/schema';
import { getGitHubIdentityModeSnapshotInTransaction } from './identity-mode';
import { GitHubStableIdentityRuntime } from './stable-identity-runtime';
import type { GitHubIdentityResolutionDecision } from './stable-identity-types';

const LEASE_MS = 60_000;
export class GitHubWriteFenceError extends Error {
  constructor(readonly code: string) {
    super(`GitHub write fenced: ${code}`);
    this.name = 'GitHubWriteFenceError';
  }
}

export class GitHubUnknownWriteOutcomeError extends Error {
  constructor(readonly leaseId: string, options?: ErrorOptions) {
    super('GitHub write outcome is unknown and requires explicit reconciliation', options);
    this.name = 'GitHubUnknownWriteOutcomeError';
  }
}

export interface GitHubWriteAuthorization {
  readonly leaseId: string;
  readonly token: string;
  readonly connectorInstanceId: string;
  readonly taskId: string;
  readonly operation: GitHubTaskWriteOperation;
  readonly sourceId: string;
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number | null;
  readonly expiresAt: string;
  readonly expectedTaskVersion?: string;
  readonly taskPushLeaseToken?: string;
  readonly targets: ReadonlyArray<{
    role: IdentityTarget['role'];
    owner: string;
    repository: string;
    issueNumber: number | null;
  }>;
}

export interface FencedGitHubConnector {
  type: string;
  preflightWriteRoute?: (route: GitHubWriteAuthorization) => Promise<{
    targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
  }>;
  runAuthorizedWrite?: <T>(
    route: GitHubWriteAuthorization,
    write: () => Promise<T>,
  ) => Promise<T>;
}

interface IdentityTarget {
  role: 'primary_issue' | 'parent_issue' | 'blocker_issue' | 'blocked_issue' | 'source_repository' | 'target_repository';
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

export function beginGitHubWriteCycle(options: {
  connectorInstanceId: string;
  modeSnapshot: { modeRevision: number };
  jobId?: string;
  pendingCandidateCount: number;
}): string {
  if (!Number.isSafeInteger(options.pendingCandidateCount) || options.pendingCandidateCount < 1) {
    throw new GitHubWriteFenceError('write_cycle_requires_candidates');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  return runTransaction((tx) => {
    const currentMode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      options.connectorInstanceId,
      now,
    );
    if (currentMode.modeRevision !== options.modeSnapshot.modeRevision) {
      throw new GitHubWriteFenceError('stale_write_cycle_mode');
    }
    const running = tx.select().from(githubIdentityWriteCycles).where(and(
      eq(githubIdentityWriteCycles.connectorInstanceId, options.connectorInstanceId),
      eq(githubIdentityWriteCycles.state, 'running'),
    )).limit(1).get();
    if (running) {
      if (running.reconciliationState !== 'unresolved') {
        throw new GitHubWriteFenceError('write_cycle_reconciliation_owned');
      }
      const activeOperation = tx.select({
        createdAt: connectorOperationLeases.createdAt,
      }).from(connectorOperationLeases).where(and(
        eq(connectorOperationLeases.connectorId, options.connectorInstanceId),
        sql`${connectorOperationLeases.leaseExpiresAt} > ${now}`,
      )).limit(1).get();
      if (activeOperation && activeOperation.createdAt <= running.startedAt) {
        throw new GitHubWriteFenceError('active_write_cycle');
      }
      tx.update(taskSourceWriteLeases).set({
        state: 'expired',
        finalizedAt: now,
        updatedAt: now,
      }).where(and(
        eq(taskSourceWriteLeases.writeCycleId, running.id),
        eq(taskSourceWriteLeases.connectorInstanceId, running.connectorInstanceId),
        eq(taskSourceWriteLeases.modeRevision, running.modeRevision),
        inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
        isNull(taskSourceWriteLeases.dispatchedAt),
        sql`${taskSourceWriteLeases.expiresAt} <= ${now}`,
      )).run();
      const leases = tx.select().from(taskSourceWriteLeases)
        .where(eq(taskSourceWriteLeases.writeCycleId, running.id))
        .all();
      if (leases.some((lease) =>
        lease.state === 'dispatched'
        || lease.state === 'unknown'
        || (
          ['claimed', 'authorized'].includes(lease.state)
          && lease.expiresAt > now
        ))) {
        throw new GitHubWriteFenceError('active_write_cycle');
      }
      const locallyFinalized = leases.length === running.pendingCandidateCount
        && leases.every((lease) =>
          ['succeeded', 'failed', 'blocked'].includes(lease.state)
          && lease.cycleOutcome === lease.state
          && lease.finalizedAt !== null);
      const changed = locallyFinalized
        ? tx.update(githubIdentityWriteCycles).set({
            observedRouteCount: leases.filter((lease) => lease.cycleObservedAt !== null).length,
            appliedCount: leases.filter((lease) => lease.cycleOutcome === 'succeeded').length,
            blockedCount: leases.filter((lease) => lease.cycleOutcome === 'blocked').length,
            failedCount: leases.filter((lease) => lease.cycleOutcome === 'failed').length,
            unknownCount: 0,
            state: 'completed',
            completedAt: now,
          }).where(and(
            eq(githubIdentityWriteCycles.id, running.id),
            eq(githubIdentityWriteCycles.state, 'running'),
            eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
          )).run().changes
        : tx.update(githubIdentityWriteCycles).set({
            state: 'interrupted',
            completedAt: now,
          }).where(and(
            eq(githubIdentityWriteCycles.id, running.id),
            eq(githubIdentityWriteCycles.state, 'running'),
            eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
          )).run().changes;
      if (changed !== 1) throw new GitHubWriteFenceError('write_cycle_replacement_lost');
    }
    tx.insert(githubIdentityWriteCycles).values({
      id,
      connectorInstanceId: options.connectorInstanceId,
      jobId: options.jobId,
      modeRevision: options.modeSnapshot.modeRevision,
      pendingCandidateCount: options.pendingCandidateCount,
      startedAt: now,
    }).run();
    return id;
  });
}

export function finishGitHubWriteCycle(
  id: string,
  outcome: { observed: number; applied: number; blocked: number; failed: number; unknown: number },
): boolean {
  const now = new Date().toISOString();
  const result = runTransaction((tx) => {
    const cycle = tx.select().from(githubIdentityWriteCycles)
      .where(eq(githubIdentityWriteCycles.id, id))
      .limit(1)
      .get();
    if (!cycle) return { changed: 0, complete: false };
    const mode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      cycle.connectorInstanceId,
      now,
    );
    if (mode.modeRevision !== cycle.modeRevision) return { changed: 0, complete: false };
    const complete = outcome.observed === cycle.pendingCandidateCount
      && outcome.applied + outcome.blocked + outcome.failed + outcome.unknown === outcome.observed;
    const changed = tx.update(githubIdentityWriteCycles).set({
      observedRouteCount: outcome.observed,
      appliedCount: outcome.applied,
      blockedCount: outcome.blocked,
      failedCount: outcome.failed,
      unknownCount: outcome.unknown,
      state: complete ? 'completed' : 'interrupted',
      completedAt: now,
    }).where(and(
      eq(githubIdentityWriteCycles.id, id),
      eq(githubIdentityWriteCycles.connectorInstanceId, cycle.connectorInstanceId),
      eq(githubIdentityWriteCycles.modeRevision, cycle.modeRevision),
      eq(githubIdentityWriteCycles.state, 'running'),
      eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
    )).run().changes;
    return { changed, complete };
  });
  return result.changed === 1 && result.complete;
}

/**
 * Durably records that a NodeID route was resolved for one lease. The route
 * evidence is the lease target rows plus `cycle_observed_at`; nothing depends
 * on a comparison record any more.
 */
function recordGitHubWriteCycleObservation(
  leaseId: string,
  decision: GitHubIdentityResolutionDecision,
): void {
  if (decision.appliedSource !== 'stable') {
    throw new GitHubWriteFenceError('write_cycle_observation_missing');
  }
  runTransaction((tx) => {
    const lease = tx.select().from(taskSourceWriteLeases)
      .where(and(
        eq(taskSourceWriteLeases.id, leaseId),
        eq(taskSourceWriteLeases.state, 'claimed'),
        isNull(taskSourceWriteLeases.cycleOutcome),
      ))
      .limit(1)
      .get();
    if (!lease?.writeCycleId) {
      throw new GitHubWriteFenceError('write_cycle_missing');
    }
    if (lease.cycleObservedAt) return;
    const now = new Date().toISOString();
    const mode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      lease.connectorInstanceId,
      now,
    );
    if (mode.modeRevision !== lease.modeRevision) {
      throw new GitHubWriteFenceError('write_cycle_observation_stale_mode');
    }
    const cycleChanged = tx.update(githubIdentityWriteCycles).set({
      observedRouteCount: sql`${githubIdentityWriteCycles.observedRouteCount} + 1`,
    }).where(and(
      eq(githubIdentityWriteCycles.id, lease.writeCycleId),
      eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
      eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
      eq(githubIdentityWriteCycles.state, 'running'),
      eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
    )).run().changes;
    if (cycleChanged !== 1) {
      throw new GitHubWriteFenceError('write_cycle_observation_lost');
    }
    const leaseChanged = tx.update(taskSourceWriteLeases).set({
      cycleObservedAt: now,
      updatedAt: now,
    }).where(and(
      eq(taskSourceWriteLeases.id, lease.id),
      eq(taskSourceWriteLeases.token, lease.token),
      eq(taskSourceWriteLeases.state, 'claimed'),
      isNull(taskSourceWriteLeases.cycleObservedAt),
    )).run();
    if (leaseChanged.changes !== 1) {
      throw new GitHubWriteFenceError('write_cycle_observation_lost');
    }
  });
}

/**
 * Freezes local route facts. The caller must perform its remote preflight after
 * this returns and call confirmGitHubWriteDispatch immediately before mutation.
 */
export function authorizeGitHubWrite(options: {
  connectorInstanceId: string;
  taskId: string;
  operation: GitHubTaskWriteOperation;
  identityRuntime?: GitHubStableIdentityRuntime;
  writeCycleId?: string | null;
  targetSourceListId?: string | null;
  expectedTaskVersion?: string;
  taskPushLeaseToken?: string;
  participantTaskIds?: ReadonlyArray<{
    role: 'parent_issue' | 'blocker_issue' | 'blocked_issue';
    taskId: string;
  }>;
}): GitHubWriteAuthorization {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = runTransaction((tx) => {
    const task = tx.select().from(tasks).where(and(
      eq(tasks.id, options.taskId),
      eq(tasks.connectorInstanceId, options.connectorInstanceId),
    )).limit(1).get();
    if (!task) throw new GitHubWriteFenceError('missing_task');
    if (
      (options.expectedTaskVersion && task.updatedAt !== options.expectedTaskVersion)
      || (
        options.taskPushLeaseToken
        && (
          task.syncStatus !== 'pushing'
          || task.lastSyncedAt !== options.taskPushLeaseToken
        )
      )
    ) {
      throw new GitHubWriteFenceError('stale_task_push_claim');
    }
    const mode = getGitHubIdentityModeSnapshotInTransaction(tx, options.connectorInstanceId, nowIso);
    const cycle = options.writeCycleId
      ? tx.select().from(githubIdentityWriteCycles).where(and(
          eq(githubIdentityWriteCycles.id, options.writeCycleId),
          eq(githubIdentityWriteCycles.connectorInstanceId, options.connectorInstanceId),
          eq(githubIdentityWriteCycles.state, 'running'),
          eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
        )).limit(1).get()
      : null;
    if (!cycle || cycle.modeRevision !== mode.modeRevision) {
      throw new GitHubWriteFenceError('stale_write_cycle');
    }
    if (hasOpenStableIdentityCollision(options.connectorInstanceId, 'task', task.id)) {
      throw new GitHubWriteFenceError('stable_identity_evidence_blocked');
    }
    const targets = loadTargets(
      options.connectorInstanceId,
      task.id,
      task.sourceListId,
      task.sourceId,
      options.operation,
      options.targetSourceListId,
      options.participantTaskIds,
    );
    if (!targets) throw new GitHubWriteFenceError('missing_or_inaccessible_identity');
    if (targets.some((target) => target.bindingState !== 'active')) {
      throw new GitHubWriteFenceError('stable_binding_not_active');
    }
    const leaseId = randomUUID();
    const { idempotencyKey, intent, initialCreate } = taskWriteIdentity(task, options.operation);
    const priorSuccess = intent
      ? tx.select({ id: taskSourceWriteLeases.id })
        .from(taskSourceWriteLeases)
        .where(and(
          eq(taskSourceWriteLeases.connectorInstanceId, options.connectorInstanceId),
          eq(taskSourceWriteLeases.taskId, task.id),
          eq(taskSourceWriteLeases.operation, options.operation),
          eq(taskSourceWriteLeases.modeRevision, mode.modeRevision),
          ...(initialCreate
            ? []
            : [
                eq(taskSourceWriteLeases.idempotencyKey, idempotencyKey),
                eq(taskSourceWriteLeases.intentKind, intent.kind),
                eq(taskSourceWriteLeases.intentDigest, intent.digest),
              ]),
          eq(taskSourceWriteLeases.state, 'succeeded'),
          eq(taskSourceWriteLeases.cycleOutcome, 'succeeded'),
        ))
        .limit(10)
        .all()
        .find((lease) => currentLeaseTargetsMatch(lease.id, true))
      : null;
    if (priorSuccess) throw new GitHubWriteFenceError('write_already_succeeded');
    try {
      tx.insert(taskSourceWriteLeases).values({
        id: leaseId,
        token,
        connectorInstanceId: options.connectorInstanceId,
        taskId: task.id,
        operation: options.operation,
        taskVersion: task.updatedAt,
        idempotencyKey,
        modeRevision: mode.modeRevision,
        writeCycleId: options.writeCycleId,
        intentKind: intent?.kind,
        intentDigest: intent?.digest,
        expiresAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
    } catch {
      throw new GitHubWriteFenceError('active_or_unknown_lease');
    }
    tx.insert(taskSourceWriteLeaseTargets).values(targets.map((target) => ({
      leaseId,
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
    }))).run();
    return { task, mode, leaseId, targets };
  });

  if (!options.identityRuntime) {
    blockGitHubWrite(result.leaseId, token, 'missing_identity_runtime');
    throw new GitHubWriteFenceError('missing_identity_runtime');
  }
  const primary = result.targets.find((target) => target.role === 'primary_issue')
    ?? result.targets.find((target) => target.role === 'target_repository')
    ?? result.targets.find((target) => target.role === 'source_repository');
  if (!primary) {
    blockGitHubWrite(result.leaseId, token, 'missing_or_inaccessible_identity');
    throw new GitHubWriteFenceError('missing_or_inaccessible_identity');
  }
  try {
    const [decision] = options.identityRuntime.applyResolvedBatch('write_route', [{
      candidateKey: `write:${result.task.id}:${options.operation}:${result.leaseId}`,
      localTaskId: result.task.id,
      localSourceListId: result.task.sourceListId ?? undefined,
      stable: {
        selectedLocalIds: [result.task.id],
        action: isLocalOnlySourceId(result.task.sourceId, result.task.id) ? 'create' : 'update',
        evidence: 'verified',
        externalEntityId: primary.entityId,
        stableIdDigest: digestLocator(primary.hostKey, primary.entityId, null),
        locatorRevision: primary.locatorRevision,
        bindingRevision: primary.bindingRevision || undefined,
        bindingState: primary.bindingState as 'shadow' | 'active' | 'collision' | 'retired',
      },
    }]);
    recordGitHubWriteCycleObservation(result.leaseId, decision);
  } catch (error) {
    blockGitHubWrite(result.leaseId, token, 'identity_route_resolution_failed');
    throw error;
  }

  const route = result.targets.find((target) => target.role === 'primary_issue')
    ?? result.targets.find((target) => target.role === 'target_repository')
    ?? result.targets.find((target) => target.role === 'source_repository');
  const parsed = parseLocatorSourceId(result.task.sourceId);
  return Object.freeze({
    leaseId: result.leaseId,
    token,
    connectorInstanceId: options.connectorInstanceId,
    taskId: result.task.id,
    operation: options.operation,
    sourceId: result.task.sourceId,
    owner: route?.owner ?? parsed?.owner ?? '',
    repository: route?.repository ?? parsed?.repository ?? '',
    issueNumber: route?.issueNumber ?? parsed?.issueNumber ?? null,
    expiresAt,
    expectedTaskVersion: options.expectedTaskVersion,
    taskPushLeaseToken: options.taskPushLeaseToken,
    targets: Object.freeze(result.targets.map((target) => Object.freeze({
      role: target.role,
      owner: target.owner,
      repository: target.repository,
      issueNumber: target.issueNumber,
    }))),
  });
}

export function hasSucceededGitHubWrite(options: {
  connectorInstanceId: string;
  taskId: string;
  operation: GitHubTaskWriteOperation;
  expectedTaskVersion: string;
  taskPushLeaseToken: string;
}): boolean {
  const task = db.select().from(tasks).where(and(
    eq(tasks.id, options.taskId),
    eq(tasks.connectorInstanceId, options.connectorInstanceId),
    eq(tasks.updatedAt, options.expectedTaskVersion),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, options.taskPushLeaseToken),
  )).limit(1).get();
  if (!task) return false;
  const { idempotencyKey, intent, initialCreate } = taskWriteIdentity(task, options.operation);
  if (!intent) return false;
  const mode = getGitHubIdentityModeSnapshotInTransaction(
    db,
    options.connectorInstanceId,
    new Date().toISOString(),
  );
  return db.select({ id: taskSourceWriteLeases.id })
    .from(taskSourceWriteLeases)
    .where(and(
      eq(taskSourceWriteLeases.connectorInstanceId, options.connectorInstanceId),
      eq(taskSourceWriteLeases.taskId, task.id),
      eq(taskSourceWriteLeases.operation, options.operation),
      eq(taskSourceWriteLeases.modeRevision, mode.modeRevision),
      ...(initialCreate
        ? []
        : [
            eq(taskSourceWriteLeases.idempotencyKey, idempotencyKey),
            eq(taskSourceWriteLeases.intentKind, intent.kind),
            eq(taskSourceWriteLeases.intentDigest, intent.digest),
          ]),
      eq(taskSourceWriteLeases.state, 'succeeded'),
      eq(taskSourceWriteLeases.cycleOutcome, 'succeeded'),
    ))
    .limit(10)
    .all()
    .some((lease) => currentLeaseTargetsMatch(lease.id, true));
}

export function authorizeGitHubSourceWrite(options: {
  connectorInstanceId: string;
  sourceListId: string;
  operation: 'create' | 'label';
  identityRuntime?: GitHubStableIdentityRuntime;
  writeCycleId?: string | null;
}): GitHubWriteAuthorization {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = runTransaction((tx) => {
    const sourceList = tx.select().from(sourceLists).where(and(
      eq(sourceLists.connectorInstanceId, options.connectorInstanceId),
      eq(sourceLists.id, options.sourceListId),
    )).limit(1).get();
    if (!sourceList) throw new GitHubWriteFenceError('missing_source_list');
    const mode = getGitHubIdentityModeSnapshotInTransaction(tx, options.connectorInstanceId, nowIso);
    const cycle = options.writeCycleId
      ? tx.select().from(githubIdentityWriteCycles).where(and(
          eq(githubIdentityWriteCycles.id, options.writeCycleId),
          eq(githubIdentityWriteCycles.connectorInstanceId, options.connectorInstanceId),
          eq(githubIdentityWriteCycles.state, 'running'),
          eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
        )).limit(1).get()
      : null;
    if (!cycle || cycle.modeRevision !== mode.modeRevision) {
      throw new GitHubWriteFenceError('stale_write_cycle');
    }
    if (hasOpenStableIdentityCollision(
      options.connectorInstanceId,
      'source_list',
      sourceList.id,
    )) {
      throw new GitHubWriteFenceError('stable_identity_evidence_blocked');
    }
    const target = identityForBinding(
      options.connectorInstanceId,
      'source_list',
      sourceList.id,
      'source_repository',
    );
    if (!target) throw new GitHubWriteFenceError('missing_or_inaccessible_identity');
    if (target.bindingState !== 'active') {
      throw new GitHubWriteFenceError('stable_binding_not_active');
    }
    const leaseId = randomUUID();
    const idempotencyKey = `source-list:${sourceList.id}:${options.operation}:${sourceList.sourceId}`;
    try {
      tx.insert(taskSourceWriteLeases).values({
        id: leaseId,
        token,
        connectorInstanceId: options.connectorInstanceId,
        taskId: `source-list:${sourceList.id}`,
        operation: options.operation,
        taskVersion: sourceList.sourceId,
        idempotencyKey,
        modeRevision: mode.modeRevision,
        writeCycleId: options.writeCycleId,
        expiresAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
    } catch {
      throw new GitHubWriteFenceError('active_or_unknown_lease');
    }
    tx.insert(taskSourceWriteLeaseTargets).values({
      leaseId,
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
    }).run();
    return { sourceList, mode, target, leaseId };
  });

  if (!options.identityRuntime) {
    blockGitHubWrite(result.leaseId, token, 'missing_identity_runtime');
    throw new GitHubWriteFenceError('missing_identity_runtime');
  }
  try {
    const [decision] = options.identityRuntime.applyResolvedBatch('write_route', [{
      candidateKey: `write:source-list:${result.sourceList.id}:${options.operation}:${result.leaseId}`,
      localSourceListId: result.sourceList.id,
      stable: {
        selectedLocalIds: [result.sourceList.id],
        action: options.operation === 'create' ? 'create' : 'update',
        evidence: 'verified',
        externalEntityId: result.target.entityId,
        stableIdDigest: digestLocator(result.target.hostKey, result.target.entityId, null),
        locatorRevision: result.target.locatorRevision,
        bindingRevision: result.target.bindingRevision || undefined,
        bindingState: result.target.bindingState as 'shadow' | 'active' | 'collision' | 'retired',
      },
    }]);
    recordGitHubWriteCycleObservation(result.leaseId, decision);
  } catch (error) {
    blockGitHubWrite(result.leaseId, token, 'identity_route_resolution_failed');
    throw error;
  }

  return Object.freeze({
    leaseId: result.leaseId,
    token,
    connectorInstanceId: options.connectorInstanceId,
    taskId: `source-list:${result.sourceList.id}`,
    operation: options.operation,
    sourceId: result.sourceList.sourceId,
    owner: result.target.owner,
    repository: result.target.repository,
    issueNumber: null,
    expiresAt,
    targets: Object.freeze([Object.freeze({
      role: result.target.role,
      owner: result.target.owner,
      repository: result.target.repository,
      issueNumber: null,
    })]),
  });
}

/**
 * The final short transaction intentionally contains no network activity.
 * Re-querying locators makes a rename, replacement, mode change, or task edit
 * between preflight and dispatch fail closed.
 */
export function assertGitHubWriteCycleCurrent(
  authorization: GitHubWriteAuthorization,
): void {
  const now = new Date().toISOString();
  const current = runTransaction((tx) => {
    const lease = tx.select().from(taskSourceWriteLeases).where(and(
      eq(taskSourceWriteLeases.id, authorization.leaseId),
      eq(taskSourceWriteLeases.token, authorization.token),
      inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
    )).limit(1).get();
    if (!lease) return false;
    if (authorization.expectedTaskVersion || authorization.taskPushLeaseToken) {
      const task = tx.select().from(tasks).where(and(
        eq(tasks.id, authorization.taskId),
        eq(tasks.connectorInstanceId, authorization.connectorInstanceId),
      )).limit(1).get();
      if (
        !task
        || (
          authorization.expectedTaskVersion
          && task.updatedAt !== authorization.expectedTaskVersion
        )
        || (
          authorization.taskPushLeaseToken
          && (
            task.syncStatus !== 'pushing'
            || task.lastSyncedAt !== authorization.taskPushLeaseToken
          )
        )
      ) return false;
    }
    if (!lease.writeCycleId) return false;
    const mode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      authorization.connectorInstanceId,
      now,
    );
    if (mode.modeRevision !== lease.modeRevision) return false;
    return Boolean(tx.select({ id: githubIdentityWriteCycles.id })
      .from(githubIdentityWriteCycles)
      .where(and(
        eq(githubIdentityWriteCycles.id, lease.writeCycleId),
        eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
        eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
        eq(githubIdentityWriteCycles.state, 'running'),
        eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
      )).limit(1).get());
  });
  if (!current) throw new GitHubWriteFenceError('stale_write_cycle');
}

export function confirmGitHubWriteDispatch(authorization: GitHubWriteAuthorization): void {
  const now = new Date().toISOString();
  const changes = runTransaction((tx) => {
    const lease = tx.select().from(taskSourceWriteLeases).where(and(
      eq(taskSourceWriteLeases.id, authorization.leaseId),
      eq(taskSourceWriteLeases.token, authorization.token),
      eq(taskSourceWriteLeases.state, 'claimed'),
    )).limit(1).get();
    if (!lease || lease.expiresAt <= now) return 0;
    const cycle = lease.writeCycleId
      ? tx.select().from(githubIdentityWriteCycles).where(and(
          eq(githubIdentityWriteCycles.id, lease.writeCycleId),
          eq(githubIdentityWriteCycles.connectorInstanceId, authorization.connectorInstanceId),
          eq(githubIdentityWriteCycles.state, 'running'),
          eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
        )).limit(1).get()
      : null;
    const mode = getGitHubIdentityModeSnapshotInTransaction(tx, authorization.connectorInstanceId, now);
    const sourceListSubject = authorization.taskId.startsWith('source-list:')
      ? tx.select().from(sourceLists).where(and(
        eq(sourceLists.id, authorization.taskId.slice('source-list:'.length)),
        eq(sourceLists.connectorInstanceId, authorization.connectorInstanceId),
      )).limit(1).get()
      : null;
    const task = sourceListSubject
      ? null
      : tx.select().from(tasks).where(eq(tasks.id, authorization.taskId)).limit(1).get();
    if (
      (!task && !sourceListSubject)
      || (task && task.connectorInstanceId !== authorization.connectorInstanceId)
      || (task && task.updatedAt !== lease.taskVersion)
      || (
        task
        && authorization.taskPushLeaseToken
        && (
          task.syncStatus !== 'pushing'
          || task.lastSyncedAt !== authorization.taskPushLeaseToken
        )
      )
      || (sourceListSubject && sourceListSubject.sourceId !== lease.taskVersion)
      || mode.modeRevision !== lease.modeRevision
      || lease.cycleObservedAt === null
      || !cycle
      || cycle.modeRevision !== lease.modeRevision
      || !currentLeaseTargetsMatch(authorization.leaseId)
    ) return 0;
    return tx.update(taskSourceWriteLeases).set({
      state: 'dispatched',
      dispatchedAt: now,
      updatedAt: now,
    }).where(and(
      eq(taskSourceWriteLeases.id, authorization.leaseId),
      eq(taskSourceWriteLeases.token, authorization.token),
      eq(taskSourceWriteLeases.state, 'claimed'),
    )).run().changes;
  });
  if (changes !== 1) {
    blockGitHubWrite(authorization.leaseId, authorization.token, 'stale_mode_lease_or_locator');
    throw new GitHubWriteFenceError('stale_mode_lease_or_locator');
  }
}

export function verifyGitHubWritePreflight(
  authorization: GitHubWriteAuthorization,
  observed: { targets: Record<string, { repositoryStableId: string; issueStableId?: string }> },
): void {
  const rows = sqlite.prepare(`
    SELECT target.role AS role, entity.entity_type AS entityType, entity.stable_id AS stableId,
      repository.stable_id AS repositoryStableId
    FROM task_source_write_lease_targets AS target
    JOIN external_entities AS entity ON entity.id = target.external_entity_id
    LEFT JOIN external_entities AS repository ON repository.id = target.repository_entity_id
    WHERE target.lease_id = ?
  `).all(authorization.leaseId) as Array<{
    role: string; entityType: 'issue' | 'repository'; stableId: string; repositoryStableId: string | null;
  }>;
  if (rows.length === 0 || rows.some((row) => {
    const value = observed.targets[row.role];
    return !value || (row.entityType === 'issue'
      ? value.issueStableId !== row.stableId || value.repositoryStableId !== row.repositoryStableId
      : value.repositoryStableId !== row.stableId);
  })) {
    blockGitHubWrite(authorization.leaseId, authorization.token, 'remote_identity_disagreement');
    throw new GitHubWriteFenceError('remote_identity_disagreement');
  }
}

export function finalizeGitHubWrite(
  authorization: GitHubWriteAuthorization,
  outcome: 'succeeded' | 'failed' | 'unknown',
  reason?: string,
  result?: unknown,
): void {
  const now = new Date().toISOString();
  const safeReason = reason?.replace(/[^a-z0-9_:-]/gi, '_').slice(0, 100) ?? null;
  const allowedStates = outcome === 'failed'
    ? ['claimed', 'authorized', 'dispatched'] as const
    : ['dispatched', 'authorized'] as const;
  const changed = runTransaction((tx) => {
    const lease = tx.select().from(taskSourceWriteLeases).where(and(
      eq(taskSourceWriteLeases.id, authorization.leaseId),
      eq(taskSourceWriteLeases.token, authorization.token),
      inArray(taskSourceWriteLeases.state, allowedStates),
    )).limit(1).get();
    if (!lease) return 0;
    if (
      lease.writeCycleId
      && (outcome !== 'failed' || lease.dispatchedAt !== null)
    ) {
      const cycle = tx.select({ id: githubIdentityWriteCycles.id })
        .from(githubIdentityWriteCycles)
        .where(and(
          eq(githubIdentityWriteCycles.id, lease.writeCycleId),
          eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
          eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
          eq(githubIdentityWriteCycles.state, 'running'),
          eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
        )).limit(1).get();
      if (!cycle) return 0;
    }
    const leaseUpdate = tx.update(taskSourceWriteLeases).set({
      state: outcome,
      cycleOutcome: outcome,
      unknownReason: outcome === 'unknown' ? safeReason ?? 'unknown_post_dispatch_outcome' : null,
      blockReason: outcome === 'failed' ? safeReason : null,
      resultDigest: outcome === 'succeeded' ? digestWriteResult(result) : null,
      finalizedAt: now,
      updatedAt: now,
    }).where(and(
      eq(taskSourceWriteLeases.id, authorization.leaseId),
      eq(taskSourceWriteLeases.token, authorization.token),
      inArray(taskSourceWriteLeases.state, allowedStates),
    )).run().changes;
    if (leaseUpdate === 1 && lease.writeCycleId && !lease.cycleOutcome) {
      if (incrementGitHubWriteCycleOutcome(lease.writeCycleId, outcome) !== 1) {
        throw new GitHubWriteFenceError('write_cycle_outcome_lost');
      }
    }
    if (leaseUpdate === 1 && outcome === 'succeeded') {
      sqlite.prepare(`
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
      `).run(
        now,
        lease.connectorInstanceId,
        lease.idempotencyKey,
        lease.id,
      );
    }
    return leaseUpdate;
  });
  if (changed !== 1) throw new GitHubWriteFenceError('lease_finalization_lost');
}

export function quarantineUnknownGitHubWrite(
  authorization: GitHubWriteAuthorization,
  cause: unknown,
): never {
  try {
    finalizeGitHubWrite(authorization, 'unknown', 'unknown_post_dispatch_outcome');
  } catch (finalizationError) {
    throw new GitHubUnknownWriteOutcomeError(authorization.leaseId, {
      cause: new AggregateError(
        [cause, finalizationError],
        'GitHub write dispatch and quarantine finalization both failed',
      ),
    });
  }
  throw new GitHubUnknownWriteOutcomeError(authorization.leaseId, { cause });
}

export function blockGitHubWrite(leaseId: string, token: string, code: string): boolean {
  const now = new Date().toISOString();
  const result = runTransaction((tx) => {
    const lease = tx.select().from(taskSourceWriteLeases).where(and(
      eq(taskSourceWriteLeases.id, leaseId),
      eq(taskSourceWriteLeases.token, token),
      inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
    )).limit(1).get();
    if (!lease) return 'unchanged';
    if (lease.writeCycleId) {
      const cycle = tx.select({ id: githubIdentityWriteCycles.id })
        .from(githubIdentityWriteCycles)
        .where(and(
          eq(githubIdentityWriteCycles.id, lease.writeCycleId),
          eq(githubIdentityWriteCycles.connectorInstanceId, lease.connectorInstanceId),
          eq(githubIdentityWriteCycles.modeRevision, lease.modeRevision),
          eq(githubIdentityWriteCycles.state, 'running'),
          eq(githubIdentityWriteCycles.reconciliationState, 'unresolved'),
        )).limit(1).get();
      if (!cycle) return 'cycle_lost';
    }
    const changed = tx.update(taskSourceWriteLeases).set({
      state: 'blocked',
      cycleOutcome: 'blocked',
      blockReason: code.slice(0, 100),
      finalizedAt: now,
      updatedAt: now,
    }).where(and(
      eq(taskSourceWriteLeases.id, leaseId),
      eq(taskSourceWriteLeases.token, token),
      inArray(taskSourceWriteLeases.state, ['claimed', 'authorized']),
    )).run().changes;
    if (changed === 1 && lease.writeCycleId && !lease.cycleOutcome) {
      if (incrementGitHubWriteCycleOutcome(lease.writeCycleId, 'blocked') !== 1) {
        throw new GitHubWriteFenceError('write_cycle_outcome_lost');
      }
    }
    return changed === 1 ? 'blocked' : 'unchanged';
  });
  return result === 'blocked';
}

function incrementGitHubWriteCycleOutcome(
  cycleId: string,
  outcome: 'succeeded' | 'failed' | 'blocked' | 'unknown',
): number {
  const column = {
    succeeded: 'applied_count',
    failed: 'failed_count',
    blocked: 'blocked_count',
    unknown: 'unknown_count',
  }[outcome];
  return sqlite.prepare(`
    UPDATE github_identity_write_cycles
    SET ${column} = ${column} + 1
    WHERE id = ?
      AND state = 'running'
      AND reconciliation_state = 'unresolved'
  `).run(cycleId).changes;
}

function loadTargets(
  connectorId: string,
  taskId: string,
  sourceListId: string | null,
  sourceId: string,
  operation: GitHubTaskWriteOperation,
  targetSourceListId?: string | null,
  participants?: ReadonlyArray<{ role: 'parent_issue' | 'blocker_issue' | 'blocked_issue'; taskId: string }>,
): IdentityTarget[] | null {
  const result: IdentityTarget[] = [];
  const localCreation = sourceId.startsWith('local:') || sourceId === taskId;
  const issue = localCreation ? null : identityForBinding(connectorId, 'task', taskId, 'primary_issue');
  if (!localCreation && !issue) return null;
  if (issue) result.push(issue);
  const localSourceListId = sourceListId
    ? resolveLocalSourceListId(connectorId, sourceListId)
    : null;
  const sourceList = localSourceListId
    ? identityForBinding(connectorId, 'source_list', localSourceListId, 'source_repository')
    : issue ? repositoryForIssue(issue, 'source_repository') : null;
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

  function resolveLocalSourceListId(connectorId: string, sourceListId: string): string | null {
    const row = sqlite.prepare(`
      SELECT id
      FROM source_lists
      WHERE connector_instance_id = ?
        AND (id = ? OR lower(source_id) = lower(?))
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(connectorId, sourceListId, sourceListId, sourceListId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  for (const participant of participants ?? []) {
    const identity = identityForBinding(connectorId, 'task', participant.taskId, participant.role);
    if (!identity) return null;
    result.push(identity);
  }
  if (operation === 'create' && !result.some((target) => target.role === 'source_repository')) return null;
  return result;
}

function identityForBinding(
  connectorId: string,
  bindingType: 'task' | 'source_list',
  localId: string,
  role: IdentityTarget['role'],
): IdentityTarget | null {
  const row = sqlite.prepare(`
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
  `).get(connectorId, bindingType, localId) as {
    entityId: string; hostKey: string; repositoryEntityId: string | null; locatorRevision: number;
    owner: string; repository: string; issueNumber: number | null; bindingState: string; bindingRevision: string;
  } | undefined;
  if (!row || !['shadow', 'active'].includes(row.bindingState) || !row.bindingRevision) return null;
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

/**
 * Blocks a write while the connector still has an open, unresolved NodeID
 * collision for this local row. `github_identity_collisions` is the canonical
 * durable record; no comparison evidence is consulted.
 */
function hasOpenStableIdentityCollision(
  connectorInstanceId: string,
  bindingType: 'task' | 'source_list',
  localId: string,
): boolean {
  const row = sqlite.prepare(`
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
  `).get(connectorInstanceId, bindingType, localId);
  return row !== undefined;
}

function repositoryForIssue(issue: IdentityTarget, role: IdentityTarget['role']): IdentityTarget | null {
  if (!issue.repositoryEntityId) return null;
  const row = sqlite.prepare(`
    SELECT entity.id AS entityId, entity.host_key AS hostKey, locator.locator_revision AS locatorRevision,
      locator.owner, locator.repository
    FROM external_entities AS entity
    JOIN external_entity_locators AS locator ON locator.external_entity_id = entity.id AND locator.valid_to IS NULL
    WHERE entity.id = ? AND entity.provider = 'github' AND entity.entity_type = 'repository'
  `).get(issue.repositoryEntityId) as {
    entityId: string; hostKey: string; locatorRevision: number; owner: string; repository: string;
  } | undefined;
  return row ? {
    ...row,
    role,
    repositoryEntityId: null,
    issueNumber: null,
    bindingRevision: '',
    bindingState: issue.bindingState,
  } : null;
}

function currentLeaseTargetsMatch(leaseId: string, requireTargets = false): boolean {
  if (
    requireTargets
    && !sqlite.prepare(`
      SELECT 1
      FROM task_source_write_lease_targets
      WHERE lease_id = ?
      LIMIT 1
    `).get(leaseId)
  ) return false;
  const mismatch = sqlite.prepare(`
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
        -- A repository target derived from an issue has no binding of its own;
        -- it is frozen with an empty binding revision and checked by locator.
        OR (
          COALESCE(target.binding_revision, '') != ''
          AND (binding.id IS NULL OR binding.verified_at != target.binding_revision)
        )
        OR locator.locator_revision != target.locator_revision
        OR lower(locator.owner) != lower(target.owner)
        OR lower(locator.repository) != lower(target.repository)
        OR COALESCE(locator.issue_number, -1) != COALESCE(target.issue_number, -1)
      )
  `).get(leaseId) as { value: number };
  return mismatch.value === 0;
}

/**
 * Parses the mutable `owner/repo:number` locator for display and for the
 * fallback route fields on the authorization. It never establishes identity.
 */
function parseLocatorSourceId(
  sourceId: string,
): { owner: string; repository: string; issueNumber: number } | null {
  const match = /^([^/:]+)\/([^/:]+):(\d+)$/.exec(sourceId);
  return match ? { owner: match[1], repository: match[2], issueNumber: Number(match[3]) } : null;
}

function isLocalOnlySourceId(sourceId: string, taskId: string): boolean {
  return sourceId.startsWith('local:') || sourceId === taskId;
}

function digestLocator(...values: Array<string | number | null>): string {
  return createHash('sha256').update(values.map((value) => value ?? '').join('\u0000')).digest('hex');
}

function taskWriteIdentity(
  task: typeof tasks.$inferSelect,
  operation: GitHubTaskWriteOperation,
): {
  idempotencyKey: string;
  intent: { kind: string; digest: string } | null;
  initialCreate: boolean;
} {
  const initialCreate = operation === 'create'
    || (operation === 'sub_issue' && task.isChecklistItem && task.sourceId === task.id);
  return {
    idempotencyKey: `${task.id}:${operation}:${task.updatedAt}`,
    intent: taskWriteIntent(task, operation),
    initialCreate,
  };
}

function taskWriteIntent(
  task: typeof tasks.$inferSelect,
  operation: GitHubTaskWriteOperation,
): { kind: string; digest: string } | null {
  if (operation === 'complete') {
    return {
      kind: 'issue_state_closed_v1',
      digest: digestWriteResult({ state: 'closed', stateReason: 'completed' }),
    };
  }
  if (operation === 'create' || operation === 'update') {
    return {
      kind: 'task_projection_v1',
      digest: digestWriteResult({
        title: task.title,
        description: task.description ?? '',
        status: task.status,
        priority: task.priority,
        effort: task.effort,
        dueDate: task.dueDate,
        microStatus: task.microStatus,
      }),
    };
  }
  if (operation === 'delete') {
    return {
      kind: 'issue_delete_v1',
      digest: digestWriteResult({ sourceId: task.sourceId }),
    };
  }
  if (operation === 'sub_issue') {
    return {
      kind: task.sourceId === task.id
        ? 'sub_issue_create_projection_v1'
        : 'sub_issue_projection_v1',
      digest: digestWriteResult({
        parentId: task.parentId,
        sourceId: task.sourceId,
        title: task.title,
        status: task.status,
      }),
    };
  }
  return null;
}

function digestWriteResult(value: unknown): string {
  const serialized = value === undefined
    ? 'undefined'
    : JSON.stringify(value, Object.keys(
        value !== null && typeof value === 'object'
          ? value as Record<string, unknown>
          : {},
      ).sort());
  return createHash('sha256').update(serialized).digest('hex');
}

export function expireUndispatchedGitHubWriteLeases(now = new Date().toISOString()): number {
  return sqlite.prepare(`
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
  `).run(now, now, now).changes;
}

function completeGitHubWriteCycleScope(options: {
  cycleId: string;
  runtime?: GitHubStableIdentityRuntime;
  runtimeState: Parameters<GitHubStableIdentityRuntime['complete']>[0];
  runtimeReason: string;
  outcome: { observed: number; applied: number; blocked: number; failed: number; unknown: number };
  primaryFailure: { error: unknown } | null;
}): void {
  const cleanupFailureCodes: string[] = [];
  try {
    options.runtime?.complete(options.runtimeState, options.runtimeReason);
  } catch (error) {
    cleanupFailureCodes.push(cleanupFailureCode(error));
  }
  if (!finishGitHubWriteCycle(options.cycleId, options.outcome)) {
    cleanupFailureCodes.push('write_cycle_finish_not_committed');
  }
  if (cleanupFailureCodes.length === 0) return;
  syncLogger.error({
    cycleId: options.cycleId,
    cleanupFailureCodes,
    primaryFailureCode: options.primaryFailure
      ? cleanupFailureCode(options.primaryFailure.error)
      : null,
  }, 'GitHub write-cycle cleanup did not complete');
}

function cleanupFailureCode(error: unknown): string {
  if (error instanceof GitHubWriteFenceError) return error.code;
  if (error instanceof GitHubUnknownWriteOutcomeError) return 'unknown_write_outcome';
  return error instanceof Error ? error.name : 'unknown_error';
}

/**
 * Use this at API and relationship callers that are outside a sync job. It
 * creates a one-candidate write cycle so direct writes cannot bypass NodeID
 * route resolution or the token-qualified dispatch CAS.
 */
export async function executeFencedGitHubTaskMutation<T>(options: {
  connectorInstanceId: string;
  taskId: string;
  operation: GitHubTaskWriteOperation;
  connector: FencedGitHubConnector;
  write: () => Promise<T>;
  targetSourceListId?: string | null;
  participantTaskIds?: ReadonlyArray<{
    role: 'parent_issue' | 'blocker_issue' | 'blocked_issue';
    taskId: string;
  }>;
}): Promise<T> {
  if (options.connector.type !== 'github-issues') return options.write();
  const snapshot = getGitHubIdentityModeSnapshotInTransaction(
    db,
    options.connectorInstanceId,
  );
  const cycleId = beginGitHubWriteCycle({
    connectorInstanceId: options.connectorInstanceId,
    modeSnapshot: snapshot,
    pendingCandidateCount: 1,
  });
  const runtime = new GitHubStableIdentityRuntime({
    connectorInstanceId: options.connectorInstanceId,
    modeSnapshot: snapshot,
    syncKind: 'incremental',
  });
  let dispatched = false;
  let observed = false;
  let outcome: 'succeeded' | 'failed' | 'unknown' | 'blocked' = 'failed';
  let primaryFailure: { error: unknown } | null = null;
  let authorization: GitHubWriteAuthorization | undefined;
  try {
    authorization = authorizeGitHubWrite({
      connectorInstanceId: options.connectorInstanceId,
      taskId: options.taskId,
      operation: options.operation,
      identityRuntime: runtime,
      writeCycleId: cycleId,
      targetSourceListId: options.targetSourceListId,
      participantTaskIds: options.participantTaskIds,
    });
    observed = true;
    if (!options.connector.preflightWriteRoute || !options.connector.runAuthorizedWrite) {
      blockGitHubWrite(authorization.leaseId, authorization.token, 'missing_write_fence_adapter');
      throw new GitHubWriteFenceError('missing_write_fence_adapter');
    }
    assertGitHubWriteCycleCurrent(authorization);
    const preflight = await options.connector.preflightWriteRoute(authorization);
    verifyGitHubWritePreflight(authorization, preflight);
    confirmGitHubWriteDispatch(authorization);
    dispatched = true;
    const value = await options.connector.runAuthorizedWrite(authorization, options.write);
    finalizeGitHubWrite(authorization, 'succeeded', undefined, value);
    outcome = 'succeeded';
    return value;
  } catch (error) {
    primaryFailure = { error };
    if (authorization && dispatched) {
      outcome = 'unknown';
      // A fence failure after dispatch is also ambiguous if an earlier step mutated GitHub.
      try {
        quarantineUnknownGitHubWrite(authorization, error);
      } catch (quarantineError) {
        primaryFailure = { error: quarantineError };
        throw quarantineError;
      }
    }
    if (error instanceof GitHubWriteFenceError) {
      outcome = 'blocked';
      throw error;
    }
    if (authorization) {
      try {
        finalizeGitHubWrite(authorization, 'failed', 'definitive_pre_dispatch_failure');
      } catch (finalizationError) {
        const combined = new AggregateError(
          [error, finalizationError],
          'GitHub write failure and lease finalization failure',
        );
        primaryFailure = { error: combined };
        throw combined;
      }
    }
    throw error;
  } finally {
    completeGitHubWriteCycleScope({
      cycleId,
      runtime,
      runtimeState: outcome === 'succeeded' ? 'succeeded' : 'failed',
      runtimeReason: outcome,
      outcome: {
        observed: observed ? 1 : 0,
        applied: outcome === 'succeeded' ? 1 : 0,
        blocked: outcome === 'blocked' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        unknown: outcome === 'unknown' ? 1 : 0,
      },
      primaryFailure,
    });
  }
}

export async function executeFencedGitHubSourceMutation<T>(options: {
  connectorInstanceId: string;
  sourceListId: string;
  operation: 'create' | 'label';
  connector: FencedGitHubConnector;
  write: () => Promise<T>;
}): Promise<T> {
  if (options.connector.type !== 'github-issues') return options.write();
  const snapshot = getGitHubIdentityModeSnapshotInTransaction(db, options.connectorInstanceId);
  const cycleId = beginGitHubWriteCycle({
    connectorInstanceId: options.connectorInstanceId,
    modeSnapshot: snapshot,
    pendingCandidateCount: 1,
  });
  const runtime = new GitHubStableIdentityRuntime({
    connectorInstanceId: options.connectorInstanceId,
    modeSnapshot: snapshot,
    syncKind: 'incremental',
  });
  let authorization: GitHubWriteAuthorization | undefined;
  let dispatched = false;
  let observed = false;
  let outcome: 'succeeded' | 'failed' | 'unknown' | 'blocked' = 'failed';
  let primaryFailure: { error: unknown } | null = null;
  try {
    authorization = authorizeGitHubSourceWrite({
      connectorInstanceId: options.connectorInstanceId,
      sourceListId: options.sourceListId,
      operation: options.operation,
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    observed = true;
    if (!options.connector.preflightWriteRoute || !options.connector.runAuthorizedWrite) {
      blockGitHubWrite(authorization.leaseId, authorization.token, 'missing_write_fence_adapter');
      throw new GitHubWriteFenceError('missing_write_fence_adapter');
    }
    assertGitHubWriteCycleCurrent(authorization);
    const preflight = await options.connector.preflightWriteRoute(authorization);
    verifyGitHubWritePreflight(authorization, preflight);
    confirmGitHubWriteDispatch(authorization);
    dispatched = true;
    const value = await options.connector.runAuthorizedWrite(authorization, options.write);
    finalizeGitHubWrite(authorization, 'succeeded', undefined, value);
    outcome = 'succeeded';
    return value;
  } catch (error) {
    primaryFailure = { error };
    if (authorization && dispatched) {
      outcome = 'unknown';
      try {
        quarantineUnknownGitHubWrite(authorization, error);
      } catch (quarantineError) {
        primaryFailure = { error: quarantineError };
        throw quarantineError;
      }
    }
    if (error instanceof GitHubWriteFenceError) {
      outcome = 'blocked';
      throw error;
    }
    if (authorization) {
      try {
        finalizeGitHubWrite(authorization, 'failed', 'definitive_pre_dispatch_failure');
      } catch (finalizationError) {
        const combined = new AggregateError(
          [error, finalizationError],
          'GitHub write failure and lease finalization failure',
        );
        primaryFailure = { error: combined };
        throw combined;
      }
    }
    throw error;
  } finally {
    completeGitHubWriteCycleScope({
      cycleId,
      runtime,
      runtimeState: outcome === 'succeeded' ? 'succeeded' : 'failed',
      runtimeReason: outcome,
      outcome: {
        observed: observed ? 1 : 0,
        applied: outcome === 'succeeded' ? 1 : 0,
        blocked: outcome === 'blocked' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        unknown: outcome === 'unknown' ? 1 : 0,
      },
      primaryFailure,
    });
  }
}
