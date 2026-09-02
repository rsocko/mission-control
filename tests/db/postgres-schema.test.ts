import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableName, isTable, type Table } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';
import { getTableConfig as getPostgresTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as postgresSchema from '@/db/postgres/schema';
import * as sqliteSchema from '@/db/schema';

function exportedTables(schema: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(schema)
      .filter((entry): entry is [string, Table] => isTable(entry[1]))
      .map(([exportName, table]) => [exportName, table]),
  );
}

/**
 * PostgreSQL-only additive tables with no SQLite counterpart. SQLite's
 * equivalent keyword-search mirror (`tasks_fts`/`alerts_fts`) is a raw FTS5
 * virtual table created via `sqlite.exec(...)` in
 * `src/lib/search/sqlite-fts-repository.ts` — it is never represented in
 * `src/db/schema/**`, so there is nothing on the SQLite side for these two
 * tables to have parity with. They are excluded from the strict 1:1
 * SQLite<->PostgreSQL schema-parity checks below and instead validated by
 * their own dedicated structural assertions (see
 * "adds PostgreSQL-only search-index tables..." below).
 */
const POSTGRES_ONLY_TABLE_EXPORTS = new Set(['taskSearchDocuments', 'notificationSearchDocuments']);

function sharedTables(schema: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(exportedTables(schema)).filter(([exportName]) => !POSTGRES_ONLY_TABLE_EXPORTS.has(exportName)),
  );
}

describe('PostgreSQL schema', () => {
  it('has a table and column equivalent for every SQLite schema export', () => {
    const sqliteTables = exportedTables(sqliteSchema);
    const postgresTables = sharedTables(postgresSchema);

    expect(Object.keys(postgresTables)).toHaveLength(163);
    expect(Object.keys(postgresTables).sort()).toEqual(Object.keys(sqliteTables).sort());

    for (const [exportName, sqliteTable] of Object.entries(sqliteTables)) {
      const postgresTable = postgresTables[exportName];
      expect(getTableName(postgresTable), exportName).toBe(getTableName(sqliteTable));

      const sqliteColumns = Object.values(getTableColumns(sqliteTable)).map((column) => column.name);
      const postgresColumns = Object.values(getTableColumns(postgresTable))
        .map((column) => column.name)
        .filter((name) => name !== 'search_vector');
      expect(postgresColumns, exportName).toEqual(sqliteColumns);

      const sqliteColumnConfig = Object.values(getTableColumns(sqliteTable)).map((column) => ({
        name: column.name,
        dataType: column.dataType,
        primary: column.primary,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
      }));
      const postgresColumnConfig = Object.values(getTableColumns(postgresTable))
        .filter((column) => column.name !== 'search_vector')
        .map((column) => ({
          name: column.name,
          dataType: column.dataType,
          primary: column.primary,
          notNull: column.notNull,
          hasDefault: column.hasDefault,
        }));
      expect(postgresColumnConfig, exportName).toEqual(sqliteColumnConfig);
    }
  });

  it('preserves declared indexes and constraint topology for every table', () => {
    const sqliteTables = exportedTables(sqliteSchema);
    const postgresTables = exportedTables(postgresSchema);

    for (const [exportName, sqliteTable] of Object.entries(sqliteTables)) {
      const postgresTable = postgresTables[exportName];
      const sqlite = getSqliteTableConfig(
        sqliteTable as Parameters<typeof getSqliteTableConfig>[0],
      );
      const postgres = getPostgresTableConfig(
        postgresTable as Parameters<typeof getPostgresTableConfig>[0],
      );

      const sqliteIndexes = sqlite.indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        partial: index.config.where !== undefined,
      }));
      const postgresIndexes = postgres.indexes
        .filter((index) => !index.config.name?.endsWith('_search_vector'))
        .map((index) => ({
          name: index.config.name,
          unique: index.config.unique,
          partial: index.config.where !== undefined,
        }));
      expect(postgresIndexes, `${exportName} indexes`).toEqual(sqliteIndexes);

      const foreignKeys = (config: typeof sqlite | typeof postgres) =>
        config.foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          return {
            columns: reference.columns.map((column) => column.name),
            foreignTable: getTableName(reference.foreignTable),
            foreignColumns: reference.foreignColumns.map((column) => column.name),
            onDelete: foreignKey.onDelete ?? 'no action',
            onUpdate: foreignKey.onUpdate ?? 'no action',
          };
        });
      expect(foreignKeys(postgres), `${exportName} foreign keys`).toEqual(
        foreignKeys(sqlite),
      );

      expect(
        postgres.primaryKeys.map((key) => key.columns.map((column) => column.name)),
        `${exportName} primary keys`,
      ).toEqual(sqlite.primaryKeys.map((key) => key.columns.map((column) => column.name)));
      expect(
        postgres.checks.map((check) => check.name),
        `${exportName} checks`,
      ).toEqual(sqlite.checks.map((check) => check.name));
    }
  });

  it('uses PostgreSQL-native booleans, jsonb, serial keys, and text timestamps', () => {
    expect(postgresSchema.tasks.isChecklistItem.columnType).toBe('PgBoolean');
    expect(postgresSchema.tasks.metadata.columnType).toBe('PgJsonb');
    expect(postgresSchema.taskHistoryEvents.id.columnType).toBe('PgSerial');
    expect(postgresSchema.tasks.createdAt.columnType).toBe('PgText');
    expect(postgresSchema.financeTransactions.tags.columnType).toBe('PgJsonb');
  });

  it('preserves representative keys, cascades, checks, and critical indexes', () => {
    const tasks = getPostgresTableConfig(postgresSchema.tasks);
    expect(tasks.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'idx_tasks_source_connector',
        'idx_tasks_list_counts',
        'idx_tasks_due_reminder',
        'idx_tasks_search_vector',
      ]),
    );
    expect(
      tasks.indexes.find((index) => index.config.name === 'idx_tasks_search_vector')?.config.method,
    ).toBe('gin');

    const dependencies = getPostgresTableConfig(postgresSchema.taskDependencies);
    expect(dependencies.foreignKeys).toHaveLength(2);
    expect(dependencies.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      'cascade',
      'cascade',
    ]);

    const facts = getPostgresTableConfig(postgresSchema.financeInsightPublicationFacts);
    expect(facts.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'publication_id',
      'kind',
      'source_ref',
    ]);
    expect(facts.foreignKeys[0]?.onDelete).toBe('cascade');

    const externalEntities = getPostgresTableConfig(postgresSchema.externalEntities);
    expect(externalEntities.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'external_entities_type_check',
        'external_entities_identity_version_check',
      ]),
    );

    const notifications = getPostgresTableConfig(postgresSchema.notifications);
    expect(
      notifications.indexes.find(
        (index) => index.config.name === 'idx_notifications_search_vector',
      )?.config.method,
    ).toBe('gin');
  });

  it('adds PostgreSQL-only search-index tables that are excluded from SQLite parity', () => {
    for (const exportName of POSTGRES_ONLY_TABLE_EXPORTS) {
      expect(postgresSchema[exportName as keyof typeof postgresSchema], exportName).toBeDefined();
      expect(
        (sqliteSchema as Record<string, unknown>)[exportName],
        `${exportName} must have no SQLite counterpart`,
      ).toBeUndefined();
    }

    const taskDocs = getPostgresTableConfig(postgresSchema.taskSearchDocuments);
    expect(getTableName(postgresSchema.taskSearchDocuments)).toBe('task_search_documents');
    expect(
      taskDocs.indexes.find((index) => index.config.name === 'idx_task_search_documents_vector')
        ?.config.method,
    ).toBe('gin');
    expect(taskDocs.foreignKeys).toHaveLength(1);
    expect(taskDocs.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(taskDocs.foreignKeys[0]?.reference().foreignTable).toBe(postgresSchema.tasks);

    const notificationDocs = getPostgresTableConfig(postgresSchema.notificationSearchDocuments);
    expect(getTableName(postgresSchema.notificationSearchDocuments)).toBe('notification_search_documents');
    expect(
      notificationDocs.indexes.find(
        (index) => index.config.name === 'idx_notification_search_documents_vector',
      )?.config.method,
    ).toBe('gin');
    expect(notificationDocs.foreignKeys).toHaveLength(1);
    expect(notificationDocs.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(notificationDocs.foreignKeys[0]?.reference().foreignTable).toBe(postgresSchema.notifications);
  });

  it('ships one clean PostgreSQL baseline plus additive notification enrichment', () => {
    const migrationDirectory = resolve(process.cwd(), 'drizzle/postgres');
    const migrations = readdirSync(migrationDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(migrations).toHaveLength(2);

    const sql = readFileSync(resolve(migrationDirectory, migrations[0]), 'utf8');
    // 162 shared tables (parity with SQLite) + 2 PostgreSQL-only search-index tables.
    expect(sql.match(/^CREATE TABLE /gm)).toHaveLength(164);
    expect(sql).toContain('CREATE TABLE "task_search_documents"');
    expect(sql).toContain('CREATE TABLE "notification_search_documents"');
    expect(sql).toContain('"id" serial PRIMARY KEY NOT NULL');
    expect(sql).toContain('"metadata" jsonb');
    expect(sql).toContain('"is_checklist_item" boolean');
    expect(sql).toMatch(
      /CREATE TABLE "triage_sync_state" \([\s\S]*"revision" integer DEFAULT 0 NOT NULL/,
    );
    expect(sql).toContain('"search_vector" "tsvector" GENERATED ALWAYS AS');
    expect(sql).toContain('USING gin ("search_vector")');
    expect(sql).not.toContain('AUTOINCREMENT');

    const enrichmentSql = readFileSync(resolve(migrationDirectory, migrations[1]), 'utf8');
    expect(enrichmentSql).toContain('CREATE TABLE "notification_enrichment_jobs"');
    expect(enrichmentSql).toContain(
      'ALTER TABLE "notifications" ADD COLUMN "enrichment_revision" text',
    );
    expect(enrichmentSql).toContain(
      'ALTER TABLE "notifications" ADD COLUMN "enrichment_generation" integer',
    );
    expect(enrichmentSql).toContain('idx_notification_enrichment_generation');
    expect(sql).not.toContain('PRAGMA');
  });
});
