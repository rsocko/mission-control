import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { and, eq, inArray } from 'drizzle-orm';
import db, { runTransaction, sqlite } from '@/db';
import {
  connectorConfigs,
  connectorMaintenanceLocks,
  connectorOperationLeases,
  externalEntities,
  externalEntityBindings,
  githubRepositoryRepointEvents,
  githubRepositoryRepoints,
  sourceLists,
  syncJobs,
  taskIngestSuppressions,
  taskLinkedSources,
  tasks,
  type GitHubRepositoryRepointPhase,
} from '@/db/schema';
import {
  getGitHubIdentityModeSnapshot,
  getCurrentExternalEntityLocatorInTransaction,
  listExternalEntityLocatorHistoryInTransaction,
  observeOperatorExternalEntityLocatorInTransaction,
  preflightExternalEntityLocator,
  preflightExternalEntityLocatorInTransaction,
  readGitHubTaskTransferBinding,
  recordGitHubTaskTransferReconciliation,
  recordExternalIdentityCollisionInTransaction,
  type ExternalEntityIdentity,
  type ExternalEntityLocatorEvidence,
  type ExternalEntityLocatorPreflight,
  type ExternalIdentityEvidence,
  type ExternalIdentityObservation,
  type ExternalIdentityTransaction,
} from '@/lib/external-identities';
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
import { parseSourceId } from './issue-transformer';
import { runWithConnectorOperationLease } from '@/lib/sync/connector-lock';

const REPOSITORY_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ACTIVE_BINDING_STATES = new Set(['shadow', 'active']);
const MAX_BACKUP_AGE_MS = 24 * 60 * 60_000;

export interface GitHubRepointBackupProof extends Record<string, unknown> {
  path: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
  integrityCheck: 'ok';
  verifiedAt: string;
}

export interface GitHubRepositoryRepointCounts extends Record<string, unknown> {
  connectorSettings: number;
  connectorSyncedLists: number;
  sourceLists: number;
  tasks: number;
  linkedSources: number;
  ingestSuppressions: number;
  deletionCandidates: number;
  pendingPushes: number;
  failedPushes: number;
  dependencySnapshots: number;
  openIdentityCollisions: number;
  targetTaskConflicts: number;
  targetSourceListConflicts: number;
}

export interface GitHubRepositoryRelationshipCounts extends Record<string, unknown> {
  projects: number;
  phases: number;
  schedules: number;
  tags: number;
  dependencies: number;
  history: number;
  myDay: number;
  focus: number;
  attachments: number;
}

export interface GitHubRepositoryRepointActivity extends Record<string, unknown> {
  queuedSyncJobs: number;
  runningSyncJobs: number;
  operationLeases: number;
  maintenanceLocks: number;
}

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
  onTransferDispatch?: () => void;
}

interface RepositoryBindingRow {
  repositoryEntityId: string;
  repositoryStableId: string;
  localId: string;
}

interface IssuePlanRow {
  taskId: string;
  sourceId: string;
  issueEntityId: string | null;
  issueStableId: string | null;
  issueNumber: number | null;
  repositoryEntityId: string | null;
}

interface IssueMutationPlan {
  row: IssuePlanRow;
  evidence: ExternalIdentityEvidence;
}

interface RepointPlan {
  report: GitHubRepositoryRepointPreflight;
  connector: typeof connectorConfigs.$inferSelect;
  repositoryBinding: RepositoryBindingRow | null;
  targetRepositoryEvidence: ExternalIdentityObservation | null;
  issues: IssueMutationPlan[];
}

interface RepointOperationRow {
  id: string;
  connectorInstanceId: string;
  idempotencyKey: string;
  phase: GitHubRepositoryRepointPhase;
  actor: string;
  hostKey: string;
  repositoryEntityId: string;
  repositoryStableId: string;
  fromOwner: string;
  fromRepository: string;
  toOwner: string;
  toRepository: string;
  connectorWasEnabled: boolean;
  backupProof: Record<string, unknown>;
  preflight: Record<string, unknown>;
  rollbackSnapshot: Record<string, unknown>;
  verification: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export async function inspectGitHubRepointBackup(
  backupPath: string,
  now = new Date(),
): Promise<GitHubRepointBackupProof> {
  const resolvedBackup = path.resolve(backupPath);
  const databasePath = path.resolve(
    process.env.MC_DB_PATH ?? path.join(process.cwd(), 'data', 'mission-control.db'),
  );
  if (resolvedBackup === databasePath) {
    throw new Error('Backup path must not be the active Mission Control database');
  }
  const stat = statSync(resolvedBackup);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Backup must be a non-empty file');
  const backup = new Database(resolvedBackup, { readonly: true, fileMustExist: true });
  try {
    const rows = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error('Backup integrity check did not return exactly "ok"');
    }
  } finally {
    backup.close();
  }
  const modifiedAt = stat.mtime.toISOString();
  if (now.getTime() - stat.mtimeMs > MAX_BACKUP_AGE_MS) {
    throw new Error('Backup is older than 24 hours');
  }
  return {
    path: resolvedBackup,
    sha256: await hashFile(resolvedBackup),
    sizeBytes: stat.size,
    modifiedAt,
    integrityCheck: 'ok',
    verifiedAt: now.toISOString(),
  };
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
  const existing = getOperationByIdempotency(input.connectorInstanceId, input.idempotencyKey);
  if (existing) {
    assertSameOperation(existing, input);
    if (existing.phase === 'verified') return toStatus(existing);
    if (existing.phase === 'applied' || existing.phase === 'verifying' || existing.phase === 'verification_failed') {
      return verifyGitHubRepositoryRepoint(existing.id, dependencies);
    }
    if (existing.phase !== 'locked') {
      throw new Error(`Repoint operation cannot resume from phase ${existing.phase}`);
    }
  } else if (!isBackupProofReady(input.backupProof, dependencies.now?.() ?? new Date())) {
    throw new Error('A verified recent backup proof is required');
  }

  const plan = await buildRepointPlan(input, dependencies, existing?.id);
  if (!plan.report.go || !plan.repositoryBinding || !plan.targetRepositoryEvidence) {
    throw new Error(`GitHub repository repoint preflight failed: ${plan.report.reasons.join('; ')}`);
  }
  const operation = existing ?? acquireRepointOperation(
    input,
    plan,
    dependencies.now?.() ?? new Date(),
  );
  if (operation.phase === 'locked') {
    const applied = applyRepointOperation(operation, plan, dependencies.now?.() ?? new Date());
    if (!applied) return toStatus(requireOperation(operation.id));
  }
  return verifyGitHubRepositoryRepoint(operation.id, {
    ...dependencies,
    remote: dependencies.remote ?? createRemote(plan.connector),
  });
}

export async function verifyGitHubRepositoryRepoint(
  operationId: string,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointStatus> {
  const operation = requireOperation(operationId);
  if (operation.phase === 'verified') return toStatus(operation);
  if (!['applied', 'verifying', 'verification_failed'].includes(operation.phase)) {
    throw new Error(`Repoint operation cannot be verified from phase ${operation.phase}`);
  }
  const connector = requireGitHubConnector(operation.connectorInstanceId);
  const remote = dependencies.remote ?? createRemote(connector);
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  setOperationPhase(operation.id, 'verifying', operation.actor, {}, now);

  const target = repositoryPath(operation.toOwner, operation.toRepository);
  const source = repositoryPath(operation.fromOwner, operation.fromRepository);
  const repositoryEvidence = await remote.resolveRepository(target);
  const issueRows = selectIssuePlanRows(operation.connectorInstanceId, target);
  const mismatches: Array<{ taskId: string; reason: string }> = [];
  const expectedTaskCount = asRecord(operation.preflight.counts).tasks;
  const repositoryMatched = Boolean(
    repositoryEvidence
    && repositoryEvidence.identity.hostKey === operation.hostKey
    && repositoryEvidence.identity.stableId === operation.repositoryStableId,
  );
  if (
    !repositoryEvidence
    || repositoryEvidence.identity.hostKey !== operation.hostKey
    || repositoryEvidence.identity.stableId !== operation.repositoryStableId
  ) {
    mismatches.push({ taskId: '', reason: 'repository_identity_mismatch' });
  } else {
    for (const row of issueRows) {
      if (!row.issueStableId || !row.issueNumber || row.repositoryEntityId !== operation.repositoryEntityId) {
        mismatches.push({ taskId: row.taskId, reason: 'missing_or_conflicting_binding' });
        continue;
      }
      const evidence = await remote.resolveIssue(target, row.issueNumber, repositoryEvidence);
      if (!evidence || evidence.entity.identity.stableId !== row.issueStableId) {
        mismatches.push({ taskId: row.taskId, reason: 'issue_identity_mismatch' });
      }
    }
  }
  if (
    typeof expectedTaskCount !== 'number'
    || !hasExpectedAppliedRouting(operation.connectorInstanceId, source, target, expectedTaskCount)
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
    failVerification(operation, verification, 'Locked verification found identity mismatches', now);
    return toStatus(requireOperation(operation.id));
  }

  function hasExpectedAppliedRouting(
    connectorInstanceId: string,
    source: string,
    target: string,
    expectedTaskCount: number,
  ): boolean {
    const connector = requireGitHubConnector(connectorInstanceId);
    const settings = asRecord(connector.settings);
    const configuredRepositories = asStringArray(settings.repos);
    const syncedLists = asStringArray(connector.syncedLists);
    const sourcePrefix = `${source}:`;
    const targetPrefix = `${target}:`;
    return configuredRepositories.filter((repository) => samePath(repository, target)).length === 1
      && configuredRepositories.every((repository) => !samePath(repository, source))
      && syncedLists.filter((repository) => samePath(repository, target)).length === 1
      && syncedLists.every((repository) => !samePath(repository, source))
      && scalar(`
        SELECT COUNT(*) AS value FROM source_lists
        WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
      `, connectorInstanceId, target) === 1
      && scalar(`
        SELECT COUNT(*) AS value FROM source_lists
        WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
      `, connectorInstanceId, source) === 0
      && scalar(`
        SELECT COUNT(*) AS value FROM tasks
        WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
      `, connectorInstanceId, targetPrefix, targetPrefix) === expectedTaskCount
      && scalar(`
        SELECT COUNT(*) AS value FROM tasks
        WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
      `, connectorInstanceId, sourcePrefix, sourcePrefix) === 0;
  }

  runTransaction((tx) => {
    const current = requireOperationInTransaction(tx, operation.id);
    requireOwnedMaintenanceLock(tx, current);
    tx.update(connectorConfigs).set({
      enabled: current.connectorWasEnabled,
      updatedAt: now,
    }).where(eq(connectorConfigs.id, current.connectorInstanceId)).run();
    tx.delete(connectorMaintenanceLocks)
      .where(eq(connectorMaintenanceLocks.connectorInstanceId, current.connectorInstanceId))
      .run();
    tx.update(githubRepositoryRepoints).set({
      phase: 'verified',
      verification,
      lastError: null,
      updatedAt: now,
      completedAt: now,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'verified', current.actor, verification, now);
  });
  return toStatus(requireOperation(operation.id));
}

export async function rollbackGitHubRepositoryRepoint(
  operationId: string,
  actor: string,
  dependencies: RepointDependencies = {},
): Promise<GitHubRepositoryRepointStatus> {
  validateActor(actor);
  const operation = requireOperation(operationId);
  if (!['applied', 'verifying', 'verification_failed', 'failed'].includes(operation.phase)) {
    throw new Error(`Repoint operation cannot be rolled back from phase ${operation.phase}`);
  }
  const connector = requireGitHubConnector(operation.connectorInstanceId);
  const remote = dependencies.remote ?? createRemote(connector);
  const nowIso = (dependencies.now?.() ?? new Date()).toISOString();
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
  const targetRows = selectIssuePlanRows(operation.connectorInstanceId, to);
  const issueRows = targetRows.length > 0
    ? targetRows
    : selectIssuePlanRows(operation.connectorInstanceId, from);
  for (const row of issueRows) {
    if (!row.issueStableId || !row.issueNumber) {
      throw new Error(`Task ${row.taskId} is missing a stable issue binding for rollback`);
    }
    const evidence = await remote.resolveIssue(from, row.issueNumber, repositoryEvidence);
    if (!evidence || evidence.entity.identity.stableId !== row.issueStableId) {
      throw new Error(`Rollback issue identity verification failed for task ${row.taskId}`);
    }
  }

  runTransaction((tx) => {
    const current = requireOperationInTransaction(tx, operation.id);
    requireOwnedMaintenanceLock(tx, current);
    assertNoConnectorActivityInTransaction(tx, current.connectorInstanceId);
    tx.update(githubRepositoryRepoints).set({
      phase: 'rolling_back',
      actor,
      updatedAt: nowIso,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'rolling_back', actor, {}, nowIso);

    restoreHistoricalLocator(tx, current.repositoryEntityId, {
      provider: 'github',
      hostKey: current.hostKey,
      entityType: 'repository',
      stableId: current.repositoryStableId,
    }, from, null, nowIso);

    const issues = selectIssuePlanRowsInTransaction(tx, current.connectorInstanceId, to);
    for (const issue of issues) {
      if (!issue.issueEntityId || !issue.issueStableId || !issue.issueNumber) {
        throw new Error(`Task ${issue.taskId} lost its issue binding before rollback`);
      }
      restoreHistoricalLocator(tx, issue.issueEntityId, {
        provider: 'github',
        hostKey: current.hostKey,
        entityType: 'issue',
        stableId: issue.issueStableId,
      }, from, current.repositoryEntityId, nowIso, issue.issueNumber);
      tx.update(tasks).set({
        sourceId: `${from}:${issue.issueNumber}`,
        sourceListId: from,
        sourceListName: from,
        updatedAt: nowIso,
      }).where(eq(tasks.id, issue.taskId)).run();
    }
    replaceActiveReferences(tx, current.connectorInstanceId, to, from, nowIso);
    const snapshot = current.rollbackSnapshot;
    tx.update(connectorConfigs).set({
      settings: snapshot.settings ?? {},
      syncedLists: snapshot.syncedLists ?? [],
      enabled: false,
      updatedAt: nowIso,
    }).where(eq(connectorConfigs.id, current.connectorInstanceId)).run();
    tx.delete(connectorMaintenanceLocks)
      .where(eq(connectorMaintenanceLocks.connectorInstanceId, current.connectorInstanceId))
      .run();
    tx.update(githubRepositoryRepoints).set({
      phase: 'rolled_back',
      actor,
      lastError: null,
      updatedAt: nowIso,
      completedAt: nowIso,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'rolled_back', actor, {
      connectorRemainsDisabled: true,
      restoredPath: from,
    }, nowIso);
  });
  return toStatus(requireOperation(operation.id));
}

export function getGitHubRepositoryRepointStatus(
  operationId: string,
): GitHubRepositoryRepointStatus {
  return toStatus(requireOperation(operationId));
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
    const mode = getGitHubIdentityModeSnapshot(input.connectorInstanceId);
    if (mode.modeRevision !== input.expectedRevision) {
      throw new Error(
        `GitHub identity mode revision changed: expected ${input.expectedRevision}, found ${mode.modeRevision}`,
      );
    }
    const source = readGitHubTaskTransferBinding(
      db,
      input.connectorInstanceId,
      input.sourceTaskId,
    );
    const successor = readGitHubTaskTransferBinding(
      db,
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

    const connector = requireGitHubConnector(input.connectorInstanceId);
    const remote = dependencies.remote ?? createRemote(connector);
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
    return recordGitHubTaskTransferReconciliation({
      ...input,
      requestedSourceId: source.sourceId,
      observation,
      now: dependencies.now?.(),
    });
  });
}

export function canTransferGitHubIssueSafely(
  connectorInstanceId: string,
  sourceId: string,
  targetRepository: string,
): boolean {
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

  const issue = selectIssuePlanRows(connectorInstanceId, source.repo)
    .find((candidate) => candidate.sourceId === sourceId);
  return Boolean(
    issue?.issueEntityId
    && issue.issueStableId
    && issue.repositoryEntityId
    && getRepositoryBinding(connectorInstanceId, targetRepository),
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
  const connector = requireGitHubConnector(input.connectorInstanceId);
  const remote = dependencies.remote ?? createRemote(connector);
  if (!remote.transferIssue) throw new Error('GitHub remote does not support issue transfer');
  const issue = selectIssuePlanRows(input.connectorInstanceId, source.repo)
    .find((candidate) => candidate.sourceId === input.sourceId);
  if (!issue?.issueEntityId || !issue.issueStableId || !issue.repositoryEntityId) {
    throw new Error('Native GitHub transfer requires an unambiguous stable issue binding');
  }
  const sourceRepositoryEntity = getRepositoryEntity(issue.repositoryEntityId);
  const targetBinding = getRepositoryBinding(input.connectorInstanceId, input.targetRepository);
  if (!targetBinding) {
    throw new Error('Target repository requires a stable source-list binding in the same connector');
  }

  const [sourceRepository, targetRepository] = await Promise.all([
    remote.resolveRepository(source.repo),
    remote.resolveRepository(input.targetRepository),
  ]);
  if (
    !sourceRepository
    || sourceRepository.identity.stableId !== sourceRepositoryEntity.stableId
    || !targetRepository
    || targetRepository.identity.stableId !== targetBinding.repositoryStableId
  ) {
    throw new Error('Native GitHub transfer repository identity verification failed');
  }
  const before = await remote.resolveIssue(source.repo, source.issueNumber, sourceRepository);
  if (!before || before.entity.identity.stableId !== issue.issueStableId) {
    throw new Error('Native GitHub transfer source issue identity verification failed');
  }

  dependencies.onTransferDispatch?.();
  const transferredNumber = await remote.transferIssue(
    issue.issueStableId,
    targetBinding.repositoryStableId,
  );
  const after = await resolveTransferredIssue(
    remote,
    input.targetRepository,
    transferredNumber,
    targetRepository,
    issue.issueStableId,
    dependencies.sleep,
  );
  if (!after || after.entity.identity.stableId !== issue.issueStableId) {
    disableConnectorAfterTransferIncident(input.connectorInstanceId);
    throw new Error('Native GitHub transfer changed issue identity; local routing was not updated');
  }
  const nowIso = (dependencies.now?.() ?? new Date()).toISOString();
  let locatorCollision = false;
  try {
    runTransaction((tx) => {
      const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
        entityId: issue.issueEntityId!,
        identity: after.entity.identity,
        locator: after.entity.locator,
        repositoryEntityId: targetBinding.repositoryEntityId,
        observedAt: nowIso,
      });
      if (observed.state === 'collision') {
        recordExternalIdentityCollisionInTransaction(tx, {
          connectorInstanceId: input.connectorInstanceId,
          category: observed.collisionCategory ?? 'stable_legacy_disagree',
          bindingType: 'task',
          localIds: [issue.taskId],
          externalEntityIds: [
            issue.issueEntityId!,
            ...(observed.conflictingEntityId ? [observed.conflictingEntityId] : []),
          ],
          legacyIdentity: input.sourceId,
          observedAt: nowIso,
        });
        tx.update(connectorConfigs).set({ enabled: false, updatedAt: nowIso })
          .where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
        locatorCollision = true;
        return;
      }
      tx.update(tasks).set({
        sourceId: `${input.targetRepository}:${transferredNumber}`,
        sourceListId: input.targetRepository,
        sourceListName: input.targetRepository,
        updatedAt: nowIso,
        syncStatus: 'synced',
      }).where(eq(tasks.id, issue.taskId)).run();
    });
  } catch (error) {
    disableConnectorAfterTransferIncident(input.connectorInstanceId);
    throw error;
  }
  if (locatorCollision) {
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
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ExternalIdentityEvidence | null> {
  const retryDelaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000];
  let observation = await remote.resolveIssue(
    targetRepository,
    transferredNumber,
    targetRepositoryEvidence,
  );
  if (observation?.entity.identity.stableId === expectedIssueStableId) return observation;

  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs);
    observation = await remote.resolveIssue(
      targetRepository,
      transferredNumber,
      targetRepositoryEvidence,
    );
    if (observation?.entity.identity.stableId === expectedIssueStableId) return observation;
  }
  return observation;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function disableConnectorAfterTransferIncident(connectorInstanceId: string): void {
  db.update(connectorConfigs).set({
    enabled: false,
    updatedAt: new Date().toISOString(),
  }).where(eq(connectorConfigs.id, connectorInstanceId)).run();
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
  const connector = requireGitHubConnector(input.connectorInstanceId);
  const origin = normalizeGitHubOrigin(readApiOrigin(connector.settings));
  const remote = dependencies.remote ?? createRemote(connector);
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const repositoryBinding = getRepositoryBinding(input.connectorInstanceId, input.from);
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

  const issueRows = selectIssuePlanRows(input.connectorInstanceId, input.from);
  const issues: IssueMutationPlan[] = [];
  let missingIssueBindings = 0;
  let issueIdentityMismatches = 0;
  let locatorCollisions = 0;
  if (repositoryBinding && targetRepositoryEvidence && repositoryIdentityMatches) {
    const repositoryPreflight = preflightExternalEntityLocator({
      entityId: repositoryBinding.repositoryEntityId,
      identity: targetRepositoryEvidence.identity,
      locator: targetRepositoryEvidence.locator,
      repositoryEntityId: null,
      observedAt,
    });
    if (repositoryPreflight.state === 'collision') {
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
      const locatorPreflight = preflightExternalEntityLocator({
        entityId: row.issueEntityId,
        identity: evidence.entity.identity,
        locator: evidence.entity.locator,
        repositoryEntityId: repositoryBinding.repositoryEntityId,
        observedAt,
      });
      if (locatorPreflight.state === 'collision') locatorCollisions++;
      issues.push({ row, evidence });
    }
  }
  if (missingIssueBindings > 0) reasons.push('affected_tasks_missing_stable_issue_bindings');
  if (issueIdentityMismatches > 0) reasons.push('target_issue_identity_mismatch');
  if (locatorCollisions > 0) reasons.push('identity_locator_collision');

  const counts = collectCounts(input.connectorInstanceId, input.from, input.to);
  const relationships = collectRelationshipCounts(input.connectorInstanceId, input.from);
  const activity = collectActivity(input.connectorInstanceId, ownedOperationId);
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
    : isBackupProofReady(input.backupProof, new Date(observedAt));
  if (!backupReady) reasons.push('verified_recent_backup_required');

  const deletionCandidates = (sqlite.prepare(`
    SELECT source_id AS sourceId
    FROM sync_deletion_candidates
    WHERE connector_id = ?
    ORDER BY source_id
    LIMIT 50
  `).all(input.connectorInstanceId) as Array<{ sourceId: string }>).map((row) => row.sourceId);
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
    deletionCandidates,
    go: false,
    reasons: [...new Set(reasons)],
  };
  report.go = report.reasons.length === 0 && issues.length === issueRows.length;
  return { report, connector, repositoryBinding, targetRepositoryEvidence, issues };
}

function acquireRepointOperation(
  input: GitHubRepositoryRepointInput,
  plan: RepointPlan,
  observedAt: Date,
): RepointOperationRow {
  const now = observedAt.toISOString();
  const [fromOwner, fromRepository] = input.from.split('/');
  const [toOwner, toRepository] = input.to.split('/');
  const operationId = randomUUID();
  runTransaction((tx) => {
    assertNoConnectorActivityInTransaction(tx, input.connectorInstanceId);
    const existingLock = tx.select().from(connectorMaintenanceLocks)
      .where(eq(connectorMaintenanceLocks.connectorInstanceId, input.connectorInstanceId))
      .limit(1).get();
    if (existingLock) throw new Error('Connector already has a maintenance lock');
    tx.insert(githubRepositoryRepoints).values({
      id: operationId,
      connectorInstanceId: input.connectorInstanceId,
      idempotencyKey: input.idempotencyKey,
      phase: 'locked',
      actor: input.actor,
      hostKey: plan.report.hostKey,
      repositoryEntityId: plan.repositoryBinding!.repositoryEntityId,
      repositoryStableId: plan.repositoryBinding!.repositoryStableId,
      fromOwner,
      fromRepository,
      toOwner,
      toRepository,
      connectorWasEnabled: plan.connector.enabled,
      backupProof: input.backupProof,
      preflight: compactPreflight(plan.report),
      rollbackSnapshot: {
        settings: plan.connector.settings,
        syncedLists: plan.connector.syncedLists,
        relationships: plan.report.relationships,
        taskIdDigest: digest(
          plan.issues.map((issue) => issue.row.taskId).sort().join('\0'),
        ),
      },
      verification: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }).run();
    tx.insert(connectorMaintenanceLocks).values({
      connectorInstanceId: input.connectorInstanceId,
      operationId,
      actor: input.actor,
      reason: 'github_repository_repoint',
      acquiredAt: now,
      updatedAt: now,
    }).run();
    tx.update(connectorConfigs).set({
      enabled: false,
      updatedAt: now,
    }).where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
    appendEvent(tx, operationId, 'locked', input.actor, {
      from: input.from,
      to: input.to,
      counts: plan.report.counts,
      backupSha256: input.backupProof.sha256,
    }, now);
  });
  return requireOperation(operationId);
}

function applyRepointOperation(
  operation: RepointOperationRow,
  plan: RepointPlan,
  now: Date,
): boolean {
  const nowIso = now.toISOString();
  let applied = false;
  runTransaction((tx) => {
    const current = requireOperationInTransaction(tx, operation.id);
    requireOwnedMaintenanceLock(tx, current);
    assertNoConnectorActivityInTransaction(tx, current.connectorInstanceId);
    tx.update(githubRepositoryRepoints).set({
      phase: 'applying',
      updatedAt: nowIso,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'applying', current.actor, {}, nowIso);

    const repositoryInput = {
      entityId: current.repositoryEntityId,
      identity: plan.targetRepositoryEvidence!.identity,
      locator: plan.targetRepositoryEvidence!.locator,
      repositoryEntityId: null,
      observedAt: nowIso,
    };
    const repositoryPreflight = preflightExternalEntityLocatorInTransaction(tx, repositoryInput);
    if (repositoryPreflight.state === 'collision') {
      recordLocatorCollision(tx, current, 'source_list', plan.repositoryBinding!.localId, current.repositoryEntityId, repositoryPreflight, nowIso);
      markOperationFailed(tx, current, 'Repository locator collision during apply', nowIso);
      return;
    }

    for (const issue of plan.issues) {
      const preflight = preflightExternalEntityLocatorInTransaction(tx, {
        entityId: issue.row.issueEntityId!,
        identity: issue.evidence.entity.identity,
        locator: issue.evidence.entity.locator,
        repositoryEntityId: current.repositoryEntityId,
        observedAt: nowIso,
      });
      if (preflight.state === 'collision') {
        recordLocatorCollision(tx, current, 'task', issue.row.taskId, issue.row.issueEntityId!, preflight, nowIso);
        markOperationFailed(tx, current, 'Issue locator collision during apply', nowIso);
        return;
      }
    }
    observeOperatorExternalEntityLocatorInTransaction(tx, repositoryInput);
    for (const issue of plan.issues) {
      observeOperatorExternalEntityLocatorInTransaction(tx, {
        entityId: issue.row.issueEntityId!,
        identity: issue.evidence.entity.identity,
        locator: issue.evidence.entity.locator,
        repositoryEntityId: current.repositoryEntityId,
        observedAt: nowIso,
      });
    }

    const from = repositoryPath(current.fromOwner, current.fromRepository);
    const to = repositoryPath(current.toOwner, current.toRepository);
    replaceConnectorConfiguration(tx, current.connectorInstanceId, from, to, nowIso);
    for (const issue of plan.issues) {
      tx.update(tasks).set({
        sourceId: `${to}:${issue.row.issueNumber}`,
        sourceListId: to,
        sourceListName: to,
        updatedAt: nowIso,
      }).where(eq(tasks.id, issue.row.taskId)).run();
    }
    replaceActiveReferences(tx, current.connectorInstanceId, from, to, nowIso);
    tx.update(githubRepositoryRepoints).set({
      phase: 'applied',
      lastError: null,
      updatedAt: nowIso,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'applied', current.actor, {
      tasksUpdated: plan.issues.length,
      sourceListsUpdated: plan.report.counts.sourceLists,
    }, nowIso);
    applied = true;
  });
  return applied;
}

function replaceConnectorConfiguration(
  tx: ExternalIdentityTransaction,
  connectorInstanceId: string,
  from: string,
  to: string,
  now: string,
): void {
  const connector = tx.select().from(connectorConfigs)
    .where(eq(connectorConfigs.id, connectorInstanceId)).limit(1).get();
  if (!connector) throw new Error('Connector disappeared during repoint');
  const settings = asRecord(connector.settings);
  const repos = asStringArray(settings.repos).map((repo) => samePath(repo, from) ? to : repo);
  const syncedLists = asStringArray(connector.syncedLists)
    .map((repo) => samePath(repo, from) ? to : repo);
  tx.update(connectorConfigs).set({
    settings: { ...settings, repos },
    syncedLists,
    updatedAt: now,
  }).where(eq(connectorConfigs.id, connectorInstanceId)).run();
  tx.update(sourceLists).set({
    sourceId: to,
    name: to,
    lastKnownRemoteName: to,
  }).where(and(
    eq(sourceLists.connectorInstanceId, connectorInstanceId),
    eq(sourceLists.sourceId, from),
  )).run();
}

function replaceActiveReferences(
  tx: ExternalIdentityTransaction,
  connectorInstanceId: string,
  from: string,
  to: string,
  now: string,
): void {
  const fromPrefix = `${from}:`;
  const toPrefix = `${to}:`;
  const linked = tx.select().from(taskLinkedSources)
    .where(eq(taskLinkedSources.connectorInstanceId, connectorInstanceId)).all();
  for (const row of linked) {
    if (!row.sourceId.startsWith(fromPrefix)) continue;
    tx.update(taskLinkedSources).set({
      sourceId: `${toPrefix}${row.sourceId.slice(fromPrefix.length)}`,
    }).where(eq(taskLinkedSources.id, row.id)).run();
  }
  const suppressions = tx.select().from(taskIngestSuppressions)
    .where(eq(taskIngestSuppressions.connectorInstanceId, connectorInstanceId)).all();
  for (const row of suppressions) {
    if (!row.sourceId.startsWith(fromPrefix)) continue;
    tx.delete(taskIngestSuppressions).where(and(
      eq(taskIngestSuppressions.connectorInstanceId, connectorInstanceId),
      eq(taskIngestSuppressions.sourceId, row.sourceId),
    )).run();
    tx.insert(taskIngestSuppressions).values({
      ...row,
      sourceId: `${toPrefix}${row.sourceId.slice(fromPrefix.length)}`,
      createdAt: row.createdAt || now,
    }).run();
  }
}

function restoreHistoricalLocator(
  tx: ExternalIdentityTransaction,
  entityId: string,
  identity: ExternalEntityIdentity,
  repository: string,
  repositoryEntityId: string | null,
  observedAt: string,
  issueNumber?: number,
): void {
  const [owner, name] = repository.split('/');
  const history = listExternalEntityLocatorHistoryInTransaction(tx, entityId);
  const previous = [...history].reverse().find((locator) => (
    samePath(`${locator.owner}/${locator.repository}`, repository)
    && locator.issueNumber === (issueNumber ?? null)
  ));
  const locator: ExternalEntityLocatorEvidence = {
    owner,
    repository: name,
    ...(issueNumber ? { issueNumber } : {}),
    ...(previous?.apiUrl ? { apiUrl: previous.apiUrl } : {}),
    ...(previous?.webUrl ? { webUrl: previous.webUrl } : {}),
  };
  const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
    entityId,
    identity,
    locator,
    repositoryEntityId,
    observedAt,
  });
  if (observed.state === 'collision') {
    throw new Error('Rollback locator conflicts with another stable entity');
  }
}

function getRepositoryBinding(
  connectorInstanceId: string,
  repository: string,
): RepositoryBindingRow | null {
  const [owner, name] = repository.split('/');
  const rows = sqlite.prepare(`
    SELECT
      entities.id AS repositoryEntityId,
      entities.stable_id AS repositoryStableId,
      bindings.local_id AS localId
    FROM external_entity_bindings AS bindings
    INNER JOIN external_entities AS entities
      ON entities.id = bindings.external_entity_id
    INNER JOIN external_entity_locators AS locators
      ON locators.external_entity_id = entities.id
      AND locators.valid_to IS NULL
    WHERE bindings.connector_instance_id = ?
      AND bindings.binding_type = 'source_list'
      AND bindings.state IN ('shadow', 'active')
      AND entities.provider = 'github'
      AND entities.entity_type = 'repository'
      AND locators.owner_key = ?
      AND locators.repository_key = ?
  `).all(connectorInstanceId, owner.toLowerCase(), name.toLowerCase()) as RepositoryBindingRow[];
  return rows.length === 1 ? rows[0] : null;
}

function getRepositoryEntity(entityId: string): { stableId: string } {
  const row = sqlite.prepare(`
    SELECT stable_id AS stableId
    FROM external_entities
    WHERE id = ? AND provider = 'github' AND entity_type = 'repository'
  `).get(entityId) as { stableId: string } | undefined;
  if (!row) throw new Error('Repository entity is missing');
  return row;
}

function selectIssuePlanRows(
  connectorInstanceId: string,
  repository: string,
): IssuePlanRow[] {
  const prefix = `${repository}:`;
  return sqlite.prepare(`
    SELECT
      task.id AS taskId,
      task.source_id AS sourceId,
      binding.external_entity_id AS issueEntityId,
      entity.stable_id AS issueStableId,
      locator.issue_number AS issueNumber,
      locator.repository_entity_id AS repositoryEntityId
    FROM tasks AS task
    LEFT JOIN external_entity_bindings AS binding
      ON binding.connector_instance_id = task.connector_instance_id
      AND binding.binding_type = 'task'
      AND binding.local_id = task.id
      AND binding.state IN ('shadow', 'active')
    LEFT JOIN external_entities AS entity
      ON entity.id = binding.external_entity_id
      AND entity.provider = 'github'
      AND entity.entity_type = 'issue'
    LEFT JOIN external_entity_locators AS locator
      ON locator.external_entity_id = entity.id
      AND locator.valid_to IS NULL
    WHERE task.connector_instance_id = ?
      AND substr(task.source_id, 1, length(?)) = ?
    ORDER BY task.id COLLATE BINARY
  `).all(connectorInstanceId, prefix, prefix) as IssuePlanRow[];
}

function selectIssuePlanRowsInTransaction(
  tx: ExternalIdentityTransaction,
  connectorInstanceId: string,
  repository: string,
): IssuePlanRow[] {
  const taskRows = tx.select({
    taskId: tasks.id,
    sourceId: tasks.sourceId,
  }).from(tasks).where(eq(tasks.connectorInstanceId, connectorInstanceId)).all()
    .filter((row) => row.sourceId.startsWith(`${repository}:`));
  if (taskRows.length === 0) return [];
  const bindings = tx.select().from(externalEntityBindings).where(and(
    eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
    inArray(externalEntityBindings.localId, taskRows.map((row) => row.taskId)),
  )).all();
  return taskRows.map((task) => {
    const binding = bindings.find((candidate) => (
      candidate.bindingType === 'task'
      && candidate.localId === task.taskId
      && ACTIVE_BINDING_STATES.has(candidate.state)
    ));
    if (!binding) {
      return {
        ...task,
        issueEntityId: null,
        issueStableId: null,
        issueNumber: null,
        repositoryEntityId: null,
      };
    }
    const entity = tx.select().from(externalEntities)
      .where(eq(externalEntities.id, binding.externalEntityId)).limit(1).get();
    const locator = getCurrentExternalEntityLocatorInTransaction(tx, binding.externalEntityId);
    return {
      ...task,
      issueEntityId: binding.externalEntityId,
      issueStableId: entity?.stableId ?? null,
      issueNumber: locator?.issueNumber ?? null,
      repositoryEntityId: locator?.repositoryEntityId ?? null,
    };
  });
}

function collectCounts(
  connectorInstanceId: string,
  from: string,
  to: string,
): GitHubRepositoryRepointCounts {
  const fromPrefix = `${from}:`;
  const toPrefix = `${to}:`;
  const connector = requireGitHubConnector(connectorInstanceId);
  const settings = asRecord(connector.settings);
  return {
    connectorSettings: asStringArray(settings.repos).filter((repo) => samePath(repo, from)).length,
    connectorSyncedLists: asStringArray(connector.syncedLists)
      .filter((repo) => samePath(repo, from)).length,
    sourceLists: scalar(`
      SELECT COUNT(*) AS value FROM source_lists
      WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
    `, connectorInstanceId, from),
    tasks: scalar(`
      SELECT COUNT(*) AS value FROM tasks
      WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
    `, connectorInstanceId, fromPrefix, fromPrefix),
    linkedSources: scalar(`
      SELECT COUNT(*) AS value FROM task_linked_sources
      WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
    `, connectorInstanceId, fromPrefix, fromPrefix),
    ingestSuppressions: scalar(`
      SELECT COUNT(*) AS value FROM task_ingest_suppressions
      WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
    `, connectorInstanceId, fromPrefix, fromPrefix),
    deletionCandidates: scalar(`
      SELECT COUNT(*) AS value FROM sync_deletion_candidates WHERE connector_id = ?
    `, connectorInstanceId),
    pendingPushes: scalar(`
      SELECT COUNT(*) AS value FROM tasks
      WHERE connector_instance_id = ? AND sync_status = 'pending_push'
    `, connectorInstanceId),
    failedPushes: scalar(`
      SELECT COUNT(*) AS value FROM tasks
      WHERE connector_instance_id = ? AND sync_status IN ('push_error', 'error')
    `, connectorInstanceId),
    dependencySnapshots: scalar(`
      SELECT COUNT(*) AS value FROM dependency_reconciliation_snapshots
      WHERE connector_instance_id = ? AND status IN ('running', 'failed', 'partial')
    `, connectorInstanceId),
    openIdentityCollisions: scalar(`
      SELECT COUNT(*) AS value FROM github_identity_collisions
      WHERE connector_instance_id = ? AND state = 'open'
    `, connectorInstanceId),
    targetTaskConflicts: scalar(`
      SELECT COUNT(*) AS value FROM tasks
      WHERE connector_instance_id = ? AND substr(source_id, 1, length(?)) = ?
    `, connectorInstanceId, toPrefix, toPrefix),
    targetSourceListConflicts: scalar(`
      SELECT COUNT(*) AS value FROM source_lists
      WHERE connector_instance_id = ? AND lower(source_id) = lower(?)
    `, connectorInstanceId, to),
  };
}

function collectRelationshipCounts(
  connectorInstanceId: string,
  repository: string,
): GitHubRepositoryRelationshipCounts {
  const prefix = `${repository}:`;
  const affected = `
    SELECT id FROM tasks
    WHERE connector_instance_id = ?
      AND substr(source_id, 1, length(?)) = ?
  `;
  return {
    projects: scalar(`SELECT COUNT(*) AS value FROM task_projects WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    phases: scalar(`SELECT COUNT(*) AS value FROM project_phase_items WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    schedules: scalar(`SELECT COUNT(*) AS value FROM task_schedules WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    tags: scalar(`SELECT COUNT(*) AS value FROM task_tags WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    dependencies: scalar(`
      SELECT COUNT(*) AS value FROM task_dependencies
      WHERE task_id IN (${affected}) OR depends_on_task_id IN (${affected})
    `, connectorInstanceId, prefix, prefix, connectorInstanceId, prefix, prefix),
    history: scalar(`SELECT COUNT(*) AS value FROM task_history_events WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    myDay: scalar(`SELECT COUNT(*) AS value FROM my_day_items WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    focus: scalar(`SELECT COUNT(*) AS value FROM focus_items WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
    attachments: scalar(`SELECT COUNT(*) AS value FROM task_attachments WHERE task_id IN (${affected})`, connectorInstanceId, prefix, prefix),
  };
}

function collectActivity(
  connectorInstanceId: string,
  ownedOperationId?: string,
): GitHubRepositoryRepointActivity {
  return {
    queuedSyncJobs: scalar(`SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = ? AND status = 'queued'`, connectorInstanceId),
    runningSyncJobs: scalar(`SELECT COUNT(*) AS value FROM sync_jobs WHERE connector_id = ? AND status = 'running'`, connectorInstanceId),
    operationLeases: scalar(`SELECT COUNT(*) AS value FROM connector_operation_leases WHERE connector_id = ?`, connectorInstanceId),
    maintenanceLocks: ownedOperationId
      ? scalar(`
        SELECT COUNT(*) AS value FROM connector_maintenance_locks
        WHERE connector_instance_id = ? AND operation_id <> ?
      `, connectorInstanceId, ownedOperationId)
      : scalar(`
        SELECT COUNT(*) AS value FROM connector_maintenance_locks
        WHERE connector_instance_id = ?
      `, connectorInstanceId),
  };
}

function assertNoConnectorActivityInTransaction(
  tx: ExternalIdentityTransaction,
  connectorInstanceId: string,
): void {
  const activeJob = tx.select({ id: syncJobs.id }).from(syncJobs).where(and(
    eq(syncJobs.connectorId, connectorInstanceId),
    inArray(syncJobs.status, ['queued', 'running']),
  )).limit(1).get();
  const activeLease = tx.select({ connectorId: connectorOperationLeases.connectorId })
    .from(connectorOperationLeases)
    .where(eq(connectorOperationLeases.connectorId, connectorInstanceId))
    .limit(1).get();
  if (activeJob || activeLease) {
    throw new Error('Connector activity started after repoint preflight');
  }
}

function createRemote(
  connector: typeof connectorConfigs.$inferSelect,
): GitHubRepositoryRepointRemote {
  const credentials = asRecord(connector.credentials);
  const settings = asRecord(connector.settings);
  const token = stringValue(credentials.token)
    || stringValue(credentials.pat)
    || stringValue(settings.token);
  if (!token) throw new Error('GitHub connector credentials are missing');
  const client = createGitHubClient(token, readApiOrigin(settings));
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

export function createGitHubRepositoryRemote(
  connectorInstanceId: string,
): GitHubRepositoryRepointRemote {
  return createRemote(requireGitHubConnector(connectorInstanceId));
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

function requireGitHubConnector(
  connectorInstanceId: string,
): typeof connectorConfigs.$inferSelect {
  const connector = db.select().from(connectorConfigs)
    .where(eq(connectorConfigs.id, connectorInstanceId)).limit(1).get();
  if (!connector || connector.deletedAt || connector.type !== 'github-issues') {
    throw new Error('Active GitHub connector was not found');
  }
  return connector;
}

function getOperationByIdempotency(
  connectorInstanceId: string,
  idempotencyKey: string,
): RepointOperationRow | null {
  const row = db.select().from(githubRepositoryRepoints).where(and(
    eq(githubRepositoryRepoints.connectorInstanceId, connectorInstanceId),
    eq(githubRepositoryRepoints.idempotencyKey, idempotencyKey),
  )).limit(1).get();
  return row ? mapOperation(row) : null;
}

function requireOperation(operationId: string): RepointOperationRow {
  const row = db.select().from(githubRepositoryRepoints)
    .where(eq(githubRepositoryRepoints.id, operationId)).limit(1).get();
  if (!row) throw new Error('GitHub repository repoint operation was not found');
  return mapOperation(row);
}

function requireOperationInTransaction(
  tx: ExternalIdentityTransaction,
  operationId: string,
): RepointOperationRow {
  const row = tx.select().from(githubRepositoryRepoints)
    .where(eq(githubRepositoryRepoints.id, operationId)).limit(1).get();
  if (!row) throw new Error('GitHub repository repoint operation was not found');
  return mapOperation(row);
}

function mapOperation(
  row: typeof githubRepositoryRepoints.$inferSelect,
): RepointOperationRow {
  return {
    ...row,
    backupProof: asRecord(row.backupProof),
    preflight: asRecord(row.preflight),
    rollbackSnapshot: asRecord(row.rollbackSnapshot),
    verification: row.verification ? asRecord(row.verification) : null,
  };
}

function requireOwnedMaintenanceLock(
  tx: ExternalIdentityTransaction,
  operation: RepointOperationRow,
): void {
  const lock = tx.select().from(connectorMaintenanceLocks).where(and(
    eq(connectorMaintenanceLocks.connectorInstanceId, operation.connectorInstanceId),
    eq(connectorMaintenanceLocks.operationId, operation.id),
  )).limit(1).get();
  if (!lock) throw new Error('Repoint operation lost its connector maintenance lock');
}

function setOperationPhase(
  operationId: string,
  phase: GitHubRepositoryRepointPhase,
  actor: string,
  payload: Record<string, unknown>,
  now: string,
): void {
  runTransaction((tx) => {
    const operation = requireOperationInTransaction(tx, operationId);
    requireOwnedMaintenanceLock(tx, operation);
    tx.update(githubRepositoryRepoints).set({
      phase,
      actor,
      updatedAt: now,
    }).where(eq(githubRepositoryRepoints.id, operationId)).run();
    appendEvent(tx, operationId, phase, actor, payload, now);
  });
}

function failVerification(
  operation: RepointOperationRow,
  verification: Record<string, unknown>,
  error: string,
  now: string,
): void {
  runTransaction((tx) => {
    const current = requireOperationInTransaction(tx, operation.id);
    requireOwnedMaintenanceLock(tx, current);
    tx.update(githubRepositoryRepoints).set({
      phase: 'verification_failed',
      verification,
      lastError: error,
      updatedAt: now,
    }).where(eq(githubRepositoryRepoints.id, current.id)).run();
    appendEvent(tx, current.id, 'verification_failed', current.actor, verification, now);
  });
}

function markOperationFailed(
  tx: ExternalIdentityTransaction,
  operation: RepointOperationRow,
  error: string,
  now: string,
): void {
  tx.update(githubRepositoryRepoints).set({
    phase: 'failed',
    lastError: error,
    updatedAt: now,
  }).where(eq(githubRepositoryRepoints.id, operation.id)).run();
  appendEvent(tx, operation.id, 'failed', operation.actor, { error }, now);
}

function recordLocatorCollision(
  tx: ExternalIdentityTransaction,
  operation: RepointOperationRow,
  bindingType: 'task' | 'source_list',
  localId: string,
  externalEntityId: string,
  observation: Pick<ExternalEntityLocatorPreflight, 'collisionCategory' | 'conflictingEntityId'>,
  now: string,
): void {
  recordExternalIdentityCollisionInTransaction(tx, {
    connectorInstanceId: operation.connectorInstanceId,
    category: observation.collisionCategory ?? 'stable_legacy_disagree',
    bindingType,
    localIds: [localId],
    externalEntityIds: [
      externalEntityId,
      ...(observation.conflictingEntityId ? [observation.conflictingEntityId] : []),
    ].filter(Boolean),
    legacyIdentity: repositoryPath(operation.fromOwner, operation.fromRepository),
    observedAt: now,
  });
}

function appendEvent(
  tx: ExternalIdentityTransaction,
  operationId: string,
  phase: GitHubRepositoryRepointPhase,
  actor: string,
  payload: Record<string, unknown>,
  now: string,
): void {
  tx.insert(githubRepositoryRepointEvents).values({
    operationId,
    phase,
    actor,
    payload,
    createdAt: now,
  }).run();
}

function toStatus(operation: RepointOperationRow): GitHubRepositoryRepointStatus {
  const lock = sqlite.prepare(`
    SELECT 1 FROM connector_maintenance_locks
    WHERE connector_instance_id = ? AND operation_id = ?
  `).get(operation.connectorInstanceId, operation.id);
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
    connectorLocked: Boolean(lock),
    verification: operation.verification,
  };
}

function assertSameOperation(
  operation: RepointOperationRow,
  input: GitHubRepositoryRepointInput,
): void {
  if (
    !samePath(repositoryPath(operation.fromOwner, operation.fromRepository), input.from)
    || !samePath(repositoryPath(operation.toOwner, operation.toRepository), input.to)
    || operation.backupProof.sha256 !== input.backupProof.sha256
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

function isBackupProofReady(
  proof: GitHubRepointBackupProof | undefined,
  now: Date,
): boolean {
  if (!proof) return false;
  const verifiedAt = Date.parse(proof.verifiedAt);
  return proof.integrityCheck === 'ok'
    && /^[a-f0-9]{64}$/.test(proof.sha256)
    && proof.sizeBytes > 0
    && Number.isFinite(verifiedAt)
    && Math.abs(now.getTime() - verifiedAt) <= MAX_BACKUP_AGE_MS;
}

function compactPreflight(
  report: GitHubRepositoryRepointPreflight,
): Record<string, unknown> {
  return {
    ...report,
    deletionCandidates: report.deletionCandidates.slice(0, 50),
  };
}

function scalar(query: string, ...parameters: unknown[]): number {
  const row = sqlite.prepare(query).get(...parameters) as { value: number } | undefined;
  return row?.value ?? 0;
}

function repositoryPath(owner: string, repository: string): string {
  return `${owner}/${repository}`;
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function encodeRepository(repository: string): string {
  validateRepositoryPath(repository, 'repository');
  return repository.split('/').map(encodeURIComponent).join('/');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return asStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readApiOrigin(settings: unknown): string | undefined {
  const value = asRecord(settings).apiOrigin;
  return typeof value === 'string' ? value : undefined;
}
