import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub write and recovery fence migration', () => {
  it('adds bounded lease evidence and preserves legacy deletion snapshots', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE github_identity_comparison_runs (id TEXT PRIMARY KEY);
      CREATE TABLE external_entities (id TEXT PRIMARY KEY);
      CREATE TABLE sync_deletion_candidates (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_id TEXT NOT NULL
      );
      CREATE TABLE sync_deletion_snapshots (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        original_task_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );
      INSERT INTO connector_configs VALUES ('github-1');
      INSERT INTO sync_deletion_snapshots
        (id, connector_id, original_task_id, deleted_at)
      VALUES ('snapshot-1', 'github-1', 'task-1', '2026-08-10T00:00:00Z');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0074_github_write_recovery_fences.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT recovery_state AS recoveryState, issue_entity_id AS issueEntityId,
        binding_revision AS bindingRevision
      FROM sync_deletion_snapshots WHERE id = 'snapshot-1'
    `).get()).toEqual({
      recoveryState: 'pending',
      issueEntityId: null,
      bindingRevision: null,
    });
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_task_source_write_leases_task_operation_active',
          'idx_task_source_write_lease_targets_entity',
          'idx_sync_deletion_snapshot_recovery'
        )
      ORDER BY name
    `).all()).toHaveLength(3);
    expect(() => sqlite.prepare(`
      INSERT INTO task_source_write_leases (
        id, token, connector_instance_id, task_id, operation, task_version,
        idempotency_key, effective_mode, mode_revision, state, expires_at,
        created_at, updated_at
      ) VALUES (
        'lease-1', 'token-1', 'github-1', 'task-1', 'reroute', 'v1',
        'task-1:reroute:v1', 'comparison', 1, 'claimed',
        '2026-08-10T00:01:00Z', '2026-08-10T00:00:00Z',
        '2026-08-10T00:00:00Z'
      )
    `).run()).toThrow();
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE|DROP)\s/mi);
    sqlite.close();
  });
});
