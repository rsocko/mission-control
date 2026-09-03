import 'server-only';

import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import type { IConnector } from '.';
import { getConnectorRegistry } from './registry-runtime';

export async function getOrInitializeConnector(
  connectorInstanceId: string,
): Promise<IConnector | null> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  const config = await repositories.connectors.get(connectorInstanceId);
  if (!config?.enabled) return null;

  const registry = getConnectorRegistry();
  const existing = registry.getConnector(connectorInstanceId);
  if (existing) return existing;

  return registry.createConnector(config);
}
