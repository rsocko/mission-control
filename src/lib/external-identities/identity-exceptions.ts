import { and, desc, eq } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  githubIdentityBackfillItems,
  githubIdentityExceptionEvents,
  externalEntityBindings,
  tasks,
} from '@/db/schema';
import type {
  GitHubIdentityExceptionRequest,
  GitHubIdentityExceptionResult,
} from './stable-identity-types';
import { GITHUB_IDENTITY_EXCEPTION_ARCHIVAL_PROOF_TYPE } from '@/db/schema';
import type { GitHubIdentityExceptionProofType } from '@/db/schema';
import type { ExternalIdentityTransaction } from './service';

export type GitHubIdentityExceptionEvent =
  typeof githubIdentityExceptionEvents.$inferSelect;

/**
 * Terminal-inaccessible exceptions let an operator retire a task whose GitHub
 * issue can no longer be read. NodeID identity is permanent, so the proof is
 * local and durable: either the Stage-1 backfill proved the issue inaccessible,
 * or the operator explicitly confirms an authoritative deletion for a task that
 * still carries a verified NodeID binding.
 */
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
    proofType = validateTerminalInaccessibleTarget(
      database,
      connectorInstanceId,
      request.bindingType,
      localId,
      request.confirmAuthoritativeDeletion === true,
    );
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
    createdAt: request.now ?? new Date().toISOString(),
  }).returning().get();
  return toResult(event, true);
}

function validateTerminalInaccessibleTarget(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  bindingType: GitHubIdentityExceptionRequest['bindingType'],
  localId: string,
  confirmAuthoritativeDeletion: boolean,
): GitHubIdentityExceptionProofType {
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
  if (!confirmAuthoritativeDeletion) {
    if (disposition?.state !== 'inaccessible') {
      throw new Error(
        `Terminal exception proof check failed: Stage-1 disposition was ${
          disposition?.state ?? 'missing'
        }, not inaccessible; accepting a NodeID-bound task requires explicit authoritative-deletion confirmation`,
      );
    }
    return 'stage1_inaccessible';
  }
  if (disposition?.state !== 'bound') {
    throw new Error(
      `Terminal exception proof check failed: authoritative-deletion evidence requires a successful bound Stage-1 disposition; found ${
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
  if (
    !binding
    || binding.state === 'collision'
    || binding.state === 'retired'
    || !binding.verifiedAt
  ) {
    throw new Error(
      'Terminal exception proof check failed: authoritative-deletion evidence requires a non-retired verified task binding',
    );
  }
  return 'post_backfill_authoritative_deletion';
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
  if (request.action === 'revoke' && request.confirmAuthoritativeDeletion) {
    throw new Error('Authoritative-deletion confirmation is valid only when accepting an exception');
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
  };
}

function requestedProofType(
  request: GitHubIdentityExceptionRequest,
): GitHubIdentityExceptionProofType | null {
  if (request.action === 'revoke') return null;
  return request.confirmAuthoritativeDeletion
    ? 'post_backfill_authoritative_deletion'
    : 'stage1_inaccessible';
}

function existingProofType(
  event: GitHubIdentityExceptionEvent,
): GitHubIdentityExceptionProofType | null {
  // Pre-cutover accepts were proven by a comparison run and are archived with
  // `legacy_comparison_evidence`. For idempotent replay they compare equal to
  // the implicit stage-1 proof they previously carried.
  if (event.proofType === GITHUB_IDENTITY_EXCEPTION_ARCHIVAL_PROOF_TYPE) {
    return 'stage1_inaccessible';
  }
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
  return getLatestGitHubIdentityException(
    connectorInstanceId,
    bindingType,
    localId,
  )?.action === 'accept';
}
