import type { NotificationRow } from './notification-web';

export interface FinanceWebKid {
  id: string;
  name: string;
  color: string;
  avatar: string | null;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
}

export interface FinanceWebKidSpending extends FinanceWebKid {
  currentMonthSpending: number;
}

export interface FinanceWebTransaction {
  id: string;
  connectorInstanceId: string;
  upstreamTransactionId: string;
  date: string;
  amount: number;
  merchantName: string | null;
  merchantLogoUrl: string | null;
  categoryId: string | null;
  originalCategory: string | null;
  confirmedCategory: string | null;
  accountId: string | null;
  accountName: string | null;
  cardLast4: string | null;
  assignedKidId: string | null;
  kidAssignmentMethod: string | null;
  manualDecisionAction: 'assign-kid' | 'parent-expense' | null;
  manualDecidedAt: string | null;
  attributionSourceRef: string | null;
  attributionContractVersion: string | null;
  attributionStatus: 'attributed' | 'unassigned' | 'pending' | 'unavailable';
  attributionConfidence: 'definite' | 'likely' | 'none' | null;
  attributionMethod:
    | 'manual'
    | 'account-rule'
    | 'merchant-rule'
    | 'historical-pattern'
    | 'unassigned'
    | 'unavailable'
    | null;
  attributionExplanation: string | null;
  attributionReasons: string[];
  attributionDecisionSource: 'manual' | 'automated' | 'fallback' | null;
  attributionPolicyVersion: number | null;
  attributionEngineVersion: string | null;
  attributionEvaluatedAt: string | null;
  attributionReviewState: 'not-required' | 'pending' | 'resolved';
  attributionProvenance: string | null;
  attributionLastErrorCode: string | null;
  attributionRetryable: boolean;
  attributionUpdatedAt: string | null;
  triageStatus: string;
  flagReason: string | null;
  isPending: boolean;
  isRecurring: boolean;
  notes: string | null;
  tags: unknown;
  tagReferences: string[];
  lifecycleStatus: 'active' | 'deleted';
  deletedAt: string | null;
  provenanceProvider: 'demo' | 'live' | null;
  provenanceFetchedAt: string | null;
  sourceFingerprint: string;
  sourceUrl: string | null;
  lastSeenGenerationId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  syncedAt: string;
}

export interface FinanceWebTransactionQuery {
  connectorId: string;
  startDate: string | null;
  endDate: string | null;
  kidId: string | null;
  category: string | null;
  triageStatus: string | null;
  limit: number;
}

export interface FinanceWebSummary {
  total: number;
  transactionCount: number;
  byCategory: Array<{
    category: string | null;
    total: number;
    count: number;
  }>;
  byKid: Array<{
    kidId: string;
    kidName: string;
    total: number;
    transactionCount: number;
  }>;
}

export interface FinanceWebOperationsData {
  connectors: Array<{ id: string; name: string }>;
  connector: { id: string; name: string };
  attention: {
    total: number;
    pendingExceptions: number;
    retryRequested: number;
    failedWritebacks: number;
    openAlerts: number;
  };
  alerts: Array<{
    title: string;
    summary: string | null;
    level: string;
    receivedAt: string;
  }>;
  subjects: Array<{
    kidId: string;
    name: string;
    policyStatus: 'current';
    limitStatus: 'unavailable';
  }>;
  digest: string[];
}

export interface FinanceCategoryExpectedVersion {
  sourceFingerprint: string;
  lastSeenAt: string;
  assignedKidId: string | null;
  confirmedCategory: string | null;
  manualDecidedAt: string | null;
  categoryName: string;
}

export interface FinanceCategoryClaimCommand {
  connectorId: string;
  transactionId: string;
  categoryId: string;
  idempotencyKey: string;
  now: string;
  staleBefore: string;
  expectedTransactionVersion?: FinanceCategoryExpectedVersion;
}

export type FinanceCategoryClaimResult =
  | { outcome: 'claimed'; upstreamTransactionId: string; claimToken: string }
  | { outcome: 'replayed' };

export class FinanceWebPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FinanceWebPersistenceError';
  }
}

export interface FinanceWebPersistence {
  listKidsWithSpending(connectorId: string, monthStart: string): Promise<FinanceWebKidSpending[]>;
  listTransactions(query: FinanceWebTransactionQuery): Promise<FinanceWebTransaction[]>;
  readSummary(input: {
    connectorId: string;
    startDate: string;
    endDate: string;
  }): Promise<FinanceWebSummary>;
  listNotifications(input: {
    type: string | null;
    level: string | null;
    inboxOnly: boolean;
    limit: number;
    now: string;
  }): Promise<NotificationRow[]>;
  dismissNotification(id: string, dismissedAt: string): Promise<void>;
  updateDemoCategory(input: {
    connectorId: string;
    transactionId: string;
    categoryId: string;
  }): Promise<boolean>;
  readOperationsOverview(
    requestedConnectorId?: string | null,
    now?: string,
  ): Promise<FinanceWebOperationsData | null>;
  claimCategoryUpdate(command: FinanceCategoryClaimCommand): Promise<FinanceCategoryClaimResult>;
  completeCategoryUpdate(input: {
    connectorId: string;
    transactionId: string;
    categoryId: string;
    idempotencyKey: string;
    claimToken: string;
    completedAt: string;
  }): Promise<boolean>;
  failCategoryUpdate(input: {
    connectorId: string;
    idempotencyKey: string;
    claimToken: string;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }): Promise<boolean>;
}
