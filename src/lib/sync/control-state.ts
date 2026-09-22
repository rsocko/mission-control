import 'server-only';

import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
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

interface SyncControlStateRuntimeRegistry {
  repository: SyncControlStateRepository | null;
}

const REGISTRY_KEY = 'mission-control.sync-control-state-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): SyncControlStateRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repository: null,
  }));
}

export function registerSyncControlStateRepository(next: SyncControlStateRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().repository;
  if (selected && selected !== next) {
    throw new Error('Sync control-state repository is already selected');
  }
  registry().repository = next;
}

export function clearSyncControlStateRepository(
  expectedRepository?: SyncControlStateRepository,
): void {
  const state = registry();
  if (expectedRepository && state.repository !== expectedRepository) return;
  state.repository = null;
}

export async function getSyncControlStateRepository(): Promise<SyncControlStateRepository> {
  assertPersistenceCompositionAccessAllowed();
  const repository = registry().repository;
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
