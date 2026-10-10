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
  type FinanceAttentionSignal,
} from '@/db/persistence/finance-attention';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import { getPersistedFinanceConnectorConfigById } from '@/lib/connectors/monarch-money/config';
import { resolveTyrionHouseholdCurrency } from '@/lib/connectors/monarch-money/attribution-client';

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
export {
  compareFinanceAttentionTransitionPrecedence,
  evaluateFinanceAttentionEnvelope,
  FINANCE_ATTENTION_CONTRACT_VERSION as FINANCE_ATTENTION_ENVELOPE_CONTRACT_VERSION,
  FINANCE_ATTENTION_SIGNAL_KINDS,
  FinanceAttentionEnvelopeError,
  parseFinanceAttentionEnvelope,
} from '@/lib/finance/attention-policy';
export type {
  FinanceAttentionCapability,
  FinanceAttentionEnvelope,
  FinanceAttentionEnvelopeSignalKind,
  FinanceAttentionPolicyDecision,
  FinanceAttentionPolicyRoute,
  FinanceAttentionTarget,
} from '@/lib/finance/attention-policy';

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
  sourceSignals?: readonly FinanceAttentionSignal[];
}): Promise<FinanceAttentionRoutingResult> {
  const decisionAt = input.now ?? new Date();
  try {
    const repositories = await getWorkerPersistenceRepositories();
    const persistence = repositories.finance.attention.routing;
    const config = await getPersistedFinanceConnectorConfigById(input.connectorId);
    const currency = await resolveTyrionHouseholdCurrency(config);
    const { summary, hasPendingDelivery } = await persistence.reconcile({
      connectorId: input.connectorId,
      decisionAt,
      currency,
      sourceSignals: input.sourceSignals,
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
