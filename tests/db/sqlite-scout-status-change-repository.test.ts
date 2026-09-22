import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ScoutStatusChangeRepository } from '@/lib/connectors/scout/status-change-repository';
import {
  describeScoutStatusChangeRepositoryContract,
  type ScoutStatusChangeContractHarness,
} from '../contracts/scout-status-change-repository.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.resetModules();
});

describe('SQLite Scout status-change adapter', () => {
  let sqlite: Database.Database;
  let harness: ScoutStatusChangeContractHarness;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteScoutStatusChangeRepository } = await import(
      '@/db/persistence/sqlite-scout-status-change-repository'
    );
    sqlite = database.sqlite;
    const repository: ScoutStatusChangeRepository =
      createSqliteScoutStatusChangeRepository(sqlite);
    harness = {
      repository,
      async reset() {
        sqlite.exec(`
          DELETE FROM tasks;
          DELETE FROM app_settings WHERE key = 'scout_write_back_synced_at';
        `);
      },
      async seed(records) {
        const insert = sqlite.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            status_reason, completed_at, snoozed_until, created_at, updated_at,
            last_synced_at, metadata
          ) VALUES (?, ?, 'scout', 'scout', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const record of records) {
          insert.run(
            record.mcTaskId,
            record.sourceId,
            record.title,
            record.status,
            record.statusReason,
            record.completedAt,
            record.snoozedUntil,
            record.updatedAt,
            record.updatedAt,
            record.updatedAt,
            JSON.stringify(JSON.stringify({ sourceType: record.sourceType })),
          );
        }
      },
    };
  }, 30_000);

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  describeScoutStatusChangeRepositoryContract('SQLite', () => harness);

  it('maps malformed and non-string source metadata to unknown without failing', async () => {
    await harness.reset();
    const insert = sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        created_at, updated_at, last_synced_at, metadata
      ) VALUES (?, ?, 'scout', 'scout', ?, 'todo', ?, ?, ?, ?)
    `);
    insert.run(
      'scout-malformed',
      'scout:legacy:malformed',
      'Malformed',
      '2026-09-08T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
      '{not-json',
    );
    insert.run(
      'scout-non-string',
      'scout:legacy:number',
      'Non-string',
      '2026-09-08T11:00:00.000Z',
      '2026-09-08T11:00:00.000Z',
      '2026-09-08T11:00:00.000Z',
      JSON.stringify({ sourceType: 42 }),
    );

    const page = await harness.repository.listChanges({
      since: null,
      through: '2026-09-08T12:00:00.000Z',
      sourceTypes: null,
      limit: 10,
    });
    expect(page.changes.map(({ sourceType }) => sourceType)).toEqual([
      'unknown',
      'unknown',
    ]);
  });
});
