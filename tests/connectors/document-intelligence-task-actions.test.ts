import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  currentTask,
  getConnector,
  initializeConnectorFromDb,
  completeTask,
  executeSourceAction,
  fetchActionTask,
  snoozeAction,
  submitActionFeedback,
  applyTaskWrite,
} = vi.hoisted(() => ({
  currentTask: {
    id: 'task-1',
    sourceId: 'owl-action-1',
    connectorType: 'document-intelligence',
    connectorInstanceId: 'owl-1',
    title: 'Pay: Acme',
    description: null as string | null,
    status: 'todo',
    statusReason: null as string | null,
    priority: 'high',
    dueDate: null as string | null,
    snoozedUntil: null as string | null,
    completedAt: null as string | null,
    metadata: { actionType: 'pay', urgency: 'high', amount: 50 } as Record<string, unknown>,
  },
  getConnector: vi.fn(),
  initializeConnectorFromDb: vi.fn(),
  completeTask: vi.fn(),
  executeSourceAction: vi.fn(),
  fetchActionTask: vi.fn(),
  snoozeAction: vi.fn(),
  submitActionFeedback: vi.fn(),
  applyTaskWrite: vi.fn(),
}));

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => ({
    documentTaskActions: {
      getTask: async () => ({ ...currentTask }),
      applyTaskWrite,
    },
  }),
}));
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

/**
 * The persistence port speaks physical column names; this projects one write
 * back into the model-shaped object the behavioural assertions read.
 */
const COLUMN_KEYS: Record<string, string> = {
  status: 'status',
  status_reason: 'statusReason',
  snoozed_until: 'snoozedUntil',
  completed_at: 'completedAt',
  priority: 'priority',
  title: 'title',
  description: 'description',
  due_date: 'dueDate',
};

function writes(): Record<string, unknown>[] {
  return applyTaskWrite.mock.calls.map(([input]) => ({
    ...Object.fromEntries(
      Object.entries(input.columns as Record<string, unknown>)
        .map(([column, value]) => [COLUMN_KEYS[column] ?? column, value]),
    ),
    metadata: JSON.parse(input.metadata as string) as Record<string, unknown>,
    syncStatus: input.syncStatus,
    updatedAt: input.updatedAt,
    expectedIdentity: input.expectedIdentity,
  }));
}

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
    applyTaskWrite.mockImplementation(async () => ({
      kind: 'applied',
      task: { ...currentTask },
    }));
    getConnector.mockReturnValue({
      type: 'document-intelligence',
      completeTask,
      executeSourceAction,
      fetchActionTask,
      snoozeAction,
      submitActionFeedback,
    });
    completeTask.mockResolvedValue(undefined);
    executeSourceAction.mockResolvedValue(null);
    fetchActionTask.mockResolvedValue({
      title: 'Pay: Acme',
      description: 'Pay invoice',
      status: 'todo',
      priority: 'high',
      dueDate: '2026-08-30',
      snoozedUntil: null,
      completedAt: null,
      metadata: {
        actionType: 'pay',
        urgency: 'high',
        amount: 50,
        primaryActionLabel: 'Pay Acme',
        primaryActionUrl: 'https://billing.example/pay',
      },
    });
    snoozeAction.mockResolvedValue(undefined);
    submitActionFeedback.mockResolvedValue(null);
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
    expect(snoozeAction.mock.invocationCallOrder[0])
      .toBeLessThan(applyTaskWrite.mock.invocationCallOrder[0]);
    expect(writes()[0]).toEqual(expect.objectContaining({
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

  it('fences the local write on the task identity observed before the remote call', async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();

    await performOwlTaskAction('task-1', { action: 'snooze', until });

    expect(writes()[0].expectedIdentity).toEqual({
      connectorType: 'document-intelligence',
      connectorInstanceId: 'owl-1',
      sourceId: 'owl-action-1',
    });
  });

  it('reports task-identity drift as a conflict instead of writing local state', async () => {
    applyTaskWrite.mockResolvedValueOnce({ kind: 'identity-changed' });

    await expect(performOwlTaskAction('task-1', { action: 'complete' }))
      .rejects.toMatchObject({ code: 'TASK_CHANGED', status: 409 });
    expect(completeTask).toHaveBeenCalledWith('owl-action-1');
  });

  it('does not record success locally when OWL rejects the action', async () => {
    submitActionFeedback.mockRejectedValue(new Error('Paperless mutation failed'));

    await expect(performOwlTaskAction('task-1', { action: 'not_an_action' }))
      .rejects.toMatchObject({
        code: 'REMOTE_WRITE_FAILED',
        status: 502,
        message: 'Paperless mutation failed',
      });
    expect(applyTaskWrite).not.toHaveBeenCalled();
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
    const recorded = writes();
    expect(recorded[0]).toEqual(expect.objectContaining({
      status: 'cancelled',
      statusReason: 'not_planned',
    }));
    expect(recorded[0].metadata).not.toHaveProperty('actionType');
    expect(recorded[0].metadata).not.toHaveProperty('amount');
    expect(recorded.at(-1)).toEqual(expect.objectContaining({
      title: 'Pay: Acme',
      dueDate: '2026-08-30',
      metadata: expect.objectContaining({
        primaryActionLabel: 'Pay Acme',
        primaryActionUrl: 'https://billing.example/pay',
      }),
    }));
  });

  it('keeps explicit completion separate from contextual CTA navigation', async () => {
    const result = await performOwlTaskAction('task-1', { action: 'complete' });

    expect(completeTask).toHaveBeenCalledWith('owl-action-1');
    expect(result.status).toBe('done');
    expect(writes()[0]).toEqual(expect.objectContaining({
      status: 'done',
      statusReason: 'completed',
    }));
  });

  it('executes a declared generic source action and refreshes source-controlled fields', async () => {
    currentTask.metadata = {
      actionType: 'file',
      sourceActions: [{
        id: 'file_document',
        label: 'File in Paperless',
        method: 'POST',
        url: '/api/action-queue/actions/owl-action-1/file',
      }],
    };
    executeSourceAction.mockResolvedValue({
      title: 'File: Invoice',
      description: 'Filed',
      status: 'done',
      priority: 'low',
      dueDate: null,
      snoozedUntil: null,
      completedAt: '2026-08-24T12:00:00.000Z',
      metadata: {
        actionType: 'file',
        actionReady: true,
        sourceActions: [],
      },
    });

    const result = await performOwlTaskAction('task-1', {
      action: 'source_action',
      sourceActionId: 'file_document',
    });

    expect(executeSourceAction).toHaveBeenCalledWith(
      'owl-action-1',
      expect.objectContaining({ id: 'file_document', method: 'POST' }),
    );
    expect(result).toMatchObject({
      status: 'done',
      title: 'File: Invoice',
      description: 'Filed',
      dueDate: null,
    });
    expect(writes()[0]).toEqual(expect.objectContaining({
      status: 'done',
      title: 'File: Invoice',
      metadata: expect.objectContaining({ sourceActions: [] }),
    }));
  });

  it('preserves concurrent lifecycle changes when saving a correction', async () => {
    submitActionFeedback.mockImplementationOnce(async () => {
      currentTask.status = 'done';
      currentTask.statusReason = 'completed';
      currentTask.completedAt = '2026-08-22T16:00:00.000Z';
    });

    const result = await performOwlTaskAction('task-1', {
      action: 'correct',
      field: 'amount',
      value: 75,
    });

    const update = writes().at(-1)!;
    expect(update).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ amount: 75 }),
      syncStatus: 'synced',
    }));
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('statusReason');
    expect(update).not.toHaveProperty('completedAt');
    expect(update).not.toHaveProperty('snoozedUntil');
    expect(update.priority).toBe('high');
    expect(result.status).toBe('done');
    expect(result.statusReason).toBe('completed');
  });

  it('serializes source actions for the same task', async () => {
    let releaseFirst!: () => void;
    snoozeAction.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const firstUntil = new Date(Date.now() + 86_400_000).toISOString();
    const secondUntil = new Date(Date.now() + 172_800_000).toISOString();

    const first = performOwlTaskAction('task-1', { action: 'snooze', until: firstUntil });
    await vi.waitFor(() => expect(snoozeAction).toHaveBeenCalledTimes(1));
    const second = performOwlTaskAction('task-1', { action: 'snooze', until: secondUntil });
    await Promise.resolve();
    expect(snoozeAction).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    await second;

    expect(snoozeAction).toHaveBeenNthCalledWith(1, 'owl-action-1', firstUntil);
    expect(snoozeAction).toHaveBeenNthCalledWith(2, 'owl-action-1', secondUntil);
  });

  it('rejects non-OWL tasks without resolving a connector', async () => {
    currentTask.connectorType = 'github-issues';

    await expect(performOwlTaskAction('task-1', { action: 'not_an_action' }))
      .rejects.toMatchObject({ code: 'NOT_OWL', status: 400 });
    expect(getConnector).not.toHaveBeenCalled();
    expect(applyTaskWrite).not.toHaveBeenCalled();
  });
});
