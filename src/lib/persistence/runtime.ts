import { sqlite } from '@/db';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import {
  sqliteCorePersistenceRepositories,
} from '@/db/persistence/sqlite-core-repositories';
import { SqliteTransactionRunner } from '@/db/persistence/sqlite-transaction-runner';
import { SqliteIdeationWorkspaceRepository } from '@/lib/graph-workspace/sqlite-repository';

const sqliteTransactions = new SqliteTransactionRunner(sqlite);
let selectedCorePersistenceRepositories = sqliteCorePersistenceRepositories;
let corePersistenceRegistered = false;
let corePersistenceAccessed = false;

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

export const persistence = {
  ideationWorkspaces: new SqliteIdeationWorkspaceRepository(
    sqlite,
    sqliteTransactions,
  ),
} as const;
