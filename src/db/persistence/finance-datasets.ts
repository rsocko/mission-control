/**
 * Backend-neutral contracts for Monarch reference collections and rotating
 * snapshots. Publication methods own their transaction and publish state only
 * after all rows for the collection have been written.
 */

export const FINANCE_DATASETS = [
  'accounts',
  'category-groups',
  'categories',
  'tags',
  'recurring',
  'budgets',
] as const;

export type FinanceDataset = typeof FINANCE_DATASETS[number];
export type FinanceReferenceDataset = Exclude<FinanceDataset, 'recurring' | 'budgets'>;
export type FinanceFreshnessState = 'fresh' | 'stale' | 'partial' | 'unavailable';

export interface FinanceDatasetState {
  dataset: FinanceDataset;
  lastAttemptAt: string | null;
  lastAttemptOutcome: 'succeeded' | 'failed' | null;
  lastSuccessfulAt: string | null;
  sourceAsOf: string | null;
  freshUntil: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  currentGenerationId: string | null;
  previousGenerationId: string | null;
  schemaVersion: string;
  configVersion: number;
  publishedItemCount: number;
  sourceLimit: number;
  lastErrorCode: string | null;
}

export interface FinanceAccountDatasetItem {
  id: string;
  displayName: string;
  type: string;
  institution: string | null;
  mask: string | null;
  isActive: boolean;
}

export interface FinanceNamedDatasetItem {
  id: string;
  name: string;
  isActive: boolean;
}

export interface FinanceCategoryDatasetItem extends FinanceNamedDatasetItem {
  groupId: string | null;
  group: string | null;
  icon: string | null;
}

export type FinanceReferenceDatasetItem =
  | FinanceAccountDatasetItem
  | FinanceNamedDatasetItem
  | FinanceCategoryDatasetItem;

export interface FinanceRecurringDatasetItem {
  id: string;
  merchant: string;
  amount: number;
  frequency: string;
  nextExpectedDate: string | null;
  account: {
    id: string;
    displayName: string;
  } | null;
  category: {
    id: string;
    name: string;
  } | null;
}

export interface FinanceBudgetDatasetItem {
  category: {
    id: string;
    name: string;
  };
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number | null;
}

export interface FinanceDatasetAttemptCommand {
  connectorId: string;
  dataset: FinanceDataset;
  attemptAt: string;
  sourceLimit: number;
  schemaVersion: string;
  configVersion: number;
}

export interface FinanceDatasetPublicationMetadata
extends FinanceDatasetAttemptCommand {
  generationId: string;
  completedAt: string;
  sourceAsOf: string;
  freshUntil: string;
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface FinanceReferencePublicationCommand
extends FinanceDatasetPublicationMetadata {
  dataset: FinanceReferenceDataset;
  items: readonly FinanceReferenceDatasetItem[];
}

export interface FinanceRecurringPublicationCommand
extends FinanceDatasetPublicationMetadata {
  dataset: 'recurring';
  items: readonly FinanceRecurringDatasetItem[];
}

export interface FinanceBudgetPublicationCommand
extends FinanceDatasetPublicationMetadata {
  dataset: 'budgets';
  periodStart: string;
  periodEnd: string;
  items: readonly FinanceBudgetDatasetItem[];
}

export interface FinanceDatasetPublishResult {
  added: number;
  updated: number;
  removed: number;
  count: number;
}

export interface FinanceDatasetFailureCommand extends FinanceDatasetAttemptCommand {
  failedAt: string;
  errorCode: string;
}

export class FinanceDatasetFenceError extends Error {
  readonly code = 'finance_dataset_attempt_stale';

  constructor() {
    super('Finance dataset attempt is no longer current');
    this.name = 'FinanceDatasetFenceError';
  }
}

export interface FinanceDatasetPersistence {
  listState(connectorId: string): Promise<FinanceDatasetState[]>;
  recordAttempt(command: FinanceDatasetAttemptCommand): Promise<void>;
  publishReference(
    command: FinanceReferencePublicationCommand,
  ): Promise<FinanceDatasetPublishResult>;
  publishRecurring(
    command: FinanceRecurringPublicationCommand,
  ): Promise<FinanceDatasetPublishResult>;
  publishBudgets(
    command: FinanceBudgetPublicationCommand,
  ): Promise<FinanceDatasetPublishResult>;
  /**
   * Records a failure only when its attempt is still current. This prevents a
   * delayed request from replacing the outcome of a newer publication.
   */
  recordFailure(command: FinanceDatasetFailureCommand): Promise<{ recorded: boolean }>;
}
