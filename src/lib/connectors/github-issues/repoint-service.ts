import { createHash } from 'node:crypto';
import type {
  GitHubRecoveryBackupAttestation,
  GitHubRecoveryIssuePlanRow,
  GitHubRecoveryRepositoryBinding,
  GitHubRepointActivity,
  GitHubRepointCounts,
  GitHubRepointIssueMutation,
  GitHubRepointRelationshipCounts,
  GitHubRecoveryConnectorSnapshot,
  GitHubRepositoryRepointOperationPhase,
} from '@/db/persistence/github-recovery';
import {
  asRecord,
  isBackupAttestationReady,
  repositoryPath,
  samePath,
  stringValue,
} from '@/db/persistence/github-recovery-values';
import { getGitHubRecoveryRepository } from '@/lib/sync/github-worker-persistence';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
} from '@/lib/external-identities/types';
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubRestIssue,
  type GitHubRestRepository,
} from './github-client';
import {
  assertTrustedGitHubUrl,
  issueEvidenceFromRest,
  normalizeGitHubOrigin,
  repositoryEvidenceFromRest,
} from './identity';
import { parseSourceId, refreshGitHubIssueMetadata } from './issue-transformer';
import { runWithConnectorOperationLease } from '@/lib/sync/connector-lock-runtime';

export { inspectGitHubRepointBackup } from './backup-verifier';

const REPOSITORY_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Externally verified backup evidence. The SQLite edge helper in
 * `./backup-verifier` produces it for SQLite deployments; PostgreSQL operators
 * supply the same bounded value from their own verified dump.
 */
export type GitHubRepointBackupProof = GitHubRecoveryBackupAttestation;
export type GitHubRepositoryRepointCounts = GitHubRepointCounts;
export type GitHubRepositoryRelationshipCounts = GitHubRepointRelationshipCounts;
export type GitHubRepositoryRepointActivity = GitHubRepointActivity;
export type GitHubRepositoryRepointPhase = GitHubRepositoryRepointOperationPhase;

export interface GitHubRepositoryRepointPreflight extends Record<string, unknown> {
  connectorInstanceId: string;
  from: string;
  to: string;
  hostKey: string;
  repositoryEntityId: string | null;
  repositoryStableIdDigest: string | null;
  targetRepositoryStableIdDigest: string | null;
  repositoryIdentityMatches: boolean;
  oldPathStatus: 'same_repository' | 'not_found' | 'replacement' | 'unresolved';
  backupReady: boolean;
  counts: GitHubRepositoryRepointCounts;
  relationships: GitHubRepositoryRelationshipCounts;
  activity: GitHubRepositoryRepointActivity;
  issueIdentitiesChecked: number;
  issueIdentityMismatches: number;
  missingIssueBindings: number;
  locatorCollisions: number;
  deletionCandidates: string[];
  go: boolean;
  reasons: string[];
}

export interface GitHubRepositoryRepointInput {
  connectorInstanceId: string;
  from: string;
  to: string;
  actor: string;
  idempotencyKey: string;
  backupProof: GitHubRepointBackupProof;
}

export interface GitHubRepositoryRepointStatus extends Record<string, unknown> {
  id: string;
  connectorInstanceId: string;
  phase: GitHubRepositoryRepointPhase;
  from: string;
  to: string;
  actor: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  connectorLocked: boolean;
  verification: Record<string, unknown> | null;
}

export interface GitHubIssueTransferResult {
  newSourceId: string;
  identityVerified: true;
  issueStableId: string;
  repositoryStableId: string;
}

export interface GitHubHistoricalIssueResolution {
  evidence: ExternalIdentityEvidence;
  title: string;
  state: string;
  stateReason: string | null;
}

export interface GitHubRepositoryRepointRemote {
  resolveRepository(repository: string): Promise<ExternalIdentityObservation | null>;
  resolveIssue(
    repository: string,
    issueNumber: number,
    repositoryEvidence: ExternalIdentityObservation,
  ): Promise<ExternalIdentityEvidence | null>;
  transferIssue?(
    issueStableId: string,
    targetRepositoryStableId: string,
  ): Promise<number>;
  resolveHistoricalIssue?(
    repository: string,
    issueNumber: number,
  ): Promise<GitHubHistoricalIssueResolution | null>;
  listIssues?(repository: string): Promise<GitHubRestIssue[]>;
}

export interface RepointDependencies {
  remote?: GitHubRepositoryRepointRemote;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Awaited *before* the GitHub transfer mutation is dispatched, so a caller
   * can durably record the pre-dispatch (ambiguous) state first.
   */
  onTransferDispatch?: () => void | Promise<void>;
  /** Awaited immediately after GitHub accepts the transfer. */
  onTransferAccepted?: (targetNumber: number) => void | Promise<void>;
  onChangedIssueIdentity?: (
    transfer: GitHubChangedIssueIdentityTransfer,
  ) => void | Promise<void>;
}

export interface GitHubChangedIssueIdentityTransfer {
  sourceTaskId: string;
  sourceExternalEntityId: string;
  sourceStableId: string;
  sourceId: string;
  targetNumber: number;
  targetRepository: string;
  targetRepositoryEntityId: string;
  targetRepositoryStableId: string;
  evidence: ExternalIdentityEvidence;
}

interface IssueMutationPlan {
  row: GitHubRecoveryIssuePlanRow;
  evidence: ExternalIdentityEvidence;
}

interface RepointPlan {
  report: GitHubRepositoryRepointPreflight;
  connector: GitHubRecoveryConnectorSnapshot;
  repositoryBinding: GitHubRecoveryRepositoryBinding | null;
  targetRepositoryEvidence: ExternalIdentityObservation | null;
  issues: IssueMutationPlan[];
}

async function recovery() {
  return getGitHubRecoveryRepository();
}

export async function preflightGitHubRepositoryRepoint(
  input: Omit<GitHubRepositoryRepointInput, 'idempotencyKey'>,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointPreflight> {
  return (await buildRepointPlan(input, dependencies)).report;
}

export async function executeGitHubRepositoryRepoint(
  input: GitHubRepositoryRepointInput,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointStatus> {
  validateOperatorInput(input);
  const ports = await recovery();
  const existing = await ports.repoint.findOperationByIdempotency(
    input.connectorInstanceId,
    input.idempotencyKey,
  );
  if (existing) {
    assertSameOperation(existing, input);
    if (existing.phase === 'verified') return toStatus(existing);
    if (
      existing.phase === 'applied'
      || existing.phase === 'verifying'
      || existing.phase === 'verification_failed'
    ) {
      return verifyGitHubRepositoryRepoint(existing.id, dependencies);
    }
    if (existing.phase !== 'locked') {
      throw new Error(`Repoint operation cannot resume from phase ${existing.phase}`);
    }
  } else if (
    !isBackupAttestationReady(
      input.backupProof,
      dependencies.now?.() ?? new Date(),
    )
  ) {
    throw new Error('A verified recent backup proof is required');
  }

  const plan = await buildRepointPlan(input, dependencies, existing?.id);
  if (!plan.report.go || !plan.repositoryBinding || !plan.targetRepositoryEvidence) {
    throw new Error(`GitHub repository repoint preflight failed: ${plan.report.reasons.join('; ')}`);
  }
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const operation = existing ?? await ports.repoint.acquireOperation({
    connectorInstanceId: input.connectorInstanceId,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    from: input.from,
    to: input.to,
    hostKey: plan.report.hostKey,
    repositoryEntityId: plan.repositoryBinding.repositoryEntityId,
    repositoryStableId: plan.repositoryBinding.repositoryStableId,
    sourceListId: plan.repositoryBinding.localId,
    backupProof: input.backupProof,
    preflight: compactPreflight(plan.report),
    relationships: plan.report.relationships,
    taskIdDigest: digest(plan.issues.map((issue) => issue.row.taskId).sort().join('\0')),
    counts: plan.report.counts,
    backupSha256: input.backupProof.sha256,
    now,
  });

  if (operation.phase === 'locked') {
    const applied = await ports.repoint.applyOperation({
      operationId: operation.id,
      repositoryIdentity: plan.targetRepositoryEvidence.identity,
      repositoryLocator: plan.targetRepositoryEvidence.locator,
      repositoryObservedAt: now,
      repositorySourceListId: plan.repositoryBinding.localId,
      issues: plan.issues.map((issue): GitHubRepointIssueMutation => ({
        taskId: issue.row.taskId,
        issueEntityId: issue.row.issueEntityId!,
        issueNumber: issue.row.issueNumber!,
        identity: issue.evidence.entity.identity,
        locator: issue.evidence.entity.locator,
        observedAt: now,
      })),
      sourceListsUpdated: plan.report.counts.sourceLists,
      now,
    });
    if (applied.outcome !== 'applied') return toStatus(await requireOperation(operation.id));
  }
  return verifyGitHubRepositoryRepoint(operation.id, {
    ...dependencies,
    remote: dependencies.remote ?? await createRemote(plan.connector),
  });
}

export async function verifyGitHubRepositoryRepoint(
  operationId: string,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointStatus> {
  const ports = await recovery();
  const operation = await requireOperation(operationId);
  if (operation.phase === 'verified') return toStatus(operation);
  if (!['applied', 'verifying', 'verification_failed'].includes(operation.phase)) {
    throw new Error(`Repoint operation cannot be verified from phase ${operation.phase}`);
  }
  const connector = await requireGitHubConnector(operation.connectorInstanceId);
  const remote = dependencies.remote ?? await createRemote(connector);
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  await ports.repoint.setOperationPhase({
    operationId: operation.id,
    phase: 'verifying',
    actor: operation.actor,
    payload: {},
    now,
  });

  const target = repositoryPath(operation.toOwner, operation.toRepository);
  const source = repositoryPath(operation.fromOwner, operation.fromRepository);
  const repositoryEvidence = await remote.resolveRepository(target);
  const issueRows = await ports.repoint.listIssuePlanRows(operation.connectorInstanceId, target);
  const mismatches: Array<{ taskId: string; reason: string }> = [];
  const expectedTaskCount = asRecord(operation.preflight.counts).tasks;
  const repositoryMatched = Boolean(
    repositoryEvidence
    && repositoryEvidence.identity.hostKey === operation.hostKey
    && repositoryEvidence.identity.stableId === operation.repositoryStableId,
  );
  if (!repositoryMatched || !repositoryEvidence) {
    mismatches.push({ taskId: '', reason: 'repository_identity_mismatch' });
  } else {
    for (const row of issueRows) {
      if (
        !row.issueStableId
        || !row.issueNumber
        || row.repositoryEntityId !== operation.repositoryEntityId
      ) {
        mismatches.push({ taskId: row.taskId, reason: 'missing_or_conflicting_binding' });
        continue;
      }
      const evidence = await remote.resolveIssue(target, row.issueNumber, repositoryEvidence);
      if (!evidence || evidence.entity.identity.stableId !== row.issueStableId) {
        mismatches.push({ taskId: row.taskId, reason: 'issue_identity_mismatch' });
      }
    }
  }
  const routing = await ports.repoint.readRoutingSnapshot({
    connectorInstanceId: operation.connectorInstanceId,
    from: source,
    to: target,
  });
  if (
    typeof expectedTaskCount !== 'number'
    || routing.configuredRepositoryMatches !== 1
    || routing.configuredRepositorySourceMatches !== 0
    || routing.syncedListMatches !== 1
    || routing.syncedListSourceMatches !== 0
    || routing.targetSourceLists !== 1
    || routing.sourceSourceLists !== 0
    || routing.targetTasks !== expectedTaskCount
    || routing.sourceTasks !== 0
  ) {
    mismatches.push({ taskId: '', reason: 'local_routing_snapshot_mismatch' });
  }

  const verification: Record<string, unknown> = {
    checkedAt: now,
    repositoryMatched,
    issuesChecked: issueRows.length,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 50),
  };
  if (mismatches.length > 0) {
    await ports.repoint.failVerification({
      operationId: operation.id,
      verification,
      error: 'Locked verification found identity mismatches',
      now,
    });
    return toStatus(await requireOperation(operation.id));
  }
  await ports.repoint.completeVerification({ operationId: operation.id, verification, now });
  return toStatus(await requireOperation(operation.id));
}

export async function rollbackGitHubRepositoryRepoint(
  operationId: string,
  actor: string,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointStatus> {
  validateActor(actor);
  const ports = await recovery();
  const operation = await requireOperation(operationId);
  if (
    !['applied', 'verifying', 'verification_failed', 'failed', 'rolled_back']
      .includes(operation.phase)
  ) {
    throw new Error(`Repoint operation cannot be rolled back from phase ${operation.phase}`);
  }
  const connector = await requireGitHubConnector(operation.connectorInstanceId);
  const remote = dependencies.remote ?? await createRemote(connector);
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const from = repositoryPath(operation.fromOwner, operation.fromRepository);
  const to = repositoryPath(operation.toOwner, operation.toRepository);
  const repositoryEvidence = await remote.resolveRepository(from);
  if (
    !repositoryEvidence
    || repositoryEvidence.identity.hostKey !== operation.hostKey
    || repositoryEvidence.identity.stableId !== operation.repositoryStableId
  ) {
    throw new Error('Rollback source repository identity verification failed');
  }
  const targetRows = await ports.repoint.listIssuePlanRows(operation.connectorInstanceId, to);
  const issueRows = targetRows.length > 0
    ? targetRows
    : await ports.repoint.listIssuePlanRows(operation.connectorInstanceId, from);
  if (operation.phase !== 'rolled_back') {
    for (const row of issueRows) {
      if (!row.issueStableId || !row.issueNumber) {
        throw new Error(`Task ${row.taskId} is missing a stable issue binding for rollback`);
      }
      const evidence = await remote.resolveIssue(from, row.issueNumber, repositoryEvidence);
      if (!evidence || evidence.entity.identity.stableId !== row.issueStableId) {
        throw new Error(`Rollback issue identity verification failed for task ${row.taskId}`);
      }
    }
  }

  await ports.repoint.rollbackOperation({ operationId: operation.id, actor, from, to, now });
  return toStatus(await requireOperation(operation.id));
}

export async function getGitHubRepositoryRepointStatus(
  operationId: string,
): Promise<GitHubRepositoryRepointStatus> {
  return toStatus(await requireOperation(operationId));
}

export async function transferGitHubIssueSafely(
  input: {
    connectorInstanceId: string;
    sourceId: string;
    targetRepository: string;
    actor: string;
  },
  dependencies: RepointDependencies = {},
): Promise<GitHubIssueTransferResult> {
  return runWithConnectorOperationLease(input.connectorInstanceId, 'transfer', () => (
    transferGitHubIssueWithLease(input, dependencies)
  ));
}

export async function reconcileHistoricalGitHubIssueTransfer(
  input: {
    connectorInstanceId: string;
    sourceTaskId: string;
    successorTaskId: string;
    expectedRevision: number;
    actor: string;
    reason: string;
    idempotencyKey: string;
  },
  dependencies: RepointDependencies = {},
) {
  return runWithConnectorOperationLease(input.connectorInstanceId, 'transfer', async () => {
    const ports = await recovery();
    const mode = await ports.transfer.getIdentityModeSnapshot(input.connectorInstanceId);
    if (mode.modeRevision !== input.expectedRevision) {
      throw new Error(
        `GitHub identity mode revision changed: expected ${input.expectedRevision}, found ${mode.modeRevision}`,
      );
    }
    const source = await ports.transfer.readTaskTransferBinding(
      input.connectorInstanceId,
      input.sourceTaskId,
    );
    const successor = await ports.transfer.readTaskTransferBinding(
      input.connectorInstanceId,
      input.successorTaskId,
    );
    const sourceLocator = parseSourceId(source.sourceId);
    const successorLocator = parseSourceId(successor.sourceId);
    if (
      sourceLocator.repo.split('/')[0].toLowerCase()
      !== successorLocator.repo.split('/')[0].toLowerCase()
    ) {
      throw new Error('Historical GitHub transfer reconciliation requires one repository owner');
    }

    const connector = await requireGitHubConnector(input.connectorInstanceId);
    const remote = dependencies.remote ?? await createRemote(connector);
    if (!remote.resolveHistoricalIssue) {
      throw new Error('GitHub remote does not support historical transfer reconciliation');
    }
    const observation = await remote.resolveHistoricalIssue(
      sourceLocator.repo,
      sourceLocator.issueNumber,
    );
    if (!observation) {
      throw new Error('Historical GitHub issue endpoint was not found or accessible');
    }
    return ports.transfer.recordHistoricalTransferReconciliation({
      ...input,
      requestedSourceId: source.sourceId,
      observation,
      now: (dependencies.now?.() ?? new Date()).toISOString(),
    });
  });
}

export async function canTransferGitHubIssueSafely(
  connectorInstanceId: string,
  sourceId: string,
  targetRepository: string,
): Promise<boolean> {
  let source: ReturnType<typeof parseSourceId>;
  try {
    source = parseSourceId(sourceId);
    validateRepositoryPath(source.repo, 'source repository');
    validateRepositoryPath(targetRepository, 'target repository');
  } catch {
    return false;
  }
  if (
    source.repo.split('/')[0].toLowerCase()
    !== targetRepository.split('/')[0].toLowerCase()
  ) {
    return false;
  }

  const ports = await recovery();
  const issue = (await ports.transfer.listIssuePlanRows(connectorInstanceId, source.repo))
    .find((candidate) => candidate.sourceId === sourceId);
  if (!issue?.issueEntityId || !issue.issueStableId || !issue.repositoryEntityId) return false;
  return Boolean(
    await ports.transfer.getRepositoryBinding(connectorInstanceId, targetRepository),
  );
}

export async function transferGitHubIssueByStableIdentity(
  client: Pick<GitHubClient, 'graphqlFetch'>,
  issueStableId: string,
  targetRepositoryStableId: string,
): Promise<number> {
  const mutation = `
    mutation TransferIssue($issueId: ID!, $repositoryId: ID!) {
      transferIssue(input: { issueId: $issueId, repositoryId: $repositoryId }) {
        issue {
          number
          repository {
            id
          }
        }
      }
    }
  `;
  const response = await client.graphqlFetch(mutation, {
    issueId: issueStableId,
    repositoryId: targetRepositoryStableId,
  });
  if (response.errors?.length) {
    throw new Error(`GitHub issue transfer failed: ${response.errors[0].message}`);
  }
  const transferred = response.data?.transferIssue?.issue;
  if (
    !Number.isSafeInteger(transferred?.number)
    || (transferred?.number ?? 0) <= 0
    || transferred?.repository?.id !== targetRepositoryStableId
  ) {
    throw new Error('GitHub issue transfer returned an invalid destination');
  }
  return transferred.number!;
}

export async function transferGitHubIssueWithLease(
  input: {
    connectorInstanceId: string;
    sourceId: string;
    targetRepository: string;
    actor: string;
  },
  dependencies: RepointDependencies,
): Promise<GitHubIssueTransferResult> {
  validateActor(input.actor);
  const source = parseSourceId(input.sourceId);
  validateRepositoryPath(source.repo, 'source repository');
  validateRepositoryPath(input.targetRepository, 'target repository');
  if (
    source.repo.split('/')[0].toLowerCase()
    !== input.targetRepository.split('/')[0].toLowerCase()
  ) {
    throw new Error('GitHub issue transfer requires repositories with the same owner');
  }
  if (!Number.isSafeInteger(source.issueNumber) || source.issueNumber <= 0) {
    throw new Error('GitHub source ID must use owner/repository:issueNumber');
  }
  const ports = await recovery();
  const connector = await requireGitHubConnector(input.connectorInstanceId);
  const remote = dependencies.remote ?? await createRemote(connector);
  if (!remote.transferIssue) throw new Error('GitHub remote does not support issue transfer');
  const issue = (await ports.transfer.listIssuePlanRows(input.connectorInstanceId, source.repo))
    .find((candidate) => candidate.sourceId === input.sourceId);
  if (!issue?.issueEntityId || !issue.issueStableId || !issue.repositoryEntityId) {
    throw new Error('Native GitHub transfer requires an unambiguous stable issue binding');
  }
  const sourceRepositoryStableId = await ports.transfer
    .getRepositoryStableId(issue.repositoryEntityId);
  if (!sourceRepositoryStableId) throw new Error('Repository entity is missing');
  const targetBinding = await ports.transfer.getRepositoryBinding(
    input.connectorInstanceId,
    input.targetRepository,
  );
  if (!targetBinding) {
    throw new Error('Target repository requires a stable source-list binding in the same connector');
  }

  const [sourceRepository, targetRepository] = await Promise.all([
    remote.resolveRepository(source.repo),
    remote.resolveRepository(input.targetRepository),
  ]);
  if (
    !sourceRepository
    || sourceRepository.identity.stableId !== sourceRepositoryStableId
    || !targetRepository
    || targetRepository.identity.stableId !== targetBinding.repositoryStableId
  ) {
    throw new Error('Native GitHub transfer repository identity verification failed');
  }
  const before = await remote.resolveIssue(source.repo, source.issueNumber, sourceRepository);
  if (!before || before.entity.identity.stableId !== issue.issueStableId) {
    throw new Error('Native GitHub transfer source issue identity verification failed');
  }

  await dependencies.onTransferDispatch?.();
  const transferredNumber = await remote.transferIssue(
    issue.issueStableId,
    targetBinding.repositoryStableId,
  );
  await dependencies.onTransferAccepted?.(transferredNumber);
  const after = await resolveTransferredIssue(
    remote,
    input.targetRepository,
    transferredNumber,
    targetRepository,
    issue.issueStableId,
    Boolean(dependencies.onChangedIssueIdentity),
    dependencies.sleep,
  );
  const nowIso = (dependencies.now?.() ?? new Date()).toISOString();
  if (!after) {
    await disableConnectorAfterTransferIncident(input.connectorInstanceId);
    throw new Error('Native GitHub transfer destination identity verification failed');
  }
  if (after.entity.identity.stableId !== issue.issueStableId) {
    if (!dependencies.onChangedIssueIdentity) {
      await disableConnectorAfterTransferIncident(input.connectorInstanceId);
      throw new Error('Native GitHub transfer changed issue identity; local routing was not updated');
    }
    if (
      !after.repository
      || after.repository.identity.stableId !== targetBinding.repositoryStableId
    ) {
      await disableConnectorAfterTransferIncident(input.connectorInstanceId);
      throw new Error('Native GitHub transfer destination identity verification failed');
    }
    const destinationLocator = after.entity.locator;
    const canonicalDestinationRepository = (
      `${destinationLocator.owner}/${destinationLocator.repository}`
    ).toLowerCase();
    if (
      destinationLocator.issueNumber !== transferredNumber
      || canonicalDestinationRepository !== input.targetRepository.toLowerCase()
    ) {
      await disableConnectorAfterTransferIncident(input.connectorInstanceId);
      throw new Error('Native GitHub transfer destination locator verification failed');
    }
    try {
      await dependencies.onChangedIssueIdentity({
        sourceTaskId: issue.taskId,
        sourceExternalEntityId: issue.issueEntityId,
        sourceStableId: issue.issueStableId,
        sourceId: input.sourceId,
        targetNumber: transferredNumber,
        targetRepository: input.targetRepository,
        targetRepositoryEntityId: targetBinding.repositoryEntityId,
        targetRepositoryStableId: targetBinding.repositoryStableId,
        evidence: after,
      });
    } catch (error) {
      await disableConnectorAfterTransferIncident(input.connectorInstanceId);
      throw error;
    }
    return {
      newSourceId: `${input.targetRepository}:${transferredNumber}`,
      identityVerified: true,
      issueStableId: after.entity.identity.stableId,
      repositoryStableId: targetBinding.repositoryStableId,
    };
  }

  let result;
  try {
    result = await ports.transfer.applyNativeTransferRouting({
      connectorInstanceId: input.connectorInstanceId,
      taskId: issue.taskId,
      issueEntityId: issue.issueEntityId,
      legacySourceId: input.sourceId,
      newSourceId: `${input.targetRepository}:${transferredNumber}`,
      targetRepository: input.targetRepository,
      targetRepositoryEntityId: targetBinding.repositoryEntityId,
      identity: after.entity.identity,
      locator: after.entity.locator,
      observedAt: nowIso,
      now: nowIso,
      refreshMetadata: (metadata) => refreshGitHubIssueMetadata(
        metadata,
        `${input.targetRepository}:${transferredNumber}`,
        after,
      ),
    });
  } catch (error) {
    await disableConnectorAfterTransferIncident(input.connectorInstanceId);
    throw error;
  }
  if (result.outcome === 'collision') {
    throw new Error('Native GitHub transfer locator collided with another stable identity');
  }
  return {
    newSourceId: `${input.targetRepository}:${transferredNumber}`,
    identityVerified: true,
    issueStableId: issue.issueStableId,
    repositoryStableId: targetBinding.repositoryStableId,
  };
}

async function resolveTransferredIssue(
  remote: GitHubRepositoryRepointRemote,
  targetRepository: string,
  transferredNumber: number,
  targetRepositoryEvidence: ExternalIdentityObservation,
  expectedIssueStableId: string,
  acceptChangedIdentity: boolean,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ExternalIdentityEvidence | null> {
  const retryDelaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000];
  let observation = await remote.resolveIssue(
    targetRepository,
    transferredNumber,
    targetRepositoryEvidence,
  );
  if (
    observation
    && (acceptChangedIdentity || observation.entity.identity.stableId === expectedIssueStableId)
  ) return observation;

  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs);
    observation = await remote.resolveIssue(
      targetRepository,
      transferredNumber,
      targetRepositoryEvidence,
    );
    if (
      observation
      && (acceptChangedIdentity || observation.entity.identity.stableId === expectedIssueStableId)
    ) return observation;
  }
  return observation;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function disableConnectorAfterTransferIncident(
  connectorInstanceId: string,
): Promise<void> {
  const ports = await recovery();
  await ports.transfer.disableConnector(connectorInstanceId, new Date().toISOString());
}

async function buildRepointPlan(
  input: Omit<GitHubRepositoryRepointInput, 'idempotencyKey'>,
  dependencies: RepointDependencies,
  ownedOperationId?: string,
): Promise<RepointPlan> {
  validateActor(input.actor);
  validateRepositoryPath(input.from, 'source repository');
  validateRepositoryPath(input.to, 'target repository');
  if (input.from.toLowerCase() === input.to.toLowerCase()) {
    throw new Error('Source and target repository paths must differ');
  }
  const ports = await recovery();
  const connector = await requireGitHubConnector(input.connectorInstanceId);
  const origin = normalizeGitHubOrigin(connector.apiOrigin ?? undefined);
  const remote = dependencies.remote ?? await createRemote(connector);
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const repositoryBinding = await ports.repoint.getRepositoryBinding(
    input.connectorInstanceId,
    input.from,
  );
  const reasons: string[] = [];
  if (!repositoryBinding) reasons.push('source_repository_binding_missing_or_ambiguous');

  let targetRepositoryEvidence: ExternalIdentityObservation | null = null;
  let oldRepositoryEvidence: ExternalIdentityObservation | null = null;
  try {
    [targetRepositoryEvidence, oldRepositoryEvidence] = await Promise.all([
      remote.resolveRepository(input.to),
      remote.resolveRepository(input.from),
    ]);
  } catch {
    reasons.push('repository_resolution_inaccessible_or_ambiguous');
  }
  if (!targetRepositoryEvidence) reasons.push('target_repository_inaccessible_or_missing_identity');
  if (targetRepositoryEvidence?.identity.hostKey !== origin.hostKey) {
    reasons.push('target_repository_host_mismatch');
  }
  const repositoryIdentityMatches = Boolean(
    repositoryBinding
    && targetRepositoryEvidence
    && targetRepositoryEvidence.identity.stableId === repositoryBinding.repositoryStableId
    && targetRepositoryEvidence.identity.hostKey === origin.hostKey,
  );
  if (!repositoryIdentityMatches) reasons.push('target_repository_is_a_replacement');

  let oldPathStatus: GitHubRepositoryRepointPreflight['oldPathStatus'] = 'unresolved';
  if (!oldRepositoryEvidence) {
    oldPathStatus = 'not_found';
  } else if (
    repositoryBinding
    && oldRepositoryEvidence.identity.stableId === repositoryBinding.repositoryStableId
  ) {
    oldPathStatus = 'same_repository';
  } else {
    oldPathStatus = 'replacement';
    reasons.push('old_repository_path_has_been_reused');
  }

  const issueRows = await ports.repoint.listIssuePlanRows(input.connectorInstanceId, input.from);
  const issues: IssueMutationPlan[] = [];
  let missingIssueBindings = 0;
  let issueIdentityMismatches = 0;
  let locatorCollisions = 0;
  if (repositoryBinding && targetRepositoryEvidence && repositoryIdentityMatches) {
    const repositoryPreflight = await ports.repoint.preflightLocator({
      entityId: repositoryBinding.repositoryEntityId,
      identity: targetRepositoryEvidence.identity,
      locator: targetRepositoryEvidence.locator,
      repositoryEntityId: null,
      observedAt,
    });
    if (repositoryPreflight === 'collision') {
      locatorCollisions++;
      reasons.push('repository_locator_collision');
    }
    for (const row of issueRows) {
      if (
        !row.issueEntityId
        || !row.issueStableId
        || !row.issueNumber
        || row.repositoryEntityId !== repositoryBinding.repositoryEntityId
      ) {
        missingIssueBindings++;
        continue;
      }
      const evidence = await remote.resolveIssue(input.to, row.issueNumber, targetRepositoryEvidence);
      if (!evidence || evidence.entity.identity.stableId !== row.issueStableId) {
        issueIdentityMismatches++;
        continue;
      }
      const locatorPreflight = await ports.repoint.preflightLocator({
        entityId: row.issueEntityId,
        identity: evidence.entity.identity,
        locator: evidence.entity.locator,
        repositoryEntityId: repositoryBinding.repositoryEntityId,
        observedAt,
      });
      if (locatorPreflight === 'collision') locatorCollisions++;
      issues.push({ row, evidence });
    }
  }
  if (missingIssueBindings > 0) reasons.push('affected_tasks_missing_stable_issue_bindings');
  if (issueIdentityMismatches > 0) reasons.push('target_issue_identity_mismatch');
  if (locatorCollisions > 0) reasons.push('identity_locator_collision');

  const inventory = await ports.repoint.collectInventory({
    connectorInstanceId: input.connectorInstanceId,
    from: input.from,
    to: input.to,
    ...(ownedOperationId ? { ownedOperationId } : {}),
  });
  const { counts, relationships, activity } = inventory;
  if (
    counts.connectorSettings !== 1
    || counts.connectorSyncedLists !== 1
    || counts.sourceLists !== 1
  ) {
    reasons.push('connector_repository_configuration_mismatch');
  }
  if (counts.pendingPushes > 0) reasons.push('pending_pushes_must_be_drained');
  if (counts.failedPushes > 0) reasons.push('failed_pushes_must_be_resolved');
  if (counts.deletionCandidates > 0) reasons.push('deletion_candidates_must_be_cleared');
  if (counts.dependencySnapshots > 0) reasons.push('dependency_snapshots_must_be_completed_or_cancelled');
  if (counts.openIdentityCollisions > 0) reasons.push('open_identity_collisions');
  if (counts.targetTaskConflicts > 0 || counts.targetSourceListConflicts > 0) {
    reasons.push('target_path_has_conflicting_local_records');
  }
  if (activity.queuedSyncJobs > 0 || activity.runningSyncJobs > 0 || activity.operationLeases > 0) {
    reasons.push('connector_activity_must_be_drained');
  }
  if (activity.maintenanceLocks > 0) reasons.push('conflicting_maintenance_operation');
  const backupReady = ownedOperationId
    ? true
    : isBackupAttestationReady(input.backupProof, new Date(observedAt));
  if (!backupReady) reasons.push('verified_recent_backup_required');

  const report: GitHubRepositoryRepointPreflight = {
    connectorInstanceId: input.connectorInstanceId,
    from: input.from,
    to: input.to,
    hostKey: origin.hostKey,
    repositoryEntityId: repositoryBinding?.repositoryEntityId ?? null,
    repositoryStableIdDigest: repositoryBinding
      ? digest(repositoryBinding.repositoryStableId)
      : null,
    targetRepositoryStableIdDigest: targetRepositoryEvidence
      ? digest(targetRepositoryEvidence.identity.stableId)
      : null,
    repositoryIdentityMatches,
    oldPathStatus,
    backupReady,
    counts,
    relationships,
    activity,
    issueIdentitiesChecked: issues.length,
    issueIdentityMismatches,
    missingIssueBindings,
    locatorCollisions,
    deletionCandidates: inventory.deletionCandidates,
    go: false,
    reasons: [...new Set(reasons)],
  };
  report.go = report.reasons.length === 0 && issues.length === issueRows.length;
  return { report, connector, repositoryBinding, targetRepositoryEvidence, issues };
}

async function createRemote(
  connector: GitHubRecoveryConnectorSnapshot,
): Promise<GitHubRepositoryRepointRemote> {
  const ports = await recovery();
  const credentials = await ports.transfer.getConnectorCredentials(connector.id);
  if (!credentials) throw new Error('GitHub connector credentials are missing');
  const client = createGitHubClient(credentials.token, credentials.apiOrigin ?? undefined);
  const resolveRepository = async (
    repository: string,
  ): Promise<ExternalIdentityObservation | null> => {
    const response = await client.restFetch(`/repos/${encodeRepository(repository)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status})`);
    return repositoryEvidenceFromRest(
      await response.json() as GitHubRestRepository,
      client.origin,
      new Date().toISOString(),
    ) ?? null;
  };
  return {
    resolveRepository,
    async resolveIssue(repository, issueNumber, repositoryEvidence) {
      const response = await client.restFetch(
        `/repos/${encodeRepository(repository)}/issues/${issueNumber}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub issue lookup failed (${response.status})`);
      return issueEvidenceFromRest(
        await response.json() as GitHubRestIssue,
        repositoryEvidence,
        client.origin,
        new Date().toISOString(),
      ) ?? null;
    },
    async transferIssue(issueStableId, targetRepositoryStableId) {
      return transferGitHubIssueByStableIdentity(
        client,
        issueStableId,
        targetRepositoryStableId,
      );
    },
    async resolveHistoricalIssue(repository, issueNumber) {
      const response = await client.restFetch(
        `/repos/${encodeRepository(repository)}/issues/${issueNumber}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`GitHub historical issue lookup failed (${response.status})`);
      }
      const issue = await response.json() as GitHubRestIssue;
      const canonicalRepository = repositoryFromApiUrl(
        issue.repository_url,
        client.origin,
      );
      const repositoryEvidence = await resolveRepository(canonicalRepository);
      if (!repositoryEvidence) {
        throw new Error('GitHub historical issue response repository was not found');
      }
      const observedAt = new Date().toISOString();
      const evidence = issueEvidenceFromRest(
        issue,
        repositoryEvidence,
        client.origin,
        observedAt,
      );
      if (!evidence) {
        throw new Error('GitHub historical issue response omitted its stable identity');
      }
      return {
        evidence,
        title: issue.title,
        state: issue.state,
        stateReason: issue.state_reason ?? null,
      };
    },
    async listIssues(repository) {
      const issues: GitHubRestIssue[] = [];
      let next: string | null = `/repos/${encodeRepository(repository)}/issues?state=all&per_page=100`;
      while (next) {
        const response = await client.restFetch(next);
        if (!response.ok) {
          throw new Error(`GitHub issue enumeration failed (${response.status})`);
        }
        const page = await response.json() as GitHubRestIssue[];
        issues.push(...page.filter((issue) => !issue.pull_request));
        next = nextLink(response.headers.get('link'));
      }
      return issues;
    },
  };
}

export async function createGitHubRepositoryRemote(
  connectorInstanceId: string,
): Promise<GitHubRepositoryRepointRemote> {
  return createRemote(await requireGitHubConnector(connectorInstanceId));
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

function repositoryFromApiUrl(
  repositoryUrl: string | undefined,
  origin: ReturnType<typeof normalizeGitHubOrigin>,
): string {
  if (!repositoryUrl) {
    throw new Error('GitHub historical issue response omitted repository_url');
  }
  const url = assertTrustedGitHubUrl(repositoryUrl, origin);
  const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) {
    throw new Error('GitHub historical issue response has an invalid repository_url');
  }
  return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
}

async function requireGitHubConnector(
  connectorInstanceId: string,
): Promise<GitHubRecoveryConnectorSnapshot> {
  const ports = await recovery();
  const connector = await ports.transfer.getConnector(connectorInstanceId);
  if (!connector || connector.type !== 'github-issues') {
    throw new Error('Active GitHub connector was not found');
  }
  return connector;
}

async function requireOperation(operationId: string) {
  const ports = await recovery();
  const operation = await ports.repoint.getOperation(operationId);
  if (!operation) throw new Error('GitHub repository repoint operation was not found');
  return operation;
}

function toStatus(operation: {
  id: string;
  connectorInstanceId: string;
  phase: GitHubRepositoryRepointPhase;
  fromOwner: string;
  fromRepository: string;
  toOwner: string;
  toRepository: string;
  actor: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  connectorLocked: boolean;
  verification: Record<string, unknown> | null;
}): GitHubRepositoryRepointStatus {
  return {
    id: operation.id,
    connectorInstanceId: operation.connectorInstanceId,
    phase: operation.phase,
    from: repositoryPath(operation.fromOwner, operation.fromRepository),
    to: repositoryPath(operation.toOwner, operation.toRepository),
    actor: operation.actor,
    lastError: operation.lastError,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
    connectorLocked: operation.connectorLocked,
    verification: operation.verification,
  };
}

function assertSameOperation(
  operation: {
    fromOwner: string;
    fromRepository: string;
    toOwner: string;
    toRepository: string;
    backupProof: Record<string, unknown>;
  },
  input: GitHubRepositoryRepointInput,
): void {
  if (
    !samePath(repositoryPath(operation.fromOwner, operation.fromRepository), input.from)
    || !samePath(repositoryPath(operation.toOwner, operation.toRepository), input.to)
    || stringValue(operation.backupProof.sha256) !== input.backupProof.sha256
  ) {
    throw new Error('Idempotency key is already assigned to a different repoint operation');
  }
}

function validateOperatorInput(input: GitHubRepositoryRepointInput): void {
  validateActor(input.actor);
  validateRepositoryPath(input.from, 'source repository');
  validateRepositoryPath(input.to, 'target repository');
  if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
    throw new Error('Idempotency key must contain 8 to 200 characters');
  }
}

function validateActor(actor: string): void {
  if (!actor.trim() || actor.length > 200) {
    throw new Error('Authenticated operator identity is required');
  }
}

function validateRepositoryPath(repository: string, label: string): void {
  if (!REPOSITORY_PATH.test(repository)) {
    throw new Error(`${label} must use owner/repository`);
  }
}

function compactPreflight(
  report: GitHubRepositoryRepointPreflight,
): Record<string, unknown> {
  return {
    ...report,
    deletionCandidates: report.deletionCandidates.slice(0, 50),
  };
}

function encodeRepository(repository: string): string {
  validateRepositoryPath(repository, 'repository');
  return repository.split('/').map(encodeURIComponent).join('/');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
