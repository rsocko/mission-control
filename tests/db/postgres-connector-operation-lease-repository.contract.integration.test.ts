import { randomUUID } from 'node:crypto';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  PostgresConnectorOperationLeaseRepository,
} from '@/db/postgres/sync/connector-operation-lease-repository';
import {
  runConnectorOperationLeaseRepositoryContract,
} from '../contracts/connector-operation-lease-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-lease-contract-test',
        }),
      }
    : {}),
});
let repository: PostgresConnectorOperationLeaseRepository;
const connectorIds = new Set<string>();

runConnectorOperationLeaseRepositoryContract(
  'PostgreSQL connector-operation lease contract',
  {
    enabled: Boolean(connectionString),
    async setup() {
      assertSafeIntegrationTestTarget(connectionString!);
      await backend.initialize();
      repository = new PostgresConnectorOperationLeaseRepository(backend.context.pool);
    },
    async reset() {
      for (const id of connectorIds) {
        await backend.context.pool.query(
          'DELETE FROM connector_operation_leases WHERE connector_id = $1',
          [id],
        );
        await backend.context.pool.query(
          'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = $1',
          [id],
        );
        await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
      }
      connectorIds.clear();
    },
    async teardown() {
      await backend.shutdown();
    },
    repository: () => repository,
    async createConnector(label) {
      const id = `pg-lease-contract-${label}-${randomUUID()}`;
      const now = new Date().toISOString();
      await backend.context.pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, capabilities, credentials, settings,
           synced_lists, created_at, updated_at
         ) VALUES ($1, 'test', $2, true, '{}', '{}', '{}', '[]', $3, $3)`,
        [id, label, now],
      );
      connectorIds.add(id);
      return id;
    },
    async setMaintenanceLock(connectorId, locked) {
      if (!locked) {
        await backend.context.pool.query(
          'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = $1',
          [connectorId],
        );
        return;
      }
      const now = new Date().toISOString();
      await backend.context.pool.query(
        `INSERT INTO connector_maintenance_locks (
           connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
         ) VALUES ($1, $2, 'contract', 'contract test', $3, $3)`,
        [connectorId, `lock-${connectorId}`, now],
      );
    },
  },
);
