import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('notification action execution migration', () => {
  it('is journaled and applies through the application migration runner', () => {
    const sqlite = new Database(':memory:');

    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

      const columns = sqlite.prepare(
        'PRAGMA table_info(notification_actions)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
        'execution_state',
        'claimed_at',
        'completed_at',
        'last_error',
      ]));
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM __drizzle_migrations
        WHERE created_at = 1785545100000
      `).get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });
});
