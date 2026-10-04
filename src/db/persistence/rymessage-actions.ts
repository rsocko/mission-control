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

export class RyMessageActionPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RyMessageActionPersistenceError';
  }
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

export interface RyMessageActionPersistence {
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
