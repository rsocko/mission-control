import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub orphan binding cleanup migration', () => {
  it('removes only task bindings without a task in the same connector', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        connector_instance_id TEXT
      );
      CREATE TABLE external_entity_bindings (
        id TEXT PRIMARY KEY,
        connector_instance_id TEXT NOT NULL,
        binding_type TEXT NOT NULL,
        local_id TEXT NOT NULL
      );
      INSERT INTO tasks (id, connector_instance_id) VALUES
        ('live-task', 'github-a'),
        ('shared-id', 'github-b');
      INSERT INTO external_entity_bindings (
        id, connector_instance_id, binding_type, local_id
      ) VALUES
        ('live-binding', 'github-a', 'task', 'live-task'),
        ('missing-task-binding', 'github-a', 'task', 'missing-task'),
        ('wrong-connector-binding', 'github-a', 'task', 'shared-id'),
        ('source-list-binding', 'github-a', 'source_list', 'missing-list');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0141_cleanup_orphan_external_bindings.sql'),
      'utf8',
    );
    sqlite.exec(migration);

    expect(sqlite.prepare(
      'SELECT id FROM external_entity_bindings ORDER BY id',
    ).pluck().all()).toEqual([
      'live-binding',
      'source-list-binding',
    ]);
    sqlite.close();
  });
});
