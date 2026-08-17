import type { ConnectorConfig, SourceList } from '@/app/settings/components/types';

export type ConnectorWithSync = ConnectorConfig & { lastSyncAt?: string | null };

export interface ConnectorData {
  connectors: ConnectorWithSync[];
  sourceLists: SourceList[];
}

type Fetcher = typeof fetch;

async function readError(response: Response, fallback: string) {
  const data = await response.clone().json().catch(() => null) as { error?: string } | null;
  if (data?.error) return data.error;
  return (await response.text().catch(() => '')).trim() || fallback;
}

export function getActiveConnectors<T extends { deletedAt?: string | null }>(connectors: T[]): T[] {
  return connectors.filter(connector => !connector.deletedAt);
}

export function getLatestConnectorSync(
  connectors: Array<{ deletedAt?: string | null; lastSyncAt?: string | null }>,
) {
  return getActiveConnectors(connectors)
    .map(connector => connector.lastSyncAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

export async function loadConnectorData({
  includeDeleted = false,
  fetcher = fetch,
}: {
  includeDeleted?: boolean;
  fetcher?: Fetcher;
} = {}): Promise<ConnectorData> {
  const response = await fetcher(`/api/connectors${includeDeleted ? '?includeDeleted=true' : ''}`);
  if (!response.ok) {
    throw new Error(await readError(response, `Failed to load connectors (${response.status})`));
  }
  const data = await response.json() as Partial<ConnectorData>;
  const connectors = Array.isArray(data.connectors) ? data.connectors : [];
  return {
    connectors: includeDeleted ? connectors : getActiveConnectors(connectors),
    sourceLists: Array.isArray(data.sourceLists) ? data.sourceLists : [],
  };
}

export async function requestConnectorSync({
  connectorId,
  full = false,
  fetcher = fetch,
}: {
  connectorId?: string;
  full?: boolean;
  fetcher?: Fetcher;
} = {}) {
  const response = await fetcher('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(connectorId ? { connectorId } : {}),
      ...(full ? { full: true } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, `Sync failed with HTTP ${response.status}`));
  }
  return response;
}
