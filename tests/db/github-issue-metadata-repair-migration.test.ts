import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('GitHub issue metadata repair migration', () => {
  it('replaces stale transferred issue numbers from authoritative source IDs', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        connector_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      INSERT INTO tasks (id, connector_type, source_id, metadata) VALUES
        ('converted-project', 'github-issues', 'rsocko/mission-control:401',
          '{"issueNumber":784,"retained":true}'),
        ('proactive-alert', 'github-issues', 'rsocko/mission-control:784',
          '"{\\"issueNumber\\":1415,\\"retained\\":true}"'),
        ('local-task', 'local', 'local:123', '{"issueNumber":999}');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0100_repair_github_issue_metadata.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const rows = sqlite.prepare(
      'SELECT id, metadata FROM tasks ORDER BY id',
    ).all() as Array<{ id: string; metadata: string }>;
    expect(rows.map((row) => [row.id, JSON.parse(row.metadata)])).toEqual([
      ['converted-project', { issueNumber: 401, retained: true }],
      ['local-task', { issueNumber: 999 }],
      ['proactive-alert', { issueNumber: 784, retained: true }],
    ]);
    sqlite.close();
  });
});
