import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('calendar notification dedupe migration', () => {
  it('keeps the newest event notification and assigns its stable source identity', () => {
    const sqlite = new Database(':memory:');
    const migrationPath = resolve(
      process.cwd(),
      'drizzle/0130_dedupe_outlook_calendar_notifications.sql',
    );

    try {
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL UNIQUE,
          connector_type TEXT NOT NULL,
          connector_instance_id TEXT NOT NULL,
          received_at TEXT NOT NULL,
          metadata TEXT NOT NULL
        );
        CREATE TABLE notification_actions (
          id TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL
        );
        CREATE TABLE semantic_documents (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL
        );
        CREATE TABLE semantic_vectors (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL
        );
        CREATE TABLE semantic_intents (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL
        );
      `);
      const metadata = JSON.stringify({ eventId: 'event-123' });
      const insertNotification = sqlite.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, received_at, metadata
        ) VALUES (?, ?, 'outlook-calendar', 'calendar-1', ?, ?)
      `);
      insertNotification.run('older', 'calendar-1:random-1', '2026-09-10T10:00:00Z', metadata);
      insertNotification.run('newer', 'calendar-1:random-2', '2026-09-10T10:10:00Z', metadata);
      sqlite.prepare(`
        INSERT INTO notification_actions (id, notification_id) VALUES ('old-action', 'older')
      `).run();
      sqlite.prepare(`
        INSERT INTO semantic_documents (id, entity_type, entity_id)
        VALUES ('old-document', 'alert', 'older'), ('new-document', 'alert', 'newer')
      `).run();
      sqlite.prepare(`
        INSERT INTO semantic_vectors (id, entity_type, entity_id)
        VALUES ('old-vector', 'alert', 'older'), ('new-vector', 'alert', 'newer')
      `).run();
      sqlite.prepare(`
        INSERT INTO semantic_intents (id, entity_type, entity_id)
        VALUES ('old-intent', 'alert', 'older'), ('new-intent', 'alert', 'newer')
      `).run();

      const statements = readFileSync(migrationPath, 'utf8')
        .split('--> statement-breakpoint')
        .map(statement => statement.trim())
        .filter(Boolean);
      for (const statement of statements) sqlite.exec(statement);

      expect(sqlite.prepare(`
        SELECT id, source_id AS sourceId FROM notifications
      `).all()).toEqual([{
        id: 'newer',
        sourceId: 'calendar-1:cal:event-123',
      }]);
      expect(sqlite.prepare('SELECT id FROM notification_actions').all()).toEqual([]);
      expect(sqlite.prepare('SELECT id FROM semantic_documents').all())
        .toEqual([{ id: 'new-document' }]);
      expect(sqlite.prepare('SELECT id FROM semantic_vectors').all())
        .toEqual([{ id: 'new-vector' }]);
      expect(sqlite.prepare('SELECT id FROM semantic_intents').all())
        .toEqual([{ id: 'new-intent' }]);
    } finally {
      sqlite.close();
    }
  });
});
