import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  runConnectorOperationLeaseRepositoryContract,
} from '../contracts/connector-operation-lease-repository.contract';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-sqlite-lease-contract-'));
process.env.MC_DB_PATH = join(directory, 'lease-contract.db');

let database: typeof import('@/db');
let repository:
  typeof import('@/db/persistence/sqlite-connector-operation-lease-repository')
  ['sqliteConnectorOperationLeaseRepository'];

runConnectorOperationLeaseRepositoryContract('SQLite connector-operation lease contract', {
  async setup() {
    database = await importInitializedSqliteDatabase();
    ({ sqliteConnectorOperationLeaseRepository: repository } = await import(
      '@/db/persistence/sqlite-connector-operation-lease-repository'
    ));
  },
  async reset() {
    database.sqlite.exec(`
      DELETE FROM connector_operation_leases;
      DELETE FROM connector_maintenance_locks;
      DELETE FROM connector_configs;
    `);
  },
  async teardown() {
    database.sqlite.close();
  },
  repository: () => repository,
  async createConnector(label) {
    const id = `sqlite-lease-contract-${label}`;
    const now = new Date().toISOString();
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at
      ) VALUES (?, 'test', ?, 1, 'poll', 5, '{}', '{}', '{}', '[]', ?, ?)
    `).run(id, label, now, now);
    return id;
  },
  async setMaintenanceLock(connectorId, locked) {
    if (!locked) {
      database.sqlite.prepare(
        'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = ?',
      ).run(connectorId);
      return;
    }
    const now = new Date().toISOString();
    database.sqlite.prepare(`
      INSERT INTO connector_maintenance_locks (
        connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
      ) VALUES (?, ?, 'contract', 'contract test', ?, ?)
    `).run(connectorId, `lock-${connectorId}`, now, now);
  },
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
});
