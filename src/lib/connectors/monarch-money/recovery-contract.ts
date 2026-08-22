export type FinanceConnectionRecoveryStatus =
  | 'transient'
  | 'degraded'
  | 'authentication_expired'
  | 'recovery_pending';

export interface FinanceConnectionRecoveryView {
  active: true;
  status: FinanceConnectionRecoveryStatus;
  authState: 'connected' | 'unauthenticated' | 'expired' | 'degraded' | 'unavailable';
  startedAt: string;
  lastObservedAt: string;
  notificationCreatedAt: string | null;
  taskCreatedAt: string | null;
  staleData: true;
  message: string;
  reconnectUrl: string | null;
  canVerifyRecovery: boolean;
}
