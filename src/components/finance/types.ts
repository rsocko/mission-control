export interface FinanceSubject {
  kidId: string;
  name: string;
  policyStatus: 'current';
  limitStatus: 'unavailable';
}

export interface FinanceOverviewData {
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
  subjects: FinanceSubject[];
  digest: string[];
  links: {
    monarch: Record<
      'transactions' | 'budgets' | 'recurring' | 'reports' | 'accounts' | 'investments' | 'goals' | 'forecasts',
      string
    >;
    tyrionConfiguration: string;
  };
}

export interface FinanceHealth {
  overall: string;
  bridge: {
    reachable: boolean;
    authenticated: boolean;
    authState: string;
    mode: string | null;
  };
  sync: {
    status: string;
    lastSuccessfulSyncAt: string | null;
    freshnessMinutes: number | null;
    stale: boolean;
    lastErrorCode: string | null;
    activeJob: {
      status: string;
      retrying: boolean;
      attempt: number;
      maxAttempts: number;
    } | null;
  };
  attribution: {
    status: string;
    lastSuccessfulAt: string | null;
    policyVersion: number | null;
    engineVersion: string | null;
  };
  projection: {
    aggregate: 'fresh' | 'stale' | 'partial' | 'unavailable';
    datasets: Array<{
      dataset: 'accounts' | 'category-groups' | 'categories' | 'tags' | 'recurring' | 'budgets';
      provenance: 'monarch-bridge';
      state: 'fresh' | 'stale' | 'partial' | 'unavailable';
      itemCount: number;
      sourceLimit: number;
      coverage: { start: string; end: string } | null;
      lastAttemptAt: string | null;
      lastSuccessfulAt: string | null;
      sourceAsOf: string | null;
      freshUntil: string | null;
      generationId: string | null;
      schemaVersion: string;
      configVersion: number;
      warning: string | null;
    }>;
  };
  recovery: import('@/lib/connectors/monarch-money/recovery-contract')
    .FinanceConnectionRecoveryView | null;
}

export type FinanceInsightPresentationState =
  | 'connectorUnavailable'
  | 'connected'
  | 'degraded'
  | 'partial'
  | 'stale'
  | 'unavailable';

export interface FinanceInsightsPresentationData {
  contractVersion: '1.0';
  state: FinanceInsightPresentationState;
  transport: 'live' | 'cache' | 'metadata-only' | 'none';
  authoritative: boolean;
  sourceAsOf: string | null;
  collapsedCount: number;
  items: InsightOccurrenceSummaryV1[];
}

export interface FinanceInsightDetailData {
  contractVersion: '1.0';
  detail: InsightOccurrenceDetailV1;
  externalLinks: Array<{
    system: 'monarch' | 'owl';
    label: string;
    url: string;
  }>;
}

export interface AttributionSubject {
  kidId: string;
  name: string;
}

export interface AttributionException {
  id: string;
  status: string;
  reasonCode: string;
  retryable: boolean;
  reviewState: string;
  policyVersion: number | null;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  updatedAt: string;
  date: string;
  merchantName: string | null;
  assignedKidId: string | null;
  attributionStatus: string;
  confidence: string | null;
  method: string | null;
  explanation: string | null;
  reasons: string[];
  decisionSource: string | null;
  evaluatedAt: string | null;
}
import type {
  InsightOccurrenceDetailV1,
  InsightOccurrenceSummaryV1,
} from '@/lib/finance-insights/contract';
