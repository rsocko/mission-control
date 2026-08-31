import 'server-only';

import {
  financeAttentionSourceId,
  financeAttentionTaskId,
  FINANCE_MY_DAY_DAILY_CAP,
  FINANCE_TASK_PROMOTION_DAILY_CAP,
  FinanceAttentionRoutingError,
  isHumanReviewableAttributionReason,
  selectFinanceAttentionRoute,
  type FinanceAttentionRoutingResult,
} from '@/db/persistence/finance-attention';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';

export {
  financeAttentionSourceId,
  financeAttentionTaskId,
  FINANCE_MY_DAY_DAILY_CAP,
  FINANCE_TASK_PROMOTION_DAILY_CAP,
  FinanceAttentionRoutingError,
  isHumanReviewableAttributionReason,
  selectFinanceAttentionRoute,
};
export type { FinanceAttentionRoutingResult };

/**
 * Reconciles finance attention signals (attribution-review, write-back
 * failed) for one connector into notifications, My Day-eligible tasks, and
 * their settlement. The adapter owns the whole operation atomically; this
 * function only resolves the backend, wakes the push dispatcher once a
 * pending delivery has actually committed, and maps unexpected failures to
 * `FinanceAttentionRoutingError`.
 */
export async function reconcileFinanceAttention(input: {
  connectorId: string;
  now?: Date;
}): Promise<FinanceAttentionRoutingResult> {
  const decisionAt = input.now ?? new Date();
  try {
    const repositories = await getWorkerPersistenceRepositories();
    const persistence = repositories.finance.attention.routing;
    const { summary, hasPendingDelivery } = await persistence.reconcile({
      connectorId: input.connectorId,
      decisionAt,
    });
    if (
      hasPendingDelivery
      && repositories.execution.support.allowsLegacyWorkflow('notification-dispatcher')
    ) {
      wakeNotificationDeliveryDispatcher();
    }
    return summary;
  } catch (error) {
    if (error instanceof FinanceAttentionRoutingError) throw error;
    throw new FinanceAttentionRoutingError();
  }
}
