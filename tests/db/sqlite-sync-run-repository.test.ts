import Database from 'better-sqlite3';
import { SqliteSyncRunRepository } from '@/db/persistence/sqlite-sync-run-repository';
import { describeSyncRunRepositoryContract } from '../contracts/sync-run-repository.contract';

describeSyncRunRepositoryContract('SQLite', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE sync_log (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      success INTEGER NOT NULL,
      tasks_added INTEGER NOT NULL DEFAULT 0,
      tasks_updated INTEGER NOT NULL DEFAULT 0,
      tasks_removed INTEGER NOT NULL DEFAULT 0,
      tasks_pushed INTEGER NOT NULL DEFAULT 0,
      local_only_protected INTEGER NOT NULL DEFAULT 0,
      alerts_added INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      details TEXT NOT NULL DEFAULT '[]',
      synced_at TEXT NOT NULL,
      duration_ms INTEGER,
      job_id TEXT,
      identity_mode TEXT,
      identity_mode_revision INTEGER
    )
  `);
  return {
    repository: new SqliteSyncRunRepository(database),
    deleteConnectorRuns: (connectorId: string) => {
      database.prepare('DELETE FROM sync_log WHERE connector_id = ?').run(connectorId);
    },
    close: () => {
      database.close();
    },
  };
});
