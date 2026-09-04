import {
  runWithConnectorOperationLease as runWithSelectedConnectorOperationLease,
} from './connector-lock-runtime';
import type { ConnectorOperationType } from './connector-operation-lease-repository';

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
export { getConnectorOperationLeaseRepository } from './connector-lock-runtime';

export async function runWithConnectorOperationLease<T>(
  connectorId: string,
  operationType: ConnectorOperationType,
  operation: () => Promise<T>,
): Promise<T> {
  return runWithSelectedConnectorOperationLease(
    connectorId,
    operationType,
    operation,
  );
}
