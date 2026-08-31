import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createSqliteTriagePersistenceRepositories,
} from '@/db/persistence/sqlite-triage-repositories';
import {
  describeTriagePersistenceContract,
} from '../contracts/triage-persistence.contract';

describeTriagePersistenceContract('SQLite', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE triage_items (
      id TEXT PRIMARY KEY,
      source_platform TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      thumbnail_url TEXT,
      content_type TEXT NOT NULL DEFAULT 'link',
      captured_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      snoozed_until TEXT,
      ai_summary TEXT,
      ai_categories TEXT NOT NULL DEFAULT '[]',
      ai_suggested_actions TEXT NOT NULL DEFAULT '[]',
      ai_relevance_score INTEGER NOT NULL DEFAULT 0,
      ai_urgency TEXT NOT NULL DEFAULT 'evergreen',
      raw_metadata TEXT NOT NULL DEFAULT '{}',
      actions_taken TEXT NOT NULL DEFAULT '[]',
      source_order INTEGER
    );
    CREATE UNIQUE INDEX idx_triage_items_source
      ON triage_items(source_platform, source_id);
    CREATE INDEX idx_triage_items_canonical_url
      ON triage_items(canonical_url);

    CREATE TABLE triage_sync_state (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      last_cursor TEXT,
      last_synced_at TEXT,
      total_imported INTEGER NOT NULL DEFAULT 0,
      total_skipped INTEGER NOT NULL DEFAULT 0,
      last_run_imported INTEGER NOT NULL DEFAULT 0,
      last_run_skipped INTEGER NOT NULL DEFAULT 0,
      last_run_errors TEXT NOT NULL DEFAULT '[]',
      last_run_duration_ms INTEGER
    );

    CREATE TABLE connector_configs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      credentials TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);

  return {
    repositories: createSqliteTriagePersistenceRepositories(database),
    seedGitHubConnector: (input: {
      id?: string;
      token?: string;
      enabled?: boolean;
      deleted?: boolean;
      createdAt?: string;
    }) => {
      database.prepare(`
        INSERT INTO connector_configs (
          id, type, enabled, credentials, created_at, deleted_at
        ) VALUES (?, 'github-issues', ?, ?, ?, ?)
      `).run(
        input.id ?? randomUUID(),
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.token ? { token: input.token } : {}),
        input.createdAt ?? '2026-08-29T10:00:00.000Z',
        input.deleted ? '2026-08-29T10:30:00.000Z' : null,
      );
    },
    close: () => {
      database.close();
    },
  };
});
