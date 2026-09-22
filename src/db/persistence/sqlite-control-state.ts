import 'server-only';

import { sqlite } from '@/db';
import type { SyncJobSource } from '@/lib/sync/job-repository';
import { ConnectorSyncControlError } from '@/lib/sync/control-state-error';

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
