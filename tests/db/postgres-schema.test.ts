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

describe('PostgreSQL schema', () => {
  it('has a table and column equivalent for every SQLite schema export', () => {
    const sqliteTables = exportedTables(sqliteSchema);
    const postgresTables = exportedTables(postgresSchema);

    expect(Object.keys(postgresTables)).toHaveLength(152);
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

  it('ships one clean PostgreSQL baseline migration', () => {
    const migrationDirectory = resolve(process.cwd(), 'drizzle/postgres');
    const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(migrations).toHaveLength(1);

    const sql = readFileSync(resolve(migrationDirectory, migrations[0]), 'utf8');
    expect(sql.match(/^CREATE TABLE /gm)).toHaveLength(152);
    expect(sql).toContain('"id" serial PRIMARY KEY NOT NULL');
    expect(sql).toContain('"metadata" jsonb');
    expect(sql).toContain('"is_checklist_item" boolean');
    expect(sql).toContain('"search_vector" "tsvector" GENERATED ALWAYS AS');
    expect(sql).toContain('USING gin ("search_vector")');
    expect(sql).not.toContain('AUTOINCREMENT');
    expect(sql).not.toContain('PRAGMA');
  });
});
