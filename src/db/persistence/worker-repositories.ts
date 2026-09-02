import type { ConnectorRepository } from './core-repositories';
import type { ConnectorExecutionRepositories } from './connector-execution';
import type { GitHubWorkerRepositories } from './github-worker';
import type { NonFinanceConnectorStateRepositories } from './work-todo';
import type { FinanceWorkerPersistence } from './finance-worker';
import type { NotificationDeliveryRepository } from './notification-delivery';
import type { TaskReminderRepository } from './task-reminders';
import type { TriagePersistenceRepositories } from './triage-repositories';
import type { PlanningSignalRepository } from './planning-signals';
import type { ProjectAutomationRepository } from './project-automation';

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
  github: GitHubWorkerRepositories;
  /**
   * Layer 4: non-finance connector-owned state (currently the Work To Do
   * bridge). Registered atomically with the rest of the composition so a
   * backend either supports every migrated connector surface or none.
   */
  connectorState: NonFinanceConnectorStateRepositories;
  notificationDelivery: NotificationDeliveryRepository;
  reminders: TaskReminderRepository;
  triage: TriagePersistenceRepositories;
  planningSignals: PlanningSignalRepository;
  projectAutomation: ProjectAutomationRepository;
  /**
   * Layer 5A: the atomic core finance worker projection (identity, transaction
   * snapshots, reference datasets, and automated attribution).
   */
  finance: FinanceWorkerPersistence;
}
