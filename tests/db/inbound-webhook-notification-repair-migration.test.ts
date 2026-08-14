import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _repairInboundWebhookNotificationActions } from '@/db';

describe('inbound webhook notification repair migration', () => {
  it('repairs JSON values and links existing primary external actions', () => {
    const sqlite = new Database(':memory:');
    const migrationPath = resolve(
      process.cwd(),
      'drizzle/0034_repair_inbound_webhook_notifications.sql',
    );

    try {
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          connector_type TEXT NOT NULL,
          metadata TEXT NOT NULL,
          is_actionable INTEGER NOT NULL DEFAULT 0,
          primary_action_id TEXT
        );
        CREATE TABLE notification_actions (
          id TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 7,
          payload TEXT NOT NULL,
          opens_external INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'system'
        );
      `);
      const metadata = { webhookId: 'legacy-hook', originalPayload: { value: 42 } };
      const payload = { url: '  https://example.test/legacy  ' };
      sqlite.prepare(`
        INSERT INTO notifications (id, connector_type, metadata)
        VALUES (?, 'inbound-webhook', ?)
      `).run('notification-1', JSON.stringify(JSON.stringify(metadata)));
      sqlite.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, is_primary, payload
        ) VALUES (?, ?, 'open_url', 1, ?)
      `).run('action-1', 'notification-1', JSON.stringify(JSON.stringify(payload)));
      sqlite.prepare(`
        INSERT INTO notifications (id, connector_type, metadata, is_actionable, primary_action_id)
        VALUES (?, 'inbound-webhook', '{}', 1, ?)
      `).run('notification-invalid', 'action-invalid');
      sqlite.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, is_primary, payload
        ) VALUES (?, ?, 'open_url', 1, ?)
      `).run(
        'action-invalid',
        'notification-invalid',
        JSON.stringify(JSON.stringify({ url: 'http://' })),
      );

      const statements = readFileSync(migrationPath, 'utf8')
        .split('--> statement-breakpoint')
        .map(statement => statement.trim())
        .filter(Boolean);
      for (const statement of statements) sqlite.exec(statement);
      _repairInboundWebhookNotificationActions(sqlite);
      _repairInboundWebhookNotificationActions(sqlite);

      const notification = sqlite.prepare(`
        SELECT metadata, is_actionable, primary_action_id
        FROM notifications
        WHERE id = 'notification-1'
      `).get() as {
        metadata: string;
        is_actionable: number;
        primary_action_id: string;
      };
      const action = sqlite.prepare(`
        SELECT payload, opens_external, sort_order, created_by
        FROM notification_actions
        WHERE id = 'action-1'
      `).get() as {
        payload: string;
        opens_external: number;
        sort_order: number;
        created_by: string;
      };

      expect(JSON.parse(notification.metadata)).toEqual(metadata);
      expect(notification).toMatchObject({
        is_actionable: 1,
        primary_action_id: 'action-1',
      });
      expect(JSON.parse(action.payload)).toEqual({ url: 'https://example.test/legacy' });
      expect(action).toMatchObject({
        opens_external: 1,
        sort_order: 0,
        created_by: 'connector',
      });
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM notification_actions
        WHERE id = 'action-invalid'
      `).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(`
        SELECT is_actionable, primary_action_id
        FROM notifications
        WHERE id = 'notification-invalid'
      `).get()).toEqual({ is_actionable: 0, primary_action_id: null });
    } finally {
      sqlite.close();
    }
  });
});
