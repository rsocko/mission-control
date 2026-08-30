import { randomUUID } from 'node:crypto';
import type {
  GitHubBulkTransferItemRecord,
  GitHubBulkTransferRunRecord,
  GitHubBulkTransferSuccessionRecord,
} from '@/db/persistence/github-recovery';
import {
  canonicalDigest,
  identifierDigest,
  isBackupAttestationReady,
} from '@/db/persistence/github-recovery-values';
import { getGitHubRecoveryRepository } from '@/lib/sync/github-worker-persistence';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import { runWithConnectorOperationLease } from '@/lib/sync/connector-lock';
import { GitHubHttpError } from './github-client';
import { parseSourceId, refreshGitHubIssueMetadata } from './issue-transformer';
import {
  createGitHubRepositoryRemote,
  type GitHubChangedIssueIdentityTransfer,
  type GitHubRepointBackupProof,
  type GitHubRepositoryRepointRemote,
  transferGitHubIssueWithLease,
} from './repoint-service';

const REPOSITORY_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_CONCURRENCY = 8;
const MAX_RATE_LIMIT_BACKOFF_MS = 300_000;

export interface GitHubBulkTransferInput {
  connectorInstanceId: string;
  sourceRepository: string;
  targetRepository: string;
  actor: string;
  backupProof: GitHubRepointBackupProof;
  scope: GitHubBulkTransferScope;
}

export type GitHubBulkTransferScope =
  | {
      mode: 'reviewed-allowlist';
      sourceRepository: string;
      manifestSha256: string;
      issueNodeIds: string[];
    }
  | { mode: 'all-issues' };

export interface GitHubBulkTransferExecuteInput extends GitHubBulkTransferInput {
  idempotencyKey: string;
  planHash: string;
  confirmation: string;
  concurrency?: number;
}

export interface GitHubBulkTransferPlanItem extends Record<string, unknown> {
  taskId: string;
  issueEntityId: string;
  issueStableId: string;
  sourceNumber: number;
  sourceState: string;
  beforeDigest: string;
}

export interface GitHubBulkTransferPreview extends Record<string, unknown> {
  connectorInstanceId: string;
  sourceRepository: string;
  targetRepository: string;
  sourceRepositoryStableIdDigest: string | null;
  targetRepositoryStableIdDigest: string | null;
  scope: GitHubBulkTransferScope;
  scopeMode: GitHubBulkTransferScope['mode'];
  reviewedManifestSha256: string | null;
  approvedIssueNodeIdCount: number;
  sourceRepositoryIssueCount: number;
  sourceIssueCount: number;
  destinationIssueCount: number;
  targetIssueStableIds: string[];
  openIssueCount: number;
  closedIssueCount: number;
  localTaskCount: number;
  globalBeforeDigest: string;
  items: GitHubBulkTransferPlanItem[];
  planHash: string;
  go: boolean;
  reasons: string[];
}

export interface GitHubBulkTransferStatus extends Record<string, unknown> {
  id: string;
  connectorInstanceId: string;
  phase: 'running' | 'completed' | 'failed' | 'aborted';
  sourceRepository: string;
  targetRepository: string;
  planHash: string;
  totalCount: number;
  transferredCount: number;
  skippedCount: number;
  failedCount: number;
  pendingCount: number;
  ambiguousCount: number;
  reconciledCount: number;
  connectorEnabled: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GitHubBulkTransferDependencies {
  remote?: GitHubRepositoryRepointRemote;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  operationLeaseOwned?: boolean;
}

export interface GitHubBulkTransferSuccessorAuthorization {
  expectedSourceStableIdDigest: string;
  expectedSuccessorStableIdDigest: string;
  reason: string;
  idempotencyKey: string;
}

async function recovery() {
  return getGitHubRecoveryRepository();
}

export async function previewGitHubBulkTransfer(
  input: GitHubBulkTransferInput,
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferPreview> {
  validateInput(input);
  const ports = await recovery();
  await requireConnector(input.connectorInstanceId);
  const remote = dependencies.remote
    ?? await createGitHubRepositoryRemote(input.connectorInstanceId);
  if (!remote.listIssues) throw new Error('GitHub remote does not support issue enumeration');

  const reasons: string[] = [];
  await ports.transfer.getIdentityModeSnapshot(input.connectorInstanceId);
  if (!backupReady(input.backupProof, dependencies.now?.() ?? new Date())) {
    reasons.push('verified_recent_backup_required');
  }
  if (await ports.bulkTransfer.countConnectorActivity({
    connectorInstanceId: input.connectorInstanceId,
    ignoreOwnedOperationLease: dependencies.operationLeaseOwned ?? false,
  }) > 0) {
    reasons.push('connector_activity_must_be_drained');
  }
  if (await ports.bulkTransfer.countBlockingState(input.connectorInstanceId) > 0) {
    reasons.push('pending_writes_deletions_or_identity_collisions');
  }

  const [sourceBinding, targetBinding] = await Promise.all([
    ports.bulkTransfer.getRepositoryBinding(input.connectorInstanceId, input.sourceRepository),
    ports.bulkTransfer.getRepositoryBinding(input.connectorInstanceId, input.targetRepository),
  ]);
  if (!sourceBinding) reasons.push('source_repository_binding_missing_or_ambiguous');
  if (!targetBinding) reasons.push('target_repository_binding_missing_or_ambiguous');

  const [sourceEvidence, targetEvidence, remoteIssues, targetIssues] = await Promise.all([
    remote.resolveRepository(input.sourceRepository),
    remote.resolveRepository(input.targetRepository),
    remote.listIssues(input.sourceRepository),
    remote.listIssues(input.targetRepository),
  ]);
  if (!sourceEvidence || sourceEvidence.identity.stableId !== sourceBinding?.stableId) {
    reasons.push('source_repository_identity_mismatch');
  }
  if (!targetEvidence || targetEvidence.identity.stableId !== targetBinding?.stableId) {
    reasons.push('target_repository_identity_mismatch');
  }
  const approvedIssueNodeIds = input.scope.mode === 'reviewed-allowlist'
    ? new Set(input.scope.issueNodeIds)
    : null;
  const selectedRemoteIssues = approvedIssueNodeIds
    ? remoteIssues.filter((issue) => (
        typeof issue.node_id === 'string' && approvedIssueNodeIds.has(issue.node_id)
      ))
    : remoteIssues;
  if (approvedIssueNodeIds) {
    const sourceNodeIds = new Set(
      remoteIssues.map((issue) => issue.node_id).filter((value): value is string => Boolean(value)),
    );
    for (const nodeId of approvedIssueNodeIds) {
      if (!sourceNodeIds.has(nodeId)) {
        reasons.push(`approved_issue_node_id_not_in_source:${nodeId}`);
      }
    }
  }

  const authoritativeDeletedTaskIds = new Set(
    await ports.bulkTransfer.listAuthoritativeDeletedTaskIds(input.connectorInstanceId),
  );
  const selectedIssueNumbers = new Set(selectedRemoteIssues.map((issue) => issue.number));
  const localRows = (await ports.bulkTransfer.listConnectorTasks(input.connectorInstanceId))
    .filter((row) => (
      parseSourceId(row.sourceId).repo.toLowerCase() === input.sourceRepository.toLowerCase()
      && (
        !approvedIssueNodeIds
        || selectedIssueNumbers.has(parseSourceId(row.sourceId).issueNumber)
      )
      && (row.status !== 'cancelled' || !authoritativeDeletedTaskIds.has(row.id))
    ));
  const remoteByNumber = new Map(selectedRemoteIssues.map((issue) => [issue.number, issue]));
  const items: GitHubBulkTransferPlanItem[] = [];
  for (const row of localRows) {
    try {
      const locator = parseSourceId(row.sourceId);
      const binding = await ports.transfer.readTaskTransferBinding(
        input.connectorInstanceId,
        row.id,
      );
      const remoteIssue = remoteByNumber.get(locator.issueNumber);
      if (!remoteIssue?.node_id || remoteIssue.node_id !== binding.stableId) {
        reasons.push(`issue_identity_mismatch:${row.id}`);
        continue;
      }
      items.push({
        taskId: row.id,
        issueEntityId: binding.externalEntityId,
        issueStableId: binding.stableId,
        sourceNumber: locator.issueNumber,
        sourceState: remoteIssue.state,
        beforeDigest: await ports.bulkTransfer.taskMetadataDigest(row.id),
      });
    } catch {
      reasons.push(`issue_binding_missing_or_ambiguous:${row.id}`);
    }
  }
  if (
    selectedRemoteIssues.length !== localRows.length
    || items.length !== selectedRemoteIssues.length
  ) {
    reasons.push('source_issue_and_task_counts_do_not_reconcile');
  }
  for (const issue of selectedRemoteIssues) {
    if (!items.some((item) => item.sourceNumber === issue.number)) {
      reasons.push(`source_issue_unbound:${issue.number}`);
    }
  }

  items.sort((left, right) => left.sourceNumber - right.sourceNumber);
  const planCore = {
    connectorInstanceId: input.connectorInstanceId,
    sourceRepository: input.sourceRepository.toLowerCase(),
    targetRepository: input.targetRepository.toLowerCase(),
    sourceRepositoryStableId: sourceBinding?.stableId ?? null,
    targetRepositoryStableId: targetBinding?.stableId ?? null,
    backupSha256: input.backupProof.sha256,
    scope: normalizedScope(input.scope),
    globalBeforeDigest: await ports.bulkTransfer
      .connectorMetadataDigest(input.connectorInstanceId),
    targetIssueStableIds: targetIssues
      .map((issue) => issue.node_id)
      .filter((value): value is string => typeof value === 'string')
      .sort(),
    items,
  };
  const planHash = digest(planCore);
  return {
    connectorInstanceId: input.connectorInstanceId,
    sourceRepository: input.sourceRepository,
    targetRepository: input.targetRepository,
    sourceRepositoryStableIdDigest: sourceBinding ? digest(sourceBinding.stableId) : null,
    targetRepositoryStableIdDigest: targetBinding ? digest(targetBinding.stableId) : null,
    scope: planCore.scope,
    scopeMode: input.scope.mode,
    reviewedManifestSha256: input.scope.mode === 'reviewed-allowlist'
      ? input.scope.manifestSha256
      : null,
    approvedIssueNodeIdCount: input.scope.mode === 'reviewed-allowlist'
      ? input.scope.issueNodeIds.length
      : remoteIssues.length,
    sourceRepositoryIssueCount: remoteIssues.length,
    sourceIssueCount: selectedRemoteIssues.length,
    destinationIssueCount: targetIssues.length,
    targetIssueStableIds: planCore.targetIssueStableIds,
    openIssueCount: selectedRemoteIssues.filter((issue) => issue.state === 'open').length,
    closedIssueCount: selectedRemoteIssues.filter((issue) => issue.state === 'closed').length,
    localTaskCount: localRows.length,
    globalBeforeDigest: planCore.globalBeforeDigest,
    items,
    planHash,
    go: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

export async function executeGitHubBulkTransfer(
  input: GitHubBulkTransferExecuteInput,
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferStatus> {
  validateExecutionInput(input);
  const ports = await recovery();
  const existing = await ports.bulkTransfer.findRun(
    input.connectorInstanceId,
    input.idempotencyKey,
  );
  if (existing) {
    assertSameRun(existing, input);
    if (existing.phase === 'completed') return status(existing.id);
    if (existing.phase === 'aborted') throw new Error('Aborted bulk transfer cannot be resumed');
    const ambiguous = (await ports.bulkTransfer.listItems(existing.id, ['transferring']))[0];
    if (ambiguous) {
      throw new Error(
        `Bulk transfer has an unresolved post-dispatch item: ${ambiguous.taskId}`,
      );
    }
  }

  return runWithConnectorOperationLease(input.connectorInstanceId, 'transfer', async () => {
    let runId: string;
    if (existing) {
      runId = existing.id;
      await ports.bulkTransfer.markRunRunning(runId, nowIso(dependencies));
    } else {
      const preview = await previewGitHubBulkTransfer(input, {
        ...dependencies,
        operationLeaseOwned: true,
      });
      if (!preview.go) {
        throw new Error(`GitHub bulk transfer preflight failed: ${preview.reasons.join('; ')}`);
      }
      if (preview.planHash !== input.planHash) {
        throw new Error('GitHub bulk transfer plan hash is stale');
      }
      runId = randomUUID();
      await ports.bulkTransfer.createRun({
        runId,
        connectorInstanceId: input.connectorInstanceId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        sourceRepository: input.sourceRepository,
        targetRepository: input.targetRepository,
        planHash: input.planHash,
        plan: preview,
        items: preview.items.map((item) => ({
          taskId: item.taskId,
          issueEntityId: item.issueEntityId,
          issueStableId: item.issueStableId,
          sourceNumber: item.sourceNumber,
          beforeDigest: item.beforeDigest,
        })),
        now: (dependencies.now?.() ?? new Date()).toISOString(),
      });
    }

    try {
      const remote = dependencies.remote
        ?? await createGitHubRepositoryRemote(input.connectorInstanceId);
      const pending = await ports.bulkTransfer.listItems(runId, ['pending', 'failed']);
      await runBounded(pending, input.concurrency ?? 1, async (item) => {
        if (await ports.bulkTransfer.taskMetadataDigest(item.taskId) !== item.beforeDigest) {
          throw new Error(`Local metadata drift detected for task ${item.taskId}`);
        }
        const attemptStartedAt = nowIso(dependencies);
        await ports.bulkTransfer.setItemState({
          runId,
          taskId: item.taskId,
          state: 'pending',
          startedAt: attemptStartedAt,
          lastError: null,
          now: attemptStartedAt,
        });
        await ports.bulkTransfer.appendEvent({
          runId,
          taskId: item.taskId,
          eventType: 'preflight_started',
          payload: { issueStableIdDigest: digest(item.issueStableId) },
          createdAt: attemptStartedAt,
        });

        let result;
        let transferAccepted = false;
        try {
          result = await withRateLimitBackoff(() => transferGitHubIssueWithLease({
            connectorInstanceId: input.connectorInstanceId,
            sourceId: `${input.sourceRepository}:${item.sourceNumber}`,
            targetRepository: input.targetRepository,
            actor: input.actor,
          }, {
            remote,
            now: dependencies.now,
            sleep: dependencies.sleep,
            // Awaited before the mutation leaves the process, so a crash after
            // dispatch always finds a durable `transferring` (ambiguous) item.
            onTransferDispatch: async () => {
              const dispatchedAt = nowIso(dependencies);
              await ports.bulkTransfer.setItemState({
                runId,
                taskId: item.taskId,
                state: 'transferring',
                now: dispatchedAt,
              });
              await ports.bulkTransfer.appendEvent({
                runId,
                taskId: item.taskId,
                eventType: 'dispatch_started',
                payload: { issueStableIdDigest: digest(item.issueStableId) },
                createdAt: dispatchedAt,
              });
            },
            onTransferAccepted: async (targetNumber) => {
              transferAccepted = true;
              await ports.bulkTransfer.appendEvent({
                runId,
                taskId: item.taskId,
                eventType: 'dispatch_accepted',
                payload: {
                  targetNumber,
                  issueStableIdDigest: digest(item.issueStableId),
                },
                createdAt: nowIso(dependencies),
              });
            },
            onChangedIssueIdentity: async (transfer) => {
              await reconcileAutomaticallyChangedIssueIdentity({
                run: await requireRun(runId),
                item,
                transfer,
                actor: input.actor,
                now: nowIso(dependencies),
              });
            },
          }), dependencies.sleep, async ({ attempt, delayMs, status: httpStatus }) => {
            const rateLimitedAt = nowIso(dependencies);
            if (!transferAccepted) {
              await ports.bulkTransfer.setItemState({
                runId,
                taskId: item.taskId,
                state: 'pending',
                lastError: null,
                now: rateLimitedAt,
              });
            }
            await ports.bulkTransfer.appendEvent({
              runId,
              taskId: item.taskId,
              eventType: transferAccepted ? 'verification_rate_limited' : 'rate_limited',
              payload: { attempt, delayMs, status: httpStatus },
              createdAt: rateLimitedAt,
            });
            return !transferAccepted;
          });
        } catch (error) {
          const current = await ports.bulkTransfer.getItem(runId, item.taskId);
          const definitelyRejectedBeforeAcceptance = (
            !transferAccepted
            && error instanceof GitHubHttpError
            && error.status === 403
          );
          if (current?.state === 'pending' || definitelyRejectedBeforeAcceptance) {
            const failedAt = nowIso(dependencies);
            const message = error instanceof Error ? error.message : String(error);
            await ports.bulkTransfer.setItemState({
              runId,
              taskId: item.taskId,
              state: 'failed',
              lastError: message.slice(0, 1_000),
              now: failedAt,
            });
            await ports.bulkTransfer.appendEvent({
              runId,
              taskId: item.taskId,
              eventType: 'pre_dispatch_failed',
              payload: { error: message.slice(0, 1_000) },
              createdAt: failedAt,
            });
          }
          throw error;
        }
        if (await ports.bulkTransfer.taskMetadataDigest(item.taskId) !== item.beforeDigest) {
          throw new Error(`Local metadata changed during transfer for task ${item.taskId}`);
        }
        const targetNumber = parseSourceId(result.newSourceId).issueNumber;
        await ports.bulkTransfer.completeItem({
          runId,
          taskId: item.taskId,
          targetNumber,
          newSourceId: result.newSourceId,
          eventPayload: {
            newSourceId: result.newSourceId,
            issueStableIdDigest: digest(result.issueStableId),
          },
          now: nowIso(dependencies),
        });
      });
      await completeRun(runId, remote, dependencies);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ports.bulkTransfer.failRun(runId, message, nowIso(dependencies));
      throw error;
    }
    return status(runId);
  });
}

export async function getGitHubBulkTransferStatus(
  runId: string,
): Promise<GitHubBulkTransferStatus> {
  return status(runId);
}

export async function reconcileGitHubBulkTransferItem(
  input: {
    runId: string;
    taskId: string;
    targetNumber: number;
    actor: string;
    successorAuthorization?: GitHubBulkTransferSuccessorAuthorization;
  },
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferStatus> {
  validateActor(input.actor);
  if (!Number.isSafeInteger(input.targetNumber) || input.targetNumber <= 0) {
    throw new Error('Bulk transfer reconciliation requires a positive target issue number');
  }
  const ports = await recovery();
  const run = await requireRun(input.runId);
  const item = await ports.bulkTransfer.getItem(input.runId, input.taskId);
  const replay = await ports.bulkTransfer.getSuccession(input.runId, input.taskId);
  if (replay) {
    if (!item || !successionProofMatches(replay, run, item)) {
      throw new Error('Bulk transfer successor replay proof is invalid');
    }
    assertSuccessorReplay(replay, input);
    return status(input.runId);
  }
  if (run.phase !== 'failed') {
    throw new Error(`Bulk transfer item cannot be reconciled from run phase ${run.phase}`);
  }
  if (!item || item.state !== 'transferring') {
    throw new Error('Bulk transfer reconciliation requires an ambiguous item');
  }
  if (await ports.bulkTransfer.taskMetadataDigest(item.taskId) !== item.beforeDigest) {
    throw new Error('Bulk transfer reconciliation found local metadata drift');
  }

  await runWithConnectorOperationLease(run.connectorInstanceId, 'transfer', async () => {
    const remote = dependencies.remote
      ?? await createGitHubRepositoryRemote(run.connectorInstanceId);
    const targetBinding = await ports.bulkTransfer.getRepositoryBinding(
      run.connectorInstanceId,
      run.targetRepository,
    );
    const targetRepository = await remote.resolveRepository(run.targetRepository);
    if (
      !targetBinding
      || !targetRepository
      || targetRepository.identity.stableId !== targetBinding.stableId
    ) {
      throw new Error('Bulk transfer reconciliation target repository identity mismatch');
    }
    const evidence = await remote.resolveIssue(
      run.targetRepository,
      input.targetNumber,
      targetRepository,
    );
    if (!evidence) {
      throw new Error('Bulk transfer reconciliation target issue was not found');
    }
    const now = nowIso(dependencies);
    if (evidence.entity.identity.stableId !== item.issueStableId) {
      await reconcileChangedIssueIdentity({
        run,
        item,
        evidence,
        targetBinding,
        targetNumber: input.targetNumber,
        actor: input.actor,
        authorization: input.successorAuthorization,
        now,
      });
      return;
    }
    const newSourceId = `${run.targetRepository}:${input.targetNumber}`;
    await ports.bulkTransfer.reconcileItemRouting({
      runId: input.runId,
      taskId: input.taskId,
      connectorInstanceId: run.connectorInstanceId,
      issueEntityId: item.issueEntityId,
      targetRepository: run.targetRepository,
      targetRepositoryEntityId: targetBinding.entityId,
      targetNumber: input.targetNumber,
      identity: evidence.entity.identity,
      locator: evidence.entity.locator,
      observedAt: now,
      actor: input.actor,
      now,
      issueStableIdDigest: digest(item.issueStableId),
      refreshMetadata: (metadata) => refreshGitHubIssueMetadata(metadata, newSourceId, evidence),
    });
  });
  return status(input.runId);
}

async function reconcileChangedIssueIdentity(input: {
  run: GitHubBulkTransferRunRecord;
  item: GitHubBulkTransferItemRecord;
  evidence: ExternalIdentityEvidence;
  targetBinding: { entityId: string; stableId: string };
  targetNumber: number;
  actor: string;
  authorization: GitHubBulkTransferSuccessorAuthorization | undefined;
  now: string;
}): Promise<void> {
  const authorization = input.authorization;
  if (!authorization) {
    throw new Error(
      'Bulk transfer target has a successor identity; explicit successor authorization is required',
    );
  }
  validateSuccessorAuthorization(authorization);
  const sourceStableIdDigest = identifierDigest(input.item.issueStableId);
  const successorStableIdDigest = identifierDigest(input.evidence.entity.identity.stableId);
  if (authorization.expectedSourceStableIdDigest !== sourceStableIdDigest) {
    throw new Error('Bulk transfer successor authorization source identity mismatch');
  }
  if (authorization.expectedSuccessorStableIdDigest !== successorStableIdDigest) {
    throw new Error('Bulk transfer successor authorization target identity mismatch');
  }
  await recordChangedIssueIdentity({
    ...input,
    audit: {
      reason: authorization.reason.trim(),
      idempotencyKey: authorization.idempotencyKey.trim(),
      requireAcceptedDispatch: false,
    },
  });
}

async function reconcileAutomaticallyChangedIssueIdentity(input: {
  run: GitHubBulkTransferRunRecord;
  item: GitHubBulkTransferItemRecord;
  transfer: GitHubChangedIssueIdentityTransfer;
  actor: string;
  now: string;
}): Promise<void> {
  const { run, item, transfer } = input;
  if (
    transfer.sourceTaskId !== item.taskId
    || transfer.sourceExternalEntityId !== item.issueEntityId
    || transfer.sourceStableId !== item.issueStableId
    || transfer.sourceId.toLowerCase()
      !== `${run.sourceRepository}:${item.sourceNumber}`.toLowerCase()
    || transfer.targetRepository.toLowerCase() !== run.targetRepository.toLowerCase()
    || transfer.targetNumber <= 0
  ) {
    throw new Error('Bulk transfer automatic successor dispatch proof mismatch');
  }
  const ports = await recovery();
  const targetBinding = await ports.bulkTransfer.getRepositoryBinding(
    run.connectorInstanceId,
    run.targetRepository,
  );
  if (
    !targetBinding
    || transfer.targetRepositoryEntityId !== targetBinding.entityId
    || transfer.targetRepositoryStableId !== targetBinding.stableId
    || !transfer.evidence.repository
    || transfer.evidence.repository.identity.stableId !== targetBinding.stableId
  ) {
    throw new Error('Bulk transfer automatic successor target repository mismatch');
  }
  await recordChangedIssueIdentity({
    run,
    item,
    evidence: transfer.evidence,
    targetBinding,
    targetNumber: transfer.targetNumber,
    actor: input.actor,
    now: input.now,
    audit: {
      reason: 'GitHub-confirmed native transfer created a successor identity',
      idempotencyKey: `automatic-${digest({ runId: run.id, taskId: item.taskId })}`,
      requireAcceptedDispatch: true,
    },
  });
}

async function recordChangedIssueIdentity(input: {
  run: GitHubBulkTransferRunRecord;
  item: GitHubBulkTransferItemRecord;
  evidence: ExternalIdentityEvidence;
  targetBinding: { entityId: string; stableId: string };
  targetNumber: number;
  actor: string;
  now: string;
  audit: {
    reason: string;
    idempotencyKey: string;
    requireAcceptedDispatch: boolean;
  };
}): Promise<void> {
  const ports = await recovery();
  const sourceStableIdDigest = identifierDigest(input.item.issueStableId);
  const successorStableIdDigest = identifierDigest(input.evidence.entity.identity.stableId);
  const mode = await ports.transfer.getIdentityModeSnapshot(input.run.connectorInstanceId);
  const sourceBinding = await ports.transfer.readTaskTransferBinding(
    input.run.connectorInstanceId,
    input.item.taskId,
  );
  const sourceId = `${input.run.sourceRepository}:${input.item.sourceNumber}`;
  if (
    sourceBinding.externalEntityId !== input.item.issueEntityId
    || sourceBinding.stableId !== input.item.issueStableId
    || sourceBinding.sourceId.toLowerCase() !== sourceId.toLowerCase()
  ) {
    throw new Error('Bulk transfer successor reconciliation source binding changed');
  }
  const acceptedTargets = await ports.bulkTransfer.listAcceptedDispatchTargets(
    input.run.id,
    input.item.taskId,
  );
  if (acceptedTargets.length > 0 && !acceptedTargets.includes(input.targetNumber)) {
    throw new Error('Bulk transfer successor target number disagrees with dispatch evidence');
  }
  if (input.audit.requireAcceptedDispatch && !acceptedTargets.includes(input.targetNumber)) {
    throw new Error('Bulk transfer automatic successor requires matching dispatch acceptance');
  }

  const successorSourceId = `${input.run.targetRepository}:${input.targetNumber}`;
  const proof = {
    kind: 'native_issue_identity_successor',
    runId: input.run.id,
    planHash: input.run.planHash,
    taskId: input.item.taskId,
    sourceExternalEntityId: input.item.issueEntityId,
    sourceStableIdDigest,
    sourceId,
    successorStableIdDigest,
    successorSourceId,
    targetRepositoryEntityId: input.targetBinding.entityId,
    targetRepositoryStableIdDigest: identifierDigest(input.targetBinding.stableId),
    targetNumber: input.targetNumber,
    beforeDigest: input.item.beforeDigest,
    expectedModeRevision: mode.modeRevision,
    dispatchTargetVerified: acceptedTargets.length > 0,
  };

  await ports.bulkTransfer.recordSuccession({
    runId: input.run.id,
    taskId: input.item.taskId,
    connectorInstanceId: input.run.connectorInstanceId,
    sourceRepository: input.run.sourceRepository,
    targetRepository: input.run.targetRepository,
    sourceNumber: input.item.sourceNumber,
    targetNumber: input.targetNumber,
    issueEntityId: input.item.issueEntityId,
    issueStableId: input.item.issueStableId,
    beforeDigest: input.item.beforeDigest,
    expectedModeRevision: mode.modeRevision,
    successorSourceId,
    sourceId,
    sourceStableIdDigest,
    successorStableIdDigest,
    targetRepositoryEntityId: input.targetBinding.entityId,
    targetRepositoryStableId: input.targetBinding.stableId,
    evidence: input.evidence,
    proof,
    proofDigest: digest(proof),
    actor: input.actor,
    reason: input.audit.reason,
    idempotencyKey: input.audit.idempotencyKey,
    now: input.now,
    refreshMetadata: (metadata) => refreshGitHubIssueMetadata(
      metadata,
      successorSourceId,
      input.evidence,
    ),
  });
}

function validateSuccessorAuthorization(
  authorization: GitHubBulkTransferSuccessorAuthorization,
): void {
  const digestPattern = /^[a-f0-9]{64}$/;
  if (
    !digestPattern.test(authorization.expectedSourceStableIdDigest)
    || !digestPattern.test(authorization.expectedSuccessorStableIdDigest)
  ) {
    throw new Error('Bulk transfer successor authorization requires lowercase SHA-256 digests');
  }
  const reason = authorization.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new Error('Bulk transfer successor authorization reason must be 3-500 characters');
  }
  const idempotencyKey = authorization.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 192) {
    throw new Error('Bulk transfer successor idempotency key must be 8-192 characters');
  }
}

function assertSuccessorReplay(
  replay: GitHubBulkTransferSuccessionRecord,
  input: {
    targetNumber: number;
    actor: string;
    successorAuthorization?: GitHubBulkTransferSuccessorAuthorization;
  },
): void {
  const authorization = input.successorAuthorization;
  if (!authorization) {
    throw new Error('Bulk transfer successor replay requires its original authorization');
  }
  validateSuccessorAuthorization(authorization);
  if (
    replay.targetNumber !== input.targetNumber
    || replay.actor !== input.actor
    || replay.reason !== authorization.reason.trim()
    || replay.idempotencyKey !== authorization.idempotencyKey.trim()
    || replay.sourceStableIdDigest !== authorization.expectedSourceStableIdDigest
    || replay.successorStableIdDigest !== authorization.expectedSuccessorStableIdDigest
  ) {
    throw new Error('Bulk transfer successor idempotency key belongs to another request');
  }
}

export async function abortGitHubBulkTransfer(
  runId: string,
  actor: string,
): Promise<GitHubBulkTransferStatus> {
  validateActor(actor);
  const ports = await recovery();
  const run = await requireRun(runId);
  if (run.phase !== 'running' && run.phase !== 'failed') {
    throw new Error(`Bulk transfer cannot be aborted from phase ${run.phase}`);
  }
  const ambiguous = (await ports.bulkTransfer.listItems(runId, ['transferring']))[0];
  if (ambiguous) {
    throw new Error('Bulk transfer cannot be aborted with an unresolved post-dispatch item');
  }
  await ports.bulkTransfer.abortRun(runId, actor, new Date().toISOString());
  return status(runId);
}

async function completeRun(
  runId: string,
  remote: GitHubRepositoryRepointRemote,
  dependencies: GitHubBulkTransferDependencies,
): Promise<void> {
  const ports = await recovery();
  const run = await requireRun(runId);
  const items = await ports.bulkTransfer.listItems(runId);
  if (items.some((item) => item.state !== 'transferred')) {
    throw new Error('Bulk transfer reconciliation found incomplete items');
  }
  for (const item of items) {
    if (await ports.bulkTransfer.taskMetadataDigest(item.taskId) !== item.beforeDigest) {
      throw new Error(`Bulk transfer reconciliation found metadata drift for ${item.taskId}`);
    }
  }
  if (
    typeof run.plan.globalBeforeDigest !== 'string'
    || await ports.bulkTransfer.connectorMetadataDigest(run.connectorInstanceId)
      !== run.plan.globalBeforeDigest
  ) {
    throw new Error('Bulk transfer reconciliation found connector metadata drift');
  }
  if (!remote.listIssues) throw new Error('GitHub remote does not support final enumeration');
  const destinationIssues = await remote.listIssues(run.targetRepository);
  const destinationStableIds = new Set(
    destinationIssues.map((issue) => issue.node_id).filter((value): value is string => Boolean(value)),
  );
  const destinationStableIdDigests = new Set(
    [...destinationStableIds].map((stableId) => identifierDigest(stableId)),
  );
  const successions = await ports.bulkTransfer.listSuccessions(runId);
  const itemByTask = new Map(items.map((item) => [item.taskId, item]));
  if (successions.some((succession) => {
    const item = itemByTask.get(succession.taskId);
    return !item || !successionProofMatches(succession, run, item);
  })) {
    throw new Error('Bulk transfer successor proof did not reconcile');
  }
  const successorByTask = new Map(
    successions.map((succession) => [succession.taskId, succession.successorStableIdDigest]),
  );
  const targetBefore = Array.isArray(run.plan.targetIssueStableIds)
    ? (run.plan.targetIssueStableIds as unknown[])
      .filter((value): value is string => typeof value === 'string')
    : null;
  if (
    !targetBefore
    || destinationIssues.length !== targetBefore.length + items.length
    || items.some((item) => {
      const expectedDigest = successorByTask.get(item.taskId);
      return expectedDigest
        ? !destinationStableIdDigests.has(expectedDigest)
        : !destinationStableIds.has(item.issueStableId);
    })
  ) {
    throw new Error('Bulk transfer destination counts or stable identities did not reconcile');
  }
  await ports.bulkTransfer.completeRun({
    runId,
    connectorInstanceId: run.connectorInstanceId,
    connectorWasEnabled: run.connectorWasEnabled,
    transferredCount: items.length,
    destinationBeforeCount: targetBefore.length,
    destinationAfterCount: destinationIssues.length,
    now: nowIso(dependencies),
  });
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        await operation(values[index]);
      } catch (error) {
        stopped = true;
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
}

async function withRateLimitBackoff<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
  onRateLimited?: (retry: {
    attempt: number;
    delayMs: number | null;
    status: number | null;
  }) => boolean | Promise<boolean>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retry = rateLimitRetry(error, attempt);
      if (!retry) throw error;
      const delayMs = attempt < 3 ? retry.delayMs : null;
      const retryAllowed = await onRateLimited?.({
        attempt: attempt + 1,
        delayMs,
        status: retry.status,
      }) ?? true;
      if (!retryAllowed) throw error;
      if (delayMs !== null) await sleep(delayMs);
    }
  }
  throw lastError;
}

function rateLimitRetry(
  error: unknown,
  attempt: number,
): { delayMs: number; status: number | null } | null {
  const fallbackDelayMs = 1_000 * 2 ** attempt;
  if (
    error instanceof GitHubHttpError
    && (error.status === 429 || isProvenRateLimitedForbidden(error))
  ) {
    const resetDelayMs = rateLimitResetDelayMilliseconds(error);
    return {
      delayMs: Math.min(
        error.retryAfterMs ?? resetDelayMs ?? fallbackDelayMs,
        MAX_RATE_LIMIT_BACKOFF_MS,
      ),
      status: error.status,
    };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (!message.includes('rate limit') && !message.includes('(429)')) return null;
  return { delayMs: fallbackDelayMs, status: null };
}

function isProvenRateLimitedForbidden(error: GitHubHttpError): boolean {
  if (error.status !== 403) return false;
  if (error.retryAfterMs !== null) return true;
  if (rateLimitResetDelayMilliseconds(error) !== null) return true;
  const body = error.responseBody?.toLowerCase() ?? '';
  return (
    body.includes('secondary rate limit')
    || body.includes('api rate limit exceeded')
    || body.includes('abuse detection mechanism')
  );
}

function rateLimitResetDelayMilliseconds(error: GitHubHttpError): number | null {
  if (error.headers['x-ratelimit-remaining']?.trim() !== '0') return null;
  const reset = error.headers['x-ratelimit-reset']?.trim();
  if (!reset || !/^\d+$/.test(reset)) return null;
  const resetAtMs = Number(reset) * 1_000;
  if (!Number.isSafeInteger(resetAtMs) || resetAtMs <= 0) return null;
  return Math.max(0, resetAtMs - Date.now());
}

async function status(runId: string): Promise<GitHubBulkTransferStatus> {
  const ports = await recovery();
  const run = await requireRun(runId);
  const counts = await ports.bulkTransfer.countItems(runId);
  const connector = await requireConnector(run.connectorInstanceId);
  return {
    id: run.id,
    connectorInstanceId: run.connectorInstanceId,
    phase: run.phase,
    sourceRepository: run.sourceRepository,
    targetRepository: run.targetRepository,
    planHash: run.planHash,
    totalCount: counts.totalCount,
    transferredCount: counts.transferredCount,
    skippedCount: run.skippedCount,
    failedCount: counts.failedCount,
    pendingCount: counts.pendingCount,
    ambiguousCount: counts.ambiguousCount,
    reconciledCount: run.phase === 'completed' ? counts.transferredCount : 0,
    connectorEnabled: connector.enabled,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

async function requireRun(runId: string): Promise<GitHubBulkTransferRunRecord> {
  const ports = await recovery();
  const run = await ports.bulkTransfer.getRun(runId);
  if (!run) throw new Error('GitHub bulk transfer run was not found');
  return run;
}

async function requireConnector(connectorInstanceId: string) {
  const ports = await recovery();
  const connector = await ports.transfer.getConnector(connectorInstanceId);
  if (!connector || connector.type !== 'github-issues') {
    throw new Error('GitHub connector was not found');
  }
  return connector;
}

function assertSameRun(
  run: GitHubBulkTransferRunRecord,
  input: GitHubBulkTransferExecuteInput,
): void {
  if (
    run.sourceRepository.toLowerCase() !== input.sourceRepository.toLowerCase()
    || run.targetRepository.toLowerCase() !== input.targetRepository.toLowerCase()
    || run.planHash !== input.planHash
    || digest(run.plan.scope) !== digest(normalizedScope(input.scope))
  ) {
    throw new Error('Bulk transfer idempotency key belongs to another request');
  }
}

function validateExecutionInput(input: GitHubBulkTransferExecuteInput): void {
  validateInput(input);
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 192) {
    throw new Error('Bulk transfer idempotency key must be 8-192 characters');
  }
  if (!/^[a-f0-9]{64}$/.test(input.planHash)) {
    throw new Error('Bulk transfer requires a valid SHA-256 plan hash');
  }
  const expected = `${input.sourceRepository}=>${input.targetRepository}`;
  if (input.confirmation !== expected) {
    throw new Error(`Bulk transfer execution requires confirmation ${expected}`);
  }
  if (
    input.concurrency !== undefined
    && (!Number.isSafeInteger(input.concurrency)
      || input.concurrency < 1
      || input.concurrency > MAX_CONCURRENCY)
  ) {
    throw new Error(`Bulk transfer concurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }
}

function validateInput(input: GitHubBulkTransferInput): void {
  validateActor(input.actor);
  if (!REPOSITORY_PATH.test(input.sourceRepository)) {
    throw new Error('Bulk transfer source repository must use owner/repository');
  }
  if (!REPOSITORY_PATH.test(input.targetRepository)) {
    throw new Error('Bulk transfer target repository must use owner/repository');
  }
  if (input.sourceRepository.toLowerCase() === input.targetRepository.toLowerCase()) {
    throw new Error('Bulk transfer source and target repositories must differ');
  }
  if (
    input.sourceRepository.split('/')[0].toLowerCase()
    !== input.targetRepository.split('/')[0].toLowerCase()
  ) {
    throw new Error('GitHub issue transfers require repositories under the same owner');
  }
  validateScope(input);
}

function validateScope(input: GitHubBulkTransferInput): void {
  const scope = (input as GitHubBulkTransferInput & {
    scope?: GitHubBulkTransferScope;
  }).scope;
  if (!scope) {
    throw new Error('Bulk transfer requires explicit reviewed-allowlist or all-issues scope');
  }
  if (scope.mode === 'all-issues') return;
  if (scope.sourceRepository.toLowerCase() !== input.sourceRepository.toLowerCase()) {
    throw new Error('Bulk transfer allowlist source repository does not match the request');
  }
  if (!/^[a-f0-9]{64}$/.test(scope.manifestSha256)) {
    throw new Error('Bulk transfer allowlist requires a valid manifest SHA-256');
  }
  if (scope.issueNodeIds.length === 0) {
    throw new Error('Bulk transfer allowlist must contain at least one issue node ID');
  }
  const normalized = scope.issueNodeIds.map((nodeId) => nodeId.trim());
  if (normalized.some((nodeId, index) => (
    nodeId.length === 0
    || nodeId.length > 200
    || nodeId !== scope.issueNodeIds[index]
  ))) {
    throw new Error('Bulk transfer allowlist contains an invalid issue node ID');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Bulk transfer allowlist contains duplicate issue node IDs');
  }
}

function normalizedScope(scope: GitHubBulkTransferScope): GitHubBulkTransferScope {
  if (scope.mode === 'all-issues') return scope;
  return {
    mode: scope.mode,
    sourceRepository: scope.sourceRepository.toLowerCase(),
    manifestSha256: scope.manifestSha256,
    issueNodeIds: [...scope.issueNodeIds].map((nodeId) => nodeId.trim()).sort(),
  };
}

function validateActor(actor: string): void {
  if (actor.trim().length < 1 || actor.length > 80) {
    throw new Error('Bulk transfer actor must be 1-80 characters');
  }
}

function backupReady(proof: GitHubRepointBackupProof, now: Date): boolean {
  return isBackupAttestationReady(proof, now);
}

function digest(value: unknown): string {
  return canonicalDigest(value);
}

function successionProofMatches(
  succession: GitHubBulkTransferSuccessionRecord,
  run: GitHubBulkTransferRunRecord,
  item: GitHubBulkTransferItemRecord,
): boolean {
  const proof = succession.proof;
  return digest(proof) === succession.proofDigest
    && proof.kind === 'native_issue_identity_successor'
    && proof.runId === run.id
    && proof.planHash === run.planHash
    && proof.taskId === item.taskId
    && proof.sourceExternalEntityId === succession.sourceExternalEntityId
    && proof.sourceStableIdDigest === succession.sourceStableIdDigest
    && proof.sourceId === succession.sourceId
    && proof.successorStableIdDigest === succession.successorStableIdDigest
    && proof.successorSourceId === succession.successorSourceId
    && proof.targetRepositoryEntityId === succession.targetRepositoryEntityId
    && proof.targetNumber === succession.targetNumber
    && proof.beforeDigest === item.beforeDigest;
}

function nowIso(dependencies: GitHubBulkTransferDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
