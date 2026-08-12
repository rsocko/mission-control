import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('task ingest suppressions migration', () => {
  it('enforces the connector/source tombstone key and hard-delete reason', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE task_linked_sources (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL
      );
      INSERT INTO task_linked_sources VALUES
        ('link-1', 'task-1', 'scout', 'scout-primary', 'scout:email:1'),
        ('link-2', 'task-2', 'scout', 'scout-primary', 'scout:email:1');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0052_add_task_ingest_suppressions.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO task_ingest_suppressions (
        connector_instance_id, source_id, reason, created_at
      ) VALUES (?, ?, ?, ?)
    `).run('scout-primary', 'scout:email:1', 'hard-deleted', '2026-08-05T13:00:00.000Z');

    expect(() => sqlite.prepare(`
      INSERT INTO task_ingest_suppressions (
        connector_instance_id, source_id, reason, created_at
      ) VALUES (?, ?, ?, ?)
    `).run('scout-primary', 'scout:email:1', 'hard-deleted', '2026-08-05T13:01:00.000Z'))
      .toThrow();
    expect(() => sqlite.prepare(`
      INSERT INTO task_ingest_suppressions (
        connector_instance_id, source_id, reason, created_at
      ) VALUES (?, ?, ?, ?)
    `).run('scout-secondary', 'scout:email:1', 'dismissed', '2026-08-05T13:01:00.000Z'))
      .toThrow();

    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_ingest_suppressions'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_task_ingest_suppressions_source');
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM task_linked_sources',
    ).get()).toEqual({ count: 1 });
    expect(() => sqlite.exec(`
      INSERT INTO task_linked_sources VALUES
        ('link-3', 'task-3', 'scout', 'scout-primary', 'scout:email:1')
    `)).toThrow();
    sqlite.close();
  });
});
