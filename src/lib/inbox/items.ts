import type {
  TaskPriority,
  TriageActionType,
  TriageContentType,
  TriageItem,
  TriageStatus,
} from '@/types';

export type InboxGroup = 'all' | 'tasks' | 'content';

export interface InboxTaskDto {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  status: string;
  statusReason?: string | null;
  localDisposition?: string | null;
  priority: TaskPriority;
  planningHorizon?: string | null;
  dueDate?: string | null;
  snoozedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
  sourceListName?: string | null;
  hubProjectIds?: string[];
  tags?: Array<{ id: string; name: string; slug: string }>;
  hasDescription?: boolean;
  editPolicy?: {
    sourceModel?: string;
    localDispositionSupported?: boolean;
  };
}

export interface InboxTaskMetadata {
  inboxKind: 'task';
  taskId: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListName: string | null;
  priority: TaskPriority;
  planningHorizon: string | null;
  dueDate: string | null;
  projectIds: string[];
  hasDescription: boolean;
  localDisposition: string;
  snoozedUntil: string | null;
  status: string;
  statusReason: string | null;
  localDispositionSupported: boolean;
  tagIds: string[];
  needsTriageTagIds: string[];
}

export interface InboxTaskActionMutation {
  update: Record<string, unknown>;
  undoPatch: Record<string, unknown>;
}

export const KNOWN_CONTENT_TYPES = new Set<TriageContentType>([
  'task',
  'link',
  'image',
  'video',
  'text_post',
  'repo',
  'model_3d',
  'article',
  'product',
  'document',
]);

function taskUrgency(task: InboxTaskDto): TriageItem['aiUrgency'] {
  if (task.priority === 'critical' || task.priority === 'high') return 'time_sensitive';
  if (task.dueDate) {
    const dueAt = new Date(task.dueDate).getTime();
    if (Number.isFinite(dueAt) && dueAt <= Date.now() + 3 * 86_400_000) return 'time_sensitive';
  }
  return task.priority === 'medium' ? 'trending' : 'evergreen';
}

function taskScore(priority: TaskPriority): number {
  if (priority === 'critical') return 95;
  if (priority === 'high') return 80;
  if (priority === 'medium') return 65;
  if (priority === 'low') return 45;
  return 30;
}

export function getInboxTaskStatus(task: InboxTaskDto, now = Date.now()): TriageStatus {
  const snoozedUntil = task.snoozedUntil ? new Date(task.snoozedUntil).getTime() : Number.NaN;
  return Number.isFinite(snoozedUntil) && snoozedUntil > now ? 'snoozed' : 'pending';
}

export function toInboxTaskItem(task: InboxTaskDto): TriageItem {
  const metadata: InboxTaskMetadata = {
    inboxKind: 'task',
    taskId: task.id,
    connectorType: task.connectorType,
    connectorInstanceId: task.connectorInstanceId,
    sourceListName: task.sourceListName ?? null,
    priority: task.priority,
    planningHorizon: task.planningHorizon ?? null,
    dueDate: task.dueDate ?? null,
    projectIds: task.hubProjectIds ?? [],
    hasDescription: task.hasDescription ?? false,
    localDisposition: task.localDisposition ?? 'active',
    snoozedUntil: task.snoozedUntil ?? null,
    status: task.status,
    statusReason: task.statusReason ?? null,
    localDispositionSupported: task.editPolicy?.localDispositionSupported === true,
    tagIds: task.tags?.map((tag) => tag.id) ?? [],
    needsTriageTagIds: task.tags
      ?.filter((tag) => tag.slug === 'needs-triage')
      .map((tag) => tag.id) ?? [],
  };

  return {
    id: `task:${task.id}`,
    sourcePlatform: 'task',
    sourceId: task.sourceId,
    sourceUrl: '',
    title: task.title,
    contentType: 'task',
    capturedAt: task.createdAt,
    ingestedAt: task.updatedAt,
    status: getInboxTaskStatus(task),
    snoozedUntil: task.snoozedUntil ?? undefined,
    aiCategories: task.tags?.map((tag) => tag.name).slice(0, 5) ?? [],
    aiSuggestedActions: [],
    aiRelevanceScore: taskScore(task.priority),
    aiUrgency: taskUrgency(task),
    rawMetadata: metadata as unknown as Record<string, unknown>,
    actionsTaken: [],
  };
}

export function isInboxTask(item: TriageItem): boolean {
  return item.contentType === 'task' && item.rawMetadata?.inboxKind === 'task';
}

export function getInboxTaskMetadata(item: TriageItem): InboxTaskMetadata | null {
  if (!isInboxTask(item)) return null;
  return item.rawMetadata as unknown as InboxTaskMetadata;
}

export function getInboxTaskActionMutation(
  metadata: InboxTaskMetadata,
  actionType: TriageActionType,
  now = Date.now(),
): InboxTaskActionMutation | null {
  const retainedTagIds = metadata.tagIds.filter(
    (tagId) => !metadata.needsTriageTagIds.includes(tagId),
  );
  const tagUpdate = retainedTagIds.length === metadata.tagIds.length
    ? {}
    : { tags: retainedTagIds };
  const tagUndo = 'tags' in tagUpdate ? { tags: metadata.tagIds } : {};

  if (actionType === 'complete_action') {
    const needsFiling = metadata.planningHorizon === null && metadata.projectIds.length === 0;
    return metadata.localDispositionSupported
      ? {
          update: { localDisposition: 'handled', ...tagUpdate },
          undoPatch: { localDisposition: metadata.localDisposition, ...tagUndo },
        }
      : {
          update: { ...(needsFiling ? { planningHorizon: 'next' } : {}), ...tagUpdate },
          undoPatch: { ...(needsFiling ? { planningHorizon: metadata.planningHorizon } : {}), ...tagUndo },
        };
  }
  if (actionType === 'dismiss') {
    return metadata.localDispositionSupported
      ? {
          update: { localDisposition: 'dismissed' },
          undoPatch: { localDisposition: metadata.localDisposition },
        }
      : {
          update: { status: 'cancelled', statusReason: 'not_planned' },
          undoPatch: { status: metadata.status, statusReason: metadata.statusReason },
        };
  }
  if (actionType === 'snooze') {
    return {
      update: { snoozedUntil: new Date(now + 86_400_000).toISOString() },
      undoPatch: { snoozedUntil: metadata.snoozedUntil },
    };
  }
  if (actionType === 'resurface') {
    return {
      update: {
        ...(metadata.localDispositionSupported ? { localDisposition: 'active' } : {}),
        snoozedUntil: null,
      },
      undoPatch: {
        ...(metadata.localDispositionSupported
          ? { localDisposition: metadata.localDisposition }
          : {}),
        snoozedUntil: metadata.snoozedUntil,
      },
    };
  }
  return null;
}

export function isOtherContentType(contentType: string): boolean {
  return !KNOWN_CONTENT_TYPES.has(contentType as TriageContentType);
}
