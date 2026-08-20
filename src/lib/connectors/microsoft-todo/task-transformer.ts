import type { TaskItem } from '@/types';
import { randomUUID } from 'crypto';
import { extractMicroStatusFromTags, isMicroStatusTag } from '@/lib/micro-status';
import type { GraphTodoTask, GraphChecklistItem } from './types';

/**
 * Maps a Graph API task to our internal TaskItem format.
 */
export function mapGraphTask(
  graphTask: GraphTodoTask,
  listId: string,
  listName: string,
  connectorType: string,
  connectorInstanceId: string,
  wellKnownListName?: string
): TaskItem {
  const categories = graphTask.categories || [];
  const microStatus = extractMicroStatusFromTags(categories);
  const bodyContent = graphTask.body?.content;
  const missionControlTaskId = bodyContent
    ?.match(/\[Mission Control Task ID: ([^\]]+)\]/)?.[1];
  const triageItemId = bodyContent
    ?.match(/\[Mission Control Triage ID: ([^\]]+)\]/)?.[1];

  return {
    id: randomUUID(),
    sourceId: `${listId}:${graphTask.id}`,
    connectorType,
    connectorInstanceId,
    title: graphTask.title,
    description: bodyContent
      ?.replace(/\n*\[Mission Control (?:Task|Triage) ID: [^\]]+\]\s*$/g, '')
      .trim() || undefined,
    status: mapStatus(graphTask.status),
    microStatus: microStatus || undefined,
    priority: importanceToPriority(graphTask.importance),
    dueDate: graphTask.dueDateTime?.dateTime?.slice(0, 10) || undefined,
    createdAt: graphTask.createdDateTime,
    updatedAt: graphTask.lastModifiedDateTime,
    completedAt: graphTask.completedDateTime?.dateTime || undefined,
    parentId: undefined,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: listId,
    sourceListName: listName,
    hubProjectIds: [],
    tags: [
      ...categories.filter((cat: string) => !isMicroStatusTag(cat)).map((cat: string) => ({
        id: randomUUID(),
        name: cat,
        slug: cat.toLowerCase().replace(/\s+/g, '-'),
        type: 'source' as const,
        source: connectorType,
        confirmed: true,
        createdAt: new Date().toISOString(),
      })),
      ...extractHashtags(graphTask.title, graphTask.body?.content, connectorType),
    ],
    assignee: undefined,
    metadata: {
      graphId: graphTask.id,
      listId,
      wellKnownListName: wellKnownListName || undefined,
      hasAttachments: graphTask.hasAttachments,
      ...(graphTask.linkedResources
        ? { linkedResources: graphTask.linkedResources }
        : {}),
      recurrence: graphTask.recurrence ? parseRecurrencePattern(graphTask.recurrence) : null,
      recurrenceIdentity: graphTask.recurrence ? getRecurrencePatternIdentity(graphTask.recurrence) : null,
      missionControlTaskId,
      triageItemId,
    },
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  };
}

/**
 * Maps a Substrate task object to our TaskItem format.
 * parentCreatedAt is used as a fallback when the substrate object doesn't
 * include CreatedDateTime (common for hidden-list tasks).
 */
export function mapSubstrateTask(
  subTask: Record<string, unknown>,
  listId: string,
  listName: string,
  connectorType: string,
  connectorInstanceId: string,
  parentCreatedAt?: string,
): TaskItem {
  const status = String(subTask.Status || 'NotStarted').toLowerCase();
  const importance = String(subTask.Importance || 'Normal').toLowerCase();
  const dueDateTime = subTask.DueDateTime as { DateTime?: string } | null;
  const body = subTask.Body as { Content?: string } | null;
  const categories = (subTask.Categories || []) as string[];
  const completedDt = subTask.CompletedDateTime as { DateTime?: string } | null;
  const recurrence = parseSubstrateRecurrence(subTask.Recurrence);
  const recurrenceIdentity = getSubstrateRecurrenceIdentity(subTask.Recurrence);
  const effectiveCreatedAt = String(subTask.CreatedDateTime || parentCreatedAt || new Date().toISOString());

  return {
    id: randomUUID(),
    sourceId: `${listId}:${subTask.Id}`,
    connectorType,
    connectorInstanceId,
    title: String(subTask.Subject || ''),
    description: body?.Content || undefined,
    status: mapStatus(status === 'completed' ? 'completed' : status === 'inprogress' ? 'inProgress' : 'notStarted'),
    priority: importanceToPriority(importance),
    dueDate: dueDateTime?.DateTime?.slice(0, 10) || undefined,
    createdAt: effectiveCreatedAt,
    updatedAt: String(subTask.LastModifiedDateTime || effectiveCreatedAt),
    completedAt: completedDt?.DateTime || undefined,
    parentId: undefined,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: listId,
    sourceListName: listName,
    hubProjectIds: [],
    tags: categories.map((cat: string) => ({
      id: randomUUID(),
      name: cat,
      slug: cat.toLowerCase().replace(/\s+/g, '-'),
      type: 'source' as const,
      source: connectorType,
      confirmed: true,
      createdAt: new Date().toISOString(),
    })),
    assignee: undefined,
    metadata: {
      graphId: String(subTask.Id || ''),
      listId,
      isHiddenList: true,
      recurrence,
      recurrenceIdentity,
    },
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  };
}

/**
 * Maps a checklist item to a TaskItem.
 * Falls back to the parent task's createdDateTime when the item itself
 * doesn't provide one (common in the Graph API).
 */
export function mapChecklistItem(
  item: GraphChecklistItem,
  listId: string,
  taskId: string,
  parentInternalId: string,
  connectorType: string,
  connectorInstanceId: string,
  parentCreatedAt?: string,
): TaskItem {
  const effectiveCreatedAt = item.createdDateTime || parentCreatedAt || new Date().toISOString();
  return {
    id: randomUUID(),
    sourceId: `${listId}:${taskId}:${item.id}`,
    connectorType,
    connectorInstanceId,
    title: item.displayName,
    description: undefined,
    status: item.isChecked ? 'done' : 'todo',
    priority: 'none' as const,
    createdAt: effectiveCreatedAt,
    updatedAt: effectiveCreatedAt,
    parentId: parentInternalId,
    childIds: [],
    depth: 1,
    isChecklistItem: true,
    sourceListId: listId,
    sourceListName: undefined,
    hubProjectIds: [],
    tags: [],
    metadata: { checklistItemId: item.id },
    syncStatus: 'synced' as const,
    lastSyncedAt: new Date().toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function mapStatus(graphStatus: string): TaskItem['status'] {
  switch (graphStatus) {
    case 'completed': return 'done';
    case 'notStarted': return 'todo';
    case 'inProgress': return 'in_progress';
    default: return 'todo';
  }
}

export function statusToGraph(status: TaskItem['status']): string {
  switch (status) {
    case 'done': return 'completed';
    case 'in_progress': return 'inProgress';
    case 'todo': return 'notStarted';
    default: return 'notStarted';
  }
}

export function importanceToPriority(importance: string): TaskItem['priority'] {
  switch (importance) {
    case 'high': return 'high';
    case 'low': return 'low';
    default: return 'none';
  }
}

export function priorityToImportance(priority?: TaskItem['priority']): string {
  switch (priority) {
    case 'critical':
    case 'high': return 'high';
    default: return 'normal';
  }
}

export function parseSourceId(sourceId: string): { listId: string; taskId: string } {
  const [listId, taskId] = sourceId.split(':');
  return { listId, taskId };
}

export function parseRecurrencePattern(recurrence: NonNullable<GraphTodoTask['recurrence']>): string {
  const { pattern } = recurrence;
  if (!pattern) return 'custom';

  switch (pattern.type) {
    case 'daily':
      return pattern.interval === 1 ? 'daily' : `every ${pattern.interval} days`;
    case 'weekly': {
      const days = pattern.daysOfWeek || [];
      const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
      if (days.length === 5 && weekdays.every(d => days.includes(d))) return 'weekdays';
      if (pattern.interval === 2 && days.length <= 1) return 'biweekly';
      if (pattern.interval === 1 && days.length <= 1) return 'weekly';
      return pattern.interval === 1
        ? `weekly (${days.join(', ')})`
        : `every ${pattern.interval} weeks (${days.join(', ')})`;
    }

    case 'absoluteMonthly':
    case 'relativeMonthly':
      return pattern.interval === 1 ? 'monthly' : `every ${pattern.interval} months`;
    case 'absoluteYearly':
    case 'relativeYearly':
      return pattern.interval === 1 ? 'yearly' : `every ${pattern.interval} years`;
    default:
      return 'custom';
  }
}

export function getRecurrencePatternIdentity(
  recurrence: NonNullable<GraphTodoTask['recurrence']>,
): string {
  const pattern = recurrence.pattern;
  return JSON.stringify({
    type: pattern.type,
    interval: pattern.interval,
    daysOfWeek: [...(pattern.daysOfWeek || [])].sort(),
    dayOfMonth: pattern.dayOfMonth ?? null,
    month: pattern.month ?? null,
  });
}

export function parseSubstrateRecurrence(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const recurrence = value as {
    Pattern?: {
      Type?: string;
      Interval?: number;
      DaysOfWeek?: string[];
      DayOfMonth?: number;
      Month?: number;
    };
    Range?: { Type?: string; StartDate?: string; EndDate?: string };
  };
  if (!recurrence.Pattern?.Type) return null;

  return parseRecurrencePattern({
    pattern: {
      type: recurrence.Pattern.Type,
      interval: recurrence.Pattern.Interval || 1,
      daysOfWeek: recurrence.Pattern.DaysOfWeek,
      dayOfMonth: recurrence.Pattern.DayOfMonth,
      month: recurrence.Pattern.Month,
    },
    range: {
      type: recurrence.Range?.Type || 'noEnd',
      startDate: recurrence.Range?.StartDate,
      endDate: recurrence.Range?.EndDate,
    },
  });
}

export function getSubstrateRecurrenceIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const recurrence = value as {
    Pattern?: {
      Type?: string;
      Interval?: number;
      DaysOfWeek?: string[];
      DayOfMonth?: number;
      Month?: number;
    };
  };
  if (!recurrence.Pattern?.Type) return null;

  return getRecurrencePatternIdentity({
    pattern: {
      type: recurrence.Pattern.Type,
      interval: recurrence.Pattern.Interval || 1,
      daysOfWeek: recurrence.Pattern.DaysOfWeek,
      dayOfMonth: recurrence.Pattern.DayOfMonth,
      month: recurrence.Pattern.Month,
    },
    range: { type: 'noEnd' },
  });
}

function extractHashtags(title: string, body?: string, connectorType?: string): Array<{
  id: string; name: string; slug: string; type: 'source'; source: string; confirmed: boolean; createdAt: string;
}> {
  const text = `${title} ${body || ''}`;
  const textWithoutUrls = text.replace(/https?:\/\/[^\s)>\]]+/gi, ' ')
    .replace(/ftp:\/\/[^\s)>\]]+/gi, ' ')
    .replace(/www\.[^\s)>\]]+/gi, ' ');

  const matches = textWithoutUrls.match(/(?:^|\s)#(\w[\w-]*)/g);
  if (!matches) return [];

  const seen = new Set<string>();
  return matches
    .map((m) => m.replace(/^\s*#/, ''))
    .filter((tag) => {
      const lower = tag.toLowerCase();
      if (seen.has(lower)) return false;
      if (/^\d+$/.test(tag)) return false;
      if (tag.length < 2) return false;
      if (/^[\dA-Fa-f]{6,}$/.test(tag)) return false;
      if (/^\d[\d-]+\d$/.test(tag)) return false;
      if (/^[A-Z0-9]{8,}$/.test(tag)) return false;
      if (/^[A-Z]{1,3}-\d{2,}/.test(tag)) return false;
      if (/^profileId/i.test(tag)) return false;
      seen.add(lower);
      return true;
    })
    .map((tag) => ({
      id: randomUUID(),
      name: tag,
      slug: tag.toLowerCase().replace(/\s+/g, '-'),
      type: 'source' as const,
      source: connectorType || 'microsoft-todo',
      confirmed: true,
      createdAt: new Date().toISOString(),
    }));
}
