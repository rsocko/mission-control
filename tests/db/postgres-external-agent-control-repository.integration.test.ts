import { afterAll, beforeAll, describe } from 'vitest';
import type { Pool } from 'pg';
import type { ExternalAgentControlPersistence } from '@/db/persistence/external-agent-control';
import {
  externalAgentControlRepositoryContract,
  type ExternalAgentControlContractSeed,
} from '../contracts/external-agent-control-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL external-agent control adapter', () => {
  let pool: Pool;
  let repository: ExternalAgentControlPersistence;
  let contractSeed: ExternalAgentControlContractSeed;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresExternalAgentControlRepository }] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/external-agent-control-repository'),
    ]);
    pool = new Pool({ connectionString });
    repository = createPostgresExternalAgentControlRepository(pool);
    contractSeed = {
      async reset() {
        await pool.query(`
          DELETE FROM agent_dispatch_events;
          DELETE FROM agent_dispatch_attempts;
          DELETE FROM agent_dispatches;
          DELETE FROM external_agents;
          DELETE FROM tasks
          WHERE id IN ('contract-task', 'contract-child-a', 'contract-child-b');
          DELETE FROM inbound_webhooks
          WHERE id IN ('callback', 'missing')
        `);
      },
      async protectedWebhook(id) {
        await pool.query(`
          INSERT INTO inbound_webhooks (
            id, name, source_label, secret, enabled, default_action,
            field_mappings, total_received, created_at, updated_at
          ) VALUES (
            $1, 'Contract callback', 'agent', 'secret', TRUE, 'auto',
            '{}'::jsonb, 0, $2, $2
          )
        `, [id, '2026-01-01T00:00:00.000Z']);
      },
      async richTask() {
        await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, effort, assignee, source_list_name,
            created_at, updated_at, last_synced_at
          ) VALUES (
            'contract-task', 'octo/example:1', 'github-issues', 'github',
            'Contract parent', 'Parent details', 'todo', 'high', '2026-02-01',
            3, 'octocat', 'octo/example',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title,
            status, priority, parent_id, sibling_order, depth, is_checklist_item,
            created_at, updated_at, last_synced_at
          ) VALUES
            (
              'contract-child-b', 'contract-child-b', 'local', 'local',
              'Second child', 'todo', 'medium', 'contract-task', 2, 1, FALSE,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z'
            ),
            (
              'contract-child-a', 'contract-child-a', 'local', 'local',
              'First child', 'todo', 'medium', 'contract-task', 1, 1, TRUE,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z'
            )
        `);
      },
    };
  });

  afterAll(async () => {
    await contractSeed?.reset();
    await pool?.end();
  });

  externalAgentControlRepositoryContract(
    'PostgreSQL',
    () => repository,
    () => contractSeed,
  );
});
