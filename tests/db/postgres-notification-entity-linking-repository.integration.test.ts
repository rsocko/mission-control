import { describe, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresNotificationEntityLinkingRepository,
} from '@/db/postgres/repositories/notification-entity-linking-repository';
import {
  describeNotificationEntityLinkingContract,
} from '../contracts/notification-entity-linking.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL notification entity-linking integration', () => {
  describeNotificationEntityLinkingContract('PostgreSQL', async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-notification-entity-linking-test',
      }),
    });
    await backend.initialize();

    const taskIds = new Set<string>();
    const projectIds = new Set<string>();
    const timestamp = '2026-01-01T00:00:00.000Z';

    return {
      repository: createPostgresNotificationEntityLinkingRepository(backend.context.pool),
      seedTask: async (input) => {
        taskIds.add(input.id);
        await backend.context.pool.query(
          `INSERT INTO tasks (
             id, source_id, connector_type, connector_instance_id, title, status,
             priority, created_at, updated_at, last_synced_at
           ) VALUES (
             $1, $2, 'github-issues', $3, 'Entity-link contract', 'todo', 'normal', $4, $4, $4
           )`,
          [input.id, input.sourceId, input.connectorInstanceId, timestamp],
        );
      },
      seedProject: async (input) => {
        projectIds.add(input.id);
        const metadata = input.repositoryJsonValue === undefined
          ? '{}'
          : `{"repository":${input.repositoryJsonValue}}`;
        await backend.context.pool.query(
          `INSERT INTO hub_projects (
             id, name, color, source_bindings, auto_include_rules, kanban_columns,
             default_view, status, hidden, sort_order, hierarchy_revision, metadata,
             created_at, updated_at
           ) VALUES (
             $1, 'Entity-link contract', '#3b82f6', '[]'::jsonb, '[]'::jsonb,
             '[]'::jsonb, 'list', 'active', false, 0, 0, $2::jsonb, $3, $3
           )`,
          [input.id, metadata, timestamp],
        );
      },
      close: async () => {
        for (const id of taskIds) {
          await backend.context.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
        }
        for (const id of projectIds) {
          await backend.context.pool.query('DELETE FROM hub_projects WHERE id = $1', [id]);
        }
        await backend.shutdown();
      },
    };
  });
});
