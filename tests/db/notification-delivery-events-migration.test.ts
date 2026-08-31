import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('notification delivery events migration', () => {
  it('creates the durable outbox with linkage, dispatch indexes, and deduplication', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

      const columns = sqlite.prepare(
        'PRAGMA table_info(notification_delivery_events)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual([
        'id',
        'notification_id',
        'channel',
        'dedupe_key',
        'status',
        'suppression_reason',
        'policy_snapshot',
        'payload_snapshot',
        'attempt_count',
        'next_attempt_at',
        'lease_expires_at',
        'subscriptions_attempted',
        'subscriptions_sent',
        'subscriptions_failed',
        'created_at',
        'sent_at',
        'last_error',
        'claim_token',
      ]);

      const indexes = sqlite.prepare(
        'PRAGMA index_list(notification_delivery_events)',
      ).all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_notification_delivery_events_dedupe',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'idx_notification_delivery_events_dispatch',
          unique: 0,
        }),
        expect.objectContaining({
          name: 'idx_notification_delivery_events_notification',
          unique: 0,
        }),
      ]));

      const foreignKeys = sqlite.prepare(
        'PRAGMA foreign_key_list(notification_delivery_events)',
      ).all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
      expect(foreignKeys).toContainEqual(expect.objectContaining({
        table: 'notifications',
        from: 'notification_id',
        to: 'id',
        on_delete: 'CASCADE',
      }));
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM __drizzle_migrations
        WHERE created_at = 1785782400000
      `).get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });
});
