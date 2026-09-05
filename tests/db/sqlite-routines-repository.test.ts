import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { RoutinesRepository } from '@/db/persistence/routines';
import {
  describeRoutinesRepositoryContract,
  type RoutinesContractHarness,
} from '../contracts/routines-repository.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('SQLite routines adapter', () => {
  let sqlite: Database.Database;
  let repository: RoutinesRepository;
  let harness: RoutinesContractHarness;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteRoutinesRepository } = await import(
      '@/db/persistence/sqlite-routines-repository'
    );
    sqlite = database.sqlite;
    repository = createSqliteRoutinesRepository(sqlite);
    harness = {
      repository,
      async reset() {
        sqlite.exec('DELETE FROM routine_completions; DELETE FROM routines;');
      },
    };
  });

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  describeRoutinesRepositoryContract('SQLite', () => harness);
});
