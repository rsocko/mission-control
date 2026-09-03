import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  externalEntities,
  externalEntityBindings,
  githubIdentityTaskTransferReconciliations,
  tasks,
} from '@/db/schema';
import {
  buildHistoricalTransferProof,
  canonicalIssueSourceId,
  digestHistoricalProof,
  historicalProofDigestMatches,
  historicalProofMatchesBindings,
  validateHistoricalAuditRequest,
} from '@/db/persistence/github-transfer-succession';
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
  const locatorSourceId = canonicalIssueSourceId(
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

/**
 * SQLite-adapter-oriented helper. Takes the SQLite Drizzle handle as an
 * explicit parameter (rather than importing the `@/db` module-level
 * singleton) so this file carries no runtime SQLite dependency of its own;
 * `db`'s static type comes from `ExternalIdentityTransaction`, which is
 * sourced from a type-only import in `service.ts` and therefore does not
 * propagate SQLite taint. This function is consumed exclusively by
 * `sqlite-github-recovery-repositories.ts` (via its
 * `recordHistoricalTransferReconciliation` port method) and must never be
 * selected as a normal PostgreSQL application service — PostgreSQL already
 * has its own genuine implementation of that port method in
 * `github-recovery-repositories.ts`.
 */
export function recordGitHubTaskTransferReconciliation(
  db: ExternalIdentityTransaction,
  request: GitHubTaskTransferReconciliationRequest,
): GitHubTaskTransferReconciliationResult {
  validateHistoricalAuditRequest(request);
  return db.transaction((tx) => {
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
    const proof = buildHistoricalTransferProof(request, source, successor);
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
        || !historicalProofMatchesBindings(replay.proof, source, successor)
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
      proofDigest: digestHistoricalProof(proof),
      observedAt: request.observation.evidence.entity.observedAt,
      actor: request.actor,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      createdAt,
    }).returning().get();
    if (!inserted) throw new Error('Failed to persist historical transfer reconciliation');
    return toResult(inserted, true);
  }, { behavior: 'immediate' });
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
    if (!historicalProofDigestMatches(reconciliation.proof, reconciliation.proofDigest)) continue;
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
      || !historicalProofMatchesBindings(reconciliation.proof, source, successor)
    ) {
      continue;
    }
    superseded.add(source.taskId);
  }
  return superseded;
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
