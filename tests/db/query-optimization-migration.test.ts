import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('list query optimization migration', () => {
  it('adds indexes used by triage, connector, and task list queries', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE triage_items (
        id TEXT PRIMARY KEY NOT NULL,
        canonical_url TEXT
      );
      CREATE TABLE sync_log (
        id TEXT PRIMARY KEY NOT NULL,
        connector_id TEXT NOT NULL,
        success INTEGER NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        is_checklist_item INTEGER NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_list_id TEXT,
        status TEXT NOT NULL
      );
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0060_optimize_list_queries.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const triagePlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM triage_items WHERE canonical_url = ?
    `).all('https://example.com/item');
    const syncPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT connector_id, max(synced_at)
      FROM sync_log
      WHERE success = 1
      GROUP BY connector_id
    `).all();
    const taskPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT source_list_id, connector_instance_id, count(*)
      FROM tasks
      WHERE status <> 'done' AND is_checklist_item = 0
      GROUP BY source_list_id, connector_instance_id
    `).all();

    expect(triagePlan.some((row) =>
      String((row as { detail: string }).detail).includes('idx_triage_items_canonical_url')
    )).toBe(true);
    expect(syncPlan.some((row) =>
      String((row as { detail: string }).detail).includes('idx_sync_log_connector_success_synced_at')
    )).toBe(true);
    expect(taskPlan.some((row) =>
      String((row as { detail: string }).detail).includes('idx_tasks_list_counts')
    )).toBe(true);
    sqlite.close();
  });
});
