import { eq } from 'drizzle-orm';
import type { PersistenceJson } from '@/db/persistence/contracts';
import type { SettingsRepository } from '@/db/persistence/core-repositories';
import type { PostgresDatabase } from '../runtime';
import { appSettings } from '../schema';

/**
 * PostgreSQL-backed implementation of the portable `SettingsRepository`
 * contract. Settings are a plain key/value table (`app_settings`), so this
 * adapter is a thin, transaction-free wrapper around upsert/select/delete.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(key: string): Promise<PersistenceJson | null> {
    const [row] = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return row ? (row.value as PersistenceJson) : null;
  }

  async set(key: string, value: PersistenceJson): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(appSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: now },
      });
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.db
      .delete(appSettings)
      .where(eq(appSettings.key, key))
      .returning({ key: appSettings.key });
    return deleted.length > 0;
  }
}
