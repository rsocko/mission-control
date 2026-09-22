import { createHash } from 'node:crypto';
import type { ConnectorConfig } from '@/types';
import type {
  FinanceConnectionRecoveryStatus,
  FinanceConnectionRecoveryView,
} from '@/lib/connectors/monarch-money/recovery-contract';

export const FINANCE_CONNECTION_NOTIFICATION_AFTER_MS = 15 * 60 * 1_000;
export const FINANCE_CONNECTION_TASK_AFTER_MS = 4 * 60 * 60 * 1_000;

export type FinanceConnectionOutageStatus =
  | FinanceConnectionRecoveryStatus
  | 'recovered';

export type FinanceConnectionAuthState =
  | 'connected'
  | 'unauthenticated'
  | 'expired'
  | 'degraded'
  | 'unavailable';

export interface FinanceConnectionOutage {
  connectorId: string;
  episodeId: string;
  status: FinanceConnectionOutageStatus;
  authState: FinanceConnectionAuthState;
  startedAt: string;
  lastObservedAt: string;
  notificationCreatedAt: string | null;
  taskCreatedAt: string | null;
  recoverySyncSucceededAt: string | null;
  recoveredAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FinanceConnectionObservation =
  | {
      kind: 'health';
      health: {
        status: string;
        mode: string;
        reachable: boolean;
        authenticated: boolean;
        authState: FinanceConnectionAuthState;
      };
    }
  | { kind: 'unavailable'; errorCode: string };

export interface FinanceConnectionReconcileResult {
  status: FinanceConnectionOutageStatus | 'healthy';
  notificationCreated: boolean;
  taskCreated: boolean;
  recovered: boolean;
  pendingDelivery: boolean;
}

export interface FinanceConnectionRecoveryPersistence {
  reconcileObservation(input: {
    connectorId: string;
    observation: FinanceConnectionObservation;
    now: Date;
  }): Promise<FinanceConnectionReconcileResult>;
  listEnabledConnectors(): Promise<ConnectorConfig[]>;
  getActiveEpisode(connectorId: string): Promise<FinanceConnectionOutage | null>;
  recordBoundedSyncFailure(input: {
    connectorId: string;
    episodeId: string;
    errorCode: string;
    now: Date;
  }): Promise<boolean>;
  recordBoundedSyncSuccess(input: {
    connectorId: string;
    episodeId: string;
    now: Date;
  }): Promise<boolean>;
  settleEpisode(input: {
    connectorId: string;
    episodeId: string;
    now: Date;
  }): Promise<boolean>;
  getView(input: {
    connectorId: string;
    reconnectUrl: string | null;
  }): Promise<FinanceConnectionRecoveryView | null>;
}

export function financeConnectionEpisodeId(
  connectorId: string,
  startedAt: string,
): string {
  return createHash('sha256')
    .update(`${connectorId}\0${startedAt}`)
    .digest('hex')
    .slice(0, 32);
}

export function financeConnectionSourceId(
  row: Pick<FinanceConnectionOutage, 'connectorId' | 'episodeId'>,
): string {
  return `finance-connection:${row.connectorId}:${row.episodeId}`;
}

export function financeConnectionNotificationId(
  row: Pick<FinanceConnectionOutage, 'episodeId'>,
): string {
  return `finance-connection-notification-${row.episodeId}`;
}

export function financeConnectionTaskId(
  row: Pick<FinanceConnectionOutage, 'episodeId'>,
): string {
  return `finance-connection-task-${row.episodeId}`;
}

export function isStrictlyHealthyFinanceObservation(
  observation: FinanceConnectionObservation,
): boolean {
  return observation.kind === 'health'
    && observation.health.status === 'ok'
    && observation.health.mode === 'live'
    && observation.health.reachable
    && observation.health.authenticated
    && observation.health.authState === 'connected';
}

export function financeObservationAuthState(
  observation: FinanceConnectionObservation,
): FinanceConnectionAuthState {
  return observation.kind === 'unavailable'
    ? 'unavailable'
    : observation.health.authState;
}

export function isFinanceAuthenticationExpired(
  observation: FinanceConnectionObservation,
): boolean {
  return observation.kind === 'health'
    && (
      observation.health.authState === 'expired'
      || observation.health.authState === 'unauthenticated'
      || !observation.health.authenticated
    );
}

export function desiredFinanceConnectionStatus(
  row: Pick<FinanceConnectionOutage, 'status' | 'startedAt'>,
  observation: FinanceConnectionObservation,
  now: Date,
): FinanceConnectionOutageStatus {
  if (isStrictlyHealthyFinanceObservation(observation)) return 'recovery_pending';
  if (isFinanceAuthenticationExpired(observation) || row.status === 'authentication_expired') {
    return 'authentication_expired';
  }
  return now.getTime() - Date.parse(row.startedAt) >= FINANCE_CONNECTION_NOTIFICATION_AFTER_MS
    ? 'degraded'
    : 'transient';
}

export function financeConnectionNotificationType(
  status: FinanceConnectionOutageStatus,
): 'connectorDegraded' | 'connectorAuthenticationExpired' {
  return status === 'authentication_expired'
    ? 'connectorAuthenticationExpired'
    : 'connectorDegraded';
}

export function financeConnectionNotificationCopy(
  status: FinanceConnectionOutageStatus,
): { title: string; body: string; level: 'urgent' | 'action_needed' } {
  if (status === 'authentication_expired') {
    return {
      title: 'Reconnect Monarch',
      body: 'Monarch authentication has expired. Finance data is stale and scheduled sync is blocked until you reconnect in Tyrion.',
      level: 'urgent',
    };
  }
  return {
    title: 'Monarch connection needs attention',
    body: 'Mission Control cannot refresh Monarch data. Finance data is stale while the Tyrion connection remains degraded.',
    level: 'action_needed',
  };
}

export function financeConnectionNotificationMetadata(
  row: FinanceConnectionOutage,
  status: FinanceConnectionOutageStatus,
  now: Date,
): Record<string, unknown> {
  return {
    notificationType: financeConnectionNotificationType(status),
    financeConnectionRecovery: {
      contractVersion: '1.0',
      outageEpisodeId: row.episodeId,
      connectorRef: row.connectorId,
      status,
      authState: row.authState,
      startedAt: row.startedAt,
      observedAt: now.toISOString(),
      staleData: true,
    },
  };
}

export function financeConnectionRecoveryView(
  row: FinanceConnectionOutage,
  reconnectUrl: string | null,
): FinanceConnectionRecoveryView | null {
  if (row.status === 'recovered') return null;
  const status = row.status;
  const message = status === 'authentication_expired'
    ? 'Monarch authentication is disconnected. Finance data is stale until Tyrion reconnects and Mission Control verifies a bounded refresh.'
    : status === 'recovery_pending'
      ? 'Monarch is connected, but Finance data remains stale until Mission Control completes and verifies a bounded refresh.'
      : status === 'transient'
        ? 'Monarch health is temporarily unavailable. Finance data may be stale while Mission Control waits for the transient window to settle.'
        : 'The Monarch connection is degraded. Finance data is stale until Tyrion reconnects and Mission Control verifies a bounded refresh.';
  return {
    active: true,
    status,
    authState: row.authState,
    startedAt: row.startedAt,
    lastObservedAt: row.lastObservedAt,
    notificationCreatedAt: row.notificationCreatedAt,
    taskCreatedAt: row.taskCreatedAt,
    staleData: true,
    message,
    reconnectUrl,
    canVerifyRecovery: row.status === 'recovery_pending',
  };
}
