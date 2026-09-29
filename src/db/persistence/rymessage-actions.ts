import type {
  CompanionActionFeedPage,
  CompanionActionMaterialization,
  CompanionActionMutation,
  CompanionActionMutationReceipt,
  PortableCompanionAction,
} from '@/lib/connectors/rymessage/action-contract';

export const RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS = 25_000;
export const RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS = 200_000;
export const RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE = 10_000;
export const RYMESSAGE_ACTION_DEFAULT_LEASE_SECONDS = 300;
export const RYMESSAGE_ACTION_MAX_LEASE_SECONDS = 1_800;
export const RYMESSAGE_ACTION_MAX_LEASE_ITEMS = 20;
export const RYMESSAGE_ACTION_MAX_ATTEMPTS = 8;
export const RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS = 5_000;

export class RyMessageActionPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RyMessageActionPersistenceError';
  }
}

export type RyMessageRelationState =
  | 'pending-import'
  | 'linked'
  | 'conflict'
  | 'deleted'
  | 'link-broken';

export interface RyMessageFeedState {
  connectorId: string;
  feedId: string | null;
  cursor: string | null;
  recoveryGeneration: number;
  recoveryRequired: boolean;
  fullSyncGeneration: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface RyMessageActionProjection {
  connectorId: string;
  actionId: string;
  sourceId: string;
  revision: number;
  action: PortableCompanionAction | null;
  tombstonedAt: string | null;
}

export interface RyMessageMaterializationRecord extends CompanionActionMaterialization {
  connectorId: string;
  actionId: string;
  actionRevision: number;
  localTaskId: string | null;
  relationState: RyMessageRelationState;
  conflictCode: string | null;
}

export interface RyMessageApplyFeedCommand {
  connectorId: string;
  page: CompanionActionFeedPage;
  requestedCursor: string | null;
  receivedAt: string;
}

export interface RyMessageApplyFeedResult {
  applied: number;
  added: number;
  updated: number;
  ignored: number;
  tombstoned: number;
  conflicts: number;
  recoveryCompleted: boolean;
}

export interface RyMessageRelationReconciliationResult {
  linked: number;
  pendingImport: number;
  conflicts: number;
  broken: number;
  observationsQueued: number;
}

export interface RyMessageEnqueueMutationCommand {
  connectorId: string;
  actionId: string;
  operationId: string;
  baseRevision: number;
  expectedFieldRevisions: Readonly<Record<string, number>>;
  mutation: CompanionActionMutation;
  now: string;
}

export interface RyMessageLeasedMutation {
  operationId: string;
  connectorId: string;
  actionId: string;
  baseRevision: number;
  expectedFieldRevisions: Readonly<Record<string, number>>;
  mutation: CompanionActionMutation;
  attemptCount: number;
}

export interface RyMessageMutationLease {
  leaseId: string;
  leaseExpiresAt: string;
  items: readonly RyMessageLeasedMutation[];
}

export interface RyMessageMutationOutcome {
  connectorId: string;
  operationId: string;
  leaseId: string;
  receipt?: CompanionActionMutationReceipt;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
  now: string;
}

export interface RyMessageActionStatus {
  feed: RyMessageFeedState;
  projectionCount: number;
  linkedCount: number;
  pendingImportCount: number;
  conflictCount: number;
  mutationConflictCount: number;
  pendingWriteCount: number;
  deadLetterCount: number;
}

export interface RyMessageActionPersistence {
  readFeedState(connectorId: string): Promise<RyMessageFeedState>;
  applyFeedPage(command: RyMessageApplyFeedCommand): Promise<RyMessageApplyFeedResult>;
  invalidateRecovery(input: {
    connectorId: string;
    reason: string;
    now: string;
  }): Promise<void>;
  reconcileMaterializations(input: {
    connectorId: string;
    now: string;
  }): Promise<RyMessageRelationReconciliationResult>;
  getProjection(
    connectorId: string,
    actionId: string,
  ): Promise<RyMessageActionProjection | null>;
  enqueueMutation(command: RyMessageEnqueueMutationCommand): Promise<'queued' | 'duplicate'>;
  leaseMutations(input: {
    connectorId: string;
    now: string;
    limit?: number;
    leaseSeconds?: number;
  }): Promise<RyMessageMutationLease>;
  completeMutation(outcome: RyMessageMutationOutcome): Promise<void>;
  readStatus(connectorId: string): Promise<RyMessageActionStatus>;
}
