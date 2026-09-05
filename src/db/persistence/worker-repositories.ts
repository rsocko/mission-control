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
import type { EventDeliveryRepositories } from './event-outbox';
import type { NotificationEnrichmentRepository } from './notification-enrichment';
import type {
  NotificationEntityLinkingRepository,
} from './notification-entity-linking';
import type { ExternalAgentControlPersistence } from './external-agent-control';
import type { AnalyticsPersistence } from './analytics';
import type { WebhookIntegrationsPersistence } from './webhook-integrations';
import type { IdeationWorkspaceRepository } from '@/lib/graph-workspace/repository';

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
   * Layer 2: the durable outbound-event outbox (subscription selection plus
   * enqueue/claim/finalize persistence) that replaced fire-and-forget webhook
   * emission.
   */
  eventDelivery: EventDeliveryRepositories;
  notificationEntityLinking: NotificationEntityLinkingRepository;
  notificationEnrichment: NotificationEnrichmentRepository;
  externalAgentControl: ExternalAgentControlPersistence;
  /**
   * Layer 5A: the atomic core finance worker projection (identity, transaction
   * snapshots, reference datasets, and automated attribution).
   */
  finance: FinanceWorkerPersistence;
  /**
   * Layer 16: user-authored Ideation workspace documents and their bounded
   * revision history. Published as its own top-level slot (rather than nested,
   * as L15 nested `projectAutomation.hierarchy`) because `graph_workspaces` and
   * `graph_workspace_versions` share no rows and no serialization namespace
   * with any other worker surface.
   */
  ideationWorkspaces: IdeationWorkspaceRepository;
  /**
   * Layer 17: the read-only derived-analytics surfaces (dashboard/reset KPIs,
   * the `/insights` query layer, cumulative flow, and the tag/word insight
   * services). Published as its own top-level slot because these read models
   * share no rows and no serialization namespace with any other worker
   * surface, and grouped into one slot because they are registered atomically:
   * a backend supports every analytics surface or none.
   */
  analytics: AnalyticsPersistence;
  /**
   * Layer 20: the webhook configuration/delivery/log surface — inbound webhook
   * CRUD plus their replay/log tables, outbound webhook subscriptions, the n8n
   * integration configuration, and the task/notification ingestion the n8n,
   * RyMessage, and per-connector webhook receivers share. Published as its own
   * top-level slot because those tables share no rows and no serialization
   * namespace with any other worker surface, and grouped into one slot because
   * a backend either supports the whole webhook contract or none of it.
   */
  webhookIntegrations: WebhookIntegrationsPersistence;
}
