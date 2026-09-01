import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type {
  ConnectorOperationLeaseRepository,
  ConnectorOperationType,
} from './connector-operation-lease-repository';
import {
  ConnectorOperationBusyError,
  getConnectorOperationLeaseMs,
} from './connector-lock-values';

export type {
  ConnectorOperationLeaseAcquireOutcome,
  ConnectorOperationLeaseIdentity,
  ConnectorOperationLeaseReleaseOutcome,
  ConnectorOperationLeaseRenewOutcome,
  ConnectorOperationLeaseRepository,
  ConnectorOperationLeaseRequest,
  ConnectorOperationRecoveryOutcome,
  ConnectorOperationType,
} from './connector-operation-lease-repository';

export {
  ConnectorOperationBusyError,
  connectorSyncLeaseOwner,
  getConnectorOperationLeaseMs,
} from './connector-lock-values';

export async function getConnectorOperationLeaseRepository(): Promise<ConnectorOperationLeaseRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresConnectorOperationLeaseRepository } = await import('@/db/runtime');
    return getPostgresConnectorOperationLeaseRepository();
  }
  const { sqliteConnectorOperationLeaseRepository } = await import(
    './sqlite-connector-operation-lease-repository'
  );
  return sqliteConnectorOperationLeaseRepository;
}

async function runWithConnectorOperationLeaseViaRepository<T>(
  repository: ConnectorOperationLeaseRepository,
  connectorId: string,
  operationType: ConnectorOperationType,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = `${operationType}:${hostname()}:${process.pid}:${randomUUID()}`;
  const leaseMs = getConnectorOperationLeaseMs();

  const acquired = await repository.acquire({
    connectorId,
    operationType,
    owner,
    leaseDurationMs: leaseMs,
    at: new Date().toISOString(),
  });
  if (acquired.status !== 'acquired') {
    throw new ConnectorOperationBusyError();
  }

  let leaseError: Error | null = null;
  const heartbeat = setInterval(() => {
    repository.renew({
      connectorId,
      owner,
      leaseDurationMs: leaseMs,
      at: new Date().toISOString(),
    }).then((result) => {
      if (result.status !== 'renewed') {
        leaseError = new Error('Connector operation lease ownership was lost');
      }
    }).catch((error) => {
      leaseError = error instanceof Error ? error : new Error(String(error));
    });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  let operationSucceeded = false;
  try {
    const result = await operation();
    const renewed = leaseError ? null : await repository.renew({
      connectorId,
      owner,
      leaseDurationMs: leaseMs,
      at: new Date().toISOString(),
    });
    if (leaseError || !renewed || renewed.status !== 'renewed') {
      throw leaseError ?? new Error('Connector operation lease ownership was lost');
    }
    operationSucceeded = true;
    return result;
  } finally {
    clearInterval(heartbeat);
    const released = await repository.release({ connectorId, owner });
    if (operationSucceeded && released.status !== 'released') {
      throw new Error('Connector operation lease ownership was lost before release');
    }
  }
}

export async function runWithConnectorOperationLease<T>(
  connectorId: string,
  operationType: ConnectorOperationType,
  operation: () => Promise<T>,
): Promise<T> {
  if (resolveDatabaseBackend() === 'postgres') {
    return runWithConnectorOperationLeaseViaRepository(
      await getConnectorOperationLeaseRepository(),
      connectorId,
      operationType,
      operation,
    );
  }
  const { runWithConnectorOperationLease: runWithSQLiteConnectorOperationLease } = await import(
    './sqlite-connector-operation-lease-repository'
  );
  return runWithSQLiteConnectorOperationLease(connectorId, operationType, operation);
}
