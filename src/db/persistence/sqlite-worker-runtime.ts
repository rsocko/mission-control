import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import type { CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { financeInsightDigestV1 } from '@/lib/finance-insights/canonical';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import {
  assertCanRegisterSqliteGitHubRepointBackupVerifier,
  clearSqliteGitHubRepointBackupVerifier,
  registerSqliteGitHubRepointBackupVerifier,
} from '@/lib/connectors/github-issues/backup-verifier';
import {
  assertCanRegisterFinanceTransactionQuery,
  clearFinanceTransactionQuery,
  registerFinanceTransactionQuery,
} from '@/lib/connectors/monarch-money/transaction-query';
import {
  assertCanRegisterSqliteLegacySearchIndexingService,
  clearSqliteLegacySearchIndexingService,
  registerSqliteLegacySearchIndexingService,
} from './sqlite-legacy-search-indexing';
import {
  assertCanRegisterSqliteAIEnrichmentService,
  clearSqliteAIEnrichmentService,
  registerSqliteAIEnrichmentService,
} from '@/lib/notifications/enrichment/ai-enrichment';
import {
  assertCanRegisterKeywordSearchRepository,
  clearKeywordSearchRepository,
  registerKeywordSearchRepository,
} from '@/lib/search/keyword-runtime';
import { sqliteKeywordSearchRepository } from '@/lib/search/sqlite-fts-repository';
import { SqliteIdeationWorkspaceRepository } from '@/lib/graph-workspace/sqlite-repository';
import type { WorkerPersistenceRepositories } from './worker-repositories';
import type { CorePersistenceRepositories } from './core-repositories';
import { SqliteSyncRunRepository } from './sqlite-sync-run-repository';
import { createSqliteConnectorExecutionRepositories } from './sqlite-connector-execution-repositories';
import { createSqliteGitHubIdentityRepositories } from './sqlite-github-identity-repositories';
import { createSqliteGitHubIdentityOperatorRepositories } from './sqlite-github-identity-operator-repositories';
import { createSqliteGitHubDependencyRepositories } from './sqlite-github-dependency-repositories';
import { createSqliteGitHubHierarchyRepositories } from './sqlite-github-hierarchy-repositories';
import { createSqliteGitHubProjectRepositories } from './sqlite-github-project-repositories';
import { createSqliteGitHubRecoveryRepositories } from './sqlite-github-recovery-repositories';
import { createSqliteWorkTodoRepositories } from './sqlite-work-todo-repositories';
import { createSqliteNotificationDeliveryRepository } from './sqlite-notification-delivery-repository';
import { createSqliteTaskReminderRepository } from './sqlite-task-reminder-repository';
import { createSqliteTriagePersistenceRepositories } from './sqlite-triage-repositories';
import { createSqlitePlanningSignalRepository } from './sqlite-planning-signal-repository';
import { createSqliteProjectAutomationRepository } from './sqlite-project-automation-repository';
import { createSqliteEventDeliveryRepositories } from './sqlite-event-outbox-repository';
import { createSqliteNotificationEnrichmentRepository } from './sqlite-notification-enrichment-repository';
import { createSqliteNotificationEntityLinkingRepository } from './sqlite-notification-entity-linking-repository';
import { createSqliteFinanceWorkerPersistence } from './sqlite-finance-worker-repositories';
import { createSqliteFinanceOperatorPersistence } from './sqlite-finance-operator-repository';
import { createSqliteFinanceConnectionRecoveryPersistence } from './sqlite-finance-recovery-repository';
import { createSqliteFinanceInsightPersistence } from './sqlite-finance-insights-repositories';
import {
  createSqliteFinanceAttentionRepairPersistence,
  createSqliteFinanceAttentionRoutingPersistence,
} from './sqlite-finance-attention-repositories';
import {
  createSqliteFinanceInsightNotificationLifecyclePersistence,
} from './sqlite-finance-insight-notification-lifecycle';
import { loadFinanceInsightProjectionFacts } from './sqlite-finance-insight-projection-facts';
import { sqliteFinanceTransactionQuery } from './sqlite-finance-transaction-query';
import { createSqliteExternalAgentControlRepository } from './sqlite-external-agent-control-repository';
import { createSqliteAnalyticsPersistence } from './sqlite-analytics-repositories';

let repositories: WorkerPersistenceRepositories | null = null;

export function assertCanRegisterSqliteWorkerRuntimeServices(): void {
  assertCanRegisterSqliteGitHubRepointBackupVerifier();
  assertCanRegisterFinanceTransactionQuery(sqliteFinanceTransactionQuery);
  assertCanRegisterSqliteLegacySearchIndexingService();
  assertCanRegisterSqliteAIEnrichmentService();
  assertCanRegisterKeywordSearchRepository(sqliteKeywordSearchRepository);
}

export function registerSqliteWorkerRuntimeServices(): void {
  assertCanRegisterSqliteWorkerRuntimeServices();
  registerSqliteGitHubRepointBackupVerifier();
  registerFinanceTransactionQuery(sqliteFinanceTransactionQuery);
  registerSqliteLegacySearchIndexingService();
  registerSqliteAIEnrichmentService();
  registerKeywordSearchRepository(sqliteKeywordSearchRepository);
}

export function clearSqliteWorkerRuntimeServices(): void {
  clearKeywordSearchRepository(sqliteKeywordSearchRepository);
  clearSqliteAIEnrichmentService();
  clearSqliteLegacySearchIndexingService();
  clearFinanceTransactionQuery(sqliteFinanceTransactionQuery);
  clearSqliteGitHubRepointBackupVerifier();
}

export function createSqliteWorkerPersistenceRepositories(
  sqlite: Database.Database,
  db: BetterSQLite3Database<typeof schema>,
  coreRepositories: CorePersistenceRepositories,
): WorkerPersistenceRepositories {
  if (repositories) return repositories;

  const githubIdentity = createSqliteGitHubIdentityRepositories(sqlite, db);
  const financeCore = createSqliteFinanceWorkerPersistence(sqlite, {
    projectionProofs: {
      snapshot: ({ connectorId, projectionStartDate, windowStart, windowEnd }) => {
        const facts = loadFinanceInsightProjectionFacts(
          sqlite,
          connectorId,
          projectionStartDate,
          'transaction',
        ).transaction;
        const dates = facts.map((fact) => fact.occurredOn).sort();
        return {
          itemCount: facts.length,
          contentDigest: financeInsightDigestV1(facts as unknown as CanonicalJsonValue),
          projectionStartDate,
          coverageStart: dates[0] ?? windowStart,
          coverageEnd: dates.at(-1) ?? windowEnd,
          bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
        };
      },
      dataset: (connectorId, dataset) => {
        const kind = dataset === 'accounts'
          ? 'account'
          : dataset === 'categories'
            ? 'category'
            : dataset === 'tags'
              ? 'tag'
              : dataset === 'recurring'
                ? 'recurring'
                : null;
        if (!kind) return null;
        const facts = loadFinanceInsightProjectionFacts(
          sqlite,
          connectorId,
          '0000-01-01',
          kind,
        )[kind];
        return {
          itemCount: facts.length,
          contentDigest: financeInsightDigestV1(facts as unknown as CanonicalJsonValue),
          bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
        };
      },
    },
  });
  const finance = {
    ...financeCore,
    insights: {
      ...createSqliteFinanceInsightPersistence(sqlite),
      notifications: createSqliteFinanceInsightNotificationLifecyclePersistence({ sqlite, db }),
    },
    attention: {
      routing: createSqliteFinanceAttentionRoutingPersistence({ sqlite, db }),
      repair: createSqliteFinanceAttentionRepairPersistence(sqlite),
    },
    recovery: createSqliteFinanceConnectionRecoveryPersistence(sqlite, db),
    operator: createSqliteFinanceOperatorPersistence({ sqlite, db }),
  };
  repositories = {
    connectors: coreRepositories.connectors,
    syncRuns: new SqliteSyncRunRepository(sqlite),
    execution: createSqliteConnectorExecutionRepositories(sqlite, db),
    github: {
      identity: githubIdentity.identity,
      writeFence: githubIdentity.writeFence,
      transferIdentity: githubIdentity.transferIdentity,
      dependencies: createSqliteGitHubDependencyRepositories(sqlite, db),
      hierarchy: createSqliteGitHubHierarchyRepositories(sqlite, db),
      projects: createSqliteGitHubProjectRepositories(sqlite, db),
      recovery: createSqliteGitHubRecoveryRepositories(sqlite, db),
      operator: createSqliteGitHubIdentityOperatorRepositories(sqlite, db),
    },
    connectorState: {
      workTodo: createSqliteWorkTodoRepositories(sqlite, db),
    },
    notificationDelivery: createSqliteNotificationDeliveryRepository(sqlite),
    reminders: createSqliteTaskReminderRepository(sqlite),
    triage: createSqliteTriagePersistenceRepositories(sqlite),
    planningSignals: createSqlitePlanningSignalRepository(sqlite),
    projectAutomation: createSqliteProjectAutomationRepository(sqlite),
    eventDelivery: createSqliteEventDeliveryRepositories(sqlite),
    notificationEntityLinking: createSqliteNotificationEntityLinkingRepository(sqlite),
    notificationEnrichment: createSqliteNotificationEnrichmentRepository(sqlite),
    externalAgentControl: createSqliteExternalAgentControlRepository(sqlite),
    finance,
    ideationWorkspaces: new SqliteIdeationWorkspaceRepository(sqlite),
    analytics: createSqliteAnalyticsPersistence(db),
  };
  return repositories;
}
