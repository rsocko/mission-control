import { createHash, randomUUID } from 'crypto';
import { syncLogger } from '@/lib/logger';
import type { GitHubTaskWriteOperation } from '@/db/schema';
import type {

  GitHubFenceTargetRole,
  GitHubFenceTaskRow,
  GitHubWriteFenceAuthorizationRef,
} from '@/db/persistence/github-identity';

import { GitHubStableIdentityRuntime } from './stable-identity-runtime';
import type { GitHubIdentityResolutionDecision } from './stable-identity-types';
import { getGitHubIdentityRepository, getGitHubWriteFenceRepository } from './worker-persistence';

const LEASE_MS = 60_000;

const GITHUB_WRITE_FENCE_MESSAGES: Readonly<Record<string, string>> = {
  stable_identity_evidence_blocked:
    'GitHub sync is paused because this task identity needs reconciliation. Run a full GitHub sync, then retry.',
};

export class GitHubWriteFenceError extends Error {
  constructor(readonly code: string) {
    super(GITHUB_WRITE_FENCE_MESSAGES[code] ?? `GitHub write fenced: ${code}`);
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
    role: GitHubFenceTargetRole;
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

/** Builds the fence-authorization reference the port re-checks require. */
function toAuthorizationRef(
  authorization: GitHubWriteAuthorization,
): GitHubWriteFenceAuthorizationRef {
  return {
    leaseId: authorization.leaseId,
    token: authorization.token,
    connectorInstanceId: authorization.connectorInstanceId,
    taskId: authorization.taskId,
    expectedTaskVersion: authorization.expectedTaskVersion,
    taskPushLeaseToken: authorization.taskPushLeaseToken,
  };
}

export async function beginGitHubWriteCycle(options: {
  connectorInstanceId: string;
  modeSnapshot: { modeRevision: number };
  jobId?: string;
  pendingCandidateCount: number;
}): Promise<string> {
  if (!Number.isSafeInteger(options.pendingCandidateCount) || options.pendingCandidateCount < 1) {
    throw new GitHubWriteFenceError('write_cycle_requires_candidates');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.beginWriteCycle({
    id,
    connectorInstanceId: options.connectorInstanceId,
    jobId: options.jobId,
    expectedModeRevision: options.modeSnapshot.modeRevision,
    pendingCandidateCount: options.pendingCandidateCount,
    now,
  });
  if (!result.ok) throw new GitHubWriteFenceError(result.code);
  return id;
}

export async function finishGitHubWriteCycle(
  id: string,
  outcome: { observed: number; applied: number; blocked: number; failed: number; unknown: number },
): Promise<boolean> {
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.finishWriteCycle({ id, outcome, now });
  return result.committed;
}

/**
 * Durably records that a NodeID route was resolved for one lease. The route
 * evidence is the lease target rows plus `cycle_observed_at`; nothing depends
 * on a comparison record any more.
 */
async function recordGitHubWriteCycleObservation(
  leaseId: string,
  decision: GitHubIdentityResolutionDecision,
): Promise<void> {
  if (decision.appliedSource !== 'stable') {
    throw new GitHubWriteFenceError('write_cycle_observation_missing');
  }
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.recordCycleObservation({ leaseId, now });
  if (!result.ok) throw new GitHubWriteFenceError(result.code);
}

/**
 * Freezes local route facts. The caller must perform its remote preflight after
 * this returns and call confirmGitHubWriteDispatch immediately before mutation.
 */
export async function authorizeGitHubWrite(options: {
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
}): Promise<GitHubWriteAuthorization> {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const leaseId = randomUUID();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.authorizeTaskWrite({
    connectorInstanceId: options.connectorInstanceId,
    taskId: options.taskId,
    operation: options.operation,
    writeCycleId: options.writeCycleId ?? null,
    targetSourceListId: options.targetSourceListId,
    participantTaskIds: options.participantTaskIds,
    expectedTaskVersion: options.expectedTaskVersion,
    taskPushLeaseToken: options.taskPushLeaseToken,
    leaseId,
    token,
    expiresAt,
    now: nowIso,
    deriveWriteIdentity: (task) => taskWriteIdentity(task, options.operation),
  });
  if (!result.ok) throw new GitHubWriteFenceError(result.code);

  if (!options.identityRuntime) {
    await blockGitHubWrite(result.leaseId, token, 'missing_identity_runtime');
    throw new GitHubWriteFenceError('missing_identity_runtime');
  }
  const primary = result.targets.find((target) => target.role === 'primary_issue')
    ?? result.targets.find((target) => target.role === 'target_repository')
    ?? result.targets.find((target) => target.role === 'source_repository');
  if (!primary) {
    await blockGitHubWrite(result.leaseId, token, 'missing_or_inaccessible_identity');
    throw new GitHubWriteFenceError('missing_or_inaccessible_identity');
  }
  try {
    const [decision] = await options.identityRuntime.applyResolvedBatch('write_route', [{
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
    await recordGitHubWriteCycleObservation(result.leaseId, decision);
  } catch (error) {
    await blockGitHubWrite(result.leaseId, token, 'identity_route_resolution_failed');
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

export async function hasSucceededGitHubWrite(options: {
  connectorInstanceId: string;
  taskId: string;
  operation: GitHubTaskWriteOperation;
  expectedTaskVersion: string;
  taskPushLeaseToken: string;
}): Promise<boolean> {
  const writeFence = await getGitHubWriteFenceRepository();
  return writeFence.hasSucceededWrite({
    connectorInstanceId: options.connectorInstanceId,
    taskId: options.taskId,
    operation: options.operation,
    expectedTaskVersion: options.expectedTaskVersion,
    taskPushLeaseToken: options.taskPushLeaseToken,
    now: new Date().toISOString(),
    deriveWriteIdentity: (task) => taskWriteIdentity(task, options.operation),
  });
}

export async function authorizeGitHubSourceWrite(options: {
  connectorInstanceId: string;
  sourceListId: string;
  operation: 'create' | 'label';
  identityRuntime?: GitHubStableIdentityRuntime;
  writeCycleId?: string | null;
}): Promise<GitHubWriteAuthorization> {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const leaseId = randomUUID();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.authorizeSourceWrite({
    connectorInstanceId: options.connectorInstanceId,
    sourceListId: options.sourceListId,
    operation: options.operation,
    writeCycleId: options.writeCycleId ?? null,
    leaseId,
    token,
    expiresAt,
    now: nowIso,
  });
  if (!result.ok) throw new GitHubWriteFenceError(result.code);

  if (!options.identityRuntime) {
    await blockGitHubWrite(result.leaseId, token, 'missing_identity_runtime');
    throw new GitHubWriteFenceError('missing_identity_runtime');
  }
  try {
    const [decision] = await options.identityRuntime.applyResolvedBatch('write_route', [{
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
    await recordGitHubWriteCycleObservation(result.leaseId, decision);
  } catch (error) {
    await blockGitHubWrite(result.leaseId, token, 'identity_route_resolution_failed');
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
export async function assertGitHubWriteCycleCurrent(
  authorization: GitHubWriteAuthorization,
): Promise<void> {
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const current = await writeFence.assertCycleCurrent({
    authorization: toAuthorizationRef(authorization),
    now,
  });
  if (!current) throw new GitHubWriteFenceError('stale_write_cycle');
}

export async function confirmGitHubWriteDispatch(
  authorization: GitHubWriteAuthorization,
): Promise<void> {
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const dispatched = await writeFence.confirmDispatch({
    authorization: toAuthorizationRef(authorization),
    now,
  });
  if (!dispatched) {
    await blockGitHubWrite(authorization.leaseId, authorization.token, 'stale_mode_lease_or_locator');
    throw new GitHubWriteFenceError('stale_mode_lease_or_locator');
  }
}

export async function verifyGitHubWritePreflight(
  authorization: GitHubWriteAuthorization,
  observed: { targets: Record<string, { repositoryStableId: string; issueStableId?: string }> },
): Promise<void> {
  const writeFence = await getGitHubWriteFenceRepository();
  const ok = await writeFence.verifyPreflight({ leaseId: authorization.leaseId, observed });
  if (!ok) {
    await blockGitHubWrite(authorization.leaseId, authorization.token, 'remote_identity_disagreement');
    throw new GitHubWriteFenceError('remote_identity_disagreement');
  }
}

export async function finalizeGitHubWrite(
  authorization: GitHubWriteAuthorization,
  outcome: 'succeeded' | 'failed' | 'unknown',
  reason?: string,
  result?: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const safeReason = reason?.replace(/[^a-z0-9_:-]/gi, '_').slice(0, 100) ?? null;
  const resultDigest = outcome === 'succeeded' ? digestWriteResult(result) : null;
  const writeFence = await getGitHubWriteFenceRepository();
  const finalized = await writeFence.finalizeWrite({
    authorization: toAuthorizationRef(authorization),
    outcome,
    safeReason,
    resultDigest,
    now,
  });
  if (finalized.status === 'outcome_lost') {
    throw new GitHubWriteFenceError('write_cycle_outcome_lost');
  }
  if (finalized.status !== 'committed') {
    throw new GitHubWriteFenceError('lease_finalization_lost');
  }
}

export async function quarantineUnknownGitHubWrite(
  authorization: GitHubWriteAuthorization,
  cause: unknown,
): Promise<never> {
  try {
    await finalizeGitHubWrite(authorization, 'unknown', 'unknown_post_dispatch_outcome');
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

export async function blockGitHubWrite(
  leaseId: string,
  token: string,
  code: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const writeFence = await getGitHubWriteFenceRepository();
  const result = await writeFence.blockWrite({ leaseId, token, code, now });
  if (result.status === 'outcome_lost') {
    throw new GitHubWriteFenceError('write_cycle_outcome_lost');
  }
  return result.status === 'blocked';
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
  task: GitHubFenceTaskRow,
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
  task: GitHubFenceTaskRow,
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

export async function expireUndispatchedGitHubWriteLeases(
  now = new Date().toISOString(),
): Promise<number> {
  const writeFence = await getGitHubWriteFenceRepository();
  return writeFence.expireUndispatchedLeases(now);
}

async function completeGitHubWriteCycleScope(options: {
  cycleId: string;
  runtime?: GitHubStableIdentityRuntime;
  runtimeState: Parameters<GitHubStableIdentityRuntime['complete']>[0];
  runtimeReason: string;
  outcome: { observed: number; applied: number; blocked: number; failed: number; unknown: number };
  primaryFailure: { error: unknown } | null;
}): Promise<void> {
  const cleanupFailureCodes: string[] = [];
  try {
    options.runtime?.complete(options.runtimeState, options.runtimeReason);
  } catch (error) {
    cleanupFailureCodes.push(cleanupFailureCode(error));
  }
  if (!await finishGitHubWriteCycle(options.cycleId, options.outcome)) {
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
  const snapshot = await (await getGitHubIdentityRepository()).getModeSnapshot(options.connectorInstanceId);
  const cycleId = await beginGitHubWriteCycle({
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
    authorization = await authorizeGitHubWrite({
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
      await blockGitHubWrite(authorization.leaseId, authorization.token, 'missing_write_fence_adapter');
      throw new GitHubWriteFenceError('missing_write_fence_adapter');
    }
    await assertGitHubWriteCycleCurrent(authorization);
    const preflight = await options.connector.preflightWriteRoute(authorization);
    await verifyGitHubWritePreflight(authorization, preflight);
    await confirmGitHubWriteDispatch(authorization);
    dispatched = true;
    const value = await options.connector.runAuthorizedWrite(authorization, options.write);
    await finalizeGitHubWrite(authorization, 'succeeded', undefined, value);
    outcome = 'succeeded';
    return value;
  } catch (error) {
    primaryFailure = { error };
    if (authorization && dispatched) {
      outcome = 'unknown';
      // A fence failure after dispatch is also ambiguous if an earlier step mutated GitHub.
      try {
        await quarantineUnknownGitHubWrite(authorization, error);
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
        await finalizeGitHubWrite(authorization, 'failed', 'definitive_pre_dispatch_failure');
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
    await completeGitHubWriteCycleScope({
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
  const snapshot = await (await getGitHubIdentityRepository()).getModeSnapshot(options.connectorInstanceId);
  const cycleId = await beginGitHubWriteCycle({
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
    authorization = await authorizeGitHubSourceWrite({
      connectorInstanceId: options.connectorInstanceId,
      sourceListId: options.sourceListId,
      operation: options.operation,
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    observed = true;
    if (!options.connector.preflightWriteRoute || !options.connector.runAuthorizedWrite) {
      await blockGitHubWrite(authorization.leaseId, authorization.token, 'missing_write_fence_adapter');
      throw new GitHubWriteFenceError('missing_write_fence_adapter');
    }
    await assertGitHubWriteCycleCurrent(authorization);
    const preflight = await options.connector.preflightWriteRoute(authorization);
    await verifyGitHubWritePreflight(authorization, preflight);
    await confirmGitHubWriteDispatch(authorization);
    dispatched = true;
    const value = await options.connector.runAuthorizedWrite(authorization, options.write);
    await finalizeGitHubWrite(authorization, 'succeeded', undefined, value);
    outcome = 'succeeded';
    return value;
  } catch (error) {
    primaryFailure = { error };
    if (authorization && dispatched) {
      outcome = 'unknown';
      try {
        await quarantineUnknownGitHubWrite(authorization, error);
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
        await finalizeGitHubWrite(authorization, 'failed', 'definitive_pre_dispatch_failure');
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
    await completeGitHubWriteCycleScope({
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
