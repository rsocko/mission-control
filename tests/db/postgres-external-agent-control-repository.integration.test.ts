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
