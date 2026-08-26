export type ConnectorOperationType = 'sync' | 'retention' | 'transfer';

export interface ConnectorOperationLeaseRequest {
  connectorId: string;
  operationType: ConnectorOperationType;
  owner: string;
  leaseDurationMs: number;
  at: string;
}

export interface ConnectorOperationLeaseIdentity {
  connectorId: string;
  owner: string;
}

export type ConnectorOperationLeaseAcquireOutcome =
  | { status: 'acquired'; expiresAt: string }
  | { status: 'conflict' };

export type ConnectorOperationLeaseRenewOutcome =
  | { status: 'renewed'; expiresAt: string }
  | { status: 'lost' };

export type ConnectorOperationLeaseReleaseOutcome =
  | { status: 'released' }
  | { status: 'lost' };

export interface ConnectorOperationRecoveryOutcome {
  exhausted: number;
  superseded: number;
  requeued: number;
}

export interface ConnectorOperationLeaseRepository {
  hasActiveSyncJobLease(input: {
    connectorId: string;
    jobId: string;
    at: string;
  }): Promise<boolean>;
  acquire(
    request: ConnectorOperationLeaseRequest,
  ): Promise<ConnectorOperationLeaseAcquireOutcome>;
  renew(
    request: Omit<ConnectorOperationLeaseRequest, 'operationType'>,
  ): Promise<ConnectorOperationLeaseRenewOutcome>;
  release(
    identity: ConnectorOperationLeaseIdentity,
  ): Promise<ConnectorOperationLeaseReleaseOutcome>;
  recoverExpiredJobs(at: string): Promise<ConnectorOperationRecoveryOutcome>;
}
