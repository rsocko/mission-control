import { sqlite } from '@/db';
import { SqliteTransactionRunner } from '@/db/persistence/sqlite-transaction-runner';
import { SqliteIdeationWorkspaceRepository } from '@/lib/graph-workspace/sqlite-repository';

const sqliteTransactions = new SqliteTransactionRunner(sqlite);

export const persistence = {
  ideationWorkspaces: new SqliteIdeationWorkspaceRepository(
    sqlite,
    sqliteTransactions,
  ),
} as const;
