import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ideation workspace migration', () => {
  it('creates workspace and checkpoint constraints', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0102_ideation_workspaces.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO graph_workspaces (
        id, name, type, schema_version, content_revision, current_document,
        migration_source, created_at, updated_at
      ) VALUES ('one', 'One', 'ideation', 1, 1, '{}', 'legacy', 'now', 'now')
    `).run();
    expect(() => sqlite.prepare(`
      INSERT INTO graph_workspaces (
        id, name, type, schema_version, content_revision, current_document,
        migration_source, created_at, updated_at
      ) VALUES ('two', 'Two', 'ideation', 1, 1, '{}', 'legacy', 'now', 'now')
    `).run()).toThrow();

    sqlite.prepare(`
      INSERT INTO graph_workspace_versions (
        id, workspace_id, revision, name, document, reason, created_at
      ) VALUES ('version', 'one', 1, 'One', '{}', 'created', 'now')
    `).run();
    sqlite.prepare(`DELETE FROM graph_workspaces WHERE id = 'one'`).run();
    expect(sqlite.prepare('SELECT count(*) AS count FROM graph_workspace_versions').get())
      .toEqual({ count: 0 });
    sqlite.close();
  });
});
