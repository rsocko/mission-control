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
  runWithConnectorOperationLease as sqliteRunWithConnectorOperationLease,
  sqliteConnectorOperationLeaseRepository,
} from './sqlite-connector-operation-lease-repository';

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
  acquireConnectorOperationLease,
  ConnectorOperationBusyError,
  connectorSyncLeaseOwner,
  getConnectorOperationLeaseMs,
  hasConnectorSyncJobLease,
  recoverExpiredSyncJobs,
  releaseConnectorOperationLease,
  renewConnectorOperationLease,
  sqliteConnectorOperationLeaseRepository,
} from './sqlite-connector-operation-lease-repository';

/**
 * Resolves the connector-operation-lease adapter for the currently selected
 * database backend. SQLite keeps using its long-standing
 * `connector_operation_leases`-backed singleton unchanged; PostgreSQL
 * resolves to the adapter registered by `initializeRuntimeDatabase` (see
 * `@/db/runtime`) once the backend has finished initializing.
 *
 * The PostgreSQL side is imported dynamically (only once actually needed)
 * so that merely importing this module — as most of the existing SQLite
 * call sites already do — never pulls in the PostgreSQL schema/driver graph.
 */
export async function getConnectorOperationLeaseRepository(): Promise<ConnectorOperationLeaseRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresConnectorOperationLeaseRepository } = await import('@/db/runtime');
    return getPostgresConnectorOperationLeaseRepository();
  }
  return sqliteConnectorOperationLeaseRepository;
}

/**
 * Portable (PostgreSQL) re-implementation of `runWithConnectorOperationLease`
 * built directly on the `ConnectorOperationLeaseRepository` contract
 * (acquire/renew/release), mirroring the SQLite adapter's
 * acquire-heartbeat-release algorithm without depending on
 * `better-sqlite3`-specific synchronous transactions.
 */
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

/**
 * Runs `operation` while holding an exclusive connector-operation lease for
 * `connectorId`/`operationType`, releasing it (and clearing any heartbeat
 * timer) once `operation` settles. Backend-selected: SQLite keeps its
 * original implementation unchanged; PostgreSQL uses the portable
 * `ConnectorOperationLeaseRepository` contract (acquire/renew/release)
 * registered for the active backend. The exported name and `Promise<T>`
 * signature are unchanged, so existing callers (already `await`ing this
 * function) require no changes for either backend.
 */
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
  return sqliteRunWithConnectorOperationLease(connectorId, operationType, operation);
}
