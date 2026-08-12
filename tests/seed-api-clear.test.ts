import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { clearUserDataTables } from '@/lib/seed-api';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('clearUserDataTables', () => {
  it('clears current, legacy, and virtual user tables while preserving migrations and history', () => {
    const database = new Database(':memory:');
    databases.push(database);
    database.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY);
      CREATE TABLE task_history_events (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE task_triage_log (id TEXT PRIMARY KEY);
      CREATE TABLE legacy_feature_data (id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE tasks_fts USING fts5(title);

      INSERT INTO __drizzle_migrations VALUES (1);
      INSERT INTO task_history_events VALUES ('history-1');
      INSERT INTO tasks VALUES ('task-1');
      INSERT INTO task_triage_log VALUES ('triage-1');
      INSERT INTO legacy_feature_data VALUES ('legacy-1');
      INSERT INTO tasks_fts VALUES ('Searchable task');
    `);

    clearUserDataTables(database);

    expect(database.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM task_history_events').get()).toEqual({ count: 1 });
    for (const table of ['tasks', 'task_triage_log', 'legacy_feature_data', 'tasks_fts']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
