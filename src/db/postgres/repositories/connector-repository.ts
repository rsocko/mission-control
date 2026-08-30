import { and, eq, isNull } from 'drizzle-orm';
import type { ConnectorConfig } from '@/types';
import type { ConnectorRepository } from '@/db/persistence/core-repositories';
import { RepositoryError } from '@/db/persistence/contracts';
import {
  mergeConnectorSettings,
  patchConnectorSettingsState,
} from '@/db/persistence/connector-settings';
import type { PostgresDatabase } from '../runtime';
import { connectorConfigs } from '../schema';

type ConnectorRow = typeof connectorConfigs.$inferSelect;

function toConnectorConfig(row: ConnectorRow): ConnectorConfig {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    syncMode: row.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
    capabilities: row.capabilities as ConnectorConfig['capabilities'],
    credentials: row.credentials as ConnectorConfig['credentials'],
    settings: row.settings as ConnectorConfig['settings'],
    syncedLists: row.syncedLists as string[],
  };
}

function toSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected connector settings to contain a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * PostgreSQL-backed implementation of the portable `ConnectorRepository`
 * contract. `connector_configs` uses a soft-delete column (`deleted_at`) that
 * several sync-scheduling queries rely on, so `get` excludes soft-deleted
 * rows and `delete` marks the row deleted rather than removing it. `upsert`
 * always clears `deleted_at`, since supplying a full connector record implies
 * the connector is active again.
 */
export class PostgresConnectorRepository implements ConnectorRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string): Promise<ConnectorConfig | null> {
    const [row] = await this.db
      .select()
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.id, id), isNull(connectorConfigs.deletedAt)))
      .limit(1);
    return row ? toConnectorConfig(row) : null;
  }

  async upsert(connector: ConnectorConfig): Promise<ConnectorConfig> {
    const now = new Date().toISOString();
    const values = {
      id: connector.id,
      type: connector.type,
      name: connector.name,
      enabled: connector.enabled,
      syncMode: connector.syncMode,
      pollIntervalMinutes: connector.pollIntervalMinutes ?? null,
      capabilities: connector.capabilities,
      credentials: connector.credentials,
      settings: connector.settings,
      syncedLists: connector.syncedLists,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const [row] = await this.db
      .insert(connectorConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: connectorConfigs.id,
        set: {
          type: values.type,
          name: values.name,
          enabled: values.enabled,
          syncMode: values.syncMode,
          pollIntervalMinutes: values.pollIntervalMinutes,
          capabilities: values.capabilities,
          credentials: values.credentials,
          settings: values.settings,
          syncedLists: values.syncedLists,
          updatedAt: values.updatedAt,
          deletedAt: null,
        },
      })
      .returning();
    return toConnectorConfig(row);
  }

  async delete(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const updated = await this.db
      .update(connectorConfigs)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(connectorConfigs.id, id), isNull(connectorConfigs.deletedAt)))
      .returning({ id: connectorConfigs.id });
    return updated.length > 0;
  }

  async mergeSettings(
    id: string,
    currentSettings: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const settings = mergeConnectorSettings(currentSettings, patch);
    const updated = await this.db
      .update(connectorConfigs)
      .set({ settings, updatedAt: new Date().toISOString() })
      .where(and(eq(connectorConfigs.id, id), isNull(connectorConfigs.deletedAt)))
      .returning({ id: connectorConfigs.id });
    if (updated.length !== 1) {
      throw new RepositoryError('not-found', `Connector ${id} was not found`);
    }
    return settings;
  }

  async patchSettingsState<T extends object>(
    id: string,
    key: string,
    patch: Partial<T>,
  ): Promise<{ settings: Record<string, unknown>; state: T }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ settings: connectorConfigs.settings })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.id, id), isNull(connectorConfigs.deletedAt)))
        .limit(1)
        .for('update');
      if (!row) {
        throw new RepositoryError('not-found', `Connector ${id} was not found`);
      }
      const result = patchConnectorSettingsState(
        toSettings(row.settings),
        key,
        patch,
      );
      await tx
        .update(connectorConfigs)
        .set({ settings: result.settings, updatedAt: new Date().toISOString() })
        .where(and(eq(connectorConfigs.id, id), isNull(connectorConfigs.deletedAt)));
      return result;
    });
  }
}
