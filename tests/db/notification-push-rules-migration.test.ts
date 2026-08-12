import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('notification push rules migration', () => {
  it('applies through the migration runner with per-instance type uniqueness', () => {
    const sqlite = new Database(':memory:');

    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

      const columns = sqlite.prepare(
        'PRAGMA table_info(notification_push_rules)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual([
        'id',
        'connector_instance_id',
        'template_key',
        'enabled',
        'min_level',
        'preview',
        'max_per_hour',
        'created_at',
        'updated_at',
      ]);

      const insert = sqlite.prepare(`
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level,
          preview, max_per_hour, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        'rule-1',
        'github-work',
        'pr_review_requested',
        1,
        'action_needed',
        'title_only',
        5,
        '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
      );
      expect(() => insert.run(
        'rule-2',
        'github-work',
        'pr_review_requested',
        0,
        'urgent',
        'title_only',
        null,
        '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
      )).toThrow(/UNIQUE constraint failed/);
      expect(() => insert.run(
        'rule-3',
        'github-personal',
        'pr_review_requested',
        0,
        'urgent',
        'title_only',
        null,
        '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
      )).not.toThrow();

      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM __drizzle_migrations
        WHERE created_at = 1785708000000
      `).get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });
});
