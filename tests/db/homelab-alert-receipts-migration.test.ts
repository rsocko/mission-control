import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('homelab alert receipt migration', () => {
  it('creates durable receipt identity and incident indexes', () => {
    const sqlite = new Database(':memory:');
    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
      const columns = sqlite.prepare(
        'PRAGMA table_info(homelab_alert_receipts)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual([
        'id',
        'integration',
        'source',
        'event_id',
        'fingerprint',
        'status',
        'occurred_at',
        'notification_id',
        'first_received_at',
        'last_received_at',
        'delivery_count',
        'applied',
      ]);

      const insert = sqlite.prepare(`
        INSERT INTO homelab_alert_receipts (
          id, integration, source, event_id, fingerprint, status, occurred_at,
          notification_id, first_received_at, last_received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const values = [
        'receipt-1',
        'homelab',
        'alertmanager',
        'event-1',
        'abcdef',
        'firing',
        '2026-08-22T20:00:00.000Z',
        'notification-1',
        '2026-08-22T20:01:00.000Z',
        '2026-08-22T20:01:00.000Z',
      ];
      insert.run(...values);
      expect(() => insert.run('receipt-2', ...values.slice(1)))
        .toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});
