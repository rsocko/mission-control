import type { FinanceAttributionPersistence } from './finance-attribution';
import type { FinanceDatasetPersistence } from './finance-datasets';
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

/**
 * Layer 5A worker composition. It is registered atomically: a backend either
 * supplies identity, snapshots, datasets, and automated attribution together,
 * or none of the finance sync path is reachable.
 */
export interface FinanceWorkerPersistence {
  readonly identity: FinanceIdentityPersistence;
  readonly snapshots: FinanceSnapshotPersistence;
  readonly datasets: FinanceDatasetPersistence;
  readonly attribution: FinanceAttributionPersistence;
}
