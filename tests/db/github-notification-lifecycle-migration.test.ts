import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub notification lifecycle migration', () => {
  it('adds mute state and typed retryable writeback fields with safe defaults', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE notifications (id TEXT PRIMARY KEY);
        CREATE TABLE notification_writeback_jobs (
          id TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL,
          status TEXT NOT NULL
        );
        INSERT INTO notifications VALUES ('notification-1');
        INSERT INTO notification_writeback_jobs
          VALUES ('job-1', 'notification-1', 'pending');
      `);
      const migration = readFileSync(
        resolve(process.cwd(), 'drizzle/0082_github_notification_lifecycle.sql'),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }

      expect(sqlite.prepare(`
        SELECT action_type AS action, retryable
        FROM notification_writeback_jobs WHERE id = 'job-1'
      `).get()).toEqual({ action: 'mark_done', retryable: 1 });
      expect(sqlite.prepare(`
        SELECT muted_at AS mutedAt FROM notifications WHERE id = 'notification-1'
      `).get()).toEqual({ mutedAt: null });
      expect((sqlite.prepare(`
        PRAGMA index_list('notification_writeback_jobs')
      `).all() as Array<{ name: string }>).map(index => index.name))
        .toContain('idx_notification_writeback_jobs_notification');
    } finally {
      sqlite.close();
    }
  });
});
