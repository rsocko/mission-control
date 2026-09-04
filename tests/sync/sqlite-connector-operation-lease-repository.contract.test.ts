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
      DELETE FROM github_repository_repoints;
      DELETE FROM external_entities;
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
    const operationId = `lock-${connectorId}`;
    const entityId = `entity-${connectorId}`;
    database.sqlite.prepare(`
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id, identity_version,
        next_locator_revision, first_seen_at, last_seen_at
      ) VALUES (?, 'github', 'github.com', 'repository', ?, 1, 1, ?, ?)
    `).run(entityId, `R_${connectorId}`, now, now);
    database.sqlite.prepare(`
      INSERT INTO github_repository_repoints (
        id, connector_instance_id, idempotency_key, phase, actor, host_key,
        repository_entity_id, repository_stable_id, from_owner, from_repository,
        to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
        rollback_snapshot, verification, last_error, created_at, updated_at, completed_at
      ) VALUES (
        ?, ?, ?, 'locked', 'contract', 'github.com', ?, ?,
        'old', 'repo', 'new', 'repo', 1, '{}', '{}', '{}', NULL, NULL, ?, ?, NULL
      )
    `).run(
      operationId,
      connectorId,
      `maintenance-${connectorId}`,
      entityId,
      `R_${connectorId}`,
      now,
      now,
    );
    database.sqlite.prepare(`
      INSERT INTO connector_maintenance_locks (
        connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
      ) VALUES (?, ?, 'contract', 'contract test', ?, ?)
    `).run(connectorId, operationId, now, now);
  },
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
});
