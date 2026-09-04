import { eq, inArray, sql } from 'drizzle-orm';
import type { PersistenceJson } from '@/db/persistence/contracts';
import type { AtomicSettingsRepository } from '@/db/persistence/core-repositories';
import type { PostgresDatabase } from '../runtime';
import { appSettings, semanticIndexIdentities } from '../schema';

/**
 * PostgreSQL-backed implementation of the portable `SettingsRepository`
 * contract. Settings are a plain key/value table (`app_settings`), so this
 * adapter is a thin, transaction-free wrapper around upsert/select/delete.
 */
export class PostgresSettingsRepository implements AtomicSettingsRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(key: string): Promise<PersistenceJson | null> {
    const [row] = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return row ? (row.value as PersistenceJson) : null;
  }

  async getMany(keys: readonly string[]): Promise<Record<string, PersistenceJson | null>> {
    const values = Object.fromEntries(keys.map((key) => [key, null])) as Record<
      string,
      PersistenceJson | null
    >;
    if (keys.length === 0) return values;
    const rows = await this.db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, [...keys]));
    for (const row of rows) values[row.key] = row.value as PersistenceJson;
    return values;
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

  async setMany(entries: ReadonlyArray<readonly [string, PersistenceJson]>): Promise<void> {
    if (entries.length === 0) return;
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error('Settings batch keys must be unique');
    }
    const now = new Date().toISOString();
    await this.db
      .insert(appSettings)
      .values(entries.map(([key, value]) => ({ key, value, updatedAt: now })))
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: sql.raw('excluded.value'),
          updatedAt: now,
        },
      });
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.db
      .delete(appSettings)
      .where(eq(appSettings.key, key))
      .returning({ key: appSettings.key });
    return deleted.length > 0;
  }

  async getActiveEmbeddingIdentity() {
    const [row] = await this.db
      .select({
        provider: semanticIndexIdentities.provider,
        model: semanticIndexIdentities.model,
        dimensions: semanticIndexIdentities.dimensions,
        vectorCount: semanticIndexIdentities.vectorCount,
      })
      .from(semanticIndexIdentities)
      .where(eq(semanticIndexIdentities.status, 'active'))
      .limit(1);
    return row ?? null;
  }
}
