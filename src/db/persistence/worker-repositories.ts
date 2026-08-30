import type { ConnectorRepository } from './core-repositories';
import type { ConnectorExecutionRepositories } from './connector-execution';

export interface SyncRunSummary {
  connectorId: string;
  success: boolean;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  notificationsAdded: number;
  errors: string[];
  syncedAt: string;
  durationMs: number | null;
}

export interface SyncRunRecord extends SyncRunSummary {
  id: string;
  tasksPushed: number;
  localOnlyProtected: number;
  details: readonly unknown[];
  jobId: string | null;
  identityMode: 'legacy' | 'stable' | null;
  identityModeRevision: number | null;
}

export interface SyncRunRepository {
  listLatestSuccessfulPulls(): Promise<SyncRunSummary[]>;
  append(record: SyncRunRecord): Promise<void>;
}

export interface WorkerPersistenceRepositories {
  connectors: ConnectorRepository;
  syncRuns: SyncRunRepository;
  execution: ConnectorExecutionRepositories;
}
