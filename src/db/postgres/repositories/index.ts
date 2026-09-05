import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import type { GitHubWorkerRepositories } from '@/db/persistence/github-worker';
import type {
  NonFinanceConnectorStateRepositories,
} from '@/db/persistence/work-todo';
import type { PostgresDatabase } from '../runtime';
import { PostgresConnectorRepository } from './connector-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { PostgresProjectRepository } from './project-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { PostgresHoustonMemoryRepository } from './houston-memory-repository';
import { PostgresSyncRunRepository } from './sync-run-repository';
import { PostgresTaskRepository } from './task-repository';
import { createPostgresIdeationWorkspaceRepository } from './ideation-workspace-repository';
import { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';
import { createPostgresGitHubIdentityRepositories } from './github-identity-repositories';
import { createPostgresGitHubIdentityOperatorRepositories } from './github-identity-operator-repositories';
import { createPostgresGitHubDependencyRepositories } from './github-dependency-repositories';
import { createPostgresGitHubHierarchyRepositories } from './github-hierarchy-repositories';
import { createPostgresGitHubProjectRepositories } from './github-project-repositories';
import { createPostgresGitHubRecoveryRepositories } from './github-recovery-repositories';
import { createPostgresWorkTodoRepositories } from './work-todo-repositories';
import { createPostgresFinanceWorkerPersistence } from './finance-worker-repositories';
import { createPostgresFinanceConnectionRecoveryPersistence } from './finance-recovery-repository';
import { createPostgresFinanceOperatorPersistence } from './finance-operator-repository';
import { createPostgresFinanceInsightPersistence } from './finance-insights-repositories';
import {
  createPostgresFinanceAttentionRepairPersistence,
  createPostgresFinanceAttentionRoutingPersistence,
} from './finance-attention-repositories';
import { createPostgresFinanceInsightNotificationLifecyclePersistence } from './finance-insight-notification-lifecycle-repositories';
import { createPostgresNotificationDeliveryRepository } from './notification-delivery-repository';
import { createPostgresTaskReminderRepository } from './task-reminder-repository';
import { createPostgresTriagePersistenceRepositories } from './triage-repositories';
import { createPostgresPlanningSignalRepository } from './planning-signal-repository';
import { createPostgresProjectAutomationRepository } from './project-automation-repository';
import { createPostgresEventDeliveryRepositories } from './event-outbox-repository';
import { createPostgresNotificationEnrichmentRepository } from './notification-enrichment-repository';
import {
  createPostgresNotificationEntityLinkingRepository,
} from './notification-entity-linking-repository';
import { createPostgresExternalAgentControlRepository } from './external-agent-control-repository';
import { createPostgresAnalyticsPersistence } from './analytics-repositories';
import { createPostgresFinanceWebPersistence } from './finance-web-repository';
import type { Pool } from 'pg';

export { PostgresConnectorRepository } from './connector-repository';
export { PostgresNotificationRepository } from './notification-repository';
export { PostgresProjectRepository } from './project-repository';
export { PostgresSettingsRepository } from './settings-repository';
export { PostgresHoustonMemoryRepository } from './houston-memory-repository';
export { PostgresSyncRunRepository } from './sync-run-repository';
export { PostgresTaskRepository } from './task-repository';
export { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';
export { createPostgresGitHubIdentityRepositories } from './github-identity-repositories';
export { createPostgresGitHubIdentityOperatorRepositories } from './github-identity-operator-repositories';
export { createPostgresGitHubDependencyRepositories } from './github-dependency-repositories';
export { createPostgresGitHubHierarchyRepositories } from './github-hierarchy-repositories';
export { createPostgresGitHubProjectRepositories } from './github-project-repositories';
export { createPostgresGitHubRecoveryRepositories } from './github-recovery-repositories';
export { createPostgresWorkTodoRepositories } from './work-todo-repositories';
export { createPostgresFinanceWorkerPersistence } from './finance-worker-repositories';
export { createPostgresFinanceConnectionRecoveryPersistence } from './finance-recovery-repository';
export { createPostgresFinanceOperatorPersistence } from './finance-operator-repository';
export { createPostgresFinanceInsightPersistence } from './finance-insights-repositories';
export {
  createPostgresFinanceAttentionRepairPersistence,
  createPostgresFinanceAttentionRoutingPersistence,
} from './finance-attention-repositories';
export {
  createPostgresFinanceInsightNotificationLifecyclePersistence,
} from './finance-insight-notification-lifecycle-repositories';
export { createPostgresNotificationDeliveryRepository } from './notification-delivery-repository';
export { createPostgresTaskReminderRepository } from './task-reminder-repository';
export { createPostgresTriagePersistenceRepositories } from './triage-repositories';
export { createPostgresPlanningSignalRepository } from './planning-signal-repository';
export { createPostgresProjectAutomationRepository } from './project-automation-repository';
export {
  createPostgresEventDeliveryRepositories,
  enqueuePostgresEventOutbox,
} from './event-outbox-repository';
export {
  createPostgresNotificationEnrichmentRepository,
} from './notification-enrichment-repository';
export {
  createPostgresNotificationEntityLinkingRepository,
} from './notification-entity-linking-repository';
export { createPostgresExternalAgentControlRepository } from './external-agent-control-repository';
export { createPostgresAnalyticsPersistence } from './analytics-repositories';
export { createPostgresFinanceWebPersistence } from './finance-web-repository';

/**
 * Builds the full set of PostgreSQL-backed `CorePersistenceRepositories`
 * (tasks, projects, connectors, notifications, settings) for a given
 * `PostgresDatabase` handle (typically `PostgresPersistenceBackend#context.db`
 * from `@/db/postgres/runtime`).
 */
export function createPostgresCoreRepositories(
  db: PostgresDatabase,
): CorePersistenceRepositories {
  return {
    tasks: new PostgresTaskRepository(db),
    projects: new PostgresProjectRepository(db),
    connectors: new PostgresConnectorRepository(db),
    notifications: new PostgresNotificationRepository(db),
    settings: new PostgresSettingsRepository(db),
    houstonMemories: new PostgresHoustonMemoryRepository(db),
  };
}

/**
 * Builds the GitHub worker persistence composition atomically. Either every
 * member resolves (and `github-issues` normal queue execution is supported on
 * PostgreSQL) or construction fails and nothing is registered — there is no
 * partially-migrated GitHub surface.
 */
export function createPostgresGitHubWorkerRepositories(
  pool: Pool,
): GitHubWorkerRepositories {
  const identity = createPostgresGitHubIdentityRepositories(pool);
  return {
    identity: identity.identity,
    writeFence: identity.writeFence,
    transferIdentity: identity.transferIdentity,
    dependencies: createPostgresGitHubDependencyRepositories(pool),
    hierarchy: createPostgresGitHubHierarchyRepositories(pool),
    projects: createPostgresGitHubProjectRepositories(pool),
    recovery: createPostgresGitHubRecoveryRepositories(pool),
    operator: createPostgresGitHubIdentityOperatorRepositories(),
  };
}

/**
 * Builds the Layer 4 non-finance connector-state composition atomically.
 * Rymessage and OWL (`document-intelligence`) have no member here because they
 * own no worker persistence table; their durable state is generic connector
 * settings plus the Layer 2 list/task/tag/notification ports.
 */
export function createPostgresNonFinanceConnectorStateRepositories(
  pool: Pool,
): NonFinanceConnectorStateRepositories {
  return {
    workTodo: createPostgresWorkTodoRepositories(pool),
  };
}

/**
 * Registers the whole worker composition in one value. Layer 5A finance is
 * present here even though normal PostgreSQL finance execution remains
 * intentionally rejected until the later finance layers are portable.
 */
export function createPostgresWorkerPersistenceRepositories(
  db: PostgresDatabase,
  pool: Pool,
  core: CorePersistenceRepositories,
): WorkerPersistenceRepositories {
  const financeCore = createPostgresFinanceWorkerPersistence(pool);
  return {
    connectors: core.connectors,
    syncRuns: new PostgresSyncRunRepository(db),
    execution: createPostgresConnectorExecutionRepositories(pool),
    github: createPostgresGitHubWorkerRepositories(pool),
    connectorState: createPostgresNonFinanceConnectorStateRepositories(pool),
    notificationDelivery: createPostgresNotificationDeliveryRepository(pool),
    reminders: createPostgresTaskReminderRepository(pool),
    triage: createPostgresTriagePersistenceRepositories(db),
    planningSignals: createPostgresPlanningSignalRepository(pool),
    projectAutomation: createPostgresProjectAutomationRepository(pool),
    eventDelivery: createPostgresEventDeliveryRepositories(pool),
    notificationEntityLinking: createPostgresNotificationEntityLinkingRepository(pool),
    notificationEnrichment: createPostgresNotificationEnrichmentRepository(pool),
    externalAgentControl: createPostgresExternalAgentControlRepository(pool),
    finance: {
      ...financeCore,
      insights: {
        ...createPostgresFinanceInsightPersistence(pool),
        notifications: createPostgresFinanceInsightNotificationLifecyclePersistence(pool),
      },
      attention: {
        routing: createPostgresFinanceAttentionRoutingPersistence(pool),
        repair: createPostgresFinanceAttentionRepairPersistence(pool),
      },
      recovery: createPostgresFinanceConnectionRecoveryPersistence(pool),
      operator: createPostgresFinanceOperatorPersistence(pool),
      web: createPostgresFinanceWebPersistence(pool),
    },
    ideationWorkspaces: createPostgresIdeationWorkspaceRepository(pool),
    analytics: createPostgresAnalyticsPersistence(pool),
  };
}
