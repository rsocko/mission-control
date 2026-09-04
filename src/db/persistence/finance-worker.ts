import type { FinanceAssistantPersistence } from './finance-assistant';
import type { FinanceAttributionPersistence } from './finance-attribution';
import type { FinanceAttentionPersistence } from './finance-attention';
import type { FinanceConnectionRecoveryPersistence } from './finance-recovery';
import type { FinanceDatasetPersistence } from './finance-datasets';
import type { FinanceInsightPersistence } from './finance-insights';
import type { FinanceSnapshotPersistence } from './finance-snapshot';

export const FINANCE_IDENTITY_NAMESPACE_CREDENTIAL = 'identityNamespace';

export interface FinanceIdentityPersistence {
  /**
   * Atomically installs `candidate` only when the credential is absent, then
   * returns the accepted namespace. Existing invalid values fail closed.
   */
  ensureNamespace(input: {
    connectorId: string;
    candidate: string;
    updatedAt: string;
  }): Promise<string>;
}

export interface FinanceCorePersistence {
  readonly identity: FinanceIdentityPersistence;
  readonly snapshots: FinanceSnapshotPersistence;
  readonly datasets: FinanceDatasetPersistence;
  readonly attribution: FinanceAttributionPersistence;
  /**
   * Houston finance-assistant reads, approval-gated mutations, pending
   * approval lifecycle, and redacted approval audit. Composed here rather
   * than registered separately so a backend still supplies either every
   * finance member or none of them.
   */
  readonly assistant: FinanceAssistantPersistence;
}

/**
 * Finance worker composition. It is registered atomically: a backend either
 * supplies every migrated Layer 5A/5B member or none of the finance path is
 * reachable.
 */
export interface FinanceWorkerPersistence extends FinanceCorePersistence {
  readonly insights: FinanceInsightPersistence;
  readonly attention: FinanceAttentionPersistence;
  readonly recovery: FinanceConnectionRecoveryPersistence;
}
