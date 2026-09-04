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
        await backend.context.pool.query(
          'DELETE FROM github_repository_repoints WHERE connector_instance_id = $1',
          [id],
        );
        await backend.context.pool.query(
          'DELETE FROM external_entities WHERE id = $1',
          [`entity-${id}`],
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
      const operationId = `lock-${connectorId}`;
      const entityId = `entity-${connectorId}`;
      await backend.context.pool.query(
        `INSERT INTO external_entities (
           id, provider, host_key, entity_type, stable_id, identity_version,
           next_locator_revision, first_seen_at, last_seen_at
         ) VALUES ($1, 'github', 'github.com', 'repository', $2, 1, 1, $3, $3)`,
        [entityId, `R_${connectorId}`, now],
      );
      await backend.context.pool.query(
        `INSERT INTO github_repository_repoints (
           id, connector_instance_id, idempotency_key, phase, actor, host_key,
           repository_entity_id, repository_stable_id, from_owner, from_repository,
           to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
           rollback_snapshot, verification, last_error, created_at, updated_at, completed_at
         ) VALUES (
           $1, $2, $3, 'locked', 'contract', 'github.com', $4, $5,
           'old', 'repo', 'new', 'repo', true, '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, NULL, NULL, $6, $6, NULL
         )`,
        [
          operationId,
          connectorId,
          `maintenance-${connectorId}`,
          entityId,
          `R_${connectorId}`,
          now,
        ],
      );
      await backend.context.pool.query(
        `INSERT INTO connector_maintenance_locks (
           connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
         ) VALUES ($1, $2, 'contract', 'contract test', $3, $3)`,
        [connectorId, operationId, now],
      );
    },
  },
);
