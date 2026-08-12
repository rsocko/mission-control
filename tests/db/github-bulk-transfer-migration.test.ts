import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub bulk transfer migration', () => {
  it('enforces durable run, item, event, and active-operation invariants', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE external_entities (id TEXT PRIMARY KEY);
      INSERT INTO connector_configs VALUES ('github-1');
      INSERT INTO external_entities VALUES ('issue-1');
    `);
    applyMigration(sqlite);
    const runValues = `
      'run-1', 'github-1', 'request-1', 'running', 'operator',
      'owner/source', 'owner/target', '${'a'.repeat(64)}', '{}', 1,
      '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
    `;
    sqlite.exec(`
      INSERT INTO github_bulk_transfer_runs (
        id, connector_instance_id, idempotency_key, phase, actor,
        source_repository, target_repository, plan_hash, plan,
        connector_was_enabled, created_at, updated_at
      ) VALUES (${runValues});
      INSERT INTO github_bulk_transfer_items (
        run_id, task_id, issue_entity_id, issue_stable_id, source_number,
        state, before_digest, updated_at
      ) VALUES (
        'run-1', 'task-1', 'issue-1', 'I_1', 1, 'pending',
        '${'b'.repeat(64)}', '2026-08-12T00:00:00Z'
      );
      INSERT INTO github_bulk_transfer_events (
        run_id, task_id, event_type, payload, created_at
      ) VALUES (
        'run-1', 'task-1', 'planned', '{}', '2026-08-12T00:00:00Z'
      );
    `);

    expect(sqlite.prepare('SELECT state FROM github_bulk_transfer_items').get())
      .toEqual({ state: 'pending' });
    expect(() => sqlite.exec(`
      INSERT INTO github_bulk_transfer_runs (
        id, connector_instance_id, idempotency_key, phase, actor,
        source_repository, target_repository, plan_hash, plan,
        connector_was_enabled, created_at, updated_at
      ) VALUES (
        'run-2', 'github-1', 'request-2', 'running', 'operator',
        'owner/source', 'owner/target', '${'c'.repeat(64)}', '{}', 1,
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
      )
    `)).toThrow();
    expect(() => sqlite.exec(`
      UPDATE github_bulk_transfer_items SET state = 'unknown'
    `)).toThrow();
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0098_github_bulk_issue_transfer.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
