import Database from 'better-sqlite3';
import { SqliteSettingsRepository } from '@/db/persistence/sqlite-core-repositories';
import { CorePreferenceSettingsRepository } from '@/lib/settings/preference-settings';
import {
  describePreferenceSettingsRepositoryContract,
  type PreferenceSettingsRepositoryHarness,
} from '../contracts/preference-settings-repository.contract';

async function createHarness(): Promise<PreferenceSettingsRepositoryHarness> {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const settings = new SqliteSettingsRepository(database);
  return {
    settings,
    repository: new CorePreferenceSettingsRepository(settings),
    async close() {
      database.close();
    },
  };
}

describePreferenceSettingsRepositoryContract('SQLite', createHarness);
