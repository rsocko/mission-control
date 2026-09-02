import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import {
  compareSqliteImportSchema,
  dependencySafeTableOrder,
  expectedImportTableNames,
  expectedJsonTargetColumns,
  preflightJsonCompatibility,
  runSqliteToPostgresImport,
} from '../../scripts/lib/sqlite-to-postgres-import';

const migrationsDirectory = resolve(process.cwd(), 'drizzle');
const scratchDirectory = resolve(process.cwd(), '.event-outbox-import-scratch');

function migrate(path = ':memory:'): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  runOrderedDatabaseBootstrap(sqlite, migrationsDirectory);
  return sqlite;
}

afterAll(() => {
  rmSync(scratchDirectory, { recursive: true, force: true });
});

describe('event outbox SQLite-to-PostgreSQL import support', () => {
  it('carries both outbox tables through the importer table plan', () => {
    const { sourceTables, targetTables } = expectedImportTableNames();

    expect(sourceTables).toContain('event_outbox');
    expect(sourceTables).toContain('event_outbox_deliveries');
    expect(targetTables).toContain('event_outbox');
    expect(targetTables).toContain('event_outbox_deliveries');
  });

  it('orders deliveries after their event and webhook parents', () => {
    const { sourceTables } = expectedImportTableNames();
    const order = dependencySafeTableOrder(sourceTables, [
      {
        table: 'event_outbox_deliveries',
        columns: ['event_sequence'],
        referencedTable: 'event_outbox',
        referencedColumns: ['sequence'],
      },
      {
        table: 'event_outbox_deliveries',
        columns: ['webhook_id'],
        referencedTable: 'outbound_webhooks',
        referencedColumns: ['id'],
      },
    ]);

    expect(order.indexOf('event_outbox_deliveries'))
      .toBeGreaterThan(order.indexOf('event_outbox'));
    expect(order.indexOf('event_outbox_deliveries'))
      .toBeGreaterThan(order.indexOf('outbound_webhooks'));
  });

  it('registers the outbox payload as a jsonb preflight target', () => {
    expect(expectedJsonTargetColumns()).toContainEqual({
      table: 'event_outbox',
      column: 'payload',
    });
  });

  it('reports no schema drift for a freshly migrated source', () => {
    const sqlite = migrate();
    try {
      const mismatches = compareSqliteImportSchema(sqlite, migrationsDirectory)
        .filter((mismatch) => mismatch.table.startsWith('event_outbox'));
      expect(mismatches).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('accepts a well-formed outbox payload', () => {
    const sqlite = migrate();
    try {
      sqlite.prepare(`
        INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
        VALUES ('k1', 'sync.completed', ?, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
      `).run(JSON.stringify({ connectorId: 'c1', itemsAdded: 3 }));

      expect(preflightJsonCompatibility(sqlite)).toMatchObject({
        issues: [],
      });
    } finally {
      sqlite.close();
    }
  });

  it('rejects a poisoned outbox payload without leaking its contents', () => {
    const sqlite = migrate();
    try {
      const insert = sqlite.prepare(`
        INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
        VALUES (?, 'sync.completed', ?, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
      `);
      insert.run('k-invalid', 'super-secret-not-json');
      insert.run('k-nested', `${'['.repeat(101)}0${']'.repeat(101)}`);

      const report = preflightJsonCompatibility(sqlite);

      expect(report.issues).toEqual(expect.arrayContaining([
        { table: 'event_outbox', column: 'payload', category: 'invalid-json', count: 1 },
        { table: 'event_outbox', column: 'payload', category: 'excessive-nesting', count: 1 },
      ]));
      expect(JSON.stringify(report)).not.toContain('super-secret-not-json');
    } finally {
      sqlite.close();
    }
  });

  it('aborts the import before any PostgreSQL access when the outbox is poisoned', async () => {
    mkdirSync(scratchDirectory, { recursive: true });
    const sourcePath = join(scratchDirectory, 'poisoned-outbox.db');
    rmSync(sourcePath, { force: true });
    const sqlite = migrate(sourcePath);
    try {
      sqlite.prepare(`
        INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
        VALUES ('k-invalid', 'sync.completed', 'not json at all',
                '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
      `).run();
    } finally {
      sqlite.close();
    }

    await expect(runSqliteToPostgresImport({
      sqliteSourcePath: sourcePath,
      confirmWritersStopped: true,
      dryRun: true,
      // Unroutable port: reaching PostgreSQL at all would fail the assertion below.
      postgresUrl: 'postgresql://127.0.0.1:1/mission_control_import_rehearsal',
    })).rejects.toThrow('event_outbox.payload:invalid-json=1');
  });
});
