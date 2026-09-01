import 'server-only';

import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SyncJobSource } from './job-repository';

export { ConnectorSyncControlError } from './control-state-error';

/**
 * Backend-selected, async equivalent of `isConnectorSyncQuarantined`. SQLite
 * delegates to the unchanged synchronous check above; PostgreSQL queries
 * `connector_sync_controls` directly via the registered pool (dynamically
 * imported so SQLite-only callers never pull in the PostgreSQL schema/driver
 * graph).
 */
export async function isConnectorSyncQuarantinedAsync(connectorId: string): Promise<boolean> {
  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { isConnectorSyncQuarantinedInPostgres }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/sync/job-repository'),
    ]);
    return isConnectorSyncQuarantinedInPostgres(
      getPostgresPersistenceBackend().context.pool,
      connectorId,
    );
  }
  const { isConnectorSyncQuarantined } = await import('./sqlite-control-state');
  return isConnectorSyncQuarantined(connectorId);
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
  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { assertConnectorSyncEnqueueAllowedInPostgres }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/sync/job-repository'),
    ]);
    await assertConnectorSyncEnqueueAllowedInPostgres(
      getPostgresPersistenceBackend().context.pool,
      connectorId,
      source,
      operatorCanaryRunId,
    );
    return;
  }
  const { assertConnectorSyncEnqueueAllowed } = await import('./sqlite-control-state');
  assertConnectorSyncEnqueueAllowed(connectorId, source, operatorCanaryRunId);
}
