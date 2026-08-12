import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub identity observe-mode migration', () => {
  it('adds an append-only audited exception table without data mutation', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      INSERT INTO connector_configs VALUES ('github-1');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0068_github_identity_observe_mode.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'github_identity_exception_events'
    `).get()).toEqual({ name: 'github_identity_exception_events' });
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_github_identity_exception_events_idempotency'
    `).get()).toEqual({ name: 'idx_github_identity_exception_events_idempotency' });
    expect(() => sqlite.prepare(`
      INSERT INTO github_identity_exception_events (
        connector_instance_id, binding_type, local_id, category, action,
        idempotency_key, actor, reason, created_at
      ) VALUES ('github-1', 'task', 'task-1', 'terminal_inaccessible', 'guess',
        'key-12345', 'operator', 'invalid action', '2026-08-10T00:00:00Z')
    `).run()).toThrow();
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE)\s/mi);
    sqlite.close();
  });

  it('adds post-backfill proof metadata without rewriting exception events', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE github_identity_comparison_runs (id TEXT PRIMARY KEY);
      INSERT INTO connector_configs VALUES ('github-1');
    `);
    applyMigration(sqlite, 'drizzle/0068_github_identity_observe_mode.sql');
    sqlite.prepare(`
      INSERT INTO github_identity_exception_events (
        connector_instance_id, binding_type, local_id, category, action,
        idempotency_key, actor, reason, created_at
      ) VALUES (?, 'task', 'task-1', 'terminal_inaccessible', 'accept',
        'legacy-key', 'operator', 'legacy acceptance', '2026-08-10T00:00:00Z')
    `).run('github-1');

    const migration = applyMigration(
      sqlite,
      'drizzle/0070_curved_joshua_kane.sql',
    );
    expect(sqlite.prepare(`
      SELECT proof_type AS proofType, comparison_run_id AS comparisonRunId
      FROM github_identity_exception_events
      WHERE idempotency_key = 'legacy-key'
    `).get()).toEqual({ proofType: null, comparisonRunId: null });
    expect(() => sqlite.prepare(`
      INSERT INTO github_identity_exception_events (
        connector_instance_id, binding_type, local_id, category, action,
        idempotency_key, actor, reason, proof_type, created_at
      ) VALUES ('github-1', 'task', 'task-2', 'terminal_inaccessible', 'accept',
        'invalid-proof', 'operator', 'invalid proof', 'guessed',
        '2026-08-10T00:00:00Z')
    `).run()).toThrow();
    sqlite.prepare(`
      INSERT INTO github_identity_comparison_runs VALUES ('run-1')
    `).run();
    expect(() => sqlite.prepare(`
      INSERT INTO github_identity_exception_events (
        connector_instance_id, binding_type, local_id, category, action,
        idempotency_key, actor, reason, proof_type, comparison_run_id, created_at
      ) VALUES ('github-1', 'task', 'task-3', 'terminal_inaccessible', 'accept',
        'mismatched-proof', 'operator', 'mismatched proof',
        'stage1_inaccessible', 'run-1', '2026-08-10T00:00:00Z')
    `).run()).toThrow();
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE|DROP)\s/mi);
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database, path: string): string {
  const migration = readFileSync(resolve(process.cwd(), path), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
  return migration;
}
