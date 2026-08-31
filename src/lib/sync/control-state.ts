import 'server-only';

import { sqlite } from '@/db';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SyncJobSource } from './job-queue';
import { ConnectorSyncControlError } from './control-state-error';

export { ConnectorSyncControlError } from './control-state-error';

/**
 * SQLite-only, synchronous checks. Kept exactly as-is: `sqlite-job-repository.ts`
 * depends on these running synchronously inside its own `better-sqlite3`
 * transactions. New callers that must work under either backend should use
 * `isConnectorSyncQuarantinedAsync`/`assertConnectorSyncEnqueueAllowedAsync`
 * below instead.
 */
export function isConnectorSyncQuarantined(connectorId: string): boolean {
  return sqlite.prepare(`
    SELECT 1
    FROM connector_sync_controls
    WHERE connector_id = ? AND scheduler_state = 'quarantined'
  `).get(connectorId) !== undefined;
}

export function assertConnectorSyncEnqueueAllowed(
  connectorId: string,
  source: SyncJobSource,
  operatorCanaryRunId?: string,
): void {
  const control = sqlite.prepare(`
    SELECT quarantine_id AS quarantineId
    FROM connector_sync_controls
    WHERE connector_id = ? AND scheduler_state = 'quarantined'
  `).get(connectorId) as { quarantineId: string | null } | undefined;

  if (!control) {
    if (source === 'operator-canary') {
      throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
    }
    return;
  }
  if (source !== 'operator-canary' || !operatorCanaryRunId) {
    throw new ConnectorSyncControlError('connector_sync_quarantined');
  }
  const authorized = sqlite.prepare(`
    SELECT 1
    FROM connector_sync_operator_runs
    WHERE id = ?
      AND connector_id = ?
      AND quarantine_id IS ?
      AND operation = 'canary'
      AND job_id IS NULL
  `).get(operatorCanaryRunId, connectorId, control.quarantineId);
  if (!authorized) {
    throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
  }
}

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
  assertConnectorSyncEnqueueAllowed(connectorId, source, operatorCanaryRunId);
}
