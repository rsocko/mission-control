import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function applyMigration(sqlite: Database.Database, path: string): void {
  const statements = readFileSync(resolve(process.cwd(), path), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.trim())
    .filter(Boolean);
  for (const statement of statements) sqlite.exec(statement);
}

describe('RyMessage canonical ActionV2 reset migration', () => {
  it('removes legacy tables and resets only RyMessage projections and notifications', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          connector_type TEXT NOT NULL,
          title TEXT NOT NULL
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

        CREATE TABLE rymessage_action_feed_state (connector_id TEXT);
        CREATE TABLE rymessage_action_materializations (connector_id TEXT);
        CREATE TABLE rymessage_action_outbound_mutations (connector_id TEXT);
        CREATE TABLE rymessage_action_projections (connector_id TEXT);
        CREATE TABLE rymessage_action_receipts (connector_id TEXT);

        CREATE TABLE rymessage_action_v2_feed_state (connector_id TEXT);
        CREATE TABLE rymessage_action_v2_outbound_mutations (connector_id TEXT);
        CREATE TABLE rymessage_action_v2_projections (connector_id TEXT);
        CREATE TABLE rymessage_action_v2_receipts (connector_id TEXT);

        INSERT INTO notifications VALUES
          ('rymessage-action', 'rymessage', '返信して — José 👋'),
          ('github-action', 'github-issues', 'Keep me');
        INSERT INTO notification_actions VALUES
          ('rymessage-action-button', 'rymessage-action'),
          ('github-action-button', 'github-action');
        INSERT INTO semantic_documents VALUES
          ('rymessage-semantic', 'alert', 'rymessage-action'),
          ('github-semantic', 'alert', 'github-action');

        INSERT INTO rymessage_action_feed_state VALUES ('rymessage');
        INSERT INTO rymessage_action_materializations VALUES ('rymessage');
        INSERT INTO rymessage_action_outbound_mutations VALUES ('rymessage');
        INSERT INTO rymessage_action_projections VALUES ('rymessage');
        INSERT INTO rymessage_action_receipts VALUES ('rymessage');
        INSERT INTO rymessage_action_v2_feed_state VALUES ('rymessage');
        INSERT INTO rymessage_action_v2_outbound_mutations VALUES ('rymessage');
        INSERT INTO rymessage_action_v2_projections VALUES ('rymessage');
        INSERT INTO rymessage_action_v2_receipts VALUES ('rymessage');
      `);

      applyMigration(sqlite, 'drizzle/0143_premium_gravity.sql');

      expect(sqlite.prepare('SELECT * FROM notifications').all()).toEqual([
        { id: 'github-action', connector_type: 'github-issues', title: 'Keep me' },
      ]);
      expect(sqlite.prepare('SELECT * FROM notification_actions').all()).toEqual([
        { id: 'github-action-button', notification_id: 'github-action' },
      ]);
      expect(sqlite.prepare('SELECT * FROM semantic_documents').all()).toEqual([
        { id: 'github-semantic', entity_type: 'alert', entity_id: 'github-action' },
      ]);
      for (const table of [
        'rymessage_action_v2_feed_state',
        'rymessage_action_v2_outbound_mutations',
        'rymessage_action_v2_projections',
        'rymessage_action_v2_receipts',
      ]) {
        expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get())
          .toEqual({ count: 0 });
      }
      for (const table of [
        'rymessage_action_feed_state',
        'rymessage_action_materializations',
        'rymessage_action_outbound_mutations',
        'rymessage_action_projections',
        'rymessage_action_receipts',
      ]) {
        expect(sqlite.prepare(`
          SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?
        `).get(table)).toEqual({ count: 0 });
      }
    } finally {
      sqlite.close();
    }
  });

  it('keeps PostgreSQL reset and drop coverage aligned', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/postgres/0021_tough_arachne.sql'),
      'utf8',
    );
    expect(migration).toContain('DELETE FROM "notifications" WHERE "connector_type" = \'rymessage\'');
    expect(migration).toContain('DELETE FROM "rymessage_action_v2_feed_state"');
    expect(migration).toContain('DROP TABLE "rymessage_action_feed_state" CASCADE');
  });
});
