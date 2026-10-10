import 'server-only';

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  FinanceCleanBootstrapApplyResult,
  FinanceCleanBootstrapDryRunResult,
  FinanceOperatorActorType,
} from '@/db/persistence/finance-operator';
import { FinanceOperatorPersistenceError } from '@/db/persistence/finance-operator';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  getConnectorOperationLeaseRepository,
} from '@/lib/sync/connector-lock-runtime';
import { getConnectorOperationLeaseMs } from '@/lib/sync/connector-lock-values';
import {
  assertFinanceInsightProjectionRepairSafe,
  FinanceInsightProjectionRepairError,
} from './projection-repair-safety';
import { normalizeSyncOperatorIdempotencyKey } from '@/lib/sync/operator-control';

export type FinanceCleanBootstrapErrorCode =
  | 'finance_clean_bootstrap_busy'
  | 'finance_clean_bootstrap_lease_lost'
  | 'finance_clean_bootstrap_manual_decisions_present'
  | 'finance_clean_bootstrap_in_flight_work'
  | 'finance_clean_bootstrap_dry_run_not_found'
  | 'finance_clean_bootstrap_confirmation_mismatch'
  | 'finance_clean_bootstrap_scope_drift'
  | 'finance_clean_bootstrap_idempotency_conflict';

export class FinanceCleanBootstrapError extends Error {
  constructor(
    readonly code: FinanceCleanBootstrapErrorCode,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'FinanceCleanBootstrapError';
  }
}

async function withExclusiveBootstrapLease<T>(
  connectorId: string,
  operation: (leaseOwner: string, now: string) => Promise<T>,
): Promise<T> {
  await assertFinanceInsightProjectionRepairSafe(connectorId);
  const repository = await getConnectorOperationLeaseRepository();
  const leaseOwner = `retention:finance-clean-bootstrap:${hostname()}:${process.pid}:${randomUUID()}`;
  const leaseDurationMs = getConnectorOperationLeaseMs();
  const now = new Date().toISOString();
  const acquired = await repository.acquire({
    connectorId,
    operationType: 'retention',
    owner: leaseOwner,
    leaseDurationMs,
    at: now,
  });
  if (acquired.status !== 'acquired') {
    throw new FinanceCleanBootstrapError('finance_clean_bootstrap_busy');
  }
  let succeeded = false;
  try {
    await assertFinanceInsightProjectionRepairSafe(connectorId);
    const result = await operation(leaseOwner, now);
    const renewed = await repository.renew({
      connectorId,
      owner: leaseOwner,
      leaseDurationMs,
      at: new Date().toISOString(),
    });
    if (renewed.status !== 'renewed') {
      throw new FinanceCleanBootstrapError('finance_clean_bootstrap_lease_lost');
    }
    succeeded = true;
    return result;
  } finally {
    const released = await repository.release({ connectorId, owner: leaseOwner });
    if (succeeded && released.status !== 'released') {
      throw new FinanceCleanBootstrapError('finance_clean_bootstrap_lease_lost');
    }
  }
}

export async function inventoryFinanceCleanBootstrap(input: {
  connectorId: string;
  actorType: FinanceOperatorActorType;
  idempotencyKey: string | null;
}): Promise<FinanceCleanBootstrapDryRunResult> {
  const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
  return withExclusiveBootstrapLease(input.connectorId, async (leaseOwner, now) => (
    (await getWorkerPersistenceRepositories()).finance.operator.inventoryCleanBootstrap({
      connectorId: input.connectorId,
      actorType: input.actorType,
      idempotencyKey,
      leaseOwner,
      now,
    })
  ));
}

export async function applyFinanceCleanBootstrap(input: {
  connectorId: string;
  actorType: FinanceOperatorActorType;
  idempotencyKey: string | null;
  dryRunId: string;
  scopeDigest: string;
  confirmationToken: string;
}): Promise<FinanceCleanBootstrapApplyResult> {
  const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
  return withExclusiveBootstrapLease(input.connectorId, async (leaseOwner, now) => (
    (await getWorkerPersistenceRepositories()).finance.operator.applyCleanBootstrap({
      ...input,
      idempotencyKey,
      leaseOwner,
      now,
    })
  ));
}

export function cleanBootstrapErrorResponse(error: unknown): {
  code: string;
  status: number;
} | null {
  if (error instanceof FinanceCleanBootstrapError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof FinanceInsightProjectionRepairError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof FinanceOperatorPersistenceError) {
    return { code: error.code, status: error.status };
  }
  return null;
}
