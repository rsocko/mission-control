import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteSettingsRepository } from '@/db/persistence/sqlite-core-repositories';
import {
  describeSettingsRepositoryBatchContract,
  type SettingsRepositoryBatchHarness,
} from '../contracts/settings-repository-batch.contract';

async function createHarness(): Promise<SettingsRepositoryBatchHarness> {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE semantic_index_identities (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      status TEXT NOT NULL,
      vector_count INTEGER NOT NULL
    );
  `);
  const repository = new SqliteSettingsRepository(database);
  return {
    repository,
    concurrentRepository: new SqliteSettingsRepository(database),
    freshRepository: () => new SqliteSettingsRepository(database),
    async forceRollback(firstKey, failureKey) {
      database.exec(`
        CREATE TRIGGER settings_batch_forced_failure
        BEFORE UPDATE ON app_settings
        WHEN NEW.key = '${failureKey.replaceAll("'", "''")}'
        BEGIN
          SELECT RAISE(ABORT, 'forced settings batch failure');
        END;
      `);
      try {
        await repository.setMany([
          [firstKey, 'after'],
          [failureKey, 'after'],
        ]);
      } finally {
        database.exec('DROP TRIGGER settings_batch_forced_failure');
      }
    },
    async ensureActiveEmbeddingIdentity() {
      const identity = {
        provider: 'azure',
        model: `embedding-${randomUUID()}`,
        dimensions: 1536,
        vectorCount: 17,
      };
      database.prepare(`
        INSERT INTO semantic_index_identities (
          id, provider, model, dimensions, status, vector_count
        ) VALUES (?, ?, ?, ?, 'active', ?)
      `).run(
        `identity-${randomUUID()}`,
        identity.provider,
        identity.model,
        identity.dimensions,
        identity.vectorCount,
      );
      return identity;
    },
    async close() {
      database.close();
    },
  };
}

describeSettingsRepositoryBatchContract('SQLite', createHarness);
