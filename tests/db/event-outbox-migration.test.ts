import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

const MIGRATION_CREATED_AT = 1788298502117;

function migrate(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  return sqlite;
}

describe('event outbox migration', () => {
  it('creates the durable event table with a stable-key uniqueness guarantee', () => {
    const sqlite = migrate();
    try {
      const columns = sqlite.prepare('PRAGMA table_info(event_outbox)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'sequence',
        'stable_key',
        'event_type',
        'payload',
        'occurred_at',
        'created_at',
      ]);
      expect(columns.every((column) => column.notnull === 1)).toBe(true);

      const indexes = sqlite.prepare('PRAGMA index_list(event_outbox)').all() as Array<{
        name: string;
        unique: number;
      }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_event_outbox_stable_key', unique: 1 }),
        expect.objectContaining({ name: 'idx_event_outbox_type', unique: 0 }),
      ]));
    } finally {
      sqlite.close();
    }
  });

  it('creates deliveries with fencing columns, cascade linkage and dispatch indexes', () => {
    const sqlite = migrate();
    try {
      const columns = sqlite.prepare(
        'PRAGMA table_info(event_outbox_deliveries)',
      ).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'event_sequence',
        'webhook_id',
        'status',
        'attempt_count',
        'next_attempt_at',
        'lease_owner',
        'lease_token',
        'lease_expires_at',
        'last_error',
        'last_status',
        'completed_at',
        'created_at',
        'updated_at',
      ]);

      const indexes = sqlite.prepare(
        'PRAGMA index_list(event_outbox_deliveries)',
      ).all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_event_outbox_deliveries_pair', unique: 1 }),
        expect.objectContaining({ name: 'idx_event_outbox_deliveries_dispatch', unique: 0 }),
        expect.objectContaining({
          name: 'idx_event_outbox_deliveries_webhook_order',
          unique: 0,
        }),
        expect.objectContaining({ name: 'idx_event_outbox_deliveries_lease', unique: 0 }),
      ]));

      const foreignKeys = sqlite.prepare(
        'PRAGMA foreign_key_list(event_outbox_deliveries)',
      ).all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'event_outbox',
          from: 'event_sequence',
          to: 'sequence',
          on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'outbound_webhooks',
          from: 'webhook_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]));
    } finally {
      sqlite.close();
    }
  });

  it('registers exactly once in the migration journal', () => {
    const sqlite = migrate();
    try {
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM __drizzle_migrations
        WHERE created_at = ${MIGRATION_CREATED_AT}
      `).get()).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('enforces stable-key uniqueness and delivery pair uniqueness at the storage layer', () => {
    const sqlite = migrate();
    try {
      sqlite.prepare(`
        INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
        VALUES ('key-a', 'sync.completed', '{}', 'now', 'now')
      `).run();
      expect(() => sqlite.prepare(`
        INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
        VALUES ('key-a', 'sync.completed', '{}', 'now', 'now')
      `).run()).toThrow(/UNIQUE/i);

      sqlite.prepare(`
        INSERT INTO outbound_webhooks (id, name, url, event_types, enabled, created_at)
        VALUES ('hook-a', 'Hook A', 'https://example.test/hook', '["sync.completed"]', 1, 'now')
      `).run();
      sqlite.prepare(`
        INSERT INTO event_outbox_deliveries (
          id, event_sequence, webhook_id, status, attempt_count, created_at, updated_at
        ) VALUES ('d1', 1, 'hook-a', 'pending', 0, 'now', 'now')
      `).run();
      expect(() => sqlite.prepare(`
        INSERT INTO event_outbox_deliveries (
          id, event_sequence, webhook_id, status, attempt_count, created_at, updated_at
        ) VALUES ('d2', 1, 'hook-a', 'pending', 0, 'now', 'now')
      `).run()).toThrow(/UNIQUE/i);
    } finally {
      sqlite.close();
    }
  });
});
