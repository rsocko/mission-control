import { randomUUID } from 'node:crypto';
import { describe, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresTriagePersistenceRepositories,
} from '@/db/postgres/repositories/triage-repositories';
import {
  describeTriagePersistenceContract,
} from '../contracts/triage-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL triage persistence integration', () => {
  describeTriagePersistenceContract('PostgreSQL', async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-triage-persistence-test',
      }),
    });
    await backend.initialize();

    // Layer 7 migration metadata is intentionally deferred until the stack rebase.
    await backend.context.pool.query(`
      ALTER TABLE triage_sync_state
      ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0
    `);
    const connectorIds = new Set<string>();

    return {
      repositories: createPostgresTriagePersistenceRepositories(backend.context.db),
      seedGitHubConnector: async (input) => {
        const id = input.id ?? `triage-contract-${randomUUID()}`;
        connectorIds.add(id);
        await backend.context.pool.query(`
          INSERT INTO connector_configs (
            id, type, name, enabled, capabilities, credentials,
            created_at, updated_at, deleted_at
          ) VALUES (
            $1, 'github-issues', 'Triage contract', $2, '{}'::jsonb,
            $3::jsonb, $4, $4, $5
          )
        `, [
          id,
          input.enabled !== false,
          JSON.stringify(input.token ? { token: input.token } : {}),
          input.createdAt ?? '2026-08-29T10:00:00.000Z',
          input.deleted ? '2026-08-29T10:30:00.000Z' : null,
        ]);
      },
      close: async () => {
        await backend.context.pool.query(
          `DELETE FROM triage_items WHERE source_url LIKE 'https://source.invalid/%'`,
        );
        await backend.context.pool.query(`
          DELETE FROM triage_sync_state
          WHERE id LIKE 'sync-%'
             OR id LIKE 'cas-%'
             OR id = 'malformed-counts'
        `);
        for (const id of connectorIds) {
          await backend.context.pool.query(
            'DELETE FROM connector_configs WHERE id = $1',
            [id],
          );
        }
        await backend.shutdown();
      },
    };
  });
});
