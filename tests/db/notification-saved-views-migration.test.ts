import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('notification saved views migration', () => {
  it('creates the saved-view table with unique names', () => {
    const sqlite = new Database(':memory:');
    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
      const columns = sqlite.prepare(
        'PRAGMA table_info(notification_saved_views)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual([
        'id',
        'name',
        'query',
        'created_at',
        'updated_at',
      ]);

      const insert = sqlite.prepare(`
        INSERT INTO notification_saved_views (id, name, query, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const now = '2026-08-10T00:00:00.000Z';
      insert.run('view-1', 'Reviews', '{"reason":"review_requested"}', now, now);
      expect(() => insert.run('view-2', 'Reviews', '{}', now, now)).toThrow(/UNIQUE constraint failed/);
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM __drizzle_migrations
        WHERE created_at = 1786389511426
      `).get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });
});
