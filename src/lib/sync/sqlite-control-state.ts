import type { SyncControlStateRepository } from './control-state';
import type { SyncJobSource } from './job-repository';

export interface SynchronousSyncControlStateCapability {
  isConnectorSyncQuarantined(connectorId: string): boolean;
  assertConnectorSyncEnqueueAllowed(
    connectorId: string,
    source: SyncJobSource,
    operatorCanaryRunId?: string,
  ): void;
}

let capability: SynchronousSyncControlStateCapability | null = null;

export function registerSqliteSyncControlStateCapability(
  next: SynchronousSyncControlStateCapability,
): void {
  capability = next;
}

export function clearSqliteSyncControlStateCapability(): void {
  capability = null;
}

function requireCapability(): SynchronousSyncControlStateCapability {
  if (!capability) {
    throw new Error('SQLite sync control-state capability has not been registered');
  }
  return capability;
}

export function isConnectorSyncQuarantined(connectorId: string): boolean {
  return requireCapability().isConnectorSyncQuarantined(connectorId);
}

export function assertConnectorSyncEnqueueAllowed(
  connectorId: string,
  source: SyncJobSource,
  operatorCanaryRunId?: string,
): void {
  requireCapability().assertConnectorSyncEnqueueAllowed(
    connectorId,
    source,
    operatorCanaryRunId,
  );
}

export const sqliteSyncControlStateRepository: SyncControlStateRepository = {
  isQuarantined: async (connectorId) => isConnectorSyncQuarantined(connectorId),
  assertEnqueueAllowed: async (connectorId, source, operatorCanaryRunId) =>
    assertConnectorSyncEnqueueAllowed(connectorId, source, operatorCanaryRunId),
};
