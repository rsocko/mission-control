import 'server-only';

import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import type { SyncJobSource } from './job-repository';

export { ConnectorSyncControlError } from './control-state-error';

export interface SyncControlStateRepository {
  isQuarantined(connectorId: string): Promise<boolean>;
  assertEnqueueAllowed(
    connectorId: string,
    source: SyncJobSource,
    operatorCanaryRunId?: string,
  ): Promise<void>;
}

let repository: SyncControlStateRepository | null = null;

export function registerSyncControlStateRepository(next: SyncControlStateRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repository && repository !== next) {
    throw new Error('Sync control-state repository is already selected');
  }
  repository = next;
}

export function clearSyncControlStateRepository(
  expectedRepository?: SyncControlStateRepository,
): void {
  if (expectedRepository && repository !== expectedRepository) return;
  repository = null;
}

export async function getSyncControlStateRepository(): Promise<SyncControlStateRepository> {
  assertPersistenceCompositionAccessAllowed();
  if (!repository) {
    throw new Error('Sync control-state repository has not been registered');
  }
  return repository;
}

export async function isConnectorSyncQuarantinedAsync(connectorId: string): Promise<boolean> {
  return (await getSyncControlStateRepository()).isQuarantined(connectorId);
}

/**
 * Backend-selected, async equivalent of `assertConnectorSyncEnqueueAllowed`.
 * SQLite delegates to the unchanged synchronous check above; PostgreSQL
 * re-implements the identical quarantine/canary-authorization rules against
 * `connector_sync_controls`/`connector_sync_operator_runs` (the same logic
 * `PostgresSyncJobRepository.enqueue()` already runs internally), dynamically
 * imported so SQLite-only callers never pull in the PostgreSQL schema/driver
 * graph.
 */
export async function assertConnectorSyncEnqueueAllowedAsync(
  connectorId: string,
  source: SyncJobSource,
  operatorCanaryRunId?: string,
): Promise<void> {
  await (await getSyncControlStateRepository()).assertEnqueueAllowed(
    connectorId,
    source,
    operatorCanaryRunId,
  );
}
