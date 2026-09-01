import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import type { CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import { registerTriagePersistenceRepositories } from '@/lib/triage/persistence';

let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories | null = null;
let sqliteWorkerPersistencePromise: Promise<WorkerPersistenceRepositories> | null = null;
let workerPersistenceRegistered = false;
let workerPersistenceAccessed = false;

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (
    selectedWorkerPersistenceRepositories !== repositories
    && (workerPersistenceRegistered || workerPersistenceAccessed)
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  registerTriagePersistenceRepositories(repositories.triage);
  selectedWorkerPersistenceRepositories = repositories;
  workerPersistenceRegistered = true;
}

async function createSqliteWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  const [
    { default: db, sqlite },
    { sqliteCorePersistenceRepositories },
    { SqliteSyncRunRepository },
    { createSqliteConnectorExecutionRepositories },
    { createSqliteGitHubIdentityRepositories },
    { createSqliteGitHubDependencyRepositories },
    { createSqliteGitHubHierarchyRepositories },
    { createSqliteGitHubProjectRepositories },
    { createSqliteGitHubRecoveryRepositories },
    { createSqliteWorkTodoRepositories },
    { createSqliteNotificationDeliveryRepository },
    { createSqliteTaskReminderRepository },
    { createSqliteTriagePersistenceRepositories },
    { createSqliteFinanceWorkerPersistence },
    { createSqliteFinanceConnectionRecoveryPersistence },
    { createSqliteFinanceInsightPersistence },
    {
      createSqliteFinanceAttentionRepairPersistence,
      createSqliteFinanceAttentionRoutingPersistence,
    },
    { createSqliteFinanceInsightNotificationLifecyclePersistence },
    { loadFinanceInsightProjectionFacts },
    { financeInsightDigestV1 },
    { MONARCH_BRIDGE_CONTRACT_VERSION },
  ] = await Promise.all([
    import('@/db'),
    import('@/db/persistence/sqlite-core-repositories'),
    import('@/db/persistence/sqlite-sync-run-repository'),
    import('@/db/persistence/sqlite-connector-execution-repositories'),
    import('@/db/persistence/sqlite-github-identity-repositories'),
    import('@/db/persistence/sqlite-github-dependency-repositories'),
    import('@/db/persistence/sqlite-github-hierarchy-repositories'),
    import('@/db/persistence/sqlite-github-project-repositories'),
    import('@/db/persistence/sqlite-github-recovery-repositories'),
    import('@/db/persistence/sqlite-work-todo-repositories'),
    import('@/db/persistence/sqlite-notification-delivery-repository'),
    import('@/db/persistence/sqlite-task-reminder-repository'),
    import('@/db/persistence/sqlite-triage-repositories'),
    import('@/db/persistence/sqlite-finance-worker-repositories'),
    import('@/db/persistence/sqlite-finance-recovery-repository'),
    import('@/db/persistence/sqlite-finance-insights-repositories'),
    import('@/db/persistence/sqlite-finance-attention-repositories'),
    import('@/db/persistence/sqlite-finance-insight-notification-lifecycle'),
    import('@/db/persistence/sqlite-finance-insight-projection-facts'),
    import('@/lib/finance-insights/canonical'),
    import('@/lib/connectors/monarch-money/constants'),
  ]);
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
  };
  return {
    connectors: sqliteCorePersistenceRepositories.connectors,
    syncRuns: new SqliteSyncRunRepository(sqlite),
    execution: createSqliteConnectorExecutionRepositories(sqlite, db),
    github: {
      identity: githubIdentity.identity,
      writeFence: githubIdentity.writeFence,
      dependencies: createSqliteGitHubDependencyRepositories(sqlite, db),
      hierarchy: createSqliteGitHubHierarchyRepositories(sqlite, db),
      projects: createSqliteGitHubProjectRepositories(sqlite, db),
      recovery: createSqliteGitHubRecoveryRepositories(sqlite, db),
    },
    connectorState: {
      workTodo: createSqliteWorkTodoRepositories(sqlite, db),
    },
    notificationDelivery: createSqliteNotificationDeliveryRepository(sqlite),
    reminders: createSqliteTaskReminderRepository(sqlite),
    triage: createSqliteTriagePersistenceRepositories(sqlite),
    finance,
  };
}

export async function getWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  workerPersistenceAccessed = true;
  if (selectedWorkerPersistenceRepositories) {
    return selectedWorkerPersistenceRepositories;
  }
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'PostgreSQL worker repositories must be registered before worker persistence is accessed',
    );
  }
  sqliteWorkerPersistencePromise ??= createSqliteWorkerPersistenceRepositories()
    .then((repositories) => {
      registerTriagePersistenceRepositories(repositories.triage);
      selectedWorkerPersistenceRepositories = repositories;
      return repositories;
    });
  return sqliteWorkerPersistencePromise;
}
