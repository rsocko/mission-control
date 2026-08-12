import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('notification lifecycle migration', () => {
  it('backfills every legacy state without losing lifecycle meaning', () => {
    const sqlite = new Database(':memory:');

    try {
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'fyi',
          connector_instance_id TEXT NOT NULL DEFAULT 'test',
          archived_at TEXT,
          resolved_at TEXT,
          sort_at TEXT NOT NULL,
          last_reconciled_at TEXT,
          received_at TEXT NOT NULL
        );
        CREATE TABLE notification_writeback_jobs (
          notification_id TEXT NOT NULL,
          status TEXT NOT NULL
        );
      `);
      const insert = sqlite.prepare(`
        INSERT INTO notifications (
          id, state, archived_at, resolved_at, sort_at, last_reconciled_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const sortAt = '2026-08-02T10:00:00.000Z';
      const receivedAt = '2026-08-02T09:00:00.000Z';
      for (const state of ['unread', 'read', 'archived', 'dismissed', 'resolved']) {
        insert.run(
          state,
          state,
          state === 'archived' ? '2026-08-02T10:30:00.000Z' : null,
          state === 'resolved' ? '2026-08-02T11:00:00.000Z' : null,
          sortAt,
          null,
          receivedAt,
        );
      }
      sqlite.exec(`
        INSERT INTO notification_writeback_jobs VALUES ('archived', 'failed');
        INSERT INTO notification_writeback_jobs VALUES ('dismissed', 'pending');
      `);

      const migration = readFileSync(
        resolve(process.cwd(), 'drizzle/0080_split_notification_lifecycle.sql'),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }

      const rows = sqlite.prepare(`
        SELECT
          id,
          read_state AS readState,
          disposition,
          source_state AS sourceState,
          sync_state AS syncState,
          handled_at AS handledAt,
          source_resolved_at AS sourceResolvedAt,
          last_source_activity_at AS lastSourceActivityAt,
          last_source_synced_at AS lastSourceSyncedAt
        FROM notifications
        ORDER BY id
      `).all();
      expect(rows).toEqual([
        {
          id: 'archived',
          readState: 'read',
          disposition: 'handled',
          sourceState: 'active',
          syncState: 'failed',
          handledAt: '2026-08-02T10:30:00.000Z',
          sourceResolvedAt: null,
          lastSourceActivityAt: sortAt,
          lastSourceSyncedAt: receivedAt,
        },
        {
          id: 'dismissed',
          readState: 'read',
          disposition: 'dismissed',
          sourceState: 'active',
          syncState: 'pending',
          handledAt: null,
          sourceResolvedAt: null,
          lastSourceActivityAt: sortAt,
          lastSourceSyncedAt: receivedAt,
        },
        {
          id: 'read',
          readState: 'read',
          disposition: 'inbox',
          sourceState: 'active',
          syncState: 'synced',
          handledAt: null,
          sourceResolvedAt: null,
          lastSourceActivityAt: sortAt,
          lastSourceSyncedAt: receivedAt,
        },
        {
          id: 'resolved',
          readState: 'read',
          disposition: 'inbox',
          sourceState: 'resolved',
          syncState: 'synced',
          handledAt: null,
          sourceResolvedAt: '2026-08-02T11:00:00.000Z',
          lastSourceActivityAt: sortAt,
          lastSourceSyncedAt: receivedAt,
        },
        {
          id: 'unread',
          readState: 'unread',
          disposition: 'inbox',
          sourceState: 'active',
          syncState: 'synced',
          handledAt: null,
          sourceResolvedAt: null,
          lastSourceActivityAt: sortAt,
          lastSourceSyncedAt: receivedAt,
        },
      ]);

      const indexes = sqlite.prepare(`PRAGMA index_list('notifications')`).all() as Array<{ name: string }>;
      expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
        'idx_notifications_inbox',
        'idx_notifications_attention',
        'idx_notifications_reconcile_source',
      ]));
    } finally {
      sqlite.close();
    }
  });
});
