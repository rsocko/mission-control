import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub repository repoint migration', () => {
  it('adds durable operations, append-only events, and exclusive maintenance locks', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE external_entities (id TEXT PRIMARY KEY);
      INSERT INTO connector_configs VALUES ('github-1');
      INSERT INTO external_entities VALUES ('repository-1');
    `);
    applyMigration(sqlite);
    sqlite.exec(`
      INSERT INTO github_repository_repoints (
        id, connector_instance_id, idempotency_key, phase, actor, host_key,
        repository_entity_id, repository_stable_id, from_owner, from_repository,
        to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
        rollback_snapshot, created_at, updated_at
      ) VALUES (
        'operation-1', 'github-1', 'request-1', 'locked', 'operator',
        'github.com', 'repository-1', 'R_1', 'old', 'repo', 'new', 'repo',
        1, '{}', '{}', '{}', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
      );
      INSERT INTO connector_maintenance_locks (
        connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
      ) VALUES (
        'github-1', 'operation-1', 'operator', 'github_repository_repoint',
        '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
      );
      INSERT INTO github_repository_repoint_events (
        operation_id, phase, actor, payload, created_at
      ) VALUES (
        'operation-1', 'locked', 'operator', '{}', '2026-08-10T00:00:00Z'
      );
    `);

    expect(sqlite.prepare('SELECT phase FROM github_repository_repoints').get())
      .toEqual({ phase: 'locked' });
    expect(sqlite.prepare('SELECT operation_id FROM connector_maintenance_locks').get())
      .toEqual({ operation_id: 'operation-1' });
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM github_repository_repoint_events').get())
      .toEqual({ value: 1 });
    expect(() => sqlite.exec(`
      INSERT INTO github_repository_repoints (
        id, connector_instance_id, idempotency_key, phase, actor, host_key,
        repository_entity_id, repository_stable_id, from_owner, from_repository,
        to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
        rollback_snapshot, created_at, updated_at
      ) VALUES (
        'operation-2', 'github-1', 'request-2', 'locked', 'operator',
        'github.com', 'repository-1', 'R_1', 'old', 'repo', 'new', 'repo',
        1, '{}', '{}', '{}', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
      )
    `)).toThrow();
    expect(() => sqlite.exec(`
      UPDATE github_repository_repoints SET phase = 'unknown' WHERE id = 'operation-1'
    `)).toThrow();
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0066_github_repository_repoint.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
