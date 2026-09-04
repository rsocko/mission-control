import 'server-only';

import {
  FINANCE_ATTRIBUTION_EXCEPTION_PAGE_MAX,
  FINANCE_ATTRIBUTION_EXCEPTION_STATUS_FILTERS,
  FinanceAttributionMutationError,
  type FinanceAttributionExceptionAction,
  type FinanceAttributionExceptionCursor,
  type FinanceAttributionExceptionStatusFilter,
  type FinanceAttributionExceptionView,
  type FinanceAttributionExpectedTransactionVersion,
  type FinanceAttributionPersistence,
  type FinanceAttributionSubjectView,
  type FinanceManualAction,
} from '@/db/persistence/finance-attribution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getSyncJobRepository, isDurableSyncMode } from '@/lib/sync/job-runtime';

/**
 * Request-independent policy for the manual/API attribution surface.
 *
 * Every SQL mechanic now lives in the SQLite/PostgreSQL
 * `FinanceAttributionPersistence` adapters, which own the single write
 * transaction that validates connector ownership, transaction existence,
 * projected-subject membership, action legality, retryability, and the
 * expected-timestamp/null-safe compare-and-swap before mutating state. What
 * stays here is exactly the part that is neither backend- nor request-specific:
 * idempotency-key shape, status/limit validation, opaque cursor encoding, the
 * public response projection, and the after-commit retry wake.
 */

export { FinanceAttributionMutationError } from '@/db/persistence/finance-attribution';

type ActorType = 'parent-admin' | 'service';

async function attributionPersistence(): Promise<FinanceAttributionPersistence> {
  return (await getWorkerPersistenceRepositories()).finance.attribution;
}

function requireIdempotencyKey(value: string | null | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new FinanceAttributionMutationError(
      'invalid_idempotency_key',
      'A valid Idempotency-Key header is required',
      400,
    );
  }
  return key;
}

export interface ManualDecisionInput {
  connectorId: string;
  transactionId: string;
  action: FinanceManualAction;
  kidId: string | null;
  idempotencyKey: string | null;
  expectedExceptionUpdatedAt?: string;
  actorType: ActorType;
  exceptionId?: string | null;
  auditAction?: 'approve' | 'manual-resolve';
  expectedTransactionVersion?: FinanceAttributionExpectedTransactionVersion;
}

export async function applyManualAttributionDecision(input: ManualDecisionInput): Promise<{
  status: 'resolved';
  transactionId: string;
  kidId: string | null;
  idempotencyKey: string;
  replayed: boolean;
}> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const persistence = await attributionPersistence();
  const result = await persistence.applyManualDecision({
    connectorId: input.connectorId,
    transactionId: input.transactionId,
    action: input.action,
    kidId: input.kidId,
    idempotencyKey,
    auditAction: input.auditAction ?? 'manual-resolve',
    actorType: input.actorType,
    exceptionId: input.exceptionId ?? null,
    expectedExceptionUpdatedAt: input.expectedExceptionUpdatedAt ?? null,
    expectedTransactionVersion: input.expectedTransactionVersion ?? null,
    now: new Date().toISOString(),
  });
  return {
    status: result.status,
    transactionId: result.transactionId,
    kidId: result.kidId,
    idempotencyKey,
    replayed: result.replayed,
  };
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString('base64url');
}

function decodeCursor(value: string | null): FinanceAttributionExceptionCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const updatedAt = (parsed as { updatedAt?: unknown } | null)?.updatedAt;
    const id = (parsed as { id?: unknown } | null)?.id;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof updatedAt === 'string'
      && updatedAt.length >= 20
      && updatedAt.length <= 35
      && Number.isFinite(Date.parse(updatedAt))
      && typeof id === 'string'
      && id.length >= 1
      && id.length <= 128
    ) {
      return { updatedAt, id };
    }
  } catch {
    // Rejected below.
  }
  throw new FinanceAttributionMutationError(
    'invalid_cursor',
    'Attribution exception cursor is invalid',
    400,
  );
}

export async function listAttributionExceptions(
  connectorId: string,
  input: { status?: string | null; limit?: string | null; cursor?: string | null },
): Promise<{
  exceptions: readonly FinanceAttributionExceptionView[];
  nextCursor: string | null;
  subjects: readonly FinanceAttributionSubjectView[];
}> {
  const persistence = await attributionPersistence();
  await persistence.assertConnector(connectorId);
  const status = (input.status ?? 'current') as FinanceAttributionExceptionStatusFilter;
  if (!FINANCE_ATTRIBUTION_EXCEPTION_STATUS_FILTERS.includes(status)) {
    throw new FinanceAttributionMutationError(
      'invalid_status',
      'Attribution exception status is invalid',
      400,
    );
  }
  const parsedLimit = Number(input.limit ?? 50);
  if (
    !Number.isSafeInteger(parsedLimit)
    || parsedLimit < 1
    || parsedLimit > FINANCE_ATTRIBUTION_EXCEPTION_PAGE_MAX
  ) {
    throw new FinanceAttributionMutationError(
      'invalid_limit',
      `Attribution exception limit must be from 1 to ${FINANCE_ATTRIBUTION_EXCEPTION_PAGE_MAX}`,
      400,
    );
  }
  const cursor = decodeCursor(input.cursor ?? null);
  const page = await persistence.listExceptions({
    connectorId,
    status,
    limit: parsedLimit,
    cursor,
  });
  const last = page.exceptions[page.exceptions.length - 1];
  return {
    exceptions: page.exceptions,
    nextCursor: page.hasMore && last ? encodeCursor(last.updatedAt, last.id) : null,
    subjects: page.subjects,
  };
}

export async function actOnAttributionException(input: {
  connectorId: string;
  exceptionId: string;
  action: FinanceAttributionExceptionAction;
  kidId?: string | null;
  expectedUpdatedAt: string;
  idempotencyKey: string | null;
  actorType: ActorType;
}): Promise<{
  status: string;
  exceptionId: string;
  idempotencyKey: string;
  replayed: boolean;
  retryScheduled: boolean;
}> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const persistence = await attributionPersistence();
  const result = await persistence.actOnException({
    connectorId: input.connectorId,
    exceptionId: input.exceptionId,
    action: input.action,
    kidId: input.action === 'manual-resolve' ? input.kidId ?? null : null,
    expectedUpdatedAt: input.expectedUpdatedAt,
    idempotencyKey,
    actorType: input.actorType,
    now: new Date().toISOString(),
  });
  // Strictly after commit, and never for an idempotent replay: a queued retry
  // must not become observable before the exception transition it belongs to.
  if (result.retryScheduled && isDurableSyncMode()) {
    const repository = await getSyncJobRepository();
    await repository.enqueue(input.connectorId, { full: true, source: 'api' });
  }
  return {
    status: result.status,
    exceptionId: result.exceptionId,
    idempotencyKey,
    replayed: result.replayed,
    retryScheduled: result.retryScheduled,
  };
}
