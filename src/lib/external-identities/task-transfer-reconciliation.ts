import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  externalEntities,
  externalEntityBindings,
  githubIdentityTaskTransferReconciliations,
  tasks,
} from '@/db/schema';
import { runTransaction } from '@/db';
import { getGitHubIdentityModeSnapshotInTransaction } from './identity-mode';
import { getCurrentExternalEntityLocatorInTransaction } from './service';
import type { ExternalIdentityTransaction } from './service';
import type { ExternalIdentityEvidence } from './types';

const ACTIVE_BINDING_STATES = ['shadow', 'active'] as const;

export interface GitHubTaskTransferBinding {
  taskId: string;
  sourceId: string;
  title: string;
  externalEntityId: string;
  stableId: string;
  hostKey: string;
  repositoryEntityId: string;
  locatorSourceId: string;
}

export interface GitHubHistoricalTransferObservation {
  evidence: ExternalIdentityEvidence;
  title: string;
  state: string;
  stateReason: string | null;
}

export interface GitHubTaskTransferReconciliationRequest {
  connectorInstanceId: string;
  sourceTaskId: string;
  successorTaskId: string;
  expectedRevision: number;
  requestedSourceId: string;
  observation: GitHubHistoricalTransferObservation;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now?: Date;
}

export interface GitHubTaskTransferReconciliationResult {
  changed: boolean;
  reconciliationId: string;
  sourceTaskId: string;
  successorTaskId: string;
  proofKind: 'rest_historical_redirect';
}

export function readGitHubTaskTransferBinding(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  taskId: string,
): GitHubTaskTransferBinding {
  const result = inspectGitHubTaskTransferBinding(
    database,
    connectorInstanceId,
    taskId,
  );
  if ('error' in result) throw new Error(result.error);
  return result.binding;
}

function inspectGitHubTaskTransferBinding(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  taskId: string,
): { binding: GitHubTaskTransferBinding } | { error: string } {
  const task = database.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
    title: tasks.title,
  }).from(tasks).where(and(
    eq(tasks.id, taskId),
    eq(tasks.connectorInstanceId, connectorInstanceId),
    eq(tasks.connectorType, 'github-issues'),
  )).limit(1).get();
  if (!task) return { error: `GitHub task binding was not found: ${taskId}` };

  const binding = database.select({
    externalEntityId: externalEntityBindings.externalEntityId,
  }).from(externalEntityBindings).where(and(
    eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
    eq(externalEntityBindings.bindingType, 'task'),
    eq(externalEntityBindings.localId, taskId),
    inArray(externalEntityBindings.state, ACTIVE_BINDING_STATES),
  )).limit(1).get();
  if (!binding) {
    return { error: `GitHub task has no active stable binding: ${taskId}` };
  }

  const entity = database.select({
    stableId: externalEntities.stableId,
    hostKey: externalEntities.hostKey,
    provider: externalEntities.provider,
    entityType: externalEntities.entityType,
  }).from(externalEntities).where(eq(
    externalEntities.id,
    binding.externalEntityId,
  )).limit(1).get();
  if (!entity || entity.provider !== 'github' || entity.entityType !== 'issue') {
    return { error: `GitHub task stable binding is not an issue: ${taskId}` };
  }

  const locator = getCurrentExternalEntityLocatorInTransaction(
    database,
    binding.externalEntityId,
  );
  if (!locator?.issueNumber || !locator.repositoryEntityId) {
    return {
      error: `GitHub task stable binding has no current issue locator: ${taskId}`,
    };
  }
  const locatorSourceId = canonicalSourceId(
    locator.owner,
    locator.repository,
    locator.issueNumber,
  );
  if (locatorSourceId !== task.sourceId.toLowerCase()) {
    return {
      error: `GitHub task source ID disagrees with its stable locator: ${taskId}`,
    };
  }

  return {
    binding: {
      taskId,
      sourceId: task.sourceId,
      title: task.title,
      externalEntityId: binding.externalEntityId,
      stableId: entity.stableId,
      hostKey: entity.hostKey,
      repositoryEntityId: locator.repositoryEntityId,
      locatorSourceId,
    },
  };
}

export function recordGitHubTaskTransferReconciliation(
  request: GitHubTaskTransferReconciliationRequest,
): GitHubTaskTransferReconciliationResult {
  validateAuditRequest(request);
  return runTransaction((tx) => {
    const mode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      request.connectorInstanceId,
    );
    if (mode.modeRevision !== request.expectedRevision) {
      throw new Error(
        `GitHub identity mode revision changed: expected ${request.expectedRevision}, found ${mode.modeRevision}`,
      );
    }

    const source = readGitHubTaskTransferBinding(
      tx,
      request.connectorInstanceId,
      request.sourceTaskId,
    );
    const successor = readGitHubTaskTransferBinding(
      tx,
      request.connectorInstanceId,
      request.successorTaskId,
    );
    const proof = buildTransferProof(request, source, successor);
    const replay = tx.select().from(githubIdentityTaskTransferReconciliations)
      .where(and(
        eq(
          githubIdentityTaskTransferReconciliations.connectorInstanceId,
          request.connectorInstanceId,
        ),
        eq(
          githubIdentityTaskTransferReconciliations.idempotencyKey,
          request.idempotencyKey,
        ),
      )).limit(1).get();
    if (replay) {
      if (
        replay.sourceTaskId !== request.sourceTaskId
        || replay.successorTaskId !== request.successorTaskId
        || replay.sourceExternalEntityId !== source.externalEntityId
        || replay.successorExternalEntityId !== successor.externalEntityId
        || replay.expectedModeRevision !== request.expectedRevision
        || replay.actor !== request.actor
        || replay.reason !== request.reason
        || !proofMatchesCurrentBindings(replay.proof, source, successor)
      ) {
        throw new Error('Historical transfer idempotency key belongs to another request');
      }
      return toResult(replay, false);
    }
    const existingSource = tx.select({
      id: githubIdentityTaskTransferReconciliations.id,
      successorTaskId: githubIdentityTaskTransferReconciliations.successorTaskId,
    }).from(githubIdentityTaskTransferReconciliations).where(and(
      eq(
        githubIdentityTaskTransferReconciliations.connectorInstanceId,
        request.connectorInstanceId,
      ),
      eq(
        githubIdentityTaskTransferReconciliations.sourceTaskId,
        request.sourceTaskId,
      ),
    )).limit(1).get();
    if (existingSource) {
      throw new Error(
        `Historical task is already reconciled to ${existingSource.successorTaskId}`,
      );
    }

    const createdAt = (request.now ?? new Date()).toISOString();
    const inserted = tx.insert(githubIdentityTaskTransferReconciliations).values({
      id: randomUUID(),
      connectorInstanceId: request.connectorInstanceId,
      sourceTaskId: source.taskId,
      successorTaskId: successor.taskId,
      sourceExternalEntityId: source.externalEntityId,
      successorExternalEntityId: successor.externalEntityId,
      expectedModeRevision: request.expectedRevision,
      proofKind: 'rest_historical_redirect',
      proof,
      proofDigest: digestProof(proof),
      observedAt: request.observation.evidence.entity.observedAt,
      actor: request.actor,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      createdAt,
    }).returning().get();
    if (!inserted) throw new Error('Failed to persist historical transfer reconciliation');
    return toResult(inserted, true);
  });
}

export function provenSupersededGitHubTaskIds(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  observedTaskIds: ReadonlySet<string>,
): Set<string> {
  const reconciliations = database.select()
    .from(githubIdentityTaskTransferReconciliations)
    .where(eq(
      githubIdentityTaskTransferReconciliations.connectorInstanceId,
      connectorInstanceId,
    )).all();
  const superseded = new Set<string>();
  for (const reconciliation of reconciliations) {
    if (
      observedTaskIds.has(reconciliation.sourceTaskId)
      || !observedTaskIds.has(reconciliation.successorTaskId)
    ) {
      continue;
    }
    if (digestProof(reconciliation.proof) !== reconciliation.proofDigest) continue;
    const sourceResult = inspectGitHubTaskTransferBinding(
      database,
      connectorInstanceId,
      reconciliation.sourceTaskId,
    );
    const successorResult = inspectGitHubTaskTransferBinding(
      database,
      connectorInstanceId,
      reconciliation.successorTaskId,
    );
    if ('error' in sourceResult || 'error' in successorResult) continue;
    const source = sourceResult.binding;
    const successor = successorResult.binding;
    if (
      source.externalEntityId !== reconciliation.sourceExternalEntityId
      || successor.externalEntityId !== reconciliation.successorExternalEntityId
      || !proofMatchesCurrentBindings(reconciliation.proof, source, successor)
    ) {
      continue;
    }
    superseded.add(source.taskId);
  }
  return superseded;
}

function buildTransferProof(
  request: GitHubTaskTransferReconciliationRequest,
  source: GitHubTaskTransferBinding,
  successor: GitHubTaskTransferBinding,
): Record<string, unknown> {
  const observation = request.observation;
  const remote = observation.evidence.entity;
  if (source.taskId === successor.taskId || source.externalEntityId === successor.externalEntityId) {
    throw new Error('Historical transfer reconciliation requires distinct tasks and identities');
  }
  if (source.hostKey !== successor.hostKey || remote.identity.hostKey !== source.hostKey) {
    throw new Error('Historical transfer reconciliation must stay in one GitHub host namespace');
  }
  if (
    remote.identity.provider !== 'github'
    || remote.identity.entityType !== 'issue'
    || remote.observationSource !== 'rest'
  ) {
    throw new Error('Historical transfer reconciliation requires authoritative REST issue evidence');
  }
  if (remote.identity.stableId !== successor.stableId) {
    throw new Error('Historical endpoint did not resolve to the successor stable identity');
  }
  if (remote.identity.stableId === source.stableId) {
    throw new Error('Historical endpoint still resolves to the source stable identity');
  }
  const remoteSourceId = canonicalSourceId(
    remote.locator.owner,
    remote.locator.repository,
    remote.locator.issueNumber,
  );
  if (request.requestedSourceId.toLowerCase() !== source.locatorSourceId) {
    throw new Error('Historical transfer lookup did not target the source task locator');
  }
  if (remoteSourceId !== successor.locatorSourceId) {
    throw new Error('Historical endpoint canonical locator does not match the successor task');
  }
  if (remoteSourceId === source.locatorSourceId) {
    throw new Error('Historical endpoint did not move to a distinct locator');
  }

  return {
    requestedSourceId: source.locatorSourceId,
    successorSourceId: successor.locatorSourceId,
    sourceStableId: source.stableId,
    successorStableId: successor.stableId,
    observedStableId: remote.identity.stableId,
    observedAt: remote.observedAt,
    title: observation.title,
    state: observation.state,
    stateReason: observation.stateReason,
    apiUrl: remote.locator.apiUrl ?? null,
    webUrl: remote.locator.webUrl ?? null,
  };
}

function proofMatchesCurrentBindings(
  value: unknown,
  source: GitHubTaskTransferBinding,
  successor: GitHubTaskTransferBinding,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return proof.requestedSourceId === source.locatorSourceId
    && proof.successorSourceId === successor.locatorSourceId
    && proof.sourceStableId === source.stableId
    && proof.successorStableId === successor.stableId
    && proof.observedStableId === successor.stableId;
}

function digestProof(proof: unknown): string {
  return createHash('sha256').update(JSON.stringify(proof)).digest('hex');
}

function canonicalSourceId(
  owner: string,
  repository: string,
  issueNumber: number | undefined,
): string {
  if (!Number.isSafeInteger(issueNumber) || (issueNumber ?? 0) <= 0) {
    throw new Error('GitHub issue locator requires a positive issue number');
  }
  return `${owner}/${repository}:${issueNumber}`.toLowerCase();
}

function validateAuditRequest(request: GitHubTaskTransferReconciliationRequest): void {
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new Error('Historical transfer reconciliation requires a non-negative mode revision');
  }
  if (request.actor.length < 1 || request.actor.length > 80) {
    throw new Error('Historical transfer reconciliation actor must be 1-80 characters');
  }
  if (request.reason.length < 3 || request.reason.length > 500) {
    throw new Error('Historical transfer reconciliation reason must be 3-500 characters');
  }
  if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 192) {
    throw new Error('Historical transfer idempotency key must be 8-192 characters');
  }
}

function toResult(
  row: typeof githubIdentityTaskTransferReconciliations.$inferSelect,
  changed: boolean,
): GitHubTaskTransferReconciliationResult {
  return {
    changed,
    reconciliationId: row.id,
    sourceTaskId: row.sourceTaskId,
    successorTaskId: row.successorTaskId,
    proofKind: row.proofKind,
  };
}
