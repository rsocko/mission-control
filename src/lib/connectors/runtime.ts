import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import type { ConnectorConfig } from '@/types';
import { connectorRegistry, type IConnector } from '.';

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return (value as string[] | null) ?? [];
}

export async function getOrInitializeConnector(
  connectorInstanceId: string,
): Promise<IConnector | null> {
  const [row] = await db.select().from(connectorConfigs).where(and(
    eq(connectorConfigs.id, connectorInstanceId),
    eq(connectorConfigs.enabled, true),
    isNull(connectorConfigs.deletedAt),
  )).limit(1);
  if (!row) return null;

  const existing = connectorRegistry.getConnector(connectorInstanceId);
  if (existing) return existing;

  const config: ConnectorConfig = {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    syncMode: row.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
    capabilities: parseJsonObject(row.capabilities) as unknown as ConnectorConfig['capabilities'],
    credentials: parseJsonObject(row.credentials) as Record<string, string>,
    settings: parseJsonObject(row.settings),
    syncedLists: parseJsonArray(row.syncedLists),
  };

  return connectorRegistry.createConnector(config);
}
