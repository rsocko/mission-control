import type {
  ConnectorOperationLeaseRepository,
  ConnectorOperationType,
} from './connector-operation-lease-repository';

export interface SqliteConnectorOperationLeaseCapability {
  hasConnectorSyncJobLease(connectorId: string, jobId: string, now?: string): boolean;
  recoverExpiredSyncJobs(nowIso: string): void;
  acquireConnectorOperationLease(
    connectorId: string,
    operationType: ConnectorOperationType,
    owner: string,
    leaseMs?: number,
    now?: Date,
  ): boolean;
  renewConnectorOperationLease(
    connectorId: string,
    owner: string,
    leaseMs?: number,
    now?: Date,
  ): boolean;
  releaseConnectorOperationLease(connectorId: string, owner: string): boolean;
  runWithConnectorOperationLease<T>(
    connectorId: string,
    operationType: ConnectorOperationType,
    operation: () => Promise<T>,
  ): Promise<T>;
  sqliteConnectorOperationLeaseRepository: ConnectorOperationLeaseRepository;
}

let capability: SqliteConnectorOperationLeaseCapability | null = null;

export function registerSqliteConnectorOperationLeaseCapability(
  next: SqliteConnectorOperationLeaseCapability,
): void {
  capability = next;
}

export function clearSqliteConnectorOperationLeaseCapability(): void {
  capability = null;
}

function requireCapability(): SqliteConnectorOperationLeaseCapability {
  if (!capability) {
    throw new Error('SQLite connector-operation lease capability has not been registered');
  }
  return capability;
}

export {
  ConnectorOperationBusyError,
  connectorSyncLeaseOwner,
  getConnectorOperationLeaseMs,
} from './connector-lock-values';

export const hasConnectorSyncJobLease = (
  ...args: Parameters<SqliteConnectorOperationLeaseCapability['hasConnectorSyncJobLease']>
) => requireCapability().hasConnectorSyncJobLease(...args);
export const recoverExpiredSyncJobs = (
  ...args: Parameters<SqliteConnectorOperationLeaseCapability['recoverExpiredSyncJobs']>
) => requireCapability().recoverExpiredSyncJobs(...args);
export const acquireConnectorOperationLease = (
  ...args: Parameters<SqliteConnectorOperationLeaseCapability['acquireConnectorOperationLease']>
) => requireCapability().acquireConnectorOperationLease(...args);
export const renewConnectorOperationLease = (
  ...args: Parameters<SqliteConnectorOperationLeaseCapability['renewConnectorOperationLease']>
) => requireCapability().renewConnectorOperationLease(...args);
export const releaseConnectorOperationLease = (
  ...args: Parameters<SqliteConnectorOperationLeaseCapability['releaseConnectorOperationLease']>
) => requireCapability().releaseConnectorOperationLease(...args);
export const runWithConnectorOperationLease = <T>(
  connectorId: string,
  operationType: ConnectorOperationType,
  operation: () => Promise<T>,
) => requireCapability().runWithConnectorOperationLease<T>(
  connectorId,
  operationType,
  operation,
);

export const sqliteConnectorOperationLeaseRepository: ConnectorOperationLeaseRepository = {
  hasActiveSyncJobLease: (...args) =>
    requireCapability().sqliteConnectorOperationLeaseRepository.hasActiveSyncJobLease(...args),
  acquire: (...args) =>
    requireCapability().sqliteConnectorOperationLeaseRepository.acquire(...args),
  renew: (...args) =>
    requireCapability().sqliteConnectorOperationLeaseRepository.renew(...args),
  release: (...args) =>
    requireCapability().sqliteConnectorOperationLeaseRepository.release(...args),
  recoverExpiredJobs: (...args) =>
    requireCapability().sqliteConnectorOperationLeaseRepository.recoverExpiredJobs(...args),
};
