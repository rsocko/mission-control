import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const sqliteMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/0148_tyrion_finance_source_identity.sql'),
  'utf8',
);
const postgresMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/postgres/0026_tyrion_finance_source_identity.sql'),
  'utf8',
);

describe('Tyrion Finance source identity migration', () => {
  it('backfills only Finance attention presentation fields without changing task identity', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_list_id TEXT,
        source_list_name TEXT,
        status TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      INSERT INTO tasks VALUES
        (
          'finance-task',
          'finance-attention:v1:signal',
          'mission-control',
          'mission-control',
          'local',
          'Local',
          'in_progress',
          '{"financeAttention":{"signalKind":"writeBackFailed"}}'
        ),
        (
          'local-task',
          'local:task',
          'mission-control',
          'mission-control',
          'local',
          'Local',
          'todo',
          '{}'
        );
    `);

    sqlite.exec(sqliteMigration);
    sqlite.exec(sqliteMigration);

    expect(sqlite.prepare(`
      SELECT id, source_id AS sourceId, connector_type AS connectorType,
             connector_instance_id AS connectorInstanceId,
             source_list_id AS sourceListId, source_list_name AS sourceListName,
             status
      FROM tasks
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'finance-task',
        sourceId: 'finance-attention:v1:signal',
        connectorType: 'mission-control',
        connectorInstanceId: 'mission-control',
        sourceListId: 'tyrion-finance',
        sourceListName: 'Tyrion',
        status: 'in_progress',
      },
      {
        id: 'local-task',
        sourceId: 'local:task',
        connectorType: 'mission-control',
        connectorInstanceId: 'mission-control',
        sourceListId: 'local',
        sourceListName: 'Local',
        status: 'todo',
      },
    ]);
    sqlite.close();
  });

  it('keeps PostgreSQL tasks and keyword-search projections on the same label', () => {
    expect(postgresMigration).toContain(`UPDATE "tasks"`);
    expect(postgresMigration).toContain(`UPDATE "task_search_documents"`);
    expect(postgresMigration.match(/'tyrion-finance'/g)).toHaveLength(1);
    expect(postgresMigration.match(/'Tyrion'/g)).toHaveLength(2);
    expect(postgresMigration.match(/"source_id" LIKE 'finance-attention:%'/g)).toHaveLength(2);
  });
});
