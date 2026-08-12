import { and, desc, eq } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  githubIdentityBackfillItems,
  githubIdentityComparisonRecords,
  githubIdentityComparisonRuns,
  githubIdentityExceptionEvents,
  externalEntityBindings,
  tasks,
} from '@/db/schema';
import type {
  GitHubIdentityExceptionRequest,
  GitHubIdentityExceptionResult,
} from './comparison-types';
import type { GitHubIdentityExceptionProofType } from '@/db/schema';
import type { ExternalIdentityTransaction } from './service';

export type GitHubIdentityExceptionEvent =
  typeof githubIdentityExceptionEvents.$inferSelect;

export function recordGitHubIdentityException(
  request: GitHubIdentityExceptionRequest,
): GitHubIdentityExceptionResult {
  return runTransaction((tx) => recordGitHubIdentityExceptionInTransaction(tx, request));
}

export function recordGitHubIdentityExceptionInTransaction(
  database: ExternalIdentityTransaction,
  request: GitHubIdentityExceptionRequest,
): GitHubIdentityExceptionResult {
  validateRequest(request);
  const connectorInstanceId = request.connectorInstanceId.trim();
  const localId = request.localId.trim();
  const actor = request.actor.trim();
  const reason = request.reason.trim();
  const idempotencyKey = request.idempotencyKey.trim();
  let proofType: GitHubIdentityExceptionProofType | null = null;
  let comparisonRunId: string | null = null;

  const replay = database.select().from(githubIdentityExceptionEvents)
    .where(and(
      eq(githubIdentityExceptionEvents.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityExceptionEvents.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .get();
  if (replay) {
    if (
      replay.bindingType !== request.bindingType
      || replay.localId !== localId
      || replay.category !== request.category
      || replay.action !== request.action
      || replay.actor !== actor
      || replay.reason !== reason
      || existingProofType(replay) !== requestedProofType(request)
      || replay.comparisonRunId !== (request.comparisonRunId?.trim() || null)
    ) {
      throw new Error('The GitHub identity exception idempotency key was already used');
    }
    return toResult(replay, false);
  }

  const latest = database.select().from(githubIdentityExceptionEvents)
    .where(and(
      eq(githubIdentityExceptionEvents.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityExceptionEvents.bindingType, request.bindingType),
      eq(githubIdentityExceptionEvents.localId, localId),
      eq(githubIdentityExceptionEvents.category, request.category),
    ))
    .orderBy(desc(githubIdentityExceptionEvents.id))
    .limit(1)
    .get();
  const currentAction = latest?.action ?? 'revoke';
  if (currentAction === request.action) {
    throw new Error(`GitHub identity exception is already ${request.action === 'accept' ? 'accepted' : 'revoked'}`);
  }

  if (request.action === 'accept') {
    const proof = validateTerminalInaccessibleTarget(
      database,
      connectorInstanceId,
      request.bindingType,
      localId,
      request.comparisonRunId?.trim(),
    );
    proofType = proof.proofType;
    comparisonRunId = proof.comparisonRunId;
  }

  const event = database.insert(githubIdentityExceptionEvents).values({
    connectorInstanceId,
    bindingType: request.bindingType,
    localId,
    category: request.category,
    action: request.action,
    idempotencyKey,
    actor,
    reason,
    proofType,
    comparisonRunId,
    createdAt: request.now ?? new Date().toISOString(),
  }).returning().get();
  return toResult(event, true);
}

function validateTerminalInaccessibleTarget(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  bindingType: GitHubIdentityExceptionRequest['bindingType'],
  localId: string,
  comparisonRunId?: string,
): {
  proofType: GitHubIdentityExceptionProofType;
  comparisonRunId: string | null;
} {
  if (bindingType !== 'task') {
    throw new Error('Terminal inaccessible exceptions currently support tasks only');
  }
  const disposition = database.select({ state: githubIdentityBackfillItems.state })
    .from(githubIdentityBackfillItems)
    .where(and(
      eq(githubIdentityBackfillItems.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityBackfillItems.bindingType, bindingType),
      eq(githubIdentityBackfillItems.localId, localId),
    ))
    .limit(1)
    .get();
  const task = database.select({ status: tasks.status })
    .from(tasks)
    .where(and(
      eq(tasks.id, localId),
      eq(tasks.connectorInstanceId, connectorInstanceId),
    ))
    .limit(1)
    .get();
  if (task?.status !== 'cancelled') {
    throw new Error('Terminal inaccessible exception requires a cancelled historical task');
  }
  if (!comparisonRunId) {
    if (disposition?.state !== 'inaccessible') {
      throw new Error(
        `Terminal exception proof check failed: Stage-1 disposition was ${
          disposition?.state ?? 'missing'
        }, not inaccessible; post-backfill acceptance requires a comparison run and explicit authoritative-deletion confirmation`,
      );
    }
    return { proofType: 'stage1_inaccessible', comparisonRunId: null };
  }
  if (disposition?.state !== 'bound') {
    throw new Error(
      `Terminal exception proof check failed: post-backfill evidence requires a successful bound Stage-1 disposition; found ${
        disposition?.state ?? 'missing'
      }`,
    );
  }
  const binding = database.select({
    state: externalEntityBindings.state,
    verifiedAt: externalEntityBindings.verifiedAt,
  }).from(externalEntityBindings)
    .where(and(
      eq(externalEntityBindings.connectorInstanceId, connectorInstanceId),
      eq(externalEntityBindings.bindingType, bindingType),
      eq(externalEntityBindings.localId, localId),
    ))
    .limit(1)
    .get();
  if (!binding || binding.state === 'collision' || binding.state === 'retired' || !binding.verifiedAt) {
    throw new Error(
      'Terminal exception proof check failed: post-backfill evidence requires a non-retired verified task binding',
    );
  }
  const run = database.select({
    state: githubIdentityComparisonRuns.state,
    syncKind: githubIdentityComparisonRuns.syncKind,
  }).from(githubIdentityComparisonRuns)
    .where(and(
      eq(githubIdentityComparisonRuns.id, comparisonRunId),
      eq(githubIdentityComparisonRuns.connectorInstanceId, connectorInstanceId),
    ))
    .limit(1)
    .get();
  if (!run) {
    throw new Error(
      'Terminal exception proof check failed: comparison run was not found for this connector',
    );
  }
  if (run.state !== 'succeeded') {
    throw new Error(
      `Terminal exception proof check failed: comparison run state was ${run.state}, not succeeded`,
    );
  }
  if (run.syncKind !== 'full') {
    throw new Error(
      'Terminal exception proof check failed: comparison run was incremental, not full',
    );
  }
  const comparison = database.select({ id: githubIdentityComparisonRecords.id })
    .from(githubIdentityComparisonRecords)
    .where(and(
      eq(githubIdentityComparisonRecords.runId, comparisonRunId),
      eq(githubIdentityComparisonRecords.surface, 'deletion'),
      eq(githubIdentityComparisonRecords.localTaskId, localId),
      eq(githubIdentityComparisonRecords.outcome, 'inaccessible'),
      eq(githubIdentityComparisonRecords.reason, 'access_denied'),
    ))
    .limit(1)
    .get();
  if (!comparison) {
    throw new Error(
      'Terminal exception proof check failed: the succeeded full run has no inaccessible deletion record for this task; partial, fallback, dependency-only, and other-task records do not qualify',
    );
  }
  return {
    proofType: 'post_backfill_authoritative_deletion',
    comparisonRunId,
  };
}

function validateRequest(request: GitHubIdentityExceptionRequest): void {
  if (!request.connectorInstanceId.trim()) throw new Error('Connector instance ID is required');
  if (!request.localId.trim()) throw new Error('Local ID is required');
  if (request.category !== 'terminal_inaccessible') {
    throw new Error('Unsupported GitHub identity exception category');
  }
  if (!request.actor.trim() || request.actor.trim().length > 200) {
    throw new Error('Actor is required and must not exceed 200 characters');
  }
  if (!request.reason.trim() || request.reason.trim().length > 500) {
    throw new Error('Reason is required and must not exceed 500 characters');
  }
  const keyLength = request.idempotencyKey.trim().length;
  if (keyLength < 8 || keyLength > 200) {
    throw new Error('Idempotency key must contain between 8 and 200 characters');
  }
  const comparisonRunId = request.comparisonRunId?.trim();
  if (request.action === 'revoke' && (comparisonRunId || request.confirmAuthoritativeDeletion)) {
    throw new Error('Comparison proof options are valid only when accepting an exception');
  }
  if (request.action === 'accept' && Boolean(comparisonRunId) !== Boolean(request.confirmAuthoritativeDeletion)) {
    throw new Error(
      'Post-backfill acceptance requires both a comparison run and explicit authoritative-deletion confirmation',
    );
  }
}

function toResult(
  event: GitHubIdentityExceptionEvent,
  changed: boolean,
): GitHubIdentityExceptionResult {
  return {
    changed,
    eventId: event.id,
    connectorInstanceId: event.connectorInstanceId,
    bindingType: event.bindingType,
    localId: event.localId,
    category: event.category,
    action: event.action,
    proofType: event.proofType,
    comparisonRunId: event.comparisonRunId,
  };
}

function requestedProofType(
  request: GitHubIdentityExceptionRequest,
): GitHubIdentityExceptionProofType | null {
  if (request.action === 'revoke') return null;
  return request.comparisonRunId?.trim()
    ? 'post_backfill_authoritative_deletion'
    : 'stage1_inaccessible';
}

function existingProofType(
  event: GitHubIdentityExceptionEvent,
): GitHubIdentityExceptionProofType | null {
  if (event.proofType) return event.proofType;
  return event.action === 'accept' ? 'stage1_inaccessible' : null;
}

export function getLatestGitHubIdentityException(
  connectorInstanceId: string,
  bindingType: GitHubIdentityExceptionRequest['bindingType'],
  localId: string,
): GitHubIdentityExceptionEvent | null {
  return db.select().from(githubIdentityExceptionEvents)
    .where(and(
      eq(githubIdentityExceptionEvents.connectorInstanceId, connectorInstanceId),
      eq(githubIdentityExceptionEvents.bindingType, bindingType),
      eq(githubIdentityExceptionEvents.localId, localId),
      eq(githubIdentityExceptionEvents.category, 'terminal_inaccessible'),
    ))
    .orderBy(desc(githubIdentityExceptionEvents.id))
    .limit(1)
    .get() ?? null;
}

export function hasAcceptedGitHubTerminalInaccessibleException(
  connectorInstanceId: string,
  bindingType: GitHubIdentityExceptionRequest['bindingType'],
  localId: string,
): boolean {
  return getLatestGitHubIdentityException(connectorInstanceId, bindingType, localId)?.action === 'accept';
}
