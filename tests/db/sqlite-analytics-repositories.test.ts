import { afterAll, beforeAll, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeAnalyticsRepositoriesContract } from '../contracts/analytics-repositories.contract';

/**
 * SQLite driver for the shared analytics contract. Uses a real migrated
 * database so the moved Drizzle query bodies run exactly as they do in
 * production, including every trigger and CHECK constraint.
 *
 * Isolation is per case and by construction: the migrated schema is built once
 * into a template file, and each case runs against a fresh byte copy that is
 * deleted afterwards. Nothing is ever deleted from `task_history_events`, so
 * the production append-only guard stays fully armed rather than being dropped,
 * disabled, or worked around.
 */

const templatePath = path.join(os.tmpdir(), `mission-control-analytics-template-${randomUUID()}.db`);
const copies = new Set<string>();

async function buildTemplate(): Promise<void> {
  process.env.MC_DB_PATH = templatePath;
  vi.doUnmock('drizzle-orm');
  vi.resetModules();
  // Importing the app database module creates the file and runs every
  // migration, so the template carries the real triggers and constraints.
  const { sqlite } = await import('@/db');
  // Closing checkpoints the WAL, so the single file is a complete snapshot.
  sqlite.close();
}

async function openCopy() {
  const databasePath = path.join(os.tmpdir(), `mission-control-analytics-${randomUUID()}.db`);
  copyFileSync(templatePath, databasePath);
  copies.add(databasePath);
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('@/db/schema');
  const connection: Database.Database = new BetterSqlite3(databasePath);
  return { connection, databasePath, db: drizzle(connection, { schema }) };
}

function discard(connection: Database.Database, databasePath: string) {
  connection.close();
  copies.delete(databasePath);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

beforeAll(async () => {
  await buildTemplate();
});

afterAll(() => {
  for (const databasePath of copies) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
  copies.clear();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${templatePath}${suffix}`, { force: true });
  }
  delete process.env.MC_DB_PATH;
});

describeAnalyticsRepositoriesContract('SQLite', async () => {
  const { connection, databasePath, db } = await openCopy();
  const { createSqliteAnalyticsPersistence } = await import(
    '@/db/persistence/sqlite-analytics-repositories'
  );
  return {
    repository: createSqliteAnalyticsPersistence(db),
    async insert(table, row) {
      const columns = Object.keys(row);
      connection.prepare(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...columns.map((column) => toSqliteValue(row[column])));
    },
    close: () => discard(connection, databasePath),
  };
});

/** SQLite has no boolean type; Drizzle stores them as 0/1 integers. */
function toSqliteValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value ?? null;
}
