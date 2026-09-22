import 'server-only';

import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import type { IConnector } from '.';
import { getConnectorRegistry } from './registry-runtime';

export async function getOrInitializeConnector(
  connectorInstanceId: string,
  options: { refresh?: boolean } = {},
): Promise<IConnector | null> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  const config = await repositories.connectors.get(connectorInstanceId);
  if (!config?.enabled) return null;

  const registry = getConnectorRegistry();
  const existing = registry.getConnector(connectorInstanceId);
  if (existing && !options.refresh) return existing;

  return existing
    ? registry.replaceConnector(config)
    : registry.createConnector(config);
}
