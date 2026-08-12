import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { createGraphClient } from '@/lib/connectors/microsoft-todo/graph-client';
import type { GraphClient } from '@/lib/connectors/microsoft-todo/graph-client';
import type { ConnectorConfig } from '@/types';
import type { TriageItem } from '@/types';
import logger from '@/lib/logger';

export interface CreateTodoTaskOptions {
  listId?: string;
  listName?: string;
  title?: string;
  body?: string;
  onTargetResolved?: (target: { listId: string; listName: string }) => Promise<void>;
}

export interface CreateTodoTaskResult {
  taskId: string;
  taskTitle: string;
  listId: string;
  listName: string;
  webUrl?: string;
}

export class TodoTaskCreationError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TodoTaskCreationError';
  }
}

// Category keywords mapped to MS Todo list display names
const LIST_CATEGORY_MAP: Record<string, string[]> = {
  'Home Automation': ['home automation', 'home assistant', 'smart home', 'hass', 'zigbee', 'z-wave', 'iot'],
  '3D Printing': ['3d print', '3d model', 'stl', 'filament', 'printer', 'prusa', 'bambu', 'ender', 'cura', 'slicer'],
};

/**
 * Infer target MS Todo list name from triage item content.
 * Checks AI categories and title/description against known category keywords.
 */
function inferListName(item: TriageItem): string | undefined {
  const searchText = [
    item.title,
    item.description,
    item.aiSummary,
    ...(item.aiCategories || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const [listName, keywords] of Object.entries(LIST_CATEGORY_MAP)) {
    if (keywords.some((kw) => searchText.includes(kw))) {
      return listName;
    }
  }

  return undefined;
}

/**
 * Resolve a Graph client from an active microsoft-todo connector config.
 */
async function resolveGraphClient(): Promise<{ client: GraphClient; connectorId: string } | null> {
  try {
    const [config] = await db
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.type, 'microsoft-todo'),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      );

    if (!config) return null;

    const client = createGraphClient(config.id);
    return { client, connectorId: config.id };
  } catch (err) {
    logger.error({ err }, 'Failed to resolve MS Graph client for triage todo action');
    return null;
  }
}

/**
 * Find a list ID by display name, falling back to the default Tasks list.
 */
async function resolveListId(
  client: GraphClient,
  listName?: string,
): Promise<{ listId: string; resolvedName: string }> {
  const res = await client.graphFetch('/me/todo/lists?$top=100');
  if (!res.ok) {
    throw new Error(`Failed to fetch todo lists: ${res.status}`);
  }

  const data = await res.json();
  const lists: Array<{ id: string; displayName: string; wellKnownListName?: string }> =
    data.value || [];

  // Try exact match on requested name
  if (listName) {
    const match = lists.find(
      (l) => l.displayName.toLowerCase() === listName.toLowerCase(),
    );
    if (match) {
      return { listId: match.id, resolvedName: match.displayName };
    }
  }

  // Fall back to the well-known default list
  const defaultList = lists.find((l) => l.wellKnownListName === 'defaultList');
  if (defaultList) {
    return { listId: defaultList.id, resolvedName: defaultList.displayName };
  }

  // Absolute fallback: first list
  if (lists.length > 0) {
    return { listId: lists[0].id, resolvedName: lists[0].displayName };
  }

  throw new Error('No todo lists found in Microsoft account');
}

import { buildActionTitle } from './build-task-title';

/**
 * Build a task title from a triage item.
 * Uses an action-oriented title derived from the item's content type and title.
 */
function buildTaskTitle(item: TriageItem, overrideTitle?: string): string {
  return buildActionTitle(item, overrideTitle);
}

/**
 * Build the task body/notes from a triage item.
 */
function buildTaskBody(item: TriageItem, overrideBody?: string): string {
  const parts: string[] = [];

  if (overrideBody) {
    parts.push(overrideBody);
  } else if (item.description) {
    parts.push(item.description);
  }

  if (item.sourceUrl) {
    parts.push(`Source: ${item.sourceUrl}`);
  }

  parts.push(`[Triage: ${item.sourcePlatform}]`);

  if (item.aiCategories?.length) {
    parts.push(`Categories: ${item.aiCategories.join(', ')}`);
  }

  parts.push(`[Mission Control Triage ID: ${item.id}]`);

  return parts.join('\n\n');
}

function getTriageMarker(itemId: string): string {
  return `[Mission Control Triage ID: ${itemId}]`;
}

export async function findTodoTaskFromTriageItem(
  item: TriageItem,
  options: CreateTodoTaskOptions = {},
): Promise<CreateTodoTaskResult | null> {
  const resolved = await resolveGraphClient();
  if (!resolved) return null;

  const { client } = resolved;
  const targetListName = options.listName || inferListName(item);
  const { listId, resolvedName } = options.listId
    ? { listId: options.listId, resolvedName: options.listName || 'Custom List' }
    : await resolveListId(client, targetListName);
  const marker = getTriageMarker(item.id);
  let url = `/me/todo/lists/${listId}/tasks?$top=100`;

  while (url) {
    const res = await client.graphFetch(url);
    if (!res.ok) {
      throw new Error(`Failed to reconcile todo task: ${res.status}`);
    }
    const data = await res.json() as {
      value?: Array<{
        id: string;
        title: string;
        webUrl?: string;
        body?: { content?: string };
      }>;
      '@odata.nextLink'?: string;
    };
    const match = data.value?.find((task) => task.body?.content?.includes(marker));
    if (match) {
      return {
        taskId: match.id,
        taskTitle: match.title,
        listId,
        listName: resolvedName,
        webUrl: match.webUrl,
      };
    }
    url = data['@odata.nextLink']?.replace('https://graph.microsoft.com/v1.0', '') || '';
  }

  return null;
}

/**
 * Create a Microsoft Todo task from a triage item.
 *
 * Uses the existing MS Graph auth infrastructure (connector configs + graph-client).
 * Infers the target list from item content, with explicit overrides available.
 */
export async function createTodoTaskFromTriageItem(
  item: TriageItem,
  options: CreateTodoTaskOptions = {},
): Promise<CreateTodoTaskResult> {
  const resolved = await resolveGraphClient();
  if (!resolved) {
    throw new Error(
      'No active Microsoft Todo connector configured. Please set up a Microsoft Todo connector in Settings.',
    );
  }

  const { client } = resolved;

  // Resolve target list
  const targetListName = options.listName || inferListName(item);
  const { listId, resolvedName } = options.listId
    ? { listId: options.listId, resolvedName: options.listName || 'Custom List' }
    : await resolveListId(client, targetListName);
  await options.onTargetResolved?.({ listId, listName: resolvedName });

  const taskTitle = buildTaskTitle(item, options.title);
  const taskBody = buildTaskBody(item, options.body);

  // Build the Graph API request body
  const graphBody: Record<string, unknown> = {
    title: taskTitle,
    body: { content: taskBody, contentType: 'text' },
  };

  // Add linked resource with source URL
  if (item.sourceUrl) {
    graphBody.linkedResources = [
      {
        webUrl: item.sourceUrl,
        applicationName: 'Mission Control',
        displayName: item.title,
      },
    ];
  }

  let res: Response;
  try {
    res = await client.graphFetch(`/me/todo/lists/${listId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(graphBody),
    });
  } catch (error) {
    throw new TodoTaskCreationError(
      'Microsoft Todo task creation may have completed, but its response was not received',
      true,
      { cause: error },
    );
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new TodoTaskCreationError(
      `Failed to create todo task: ${res.status} ${errorText}`,
      res.status === 408 || res.status >= 500,
    );
  }

  let created: { id: string; title: string; webUrl?: string };
  try {
    created = await res.json();
  } catch (error) {
    throw new TodoTaskCreationError(
      'Microsoft Todo created the task, but its response could not be read',
      true,
      { cause: error },
    );
  }

  logger.info(
    {
      taskId: created.id,
      listId,
      listName: resolvedName,
      triageItemId: item.id,
    },
    'Created MS Todo task from triage item',
  );

  return {
    taskId: created.id,
    taskTitle: created.title,
    listId,
    listName: resolvedName,
    webUrl: created.webUrl,
  };
}
