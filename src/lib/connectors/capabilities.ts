import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import type { ConnectorCapabilities } from '@/types';
import { resolvePersistedConnectorCapabilities } from './resolved-capabilities';

export { CAPABILITY_DEFAULTS } from './resolved-capabilities';

/**
 * Look up a connector's capabilities by its instance ID.
 * Merges stored capabilities with runtime defaults for the connector type,
 * so newly-added capability flags work for pre-existing connector configs.
 * Returns the capabilities object, or null if the connector is not found / soft-deleted.
 */
export async function getConnectorCapabilities(
  connectorInstanceId: string,
): Promise<ConnectorCapabilities | null> {
  if (!connectorInstanceId || connectorInstanceId === 'local') return null;

  const repositories = await getCorePersistenceRepositoriesForBackend();
  const config = await repositories.connectors.get(connectorInstanceId);

  if (!config?.capabilities) return null;

  return resolvePersistedConnectorCapabilities({
    type: config.type,
    capabilities: config.capabilities as ConnectorCapabilities,
    settings: config.settings as Record<string, unknown>,
  });
}

/**
 * Check whether a connector is enabled (not disabled and not soft-deleted).
 * Returns false for unknown IDs, 'local', or disabled connectors.
 */
export async function isConnectorEnabled(
  connectorInstanceId: string,
): Promise<boolean> {
  if (!connectorInstanceId || connectorInstanceId === 'local') return true;

  const repositories = await getCorePersistenceRepositoriesForBackend();
  const config = await repositories.connectors.get(connectorInstanceId);

  return config?.enabled ?? true;
}
