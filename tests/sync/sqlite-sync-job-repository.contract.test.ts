import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { runSyncJobRepositoryContract } from '../contracts/sync-job-repository.contract';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-sqlite-sync-contract-'));
process.env.MC_DB_PATH = join(directory, 'sync-contract.db');

let database: typeof import('@/db');
let repository: typeof import('@/db/persistence/sqlite-sync-job-repository')
  ['sqliteSyncJobRepository'];

runSyncJobRepositoryContract('SQLite sync job repository contract', {
  async setup() {
    database = await importInitializedSqliteDatabase();
    ({ sqliteSyncJobRepository: repository } = await import(
      '@/db/persistence/sqlite-sync-job-repository'
    ));
  },
  async reset() {
    database.sqlite.exec(`
      DELETE FROM connector_operation_leases;
      DELETE FROM sync_job_events;
      DELETE FROM sync_jobs;
      DELETE FROM sync_schedules;
      DELETE FROM connector_configs;
    `);
  },
  async teardown() {
    database.sqlite.close();
  },
  repository: () => repository,
  async createConnector(label) {
    const id = `sqlite-contract-${label}`;
    const now = new Date().toISOString();
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at
      ) VALUES (?, 'test', ?, 1, 'poll', 5, '{}', '{}', '{}', '[]', ?, ?)
    `).run(id, label, now, now);
    return id;
  },
  async makeRunnable(jobId) {
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(jobId);
  },
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
});
