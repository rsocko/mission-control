import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
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

interface ConnectorOperationLeaseRuntimeRegistry {
  repository: ConnectorOperationLeaseRepository | null;
}

const REGISTRY_KEY = 'mission-control.connector-operation-lease-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): ConnectorOperationLeaseRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repository: null,
  }));
}

export function registerConnectorOperationLeaseRepository(
  next: ConnectorOperationLeaseRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().repository;
  if (selected && selected !== next) {
    throw new Error('Connector operation lease repository is already selected');
  }
  registry().repository = next;
}

export function clearConnectorOperationLeaseRepository(
  expectedRepository?: ConnectorOperationLeaseRepository,
): void {
  const state = registry();
  if (expectedRepository && state.repository !== expectedRepository) return;
  state.repository = null;
}

export async function getConnectorOperationLeaseRepository():
Promise<ConnectorOperationLeaseRepository> {
  assertPersistenceCompositionAccessAllowed();
  const repository = registry().repository;
  if (!repository) {
    throw new Error('Connector operation lease repository has not been registered');
  }
  return repository;
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
  return runWithConnectorOperationLeaseViaRepository(
    await getConnectorOperationLeaseRepository(),
    connectorId,
    operationType,
    operation,
  );
}
