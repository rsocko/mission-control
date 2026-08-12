import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub linked-source identity migration', () => {
  it('adds an empty normalized association without rewriting legacy linked sources', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE external_entities (id TEXT PRIMARY KEY);
      CREATE TABLE task_linked_sources (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        linked_at TEXT NOT NULL
      );
      INSERT INTO connector_configs VALUES ('github-1');
      INSERT INTO external_entities VALUES ('issue-1');
      INSERT INTO task_linked_sources VALUES (
        'linked-legacy', 'task-1', 'github-issues', 'github-1',
        'owner/repo:1', 'Legacy source', '2026-08-09T00:00:00Z'
      );
    `);
    const before = sqlite.prepare('SELECT * FROM task_linked_sources').all();

    applyMigration(sqlite);

    expect(sqlite.prepare('SELECT * FROM task_linked_sources').all()).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM task_linked_source_entities').get())
      .toEqual({ value: 0 });
    expect(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
    ).all('task_linked_source_entities')).toEqual([
      { name: 'idx_task_linked_source_entities_connector' },
      { name: 'idx_task_linked_source_entities_connector_entity' },
      { name: 'idx_task_linked_source_entities_entity' },
      { name: 'sqlite_autoindex_task_linked_source_entities_1' },
    ]);
    sqlite.prepare(`
      INSERT INTO task_linked_source_entities (
        linked_source_id, connector_instance_id, external_entity_id,
        verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'linked-legacy',
      'github-1',
      'issue-1',
      '2026-08-09T00:01:00Z',
      '2026-08-09T00:01:00Z',
      '2026-08-09T00:01:00Z',
    );
    expect(() => sqlite.prepare(`
      INSERT INTO task_linked_source_entities (
        linked_source_id, connector_instance_id, external_entity_id,
        verified_at, created_at, updated_at
      ) VALUES ('missing', 'github-1', 'issue-1', 'now', 'now', 'now')
    `).run()).toThrow();
    sqlite.prepare(`
      INSERT INTO task_linked_sources VALUES (
        'linked-duplicate', 'task-2', 'github-issues', 'github-1',
        'owner/repo:2', 'Duplicate entity', '2026-08-09T00:02:00Z'
      )
    `).run();
    expect(() => sqlite.prepare(`
      INSERT INTO task_linked_source_entities (
        linked_source_id, connector_instance_id, external_entity_id,
        verified_at, created_at, updated_at
      ) VALUES ('linked-duplicate', 'github-1', 'issue-1', 'now', 'now', 'now')
    `).run()).toThrow();
    sqlite.close();
  });

  it('contains no legacy linked-source data migration', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0073_github-linked-source-identity.sql'),
      'utf8',
    );
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE)\s/mi);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+`?task_linked_source_entities`?/i);
  });
});

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0073_github-linked-source-identity.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
