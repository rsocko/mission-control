import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
import type { FinanceConnectorConfigurationState } from '@/lib/connectors/monarch-money/config';
import type { SyncJob, SyncJobStatus } from './job-repository';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export type SyncOperatorErrorCode =
  | 'invalid_operator_idempotency_key'
  | 'finance_connector_not_found'
  | 'invalid_finance_connector_type'
  | 'sync_quarantine_active_job'
  | 'sync_quarantine_already_active'
  | 'sync_quarantine_required'
  | 'sync_canary_already_invoked'
  | 'sync_canary_not_successful'
  | 'sync_job_active'
  | 'household_currency_unavailable'
  | 'finance_service_token_unavailable'
  | 'attribution_policy_fence_unavailable'
  | 'finance_insight_shadow_ingest_disabled'
  | 'finance_delivery_gate_enabled'
  | 'finance_notification_gate_enabled'
  | 'operator_idempotency_conflict';

export class SyncOperatorError extends Error {
  constructor(
    readonly code: SyncOperatorErrorCode,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'SyncOperatorError';
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/;

export function normalizeSyncOperatorIdempotencyKey(
  value: string | null | undefined,
): string {
  const normalized = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new SyncOperatorError('invalid_operator_idempotency_key', 400);
  }
  return normalized;
}

export interface SyncOperatorInput {
  connectorId: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}

export interface FinanceSyncControlStatus {
  connector: {
    id: string;
    enabled: boolean;
    configurationState: FinanceConnectorConfigurationState;
  };
  scheduler: {
    state: 'scheduled' | 'quarantined';
    quarantineId: string | null;
    quarantinedAt: string | null;
    releasedAt: string | null;
    queued: number;
    running: number;
  };
  gates: {
    shadowIngestEnabled: boolean;
    immediateNotificationsEnabled: boolean;
    monthlyDigestEnabled: boolean;
    deliveryEnabled: boolean;
    presentationEnabled: boolean;
    actionsEnabled: boolean;
  };
  canary: {
    status: 'not-started' | SyncJobStatus;
    jobId: string | null;
    counts: {
      tasksAdded: number;
      tasksUpdated: number;
      tasksRemoved: number;
      notificationsAdded: number;
    } | null;
    resultCode: string | null;
  };
  readiness: {
    ready: boolean;
    blockers: SyncOperatorErrorCode[];
  };
}

export interface QuarantineFinanceConnectorSyncResult {
  status: 'quarantined';
  quarantineId: string | null;
  cancelledQueuedCount: number;
  replayed: boolean;
}

export interface EnqueueFinanceOperatorCanaryResult {
  job: SyncJob;
  replayed: boolean;
}

export interface ReleaseFinanceConnectorQuarantineResult {
  status: 'released';
  replayed: boolean;
}

export interface RollbackFinanceOperatorCanaryResult {
  status: 'quarantined';
  cancelledQueuedCount: number;
  cancellationRequestedCount: number;
  quarantineId?: string;
  replayed: boolean;
}

export interface SqliteSyncOperatorCapability {
  getFinanceSyncControlStatus(connectorId: string): FinanceSyncControlStatus;
  quarantineFinanceConnectorSync(
    input: SyncOperatorInput,
  ): QuarantineFinanceConnectorSyncResult;
  enqueueFinanceOperatorCanary(
    input: SyncOperatorInput,
  ): EnqueueFinanceOperatorCanaryResult;
  releaseFinanceConnectorQuarantine(
    input: SyncOperatorInput,
  ): ReleaseFinanceConnectorQuarantineResult;
  rollbackFinanceOperatorCanary(
    input: SyncOperatorInput,
  ): RollbackFinanceOperatorCanaryResult;
}

let capability: SqliteSyncOperatorCapability | null = null;

export function registerSqliteSyncOperatorCapability(
  next: SqliteSyncOperatorCapability,
): void {
  capability = next;
}

export function clearSqliteSyncOperatorCapability(): void {
  capability = null;
}

function requireCapability(): SqliteSyncOperatorCapability {
  if (!capability) {
    throw new Error('SQLite sync operator capability has not been registered');
  }
  return capability;
}

export interface SyncOperatorControlRepository {
  getStatus(connectorId: string): Promise<FinanceSyncControlStatus>;
  quarantine(input: SyncOperatorInput): Promise<QuarantineFinanceConnectorSyncResult>;
  enqueueCanary(input: SyncOperatorInput): Promise<EnqueueFinanceOperatorCanaryResult>;
  release(input: SyncOperatorInput): Promise<ReleaseFinanceConnectorQuarantineResult>;
  rollback(input: SyncOperatorInput): Promise<RollbackFinanceOperatorCanaryResult>;
}

export const sqliteSyncOperatorControlRepository: SyncOperatorControlRepository = {
  getStatus: async (connectorId) =>
    requireCapability().getFinanceSyncControlStatus(connectorId),
  quarantine: async (input) =>
    requireCapability().quarantineFinanceConnectorSync(input),
  enqueueCanary: async (input) =>
    requireCapability().enqueueFinanceOperatorCanary(input),
  release: async (input) =>
    requireCapability().releaseFinanceConnectorQuarantine(input),
  rollback: async (input) =>
    requireCapability().rollbackFinanceOperatorCanary(input),
};

let repository: SyncOperatorControlRepository | null = null;

export function registerSyncOperatorControlRepository(
  next: SyncOperatorControlRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repository && repository !== next) {
    throw new Error('Sync operator-control repository is already selected');
  }
  repository = next;
}

export function clearSyncOperatorControlRepository(
  expectedRepository?: SyncOperatorControlRepository,
): void {
  if (expectedRepository && repository !== expectedRepository) return;
  repository = null;
}

async function getSyncOperatorControlRepository():
Promise<SyncOperatorControlRepository> {
  assertPersistenceCompositionAccessAllowed();
  if (!repository) {
    throw new Error('Sync operator-control repository has not been registered');
  }
  return repository;
}

export async function getFinanceSyncControlStatus(
  connectorId: string,
): Promise<FinanceSyncControlStatus> {
  return (await getSyncOperatorControlRepository()).getStatus(connectorId);
}

export async function quarantineFinanceConnectorSync(
  input: SyncOperatorInput,
): Promise<QuarantineFinanceConnectorSyncResult> {
  return (await getSyncOperatorControlRepository()).quarantine(input);
}

export async function enqueueFinanceOperatorCanary(
  input: SyncOperatorInput,
): Promise<EnqueueFinanceOperatorCanaryResult> {
  return (await getSyncOperatorControlRepository()).enqueueCanary(input);
}

export async function releaseFinanceConnectorQuarantine(
  input: SyncOperatorInput,
): Promise<ReleaseFinanceConnectorQuarantineResult> {
  return (await getSyncOperatorControlRepository()).release(input);
}

export async function rollbackFinanceOperatorCanary(
  input: SyncOperatorInput,
): Promise<RollbackFinanceOperatorCanaryResult> {
  return (await getSyncOperatorControlRepository()).rollback(input);
}
