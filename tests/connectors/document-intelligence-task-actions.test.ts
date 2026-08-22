import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  currentTask,
  getConnector,
  initializeConnectorFromDb,
  snoozeAction,
  submitActionFeedback,
  updateSet,
} = vi.hoisted(() => ({
  currentTask: {
    id: 'task-1',
    sourceId: 'owl-action-1',
    connectorType: 'document-intelligence',
    connectorInstanceId: 'owl-1',
    status: 'todo',
    statusReason: null,
    priority: 'high',
    snoozedUntil: null,
    completedAt: null,
    metadata: { actionType: 'pay', urgency: 'high', amount: 50 },
  },
  getConnector: vi.fn(),
  initializeConnectorFromDb: vi.fn(),
  snoozeAction: vi.fn(),
  submitActionFeedback: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [currentTask]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: updateSet.mockImplementation(() => ({ where: vi.fn(async () => undefined) })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({ tasks: { id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((...args: unknown[]) => args) }));
vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector },
}));
vi.mock('@/lib/sync', () => ({
  syncScheduler: { initializeConnectorFromDb },
}));

import {
  parseOwlTaskActionInput,
  performOwlTaskAction,
} from '@/lib/connectors/document-intelligence/task-actions';

describe('OWL task action service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentTask.connectorType = 'document-intelligence';
    currentTask.status = 'todo';
    currentTask.statusReason = null;
    currentTask.priority = 'high';
    currentTask.snoozedUntil = null;
    currentTask.completedAt = null;
    currentTask.metadata = { actionType: 'pay', urgency: 'high', amount: 50 };
    getConnector.mockReturnValue({
      type: 'document-intelligence',
      snoozeAction,
      submitActionFeedback,
    });
    snoozeAction.mockResolvedValue(undefined);
    submitActionFeedback.mockResolvedValue(undefined);
  });

  it('validates future snoozes and supported correction values', () => {
    expect(parseOwlTaskActionInput({ action: 'snooze', until: 'not-a-date' })).toBeNull();
    expect(parseOwlTaskActionInput({
      action: 'snooze',
      until: new Date(Date.now() + 60_000).toISOString(),
    })).toMatchObject({ action: 'snooze' });
    expect(parseOwlTaskActionInput({
      action: 'correct',
      field: 'urgency',
      value: 'urgent-ish',
    })).toBeNull();
    expect(parseOwlTaskActionInput({
      action: 'correct',
      field: 'amount',
      value: -1,
    })).toBeNull();
  });

  it('writes the remote snooze before updating local state', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();

    const result = await performOwlTaskAction('task-1', { action: 'snooze', until });

    expect(snoozeAction).toHaveBeenCalledWith('owl-action-1', until);
    expect(snoozeAction.mock.invocationCallOrder[0]).toBeLessThan(updateSet.mock.invocationCallOrder[0]);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'todo',
      snoozedUntil: until,
      syncStatus: 'synced',
      metadata: expect.objectContaining({
        owlStatus: 'snoozed',
        owlSnoozedUntil: until,
      }),
    }));
    expect(result.snoozedUntil).toBe(until);
  });

  it('does not record success locally when OWL rejects the action', async () => {
    submitActionFeedback.mockRejectedValue(new Error('Paperless mutation failed'));

    await expect(performOwlTaskAction('task-1', { action: 'not_an_action' }))
      .rejects.toMatchObject({
        code: 'REMOTE_WRITE_FAILED',
        status: 502,
        message: 'Paperless mutation failed',
      });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('maps no-action and extraction corrections to OWL feedback', async () => {
    await performOwlTaskAction('task-1', { action: 'not_an_action' });
    await performOwlTaskAction('task-1', {
      action: 'correct',
      field: 'action_type',
      value: 'respond',
    });
    await performOwlTaskAction('task-1', {
      action: 'correct',
      field: 'amount',
      value: 125.5,
    });

    expect(submitActionFeedback).toHaveBeenNthCalledWith(
      1,
      'owl-action-1',
      { feedback_type: 'not_an_action' },
    );
    expect(submitActionFeedback).toHaveBeenNthCalledWith(
      2,
      'owl-action-1',
      { feedback_type: 'misclassified', corrected_action_type: 'respond' },
    );
    expect(submitActionFeedback).toHaveBeenNthCalledWith(
      3,
      'owl-action-1',
      { feedback_type: 'wrong_amount', corrected_amount: 125.5 },
    );
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      statusReason: 'not_planned',
    }));
  });

  it('rejects non-OWL tasks without resolving a connector', async () => {
    currentTask.connectorType = 'github-issues';

    await expect(performOwlTaskAction('task-1', { action: 'not_an_action' }))
      .rejects.toMatchObject({ code: 'NOT_OWL', status: 400 });
    expect(getConnector).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});
