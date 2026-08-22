import db from '@/db';
import { tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { IConnector } from '@/lib/connectors';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import type { DocActionFeedback } from './document-client';

const ACTION_TYPES = ['pay', 'respond', 'file', 'review', 'sign', 'schedule'] as const;
const URGENCY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

type OwlActionType = (typeof ACTION_TYPES)[number];
type OwlUrgency = (typeof URGENCY_VALUES)[number];

export type OwlTaskActionInput =
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
}

export class OwlTaskActionError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'NOT_OWL' | 'CONNECTOR_UNAVAILABLE' | 'REMOTE_WRITE_FAILED',
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OwlTaskActionError';
  }
}

interface OwlActionConnector extends IConnector {
  snoozeAction(sourceId: string, until: string): Promise<void>;
  submitActionFeedback(sourceId: string, feedback: DocActionFeedback): Promise<void>;
}

function isOwlActionConnector(connector: IConnector | null): connector is OwlActionConnector {
  if (!connector || connector.type !== 'document-intelligence') return false;
  const candidate = connector as Partial<OwlActionConnector>;
  return typeof candidate.snoozeAction === 'function'
    && typeof candidate.submitActionFeedback === 'function';
}

export function parseOwlTaskActionInput(value: unknown): OwlTaskActionInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;

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
  if (input.action === 'snooze') {
    return {
      ...current,
      owlStatus: 'snoozed',
      owlSnoozedUntil: input.until,
      owlUpdatedAt: now,
    };
  }
  if (input.action === 'not_an_action') {
    const withoutSnooze = { ...current };
    delete withoutSnooze.owlSnoozedUntil;
    return {
      ...withoutSnooze,
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

export async function performOwlTaskAction(
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

  try {
    if (input.action === 'snooze') {
      await connector.snoozeAction(task.sourceId, input.until);
    } else if (input.action === 'not_an_action') {
      await connector.submitActionFeedback(task.sourceId, { feedback_type: 'not_an_action' });
    } else {
      await connector.submitActionFeedback(task.sourceId, feedbackFor(input));
    }
  } catch (error) {
    throw new OwlTaskActionError(
      error instanceof Error ? error.message : 'OWL write-back failed',
      'REMOTE_WRITE_FAILED',
      502,
      { cause: error },
    );
  }

  const now = new Date().toISOString();
  const metadata = localMetadataAfter(
    parseTaskMetadataCompat(task.metadata).metadata,
    input,
    now,
  );
  const status = input.action === 'not_an_action'
    ? 'cancelled'
    : input.action === 'snooze'
      ? 'todo'
      : task.status;
  const statusReason = input.action === 'not_an_action'
    ? 'not_planned'
    : input.action === 'snooze'
      ? null
      : task.statusReason;
  const snoozedUntil = input.action === 'snooze'
    ? input.until
    : input.action === 'not_an_action'
      ? null
      : task.snoozedUntil;
  const priority = input.action === 'correct' && input.field === 'urgency'
    ? input.value
    : task.priority;

  await db.update(tasks).set({
    metadata,
    status,
    statusReason,
    snoozedUntil,
    priority,
    completedAt: input.action === 'not_an_action' ? now : task.completedAt,
    updatedAt: now,
    lastSyncedAt: now,
    syncStatus: 'synced',
  }).where(eq(tasks.id, taskId));

  return {
    status,
    statusReason,
    snoozedUntil,
    priority,
    metadata,
    updatedAt: now,
    syncStatus: 'synced',
  };
}
