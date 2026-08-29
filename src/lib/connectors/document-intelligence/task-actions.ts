import db from '@/db';
import { tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { IConnector } from '@/lib/connectors';
import type { TaskItem } from '@/types';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import type { DocActionFeedback } from './document-client';
import type { DocSourceAction } from './document-parser';

const ACTION_TYPES = ['pay', 'respond', 'file', 'archive', 'review', 'sign', 'schedule'] as const;
const URGENCY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

type OwlActionType = (typeof ACTION_TYPES)[number];
type OwlUrgency = (typeof URGENCY_VALUES)[number];

export type OwlTaskActionInput =
  | { action: 'complete' }
  | { action: 'source_action'; sourceActionId: string }
  | { action: 'snooze'; until: string }
  | { action: 'not_an_action' }
  | { action: 'correct'; field: 'action_type'; value: OwlActionType }
  | { action: 'correct'; field: 'urgency'; value: OwlUrgency }
  | { action: 'correct'; field: 'amount'; value: number | null };

export interface OwlTaskActionResult {
  status: string;
  statusReason: string | null;
  snoozedUntil: string | null;
  priority: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  syncStatus: string;
  title?: string;
  description?: string | null;
  dueDate?: string | null;
}

export class OwlTaskActionError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'NOT_OWL' | 'CONNECTOR_UNAVAILABLE' | 'REMOTE_WRITE_FAILED' | 'SOURCE_ACTION_UNAVAILABLE' | 'TASK_CHANGED',
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OwlTaskActionError';
  }
}

interface OwlActionConnector extends IConnector {
  completeTask(sourceId: string): Promise<void>;
  snoozeAction(sourceId: string, until: string): Promise<void>;
  submitActionFeedback(sourceId: string, feedback: DocActionFeedback): Promise<TaskItem | null>;
  fetchActionTask(sourceId: string): Promise<TaskItem | null>;
  executeSourceAction(sourceId: string, sourceAction: DocSourceAction): Promise<TaskItem | null>;
}

const taskActionQueues = new Map<string, Promise<void>>();

function isOwlActionConnector(connector: IConnector | null): connector is OwlActionConnector {
  if (!connector || connector.type !== 'document-intelligence') return false;
  const candidate = connector as Partial<OwlActionConnector>;
  return typeof candidate.completeTask === 'function'
    && typeof candidate.snoozeAction === 'function'
    && typeof candidate.submitActionFeedback === 'function'
    && typeof candidate.fetchActionTask === 'function'
    && typeof candidate.executeSourceAction === 'function';
}

export function parseOwlTaskActionInput(value: unknown): OwlTaskActionInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;

  if (body.action === 'complete') {
    return { action: 'complete' };
  }
  if (
    body.action === 'source_action'
    && typeof body.sourceActionId === 'string'
    && body.sourceActionId.trim()
  ) {
    return { action: 'source_action', sourceActionId: body.sourceActionId.trim() };
  }
  if (body.action === 'not_an_action') {
    return { action: 'not_an_action' };
  }
  if (body.action === 'snooze' && typeof body.until === 'string') {
    const parsed = Date.parse(body.until);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      return { action: 'snooze', until: new Date(parsed).toISOString() };
    }
    return null;
  }
  if (body.action !== 'correct' || typeof body.field !== 'string') return null;

  if (
    body.field === 'action_type'
    && typeof body.value === 'string'
    && ACTION_TYPES.includes(body.value as OwlActionType)
  ) {
    return { action: 'correct', field: 'action_type', value: body.value as OwlActionType };
  }
  if (
    body.field === 'urgency'
    && typeof body.value === 'string'
    && URGENCY_VALUES.includes(body.value as OwlUrgency)
  ) {
    return { action: 'correct', field: 'urgency', value: body.value as OwlUrgency };
  }
  if (
    body.field === 'amount'
    && (body.value === null || (
      typeof body.value === 'number'
      && Number.isFinite(body.value)
      && body.value >= 0
    ))
  ) {
    return { action: 'correct', field: 'amount', value: body.value as number | null };
  }
  return null;
}

function feedbackFor(input: Extract<OwlTaskActionInput, { action: 'correct' }>): DocActionFeedback {
  switch (input.field) {
    case 'action_type':
      return { feedback_type: 'misclassified', corrected_action_type: input.value };
    case 'urgency':
      return { feedback_type: 'wrong_urgency', corrected_urgency: input.value };
    case 'amount':
      return { feedback_type: 'wrong_amount', corrected_amount: input.value };
  }
}

function localMetadataAfter(
  current: Record<string, unknown>,
  input: OwlTaskActionInput,
  now: string,
): Record<string, unknown> {
  if (input.action === 'complete') {
    const withoutSnooze = { ...current };
    delete withoutSnooze.owlSnoozedUntil;
    return {
      ...withoutSnooze,
      owlStatus: 'completed',
      owlUpdatedAt: now,
    };
  }
  if (input.action === 'snooze') {
    return {
      ...current,
      owlStatus: 'snoozed',
      owlSnoozedUntil: input.until,
      owlUpdatedAt: now,
    };
  }
  if (input.action === 'source_action') {
    return {
      ...current,
      owlUpdatedAt: now,
    };
  }
  if (input.action === 'not_an_action') {
    const withoutRejectedAction = { ...current };
    for (const key of [
      'actionType',
      'category',
      'amount',
      'urgency',
      'confidence',
      'actionReady',
      'reviewState',
      'reviewUrl',
      'primaryActionId',
      'primaryActionLabel',
      'primaryActionUrl',
      'owlSnoozedUntil',
    ]) {
      delete withoutRejectedAction[key];
    }
    return {
      ...withoutRejectedAction,
      owlStatus: 'not_an_action',
      owlDisposition: 'not_an_action',
      owlUpdatedAt: now,
    };
  }
  return {
    ...current,
    ...(input.field === 'action_type' ? { actionType: input.value } : {}),
    ...(input.field === 'urgency' ? { urgency: input.value } : {}),
    ...(input.field === 'amount' ? { amount: input.value } : {}),
    owlUpdatedAt: now,
  };
}

async function performOwlTaskActionNow(
  taskId: string,
  input: OwlTaskActionInput,
): Promise<OwlTaskActionResult> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).then((rows) => rows[0]);
  if (!task) {
    throw new OwlTaskActionError('Task not found', 'NOT_FOUND', 404);
  }
  if (task.connectorType !== 'document-intelligence') {
    throw new OwlTaskActionError('This action is available only for OWL tasks', 'NOT_OWL', 400);
  }

  const connector = connectorRegistry.getConnector(task.connectorInstanceId)
    ?? await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId);
  if (!isOwlActionConnector(connector)) {
    throw new OwlTaskActionError(
      'The OWL connector is unavailable',
      'CONNECTOR_UNAVAILABLE',
      503,
    );
  }

  let refreshedTask: TaskItem | null = null;
  try {
    if (input.action === 'complete') {
      await connector.completeTask(task.sourceId);
    } else if (input.action === 'source_action') {
      const sourceAction = findSourceAction(
        parseTaskMetadataCompat(task.metadata).metadata,
        input.sourceActionId,
      );
      if (!sourceAction) {
        throw new OwlTaskActionError(
          'This OWL source action is no longer available; refresh the task',
          'SOURCE_ACTION_UNAVAILABLE',
          409,
        );
      }
      refreshedTask = await connector.executeSourceAction(task.sourceId, sourceAction);
      refreshedTask ??= await connector.fetchActionTask(task.sourceId);
      if (!refreshedTask) {
        throw new Error('OWL accepted the source action but did not return the refreshed action');
      }
    } else if (input.action === 'snooze') {
      await connector.snoozeAction(task.sourceId, input.until);
    } else if (input.action === 'not_an_action') {
      await connector.submitActionFeedback(task.sourceId, { feedback_type: 'not_an_action' });
    } else {
      refreshedTask = await connector.submitActionFeedback(task.sourceId, feedbackFor(input));
      refreshedTask ??= await connector.fetchActionTask(task.sourceId);
      if (!refreshedTask) {
        throw new Error('OWL accepted the correction but did not return the refreshed action');
      }
    }
  } catch (error) {
    if (error instanceof OwlTaskActionError) throw error;
    throw new OwlTaskActionError(
      error instanceof Error ? error.message : 'OWL write-back failed',
      'REMOTE_WRITE_FAILED',
      502,
      { cause: error },
    );
  }

  const now = new Date().toISOString();
  const latestTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    .then((rows) => rows[0]);
  if (
    !latestTask
    || latestTask.connectorType !== 'document-intelligence'
    || latestTask.connectorInstanceId !== task.connectorInstanceId
    || latestTask.sourceId !== task.sourceId
  ) {
    throw new OwlTaskActionError(
      'Task changed while the OWL action was being applied; refresh to reconcile the source result',
      'TASK_CHANGED',
      409,
    );
  }
  const metadata = localMetadataAfter(
    refreshedTask?.metadata
      ?? parseTaskMetadataCompat(latestTask.metadata).metadata,
    input,
    now,
  );
  const sourceActionReady = refreshedTask?.metadata.actionReady !== false;
  const status = input.action === 'complete'
    ? 'done'
    : input.action === 'source_action'
      ? sourceActionReady
        ? refreshedTask?.status ?? latestTask.status
        : 'cancelled'
    : input.action === 'not_an_action'
    ? 'cancelled'
    : input.action === 'snooze'
      ? 'todo'
      : latestTask.status;
  const statusReason = input.action === 'complete'
    ? 'completed'
    : input.action === 'source_action'
      ? status === 'done'
        ? 'completed'
        : status === 'cancelled'
          ? 'not_planned'
          : latestTask.statusReason
    : input.action === 'not_an_action'
    ? 'not_planned'
    : input.action === 'snooze'
      ? null
      : latestTask.statusReason;
  const snoozedUntil = input.action === 'snooze'
    ? input.until
    : input.action === 'complete' || input.action === 'not_an_action'
      ? null
      : input.action === 'source_action'
        ? refreshedTask?.snoozedUntil ?? null
      : latestTask.snoozedUntil;
  const priority = refreshedTask?.priority
    ?? (input.action === 'correct' && input.field === 'urgency'
      ? input.value
      : latestTask.priority);

  const updates: Partial<typeof tasks.$inferInsert> = {
    metadata,
    updatedAt: now,
    lastSyncedAt: now,
    syncStatus: 'synced',
  };
  if (refreshedTask) {
    Object.assign(updates, {
      title: refreshedTask.title,
      description: refreshedTask.description ?? null,
      dueDate: refreshedTask.dueDate ?? null,
      priority,
    });
  }
  if (input.action === 'source_action') {
    Object.assign(updates, {
      status,
      statusReason,
      snoozedUntil,
      completedAt: status === 'done' || status === 'cancelled'
        ? refreshedTask?.completedAt || now
        : null,
    });
  } else if (input.action === 'complete') {
    Object.assign(updates, {
      status,
      statusReason,
      snoozedUntil,
      completedAt: now,
    });
  } else if (input.action === 'snooze') {
    Object.assign(updates, {
      status,
      statusReason,
      snoozedUntil,
      completedAt: null,
    });
  } else if (input.action === 'not_an_action') {
    Object.assign(updates, {
      status,
      statusReason,
      snoozedUntil,
      completedAt: now,
    });
  } else if (input.field === 'urgency') {
    updates.priority = priority;
  }

  function findSourceAction(
    metadata: Record<string, unknown>,
    sourceActionId: string,
  ): DocSourceAction | null {
    if (!Array.isArray(metadata.sourceActions)) return null;
    const action = metadata.sourceActions.find((candidate) => (
      !!candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).id === sourceActionId
    ));
    if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
    const record = action as Record<string, unknown>;
    return typeof record.id === 'string'
      && typeof record.label === 'string'
      && record.method === 'POST'
      && typeof record.url === 'string'
      ? {
          id: record.id,
          label: record.label,
          method: 'POST',
          url: record.url,
        }
      : null;
  }

  await db.update(tasks).set(updates).where(eq(tasks.id, taskId));

  return {
    status,
    statusReason,
    snoozedUntil,
    priority,
    metadata,
    updatedAt: now,
    syncStatus: 'synced',
    title: refreshedTask?.title,
    description: refreshedTask ? refreshedTask.description ?? null : undefined,
    dueDate: refreshedTask ? refreshedTask.dueDate ?? null : undefined,
  };
}

export async function performOwlTaskAction(
  taskId: string,
  input: OwlTaskActionInput,
): Promise<OwlTaskActionResult> {
  const previous = taskActionQueues.get(taskId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => performOwlTaskActionNow(taskId, input));
  const settled = result.then(() => undefined, () => undefined);
  taskActionQueues.set(taskId, settled);

  try {
    return await result;
  } finally {
    if (taskActionQueues.get(taskId) === settled) {
      taskActionQueues.delete(taskId);
    }
  }
}
