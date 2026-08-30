import { sqlite } from '@/db';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  sqliteCorePersistenceRepositories,
} from '@/db/persistence/sqlite-core-repositories';
import { SqliteTransactionRunner } from '@/db/persistence/sqlite-transaction-runner';
import { SqliteSyncRunRepository } from '@/db/persistence/sqlite-sync-run-repository';
import { SqliteIdeationWorkspaceRepository } from '@/lib/graph-workspace/sqlite-repository';

const sqliteTransactions = new SqliteTransactionRunner(sqlite);
let selectedCorePersistenceRepositories = sqliteCorePersistenceRepositories;
let corePersistenceRegistered = false;
let corePersistenceAccessed = false;
let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories = {
  connectors: sqliteCorePersistenceRepositories.connectors,
  syncRuns: new SqliteSyncRunRepository(sqlite),
};
let workerPersistenceRegistered = false;
let workerPersistenceAccessed = false;

export function registerCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  if (
    selectedCorePersistenceRepositories !== repositories
    && (corePersistenceRegistered || corePersistenceAccessed)
  ) {
    throw new Error('Core persistence repositories are already selected');
  }
  selectedCorePersistenceRepositories = repositories;
  corePersistenceRegistered = true;
}

export function getCorePersistenceRepositories(): CorePersistenceRepositories {
  corePersistenceAccessed = true;
  return selectedCorePersistenceRepositories;
}

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (
    selectedWorkerPersistenceRepositories !== repositories
    && (workerPersistenceRegistered || workerPersistenceAccessed)
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  selectedWorkerPersistenceRepositories = repositories;
  workerPersistenceRegistered = true;
}

export function getWorkerPersistenceRepositories(): WorkerPersistenceRepositories {
  workerPersistenceAccessed = true;
  return selectedWorkerPersistenceRepositories;
}

export const persistence = {
  ideationWorkspaces: new SqliteIdeationWorkspaceRepository(
    sqlite,
    sqliteTransactions,
  ),
} as const;
