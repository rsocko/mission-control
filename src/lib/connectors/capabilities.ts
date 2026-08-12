import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq, isNull, and } from 'drizzle-orm';
import type { ConnectorCapabilities } from '@/types';
import {
  DOCUMENT_INTELLIGENCE_TASK_AUTHORITY,
  GITHUB_ISSUES_TASK_AUTHORITY,
  MICROSOFT_TODO_TASK_AUTHORITY,
  WORK_TODO_TASK_AUTHORITY,
  SCOUT_TASK_AUTHORITY,
  resolveConnectorCapabilities,
} from './task-source-profiles';

/** Runtime capability defaults per connector type (for fields added after initial setup) */
export const CAPABILITY_DEFAULTS: Record<string, Partial<ConnectorCapabilities>> = {
  'microsoft-todo': {
    attachments: true,
    taskCreate: true,
    taskMove: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    tagScope: 'global',
    ...MICROSOFT_TODO_TASK_AUTHORITY,
  },
  'microsoft-todo-work': {
    taskCreate: false,
    taskMove: false,
    attachments: false,
    microStatusSync: false,
    microStatusWriteBack: false,
    tagScope: 'global',
    ...WORK_TODO_TASK_AUTHORITY,
  },
  'github-issues': {
    close: true,
    taskCreate: true,
    taskMove: false,
    dependencyRead: true,
    dependencyWrite: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    tagScope: 'per-list',
    ...GITHUB_ISSUES_TASK_AUTHORITY,
  },
  'document-intelligence': {
    ...DOCUMENT_INTELLIGENCE_TASK_AUTHORITY,
  },
  scout: {
    ...SCOUT_TASK_AUTHORITY,
  },
};

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

  const stored = config.capabilities as ConnectorCapabilities;
  const defaults = CAPABILITY_DEFAULTS[config.type] ?? {};
  const settings = config.settings as Record<string, unknown>;
  return resolveConnectorCapabilities(
    config.type,
    { ...defaults, ...stored } as ConnectorCapabilities,
    settings,
  );
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
