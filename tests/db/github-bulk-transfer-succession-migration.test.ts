import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub bulk transfer succession migration', () => {
  it('enforces one audited successor relation per transfer item', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE github_bulk_transfer_runs (id TEXT PRIMARY KEY);
      CREATE TABLE external_entities (id TEXT PRIMARY KEY);
      INSERT INTO github_bulk_transfer_runs VALUES ('run-1');
      INSERT INTO external_entities VALUES ('issue-source');
      INSERT INTO external_entities VALUES ('issue-successor');
      INSERT INTO external_entities VALUES ('repository-target');
    `);
    applyMigration(sqlite);
    const values = `
      'succession-1', 'run-1', 'task-1', 'issue-source', 'issue-successor',
      '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'owner/source:1',
      'owner/target:7', 'repository-target', 7, '{}', '${'c'.repeat(64)}',
      'operator', 'Reviewed native transfer successor', 'successor-request-1',
      '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
    `;
    sqlite.exec(`
      INSERT INTO github_bulk_transfer_successions (
        id, run_id, task_id, source_external_entity_id,
        successor_external_entity_id, source_stable_id_digest,
        successor_stable_id_digest, source_id, successor_source_id,
        target_repository_entity_id, target_number, proof, proof_digest,
        actor, reason, idempotency_key, observed_at, created_at
      ) VALUES (${values});
    `);

    expect(sqlite.prepare(`
      SELECT task_id AS taskId, target_number AS targetNumber
      FROM github_bulk_transfer_successions
    `).get()).toEqual({ taskId: 'task-1', targetNumber: 7 });
    expect(() => sqlite.exec(`
      INSERT INTO github_bulk_transfer_successions (
        id, run_id, task_id, source_external_entity_id,
        successor_external_entity_id, source_stable_id_digest,
        successor_stable_id_digest, source_id, successor_source_id,
        target_repository_entity_id, target_number, proof, proof_digest,
        actor, reason, idempotency_key, observed_at, created_at
      ) VALUES (
        'succession-2', 'run-1', 'task-1', 'issue-source', 'issue-successor',
        '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'owner/source:1',
        'owner/target:7', 'repository-target', 7, '{}', '${'c'.repeat(64)}',
        'operator', 'Duplicate item', 'successor-request-2',
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
      )
    `)).toThrow();
    expect(() => sqlite.exec(`
      INSERT INTO github_bulk_transfer_successions (
        id, run_id, task_id, source_external_entity_id,
        successor_external_entity_id, source_stable_id_digest,
        successor_stable_id_digest, source_id, successor_source_id,
        target_repository_entity_id, target_number, proof, proof_digest,
        actor, reason, idempotency_key, observed_at, created_at
      ) VALUES (
        'succession-3', 'run-1', 'task-2', 'issue-source', 'issue-source',
        '${'a'.repeat(64)}', '${'a'.repeat(64)}', 'owner/source:2',
        'owner/target:8', 'repository-target', 8, '{}', '${'c'.repeat(64)}',
        'operator', 'Same identity', 'successor-request-3',
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
      )
    `)).toThrow();
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0099_long_mole_man.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
