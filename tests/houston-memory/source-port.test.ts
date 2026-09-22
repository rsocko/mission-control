import Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { SqliteSemanticSourcePort } from '@/lib/semantic-index/source/sqlite-source-port';
import { PostgresSemanticSourcePort } from '@/db/postgres/semantic-index/source-port';

const sqliteSchema = `
  CREATE TABLE houston_conversation_memories (
    id TEXT PRIMARY KEY,
    authorization_scope TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    decisions TEXT NOT NULL,
    commitments TEXT NOT NULL,
    topics TEXT NOT NULL,
    linked_entities TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    retain_until TEXT NOT NULL,
    excluded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const row = {
  id: 'memory-1',
  authorizationScope: 'installation',
  title: 'Release planning',
  summary: 'Use a staged rollout.',
  decisions: ['Ship Friday'],
  commitments: [],
  topics: ['release'],
  linkedEntities: [],
  sensitivity: 'restricted',
  retainUntil: '2026-06-01T00:00:00.000Z',
  excludedAt: null,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

describe('Houston semantic source ports', () => {
  it('hydrates minimized JSON fields from SQLite', async () => {
    const database = new Database(':memory:');
    database.exec(sqliteSchema);
    database.prepare(`
      INSERT INTO houston_conversation_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.authorizationScope,
      row.title,
      row.summary,
      JSON.stringify(row.decisions),
      JSON.stringify(row.commitments),
      JSON.stringify(row.topics),
      JSON.stringify(row.linkedEntities),
      row.sensitivity,
      row.retainUntil,
      row.excludedAt,
      row.createdAt,
      row.updatedAt,
    );
    const port = new SqliteSemanticSourcePort(database);

    await expect(port.get('houston-summary', row.id)).resolves.toMatchObject({
      entityType: 'houston-summary',
      semanticEligible: true,
      decisions: ['Ship Friday'],
      authorizationScope: 'installation',
    });
    database.close();
  });

  it('uses bounded, exclusion-aware PostgreSQL source queries', async () => {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const pool = {
      query: async (sql: string, values: unknown[]) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        params.push(values);
        return { rows: [row], rowCount: 1 };
      },
    } as unknown as Pool;
    const port = new PostgresSemanticSourcePort(pool);

    const page = await port.list('houston-summary', { limit: 5 });
    expect(page.records[0]).toMatchObject({
      entityType: 'houston-summary',
      semanticEligible: true,
      authorizationScope: 'installation',
    });
    expect(statements[0]).toContain('excluded_at IS NULL');
    expect(statements[0]).toContain('ORDER BY id ASC LIMIT $2');
    expect(params[0]).toEqual(['', 5]);
  });
});
