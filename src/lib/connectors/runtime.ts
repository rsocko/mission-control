import 'server-only';

import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { connectorRegistry, type IConnector } from '.';

export async function getOrInitializeConnector(
  connectorInstanceId: string,
): Promise<IConnector | null> {
  const config = await getCorePersistenceRepositories().connectors.get(connectorInstanceId);
  if (!config?.enabled) return null;

  const existing = connectorRegistry.getConnector(connectorInstanceId);
  if (existing) return existing;

  return connectorRegistry.createConnector(config);
}
