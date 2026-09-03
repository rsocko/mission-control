import { fromZonedTime } from 'date-fns-tz';
import {
  isReminderRelativeRule,
  resolveRelativeReminderMutation,
} from '@/lib/tasks/relative-reminder';
import { windowsToIanaTimezone } from '@/lib/mode';
import type { TaskPriority, TaskStatus } from '@/types';
import { decodeLenientJsonObject } from './value-codecs';
import type { WorkTodoChangeOperation } from './work-todo';

/**
 * Pure Work To Do value derivations shared by the SQLite and PostgreSQL
 * adapters. Nothing here touches a database, a driver, or a transaction — the
 * adapters call these inside their own transaction once they have read the
 * current row, so both backends compute byte-identical persisted values.
 */

export const WORK_TODO_CONNECTOR_TYPE = 'microsoft-todo-work';

export interface WorkTodoRemoteDateTime {
  dateTime: string;
  timeZone: string;
}

export interface WorkTodoRemoteTaskInput {
  id: string;
  title: string;
  status: string;
  importance: string;
  body?: { content: string; contentType: 'text' | 'html' } | null;
  createdDateTime: string;
  lastModifiedDateTime: string;
  completedDateTime?: WorkTodoRemoteDateTime | null;
  dueDateTime?: WorkTodoRemoteDateTime | null;
  isReminderOn?: boolean | null;
  reminderDateTime?: WorkTodoRemoteDateTime | null;
  etag?: string | null;
  bodyLastModifiedDateTime?: string | null;
  categories?: readonly string[];
  recurrence?: Record<string, unknown> | null;
  linkedResources?: readonly unknown[];
  attachments?: readonly unknown[];
}

export interface WorkTodoRemoteListInput {
  id: string;
  isOwner?: boolean | null;
  isShared?: boolean | null;
}

export interface WorkTodoExistingTaskState {
  dueDate: string | null;
  reminderAt: string | null;
  reminderRelative: string | null;
  reminderDueTime: string | null;
}

export interface WorkTodoRemoteValues {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  completedAt: string | null;
  reminderAt: string | null;
  reminderRelative?: string | null;
  reminderDueTime?: string | null;
}

export function mapWorkTodoStatus(status: string): TaskStatus {
  if (status === 'completed') return 'done';
  if (status === 'inProgress') return 'in_progress';
  return 'todo';
}

export function mapWorkTodoPriority(importance: string): TaskPriority {
  if (importance === 'high') return 'high';
  if (importance === 'low') return 'low';
  return 'none';
}

export function normalizeWorkTodoReminderAt(
  value: WorkTodoRemoteDateTime | null | undefined,
): string | null {
  if (!value) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime);
  if (hasOffset) {
    const instant = new Date(value.dateTime);
    if (!Number.isFinite(instant.getTime())) {
      throw new Error(`Invalid Microsoft To Do reminder datetime "${value.dateTime}"`);
    }
    return instant.toISOString();
  }

  const timezone = windowsToIanaTimezone(value.timeZone);
  if (!timezone) {
    return `invalid-timezone:${encodeURIComponent(value.timeZone)}:${value.dateTime}`;
  }
  const instant = fromZonedTime(value.dateTime, timezone);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Invalid Microsoft To Do reminder datetime "${value.dateTime}"`);
  }
  return instant.toISOString();
}

export function workTodoRemoteSourceId(listId: string, taskId: string): string {
  return `${listId}:${taskId}`;
}

export function workTodoChecklistSourceId(taskSourceId: string, itemId: string): string {
  return `${taskSourceId}:checklist:${itemId}`;
}

export function extractWorkTodoRemoteTaskId(sourceId: string, metadata: unknown): string {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).graphId;
    if (typeof value === 'string' && value) return value;
  }
  const separator = sourceId.indexOf(':');
  return separator >= 0 ? sourceId.slice(separator + 1) : sourceId;
}

export function workTodoSourceTagNames(task: WorkTodoRemoteTaskInput): string[] {
  const categories = Array.isArray(task.categories) ? task.categories : [];
  const text = `${task.title} ${task.body?.content ?? ''}`
    .replace(/https?:\/\/[^\s)>\]]+/gi, ' ');
  const hashtags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1]);
  return [...new Set([...categories, ...hashtags].map((name) => name.trim()).filter(Boolean))];
}

export function slugifyWorkTodoTag(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function buildWorkTodoTaskMetadata(
  remoteTask: WorkTodoRemoteTaskInput,
  list: WorkTodoRemoteListInput,
): Record<string, unknown> {
  return {
    graphId: remoteTask.id,
    listId: list.id,
    etag: remoteTask.etag ?? null,
    bodyContentType: remoteTask.body?.contentType ?? 'text',
    bodyLastModifiedDateTime: remoteTask.bodyLastModifiedDateTime ?? null,
    remoteStatus: remoteTask.status,
    remoteImportance: remoteTask.importance,
    isOwner: list.isOwner ?? null,
    isShared: list.isShared ?? null,
    categories: remoteTask.categories ? [...remoteTask.categories] : [],
    recurrence: remoteTask.recurrence ?? null,
    linkedResources: remoteTask.linkedResources ? [...remoteTask.linkedResources] : [],
    attachmentMetadata: remoteTask.attachments ? [...remoteTask.attachments] : [],
    reminderTimeZone: remoteTask.reminderDateTime?.timeZone ?? null,
  };
}

export function buildWorkTodoChecklistMetadata(
  remoteTaskId: string,
  listId: string,
  checklistItemId: string,
): Record<string, unknown> {
  return { graphId: remoteTaskId, listId, checklistItemId };
}

/**
 * Derives the remote-authoritative task values, preserving the existing
 * relative-reminder contract: an unchanged due date keeps the stored reminder,
 * and a changed due date recomputes it (or clears it when recomputation fails).
 */
export function resolveWorkTodoRemoteValues(input: {
  remoteTask: WorkTodoRemoteTaskInput;
  existing: WorkTodoExistingTaskState | null;
  timezone: string;
  syncTimestamp: string;
}): WorkTodoRemoteValues {
  const { remoteTask, existing, timezone, syncTimestamp } = input;
  const remoteValues: WorkTodoRemoteValues = {
    title: remoteTask.title,
    description: remoteTask.body?.content ?? null,
    status: mapWorkTodoStatus(remoteTask.status),
    priority: mapWorkTodoPriority(remoteTask.importance),
    dueDate: remoteTask.dueDateTime?.dateTime.slice(0, 10) ?? null,
    completedAt: remoteTask.completedDateTime?.dateTime ?? null,
    reminderAt: remoteTask.isReminderOn
      ? normalizeWorkTodoReminderAt(remoteTask.reminderDateTime)
      : null,
  };

  if (existing && isReminderRelativeRule(existing.reminderRelative ?? '')) {
    if (remoteValues.dueDate === existing.dueDate) {
      remoteValues.reminderAt = existing.reminderAt;
    } else {
      const reminderMutation = resolveRelativeReminderMutation({
        current: existing,
        input: { dueDate: remoteValues.dueDate ?? null },
        timezone,
        now: new Date(syncTimestamp),
      });
      Object.assign(
        remoteValues,
        reminderMutation.success ? reminderMutation.updates : { reminderAt: null },
      );
    }
  }

  return remoteValues;
}

export interface WorkTodoPendingTaskState {
  id: string;
  sourceId: string;
  sourceListId: string | null;
  isChecklistItem: boolean;
  metadata: Record<string, unknown>;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  updatedAt: string;
}

export interface WorkTodoOutboundChangeDraft {
  taskId: string;
  sourceId: string;
  listSourceId: string;
  remoteTaskId: string;
  operation: WorkTodoChangeOperation;
  fields: Record<string, unknown> | null;
  taskVersion: string;
}

/**
 * Builds the durable outbound change for one locally-edited task, or `null`
 * when the task is not eligible (checklist item, unknown list, no dirty fields,
 * or no mappable field payload).
 */
export function buildWorkTodoOutboundChange(
  task: WorkTodoPendingTaskState,
): WorkTodoOutboundChangeDraft | null {
  const metadata = task.metadata;
  const listId = typeof metadata.listId === 'string' ? metadata.listId : task.sourceListId;
  if (!listId) return null;
  if (task.isChecklistItem) return null;
  const dirtyFields = Array.isArray(metadata.workTodoDirtyFields)
    ? metadata.workTodoDirtyFields.filter((field): field is string => typeof field === 'string')
    : [];
  if (dirtyFields.length === 0) return null;

  const remoteTaskId = extractWorkTodoRemoteTaskId(task.sourceId, metadata);
  const onlyCompletion = dirtyFields.length === 1
    && dirtyFields[0] === 'status'
    && task.status === 'done';
  const operation: WorkTodoChangeOperation = onlyCompletion ? 'complete' : 'update';
  const fields = operation === 'update'
    ? Object.fromEntries(dirtyFields.flatMap((field) => {
        if (field === 'title') return [['title', task.title]];
        if (field === 'description') return [['bodyContent', task.description]];
        if (field === 'status') {
          const status = task.status === 'done'
            ? 'completed'
            : task.status === 'in_progress' ? 'inProgress' : 'notStarted';
          return [['status', status]];
        }
        if (field === 'priority') {
          const importance = task.priority === 'high' || task.priority === 'critical'
            ? 'high'
            : task.priority === 'low' ? 'low' : 'normal';
          return [['importance', importance]];
        }
        if (field === 'dueDate') return [['dueDateTime', task.dueDate]];
        return [];
      }))
    : null;
  if (operation === 'update' && Object.keys(fields ?? {}).length === 0) return null;

  return {
    taskId: task.id,
    sourceId: task.sourceId,
    listSourceId: listId,
    remoteTaskId,
    operation,
    fields,
    taskVersion: task.updatedAt,
  };
}

export function parseWorkTodoJsonObject(value: unknown): Record<string, unknown> {
  return decodeLenientJsonObject(value);
}
