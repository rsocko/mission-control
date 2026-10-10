import 'server-only';

import {
  getFinanceSyncControlStatus,
  type FinanceSyncControlStatus,
} from '@/lib/sync/operator-control';

export type FinanceInsightProjectionRepairErrorCode =
  | 'finance_insight_repair_connector_enabled'
  | 'finance_insight_repair_quarantine_required'
  | 'finance_insight_repair_active_work'
  | 'finance_insight_repair_gates_enabled';

export class FinanceInsightProjectionRepairError extends Error {
  constructor(
    readonly code: FinanceInsightProjectionRepairErrorCode,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'FinanceInsightProjectionRepairError';
  }
}

export function assertFinanceInsightProjectionRepairStatus(
  status: FinanceSyncControlStatus,
): void {
  if (status.connector.enabled) {
    throw new FinanceInsightProjectionRepairError(
      'finance_insight_repair_connector_enabled',
    );
  }
  if (status.scheduler.state !== 'quarantined') {
    throw new FinanceInsightProjectionRepairError(
      'finance_insight_repair_quarantine_required',
    );
  }
  if (status.scheduler.queued > 0 || status.scheduler.running > 0) {
    throw new FinanceInsightProjectionRepairError(
      'finance_insight_repair_active_work',
    );
  }
  if (
    status.gates.immediateNotificationsEnabled
    || status.gates.monthlyDigestEnabled
    || status.gates.weeklySummaryEnabled
    || status.gates.deliveryEnabled
    || status.gates.presentationEnabled
    || status.gates.actionsEnabled
  ) {
    throw new FinanceInsightProjectionRepairError(
      'finance_insight_repair_gates_enabled',
    );
  }
}

export async function assertFinanceInsightProjectionRepairSafe(
  connectorId: string,
): Promise<void> {
  assertFinanceInsightProjectionRepairStatus(
    await getFinanceSyncControlStatus(connectorId),
  );
}
