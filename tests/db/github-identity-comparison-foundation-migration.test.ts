import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub identity comparison foundation migration', () => {
  it('adds dark foundation tables without mutating Stage 1 rows', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE external_entities (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, host_key TEXT NOT NULL,
        entity_type TEXT NOT NULL, stable_id TEXT NOT NULL, identity_version INTEGER NOT NULL,
        next_locator_revision INTEGER NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE github_identity_migrations (
        connector_instance_id TEXT PRIMARY KEY, phase TEXT NOT NULL, task_cursor TEXT,
        source_list_cursor TEXT, batch_size INTEGER NOT NULL, started_at TEXT,
        updated_at TEXT NOT NULL, completed_at TEXT, last_error TEXT, counters TEXT NOT NULL
      );
      CREATE TABLE github_identity_backfill_items (
        connector_instance_id TEXT NOT NULL, binding_type TEXT NOT NULL, local_id TEXT NOT NULL,
        state TEXT NOT NULL, external_entity_id TEXT, attempt_count INTEGER NOT NULL,
        next_attempt_at TEXT, reason_code TEXT, observed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (connector_instance_id, binding_type, local_id)
      );
      CREATE TABLE github_identity_collisions (
        id TEXT PRIMARY KEY, connector_instance_id TEXT NOT NULL, category TEXT NOT NULL,
        fingerprint TEXT NOT NULL, binding_type TEXT NOT NULL, local_ids TEXT NOT NULL,
        external_entity_ids TEXT NOT NULL, legacy_identity_digest TEXT, state TEXT NOT NULL,
        resolution TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        resolved_at TEXT, resolved_by TEXT
      );
      CREATE TABLE sync_jobs (
        id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, full INTEGER NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        available_at TEXT NOT NULL, scheduled_for TEXT NOT NULL, lease_owner TEXT,
        lease_expires_at TEXT, cancel_requested_at TEXT, started_at TEXT, completed_at TEXT,
        result TEXT, error TEXT, duration_budget_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sync_log (
        id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, success INTEGER NOT NULL,
        tasks_added INTEGER NOT NULL, tasks_updated INTEGER NOT NULL, tasks_removed INTEGER NOT NULL,
        tasks_pushed INTEGER NOT NULL, local_only_protected INTEGER NOT NULL,
        alerts_added INTEGER NOT NULL, errors TEXT NOT NULL, details TEXT NOT NULL,
        synced_at TEXT NOT NULL, duration_ms INTEGER, job_id TEXT, trigger TEXT,
        scheduled_for TEXT, started_at TEXT, attempt INTEGER, max_attempts INTEGER
      );
      INSERT INTO connector_configs VALUES ('github-1', 'github-issues');
      INSERT INTO external_entities VALUES (
        'issue-1', 'github', 'github.com', 'issue', 'I_1', 1, 2,
        '2026-08-09T00:00:00Z', '2026-08-09T00:01:00Z'
      );
      INSERT INTO github_identity_migrations VALUES (
        'github-1', 'backfilling', 'task-cursor', 'list-cursor', 100,
        '2026-08-09T00:00:00Z', '2026-08-09T00:01:00Z', NULL, NULL,
        '{"eligible":1,"bound":1}'
      );
      INSERT INTO github_identity_backfill_items VALUES (
        'github-1', 'task', 'task-1', 'bound', 'issue-1', 1, NULL, NULL,
        '2026-08-09T00:00:00Z', '2026-08-09T00:01:00Z'
      );
      INSERT INTO github_identity_collisions VALUES (
        'collision-1', 'github-1', 'stable_legacy_disagree', 'fingerprint', 'task',
        '["task-1"]', '["issue-1"]', 'digest', 'resolved', '{"rationale":"test"}',
        '2026-08-09T00:00:00Z', '2026-08-09T00:01:00Z',
        '2026-08-09T00:01:00Z', 'operator'
      );
      INSERT INTO sync_jobs VALUES (
        'job-1', 'github-1', 0, 'api', 'queued', 0, 3,
        '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, 300000, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'
      );
      INSERT INTO sync_log VALUES (
        'log-1', 'github-1', 1, 0, 0, 0, 0, 0, 0, '[]', '[]',
        '2026-08-09T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL
      );
    `);
    const before = stageOneRows(sqlite);

    applyMigration(sqlite);

    expect(stageOneRows(sqlite)).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM github_identity_controls').get())
      .toEqual({ value: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM github_identity_mode_events').get())
      .toEqual({ value: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM github_identity_comparison_runs').get())
      .toEqual({ value: 0 });
    expect(sqlite.prepare(`
      SELECT identity_mode AS identityMode, identity_mode_revision AS identityModeRevision
      FROM sync_jobs WHERE id = 'job-1'
    `).get()).toEqual({ identityMode: null, identityModeRevision: null });
    expect(sqlite.prepare(`
      SELECT identity_mode AS identityMode, identity_mode_revision AS identityModeRevision
      FROM sync_log WHERE id = 'log-1'
    `).get()).toEqual({ identityMode: null, identityModeRevision: null });
    sqlite.close();
  });

  it('contains no Stage 1 data migration statements', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0067_github_identity_comparison_foundation.sql'),
      'utf8',
    );
    expect(migration).not.toMatch(/(?:^|;)\s*UPDATE\s/mi);
    expect(migration).not.toMatch(/(?:^|;)\s*INSERT\s+INTO\s/mi);
    expect(migration).toContain('ALTER TABLE `sync_jobs` ADD `identity_mode` text');
  });
});

function stageOneRows(sqlite: Database.Database): Record<string, unknown[]> {
  return {
    migrations: sqlite.prepare('SELECT * FROM github_identity_migrations').all(),
    backfill: sqlite.prepare('SELECT * FROM github_identity_backfill_items').all(),
    collisions: sqlite.prepare('SELECT * FROM github_identity_collisions').all(),
    entities: sqlite.prepare('SELECT * FROM external_entities').all(),
  };
}

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0067_github_identity_comparison_foundation.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
