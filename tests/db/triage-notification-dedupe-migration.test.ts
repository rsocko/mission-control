import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('triage notification dedupe migration', () => {
  it('keeps the newest reminder and its state, removes duplicate dependents, and leaves other notifications alone', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL UNIQUE,
          connector_type TEXT NOT NULL,
          connector_instance_id TEXT NOT NULL,
          template_key TEXT,
          received_at TEXT NOT NULL,
          dedupe_key TEXT,
          metadata TEXT NOT NULL,
          disposition TEXT NOT NULL
        );
        CREATE TABLE notification_actions (id TEXT PRIMARY KEY, notification_id TEXT NOT NULL);
        CREATE TABLE notification_delivery_events (
          id TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE
        );
        CREATE TABLE semantic_documents (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT);
        CREATE TABLE semantic_vectors (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT);
        CREATE TABLE semantic_intents (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT);
      `);
      const insert = sqlite.prepare(`
        INSERT INTO notifications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('old', 'push:triage_nudge:2026-10-26:3541', 'system', 'push-triggers',
        'triage_nudge', '2026-10-26T12:00:00Z', 'push:triage_nudge:2026-10-26',
        '{"queueSize":3541}', 'inbox');
      insert.run('new', 'push:triage_nudge:2026-10-29:3541', 'system', 'push-triggers',
        'triage_nudge', '2026-10-29T12:00:00Z', 'push:triage_nudge:2026-10-29',
        '{"queueSize":3541}', 'dismissed');
      insert.run('morning', 'push:morning_start_day:2026-10-29', 'system', 'push-triggers',
        'morning_start_day', '2026-10-29T13:00:00Z', null, '{}', 'inbox');
      insert.run('other-connector', 'other-triage', 'system', 'other-instance',
        'triage_nudge', '2026-10-29T13:00:00Z', null, '{}', 'inbox');
      sqlite.exec(`
        INSERT INTO notification_actions VALUES ('old-action', 'old'), ('new-action', 'new');
        INSERT INTO notification_delivery_events VALUES ('old-delivery', 'old'), ('new-delivery', 'new');
        INSERT INTO semantic_documents VALUES
          ('old-doc', 'alert', 'old'), ('new-doc', 'alert', 'new'), ('task-doc', 'task', 'old');
        INSERT INTO semantic_vectors VALUES ('old-vector', 'alert', 'old');
        INSERT INTO semantic_intents VALUES ('old-intent', 'alert', 'old');
      `);

      const migration = readFileSync(resolve(
        process.cwd(), 'drizzle/0160_dedupe_triage_notifications.sql',
      ), 'utf8');
      // Replaying the repair must also work once the stable identity exists.
      for (let run = 0; run < 2; run++) {
        sqlite.transaction(() => {
          for (const statement of migration.split('--> statement-breakpoint')) {
            if (statement.trim()) sqlite.exec(statement);
          }
        })();
      }

      expect(sqlite.prepare(`
        SELECT id, source_id, dedupe_key, metadata, disposition
        FROM notifications WHERE id = 'new'
      `).get()).toEqual({
        id: 'new',
        source_id: 'push:triage_nudge',
        dedupe_key: 'push:triage_nudge:2026-10-29',
        metadata: '{"queueSize":3541}',
        disposition: 'dismissed',
      });
      expect(sqlite.prepare('SELECT id FROM notifications ORDER BY id').all())
        .toEqual([{ id: 'morning' }, { id: 'new' }, { id: 'other-connector' }]);
      expect(sqlite.prepare('SELECT id FROM notification_actions').all())
        .toEqual([{ id: 'new-action' }]);
      expect(sqlite.prepare('SELECT id FROM notification_delivery_events').all())
        .toEqual([{ id: 'new-delivery' }]);
      expect(sqlite.prepare('SELECT id FROM semantic_documents ORDER BY id').all())
        .toEqual([{ id: 'new-doc' }, { id: 'task-doc' }]);
      expect(sqlite.prepare('SELECT id FROM semantic_vectors').all()).toEqual([]);
      expect(sqlite.prepare('SELECT id FROM semantic_intents').all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
