import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresSettingsRepository } from '@/db/postgres/repositories/settings-repository';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describeSettingsRepositoryBatchContract,
  type SettingsRepositoryBatchHarness,
} from '../contracts/settings-repository-batch.contract';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL settings batch integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-settings-batch-test',
          }),
        }
      : {}),
  });
  const ownedKeys = new Set<string>();
  const ownedIdentities = new Set<string>();

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    await backend.initialize();
  }, 120_000);

  afterAll(async () => {
    await backend.context.pool.query(
      `DELETE FROM app_settings WHERE key LIKE 'settings-batch-%'`,
    );
    for (const key of ownedKeys) {
      await backend.context.pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
    }
    for (const id of ownedIdentities) {
      await backend.context.pool.query(
        'DELETE FROM semantic_index_identities WHERE id = $1',
        [id],
      );
    }
    await backend.shutdown();
  });

  describeSettingsRepositoryBatchContract('PostgreSQL', async () => {
    const repository = new PostgresSettingsRepository(backend.context.db);
    return {
      repository,
      concurrentRepository: new PostgresSettingsRepository(backend.context.db),
      freshRepository: () => new PostgresSettingsRepository(backend.context.db),
      async forceRollback(firstKey: string, failureKey: string) {
        ownedKeys.add(firstKey);
        ownedKeys.add(failureKey);
        const suffix = randomUUID().replaceAll('-', '');
        const functionName = `settings_batch_fail_${suffix}`;
        const triggerName = `settings_batch_trigger_${suffix}`;
        await backend.context.pool.query(`
          CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
          BEGIN
            IF NEW.key = '${failureKey.replaceAll("'", "''")}' THEN
              RAISE EXCEPTION 'forced settings batch failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await backend.context.pool.query(`
          CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON app_settings
          FOR EACH ROW EXECUTE FUNCTION ${functionName}()
        `);
        try {
          await repository.setMany([
            [firstKey, 'after'],
            [failureKey, 'after'],
          ]);
        } finally {
          await backend.context.pool.query(`DROP TRIGGER ${triggerName} ON app_settings`);
          await backend.context.pool.query(`DROP FUNCTION ${functionName}()`);
        }
      },
      async ensureActiveEmbeddingIdentity() {
        const existing = await repository.getActiveEmbeddingIdentity();
        if (existing) return existing;
        const id = `settings-batch-identity-${randomUUID()}`;
        const identity = {
          provider: 'azure',
          model: `embedding-${randomUUID()}`,
          dimensions: 1536,
          vectorCount: 17,
        };
        try {
          await backend.context.pool.query(
            `INSERT INTO semantic_index_identities (
              id, provider, model, dimensions, projection_version, status,
              document_count, vector_count, created_at, updated_at, activated_at
            ) VALUES ($1, $2, $3, $4, 1, 'active', 0, $5, $6, $6, $6)`,
            [
              id,
              identity.provider,
              identity.model,
              identity.dimensions,
              identity.vectorCount,
              new Date().toISOString(),
            ],
          );
          ownedIdentities.add(id);
          return identity;
        } catch (error) {
          const concurrentlyCreated = await repository.getActiveEmbeddingIdentity();
          if (concurrentlyCreated) return concurrentlyCreated;
          throw error;
        }
      },
      async close() {
        for (const key of ownedKeys) await repository.delete(key);
      },
    } satisfies SettingsRepositoryBatchHarness;
  });
});
