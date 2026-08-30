import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq, isNull, and } from 'drizzle-orm';
import type { ConnectorCapabilities } from '@/types';
import {
  CAPABILITY_DEFAULTS,
  resolvePersistedConnectorCapabilities,
} from './resolved-capabilities';

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

  const [config] = await db
    .select({
      capabilities: connectorConfigs.capabilities,
      settings: connectorConfigs.settings,
      type: connectorConfigs.type,
    })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, connectorInstanceId),
        isNull(connectorConfigs.deletedAt),
      ),
    );

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

  const [config] = await db
    .select({ enabled: connectorConfigs.enabled })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, connectorInstanceId),
        isNull(connectorConfigs.deletedAt),
      ),
    );

  return config?.enabled ?? true;
}
