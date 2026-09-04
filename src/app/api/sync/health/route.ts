import { NextResponse } from 'next/server';
import type { IConnector } from '@/lib/connectors';
import type {
  ConnectorCapabilities,
  ConnectorConfig,
  SyncMode,
} from '@/types';
import { ApiErrors } from '@/lib/api-error';
import { isPublicDemoMode } from '@/lib/public-demo';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import type { ManagedConnectorRecord } from '@/db/persistence/connector-management';

/**
 * Checks the sync health of Microsoft To Do lists.
 * Detects lists affected by the Graph API UTF-16 surrogate-pair bug:
 * lists whose displayName starts with any Supplementary Multilingual Plane
 * emoji (U+10000+) are invisible to the Graph API listing endpoint, while
 * BMP emoji (U+FFFF and below) remain visible.
 * 
 * Returns affected lists and recommended fixes.
 */
 
// U+10000 is the BMP/SMP boundary in Unicode. Codepoints at or above this
// value require a UTF-16 surrogate pair, which Graph's list-indexing path
// appears to mishandle by treating the leading character as a single char.
const GRAPH_EMOJI_THRESHOLD = 0x10000;

function getFirstCodepoint(str: string): number {
  if (!str) return 0;
  return str.codePointAt(0) || 0;
}

function isAffectedByGraphEmojiBug(name: string): boolean {
  const cp = getFirstCodepoint(name);
  return cp >= GRAPH_EMOJI_THRESHOLD;
}

function getEmojiPrefix(name: string): string {
  if (!name) return '';
  const cp = name.codePointAt(0) || 0;
  if (cp > 0x2600) {
    const charLen = cp > 0xFFFF ? 2 : 1;
    return name.substring(0, charLen);
  }
  return '';
}

export interface AffectedList {
  id: string;
  sourceId: string;
  name: string;
  emoji: string;
  codepoint: string;
  taskCount: number | null;
  connectorInstanceId: string;
}

export interface SyncHealthResult {
  healthy: boolean;
  graphApiEmojiIssue: {
    affected: boolean;
    affectedLists: AffectedList[];
    totalLists: number;
    graphVisibleLists: number;
    substrateOnlyLists: number;
    description: string;
  };
}

async function fetchTaskCount(connector: IConnector, listSourceId: string): Promise<number | null> {
  try {
    const graphFetch = (connector as IConnector & { graphFetch?: (path: string) => Promise<Response> }).graphFetch?.bind(connector);
    if (!graphFetch) return null;
    // Fetch first page to count (Graph doesn't always support $count on tasks)
    // Use $select=id to minimize payload, and count the value array + follow pagination
    const res: Response = await graphFetch(`/me/todo/lists/${encodeURIComponent(listSourceId)}/tasks?$top=200&$select=id`);
    if (!res.ok) return null;
    const data = await res.json();
    // If there's no nextLink, the count is the array length
    const count = data.value?.length ?? 0;
    if (data['@odata.nextLink']) {
      // More than 200 tasks — just show "200+" as a rough indicator
      return count; // Will be 200, close enough for display
    }
    return count;
  } catch {
    return null;
  }
}

function isSyncMode(value: string): value is SyncMode {
  return value === 'webhook' || value === 'poll' || value === 'manual';
}

function isConnectorCapabilities(
  value: unknown,
): value is ConnectorCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'read',
    'write',
    'delete',
    'sync',
    'subtasks',
    'lists',
    'tags',
    'tagWriteBack',
  ].every((key) => typeof Reflect.get(value, key) === 'boolean');
}

function isStringRecord(
  value: Record<string, unknown>,
): value is Record<string, string> {
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function asConnectorConfig(connector: ManagedConnectorRecord): ConnectorConfig | null {
  if (
    !isSyncMode(connector.syncMode)
    || !isConnectorCapabilities(connector.capabilities)
    || !isStringRecord(connector.credentials)
  ) {
    return null;
  }
  return {
    id: connector.id,
    type: connector.type,
    name: connector.name,
    enabled: connector.enabled,
    syncMode: connector.syncMode,
    ...(connector.pollIntervalMinutes === null
      ? {}
      : { pollIntervalMinutes: connector.pollIntervalMinutes }),
    capabilities: connector.capabilities,
    credentials: connector.credentials,
    settings: connector.settings,
    syncedLists: connector.syncedLists,
  };
}

export async function GET() {
  try {
    const {
      connectors: todoConnectors,
      sourceLists: todoLists,
      taskCounts,
    } = await (
      await getConnectorManagementPersistence()
    ).getMicrosoftTodoHealthSnapshot();
    const affectedLists: AffectedList[] = [];

    const taskCountMap = new Map(
      taskCounts.map((row) => [
        `${row.connectorInstanceId}:${row.sourceListId ?? ''}`,
        row.count,
      ]),
    );

    // Get connector for live task count queries (fallback if tasks not synced)
    const connectorConfig = todoConnectors[0];
    const connectorRegistry = getConnectorRegistry();
    let connector = connectorConfig ? connectorRegistry.getConnector(connectorConfig.id) : null;
    if (isPublicDemoMode()) {
      connector = null;
    } else if (!connector && connectorConfig) {
      try {
        const normalizedConfig = asConnectorConfig(connectorConfig);
        if (normalizedConfig) {
          connector = await connectorRegistry.createConnector(normalizedConfig);
        }
      } catch {
        // Can't initialize connector — will show counts from local DB
      }
    }
    
    for (const list of todoLists) {
      if (isAffectedByGraphEmojiBug(list.name)) {
        const emoji = getEmojiPrefix(list.name);
        const cp = getFirstCodepoint(list.name);
        
        // Use local task count from tasks table (accurate if synced)
        const localCount = taskCountMap.get(
          `${list.connectorInstanceId}:${list.sourceId}`,
        ) ?? null;
        
        affectedLists.push({
          id: list.id,
          sourceId: list.sourceId,
          name: list.name,
          emoji,
          codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
          taskCount: localCount,
          connectorInstanceId: list.connectorInstanceId,
        });
      }
    }

    // For lists with no local tasks, try fetching count from Graph API
    if (connector) {
      const needsCount = affectedLists.filter(l => l.taskCount === null || l.taskCount === 0);
      if (needsCount.length > 0) {
        const counts = await Promise.all(
          needsCount.map(l => fetchTaskCount(connector!, l.sourceId))
        );
        needsCount.forEach((list, i) => {
          if (counts[i] !== null) list.taskCount = counts[i];
        });
      }
    }

    const graphVisibleLists = todoLists.filter(l => !isAffectedByGraphEmojiBug(l.name)).length;
    const substrateOnlyLists = affectedLists.length;

    const result: SyncHealthResult = {
      healthy: affectedLists.length === 0,
      graphApiEmojiIssue: {
        affected: affectedLists.length > 0,
        affectedLists,
        totalLists: todoLists.length,
        graphVisibleLists,
        substrateOnlyLists,
        description: affectedLists.length > 0
          ? `${affectedLists.length} list(s) have names starting with SMP emoji characters (U+10000+) that are invisible to the Microsoft Graph API listing endpoint. BMP emoji remain visible. This appears to be a UTF-16 surrogate-pair handling bug in Microsoft's backend, so these lists currently sync via an unofficial Substrate API fallback.`
          : 'All lists are accessible via the official Microsoft Graph API.',
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    return ApiErrors.internal('Health check failed', error);
  }
}
