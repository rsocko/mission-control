import type { Pool } from 'pg';
import { ConnectorSyncControlError } from '@/lib/sync/control-state-error';
import type { SyncControlStateRepository } from '@/lib/sync/control-state';
import type { SyncJobSource } from '@/lib/sync/job-repository';

export class PostgresSyncControlStateRepository implements SyncControlStateRepository {
  constructor(private readonly pool: Pool) {}

  async isQuarantined(connectorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM connector_sync_controls
       WHERE connector_id = $1 AND scheduler_state = 'quarantined'`,
      [connectorId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async assertEnqueueAllowed(
    connectorId: string,
    source: SyncJobSource,
    operatorCanaryRunId?: string,
  ): Promise<void> {
    const result = await this.pool.query<{ quarantineId: string | null }>(
      `SELECT quarantine_id AS "quarantineId"
       FROM connector_sync_controls
       WHERE connector_id = $1 AND scheduler_state = 'quarantined'`,
      [connectorId],
    );
    const control = result.rows[0];
    if (!control) {
      if (source === 'operator-canary') {
        throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
      }
      return;
    }
    if (source !== 'operator-canary' || !operatorCanaryRunId) {
      throw new ConnectorSyncControlError('connector_sync_quarantined');
    }
    const authorized = await this.pool.query(
      `SELECT 1
       FROM connector_sync_operator_runs
       WHERE id = $1
         AND connector_id = $2
         AND quarantine_id IS NOT DISTINCT FROM $3
         AND operation = 'canary'
         AND job_id IS NULL`,
      [operatorCanaryRunId, connectorId, control.quarantineId],
    );
    if ((authorized.rowCount ?? 0) !== 1) {
      throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
    }
  }
}

export function createPostgresSyncControlStateRepository(
  pool: Pool,
): SyncControlStateRepository {
  return new PostgresSyncControlStateRepository(pool);
}
