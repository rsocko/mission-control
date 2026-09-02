import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import {
  compareSqliteImportSchema,
  dependencySafeTableOrder,
  expectedImportTableNames,
  expectedJsonTargetColumns,
  preflightJsonCompatibility,
} from '../../scripts/lib/sqlite-to-postgres-import';

const migrationsDirectory = resolve(process.cwd(), 'drizzle');

describe('notification enrichment SQLite-to-PostgreSQL import support', () => {
  it('includes the queue after its notification parent and preflights payload JSON', () => {
    const { sourceTables, targetTables } = expectedImportTableNames();
    expect(sourceTables).toContain('notification_enrichment_jobs');
    expect(targetTables).toContain('notification_enrichment_jobs');
    const order = dependencySafeTableOrder(sourceTables, [{
      table: 'notification_enrichment_jobs',
      columns: ['notification_id'],
      referencedTable: 'notifications',
      referencedColumns: ['id'],
    }]);
    expect(order.indexOf('notification_enrichment_jobs')).toBeGreaterThan(
      order.indexOf('notifications'),
    );
    expect(expectedJsonTargetColumns()).toContainEqual({
      table: 'notification_enrichment_jobs',
      column: 'payload',
    });
  });

  it('keeps freshly migrated queue schemas aligned and rejects poisoned payloads safely', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      runOrderedDatabaseBootstrap(sqlite, migrationsDirectory);
      expect(compareSqliteImportSchema(sqlite, migrationsDirectory)
        .filter(({ table }) => table === 'notification_enrichment_jobs')).toEqual([]);
      sqlite.exec(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, level, level_rank,
          category, state, read_state, disposition, source_state, sync_state, is_actionable,
          received_at, sort_at, metadata, presentation
        ) VALUES (
          'n1', 's1', 'github-issues', 'c1', 'Title', 'fyi', 3, 'development',
          'unread', 'unread', 'inbox', 'active', 'synced', 1, 'now', 'now', '{}', '{}'
        );
        INSERT INTO notification_enrichment_jobs (
          id, notification_id, source_id, source_revision, source_generation, payload,
          next_attempt_at, created_at, updated_at
        ) VALUES ('j1', 'n1', 's1', 'r1', 1, 'secret-invalid-json', 'now', 'now', 'now');
      `);
      const report = preflightJsonCompatibility(sqlite);
      expect(report.issues).toContainEqual({
        table: 'notification_enrichment_jobs',
        column: 'payload',
        category: 'invalid-json',
        count: 1,
      });
      expect(JSON.stringify(report)).not.toContain('secret-invalid-json');
    } finally {
      sqlite.close();
    }
  });
});
