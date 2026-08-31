import 'server-only';

import type { ConnectorConfig } from '@/types';
import {
  FINANCE_CONNECTION_NOTIFICATION_AFTER_MS,
  FINANCE_CONNECTION_TASK_AFTER_MS,
  isStrictlyHealthyFinanceObservation,
  type FinanceConnectionObservation,
  type FinanceConnectionReconcileResult,
} from '@/db/persistence/finance-recovery';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import { resolveTyrionReconnectUrl } from '@/lib/finance/tyrion-reconnect';
import { isConnectorSyncQuarantinedAsync } from '@/lib/sync/control-state';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
  type MonarchBridgeHealth,
} from './client';
import type { FinanceConnectionRecoveryView } from './recovery-contract';

export {
  FINANCE_CONNECTION_NOTIFICATION_AFTER_MS,
  FINANCE_CONNECTION_TASK_AFTER_MS,
};
export const FINANCE_RECOVERY_SYNC_DAYS = 30;
export type { FinanceConnectionObservation, FinanceConnectionReconcileResult };

async function recoveryPersistence() {
  return (await getWorkerPersistenceRepositories()).finance.recovery;
}

export async function reconcileFinanceConnectionObservation(input: {
  connectorId: string;
  observation: FinanceConnectionObservation;
  now?: Date;
}): Promise<FinanceConnectionReconcileResult> {
  const result = await (await recoveryPersistence()).reconcileObservation({
    connectorId: input.connectorId,
    observation: input.observation,
    now: input.now ?? new Date(),
  });
  if (result.pendingDelivery) wakeNotificationDeliveryDispatcher();
  return result;
}

export async function probeFinanceConnection(
  config: ConnectorConfig,
  now = new Date(),
): Promise<FinanceConnectionReconcileResult> {
  try {
    const health = await new MonarchBridgeClient(config).getHealth();
    return reconcileFinanceConnectionObservation({
      connectorId: config.id,
      observation: { kind: 'health', health },
      now,
    });
  } catch (error) {
    return reconcileFinanceConnectionObservation({
      connectorId: config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
  }
}

export async function probeAllFinanceConnections(now = new Date()): Promise<void> {
  const persistence = await recoveryPersistence();
  const connectors = await persistence.listEnabledConnectors();
  await Promise.all(connectors.map((config) => probeFinanceConnection(config, now)));
}

export async function verifyFinanceConnectionRecovery(input: {
  config: ConnectorConfig;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ recovered: boolean; reason?: string }> {
  const now = input.now ?? new Date();
  if (await isConnectorSyncQuarantinedAsync(input.config.id)) {
    return { recovered: false, reason: 'connector_sync_quarantined' };
  }
  const persistence = await recoveryPersistence();
  const client = new MonarchBridgeClient(input.config);
  let health: MonarchBridgeHealth;
  try {
    health = await client.getHealth(input.signal);
  } catch (error) {
    await reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
    return { recovered: false, reason: 'health_unavailable' };
  }
  if (!isStrictlyHealthyFinanceObservation({ kind: 'health', health })) {
    await reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: { kind: 'health', health },
      now,
    });
    return { recovered: false, reason: 'authentication_not_connected' };
  }

  const existing = await persistence.getActiveEpisode(input.config.id);
  if (!existing) return { recovered: true };

  await reconcileFinanceConnectionObservation({
    connectorId: input.config.id,
    observation: { kind: 'health', health },
    now,
  });
  try {
    await client.runBoundedSync(FINANCE_RECOVERY_SYNC_DAYS, input.signal);
  } catch (error) {
    await persistence.recordBoundedSyncFailure({
      connectorId: input.config.id,
      episodeId: existing.episodeId,
      errorCode: error instanceof MonarchBridgeError ? error.code : 'bounded_sync_failed',
      now,
    });
    return { recovered: false, reason: 'bounded_sync_failed' };
  }
  const recorded = await persistence.recordBoundedSyncSuccess({
    connectorId: input.config.id,
    episodeId: existing.episodeId,
    now,
  });
  if (!recorded) return { recovered: false, reason: 'outage_episode_changed' };

  let confirmation: MonarchBridgeHealth;
  try {
    confirmation = await client.getHealth(input.signal);
  } catch (error) {
    await reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
    return { recovered: false, reason: 'confirmation_health_unavailable' };
  }
  if (!isStrictlyHealthyFinanceObservation({ kind: 'health', health: confirmation })) {
    await reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: { kind: 'health', health: confirmation },
      now,
    });
    return { recovered: false, reason: 'confirmation_not_connected' };
  }
  const settled = await persistence.settleEpisode({
    connectorId: input.config.id,
    episodeId: existing.episodeId,
    now,
  });
  return settled
    ? { recovered: true }
    : { recovered: false, reason: 'outage_episode_changed' };
}

export async function getFinanceConnectionRecoveryView(
  connectorId: string,
): Promise<FinanceConnectionRecoveryView | null> {
  let reconnectUrl: string | null = null;
  try {
    reconnectUrl = resolveTyrionReconnectUrl();
  } catch {
    reconnectUrl = null;
  }
  return (await recoveryPersistence()).getView({ connectorId, reconnectUrl });
}
