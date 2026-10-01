import type {
  CompanionActionFeedPage,
  CompanionActionMaterialization,
  CompanionActionMutation,
  CompanionActionMutationReceipt,
  PortableCompanionAction,
} from '@/lib/connectors/rymessage/action-contract';
import type {
  CompanionActionFeedItemV2,
  CompanionActionFeedPageV2,
  CompanionActionMutationReceiptV2,
  CompanionActionMutationRequestV2,
} from '@/lib/connectors/rymessage/action-contract-v2';

export const RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS = 25_000;
export const RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS = 25_000;
export const RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS = 200_000;
export const RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE = 10_000;
export const RYMESSAGE_ACTION_DEFAULT_LEASE_SECONDS = 300;
export const RYMESSAGE_ACTION_MAX_LEASE_SECONDS = 1_800;
export const RYMESSAGE_ACTION_MAX_LEASE_ITEMS = 20;
export const RYMESSAGE_ACTION_MAX_ATTEMPTS = 8;
export const RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS = 5_000;
export const RYMESSAGE_ACTION_MAX_OBSERVATIONS_PER_RECONCILE = 100;

export class RyMessageActionPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RyMessageActionPersistenceError';
  }
}

export function companionMutationFields(mutation: CompanionActionMutation): string[] {
  if (mutation.kind === 'action.user-edit') return Object.keys(mutation.patch);
  if (mutation.kind === 'action.lifecycle' || mutation.kind === 'action.correction') {
    return ['lifecycle'];
  }
  return [`materialization:${mutation.materializationId}`];
}

export function assertCompanionMutationRevisionFence(input: {
  action: PortableCompanionAction;
  baseRevision: number;
  expectedFieldRevisions: Readonly<Record<string, number>>;
  mutation: CompanionActionMutation;
}): void {
  if (input.baseRevision > input.action.revision) {
    throw new RyMessageActionPersistenceError(
      'FUTURE_BASE_REVISION',
      'Mutation base revision is newer than the canonical action',
    );
  }
  const conflicts: string[] = [];
  for (const field of companionMutationFields(input.mutation)) {
    const expected = input.expectedFieldRevisions[field];
    const current = input.action.fieldRevisions[field] ?? 0;
    if (!Number.isSafeInteger(expected) || (expected ?? -1) < 0) {
      throw new RyMessageActionPersistenceError(
        'FIELD_REVISION_REQUIRED',
        `Expected revision is required for field ${field}`,
      );
    }
    if (expected! > current) {
      throw new RyMessageActionPersistenceError(
        'FUTURE_FIELD_REVISION',
        `Expected revision for field ${field} is newer than canonical state`,
      );
    }
    if (expected! < current) conflicts.push(field);
  }
  if (conflicts.length > 0) {
    throw new RyMessageActionPersistenceError(
      'FIELD_REVISION_CONFLICT',
      `Conflicting fields: ${conflicts.join(', ')}`.slice(0, 300),
    );
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

export interface RyMessageActionV2FeedState {
  connectorId: string;
  feedId: string | null;
  cursor: string | null;
  recoveryGeneration: number;
  recoveryRequired: boolean;
  fullSyncGeneration: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface RyMessageActionV2Projection {
  connectorId: string;
  actionId: string;
  sourceId: string;
  revision: number;
  item: CompanionActionFeedItemV2 | null;
  tombstonedAt: string | null;
}

export interface RyMessageActionV2LeasedMutation {
  connectorId: string;
  operationId: string;
  actionId: string;
  request: CompanionActionMutationRequestV2;
  mutationDigest: string;
  attemptCount: number;
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
  recoveryRequired: boolean;
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
  listProjections(connectorId: string): Promise<RyMessageActionProjection[]>;
  enqueueMutation(command: RyMessageEnqueueMutationCommand): Promise<'queued' | 'duplicate'>;
  leaseMutations(input: {
    connectorId: string;
    now: string;
    limit?: number;
    leaseSeconds?: number;
  }): Promise<RyMessageMutationLease>;
  completeMutation(outcome: RyMessageMutationOutcome): Promise<void>;
  readStatus(connectorId: string): Promise<RyMessageActionStatus>;
  readV2FeedState(connectorId: string): Promise<RyMessageActionV2FeedState>;
  applyV2FeedPage(command: {
    connectorId: string;
    page: CompanionActionFeedPageV2;
    requestedCursor: string | null;
    receivedAt: string;
  }): Promise<{ applied: number; replayed: number }>;
  listV2Projections(connectorId: string): Promise<RyMessageActionV2Projection[]>;
  getV2Projection(
    connectorId: string,
    actionId: string,
  ): Promise<RyMessageActionV2Projection | null>;
  enqueueV2Mutation(input: {
    connectorId: string;
    request: CompanionActionMutationRequestV2;
    now: string;
  }): Promise<'queued' | 'duplicate'>;
  leaseV2Mutations(input: {
    connectorId: string;
    now: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<{
    leaseId: string;
    leaseExpiresAt: string;
    items: RyMessageActionV2LeasedMutation[];
  }>;
  settleV2Mutation(input: {
    connectorId: string;
    operationId: string;
    leaseId: string;
    now: string;
    receipt?: CompanionActionMutationReceiptV2;
    retryable?: boolean;
    errorCode?: string;
  }): Promise<boolean>;
  invalidateV2Recovery(input: {
    connectorId: string;
    reason: string;
    now: string;
  }): Promise<void>;
}
