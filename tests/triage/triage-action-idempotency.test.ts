import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TriageActionRecord } from '@/types';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

const createTodoTaskFromTriageItem = vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    taskId: 'todo-task-1',
    taskTitle: 'Read the saved article',
    listId: 'todo-list-1',
    listName: 'Tasks',
  };
});
const findTodoTaskFromTriageItem = vi.fn();
const documentConnector = vi.hoisted(() => ({
  completeTask: vi.fn(async () => {}),
  reopenTask: vi.fn(async () => {}),
}));

vi.mock('@/lib/triage/actions/ms-todo', () => ({
  createTodoTaskFromTriageItem,
  findTodoTaskFromTriageItem,
  TodoTaskCreationError: class TodoTaskCreationError extends Error {
    constructor(
      message: string,
      readonly outcomeUnknown: boolean,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn((id: string) => id === 'di-connector'
      ? { type: 'document-intelligence', ...documentConnector }
      : null),
  },
}));

let db: typeof import('@/db').default;
let triageItems: typeof import('@/db/schema').triageItems;
let triageActionClaims: typeof import('@/db/schema').triageActionClaims;
let applyTriageAction: typeof import('@/lib/triage').applyTriageAction;
let undoTriageAction: typeof import('@/lib/triage').undoTriageAction;
let TodoTaskCreationError: typeof import('@/lib/triage/actions/ms-todo').TodoTaskCreationError;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ triageItems, triageActionClaims } = await import('@/db/schema'));
  ({ applyTriageAction, undoTriageAction } = await import('@/lib/triage'));
  ({ TodoTaskCreationError } = await import('@/lib/triage/actions/ms-todo'));

  await db.insert(triageItems).values({
    id: 'triage-item-1',
    sourcePlatform: 'reddit',
    sourceId: 'reddit:item-1',
    sourceUrl: 'https://example.com/article',
    title: 'Saved article',
    contentType: 'article',
    capturedAt: '2026-08-03T12:00:00.000Z',
    ingestedAt: '2026-08-03T12:00:00.000Z',
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 50,
    aiUrgency: 'evergreen',
    rawMetadata: {},
    actionsTaken: [],
  });
  await db.insert(triageItems).values([
    {
      id: 'triage-item-3',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-3',
      sourceUrl: 'https://example.com/third-article',
      title: 'Third saved article',
      contentType: 'article',
      capturedAt: '2026-08-03T12:02:00.000Z',
      ingestedAt: '2026-08-03T12:02:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
    {
      id: 'triage-item-4',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-4',
      sourceUrl: 'https://example.com/fourth-article',
      title: 'Fourth saved article',
      contentType: 'article',
      capturedAt: '2026-08-03T12:03:00.000Z',
      ingestedAt: '2026-08-03T12:03:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
    {
      id: 'triage-item-5',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-5',
      sourceUrl: 'https://example.com/fifth-article',
      title: 'Fifth saved article',
      contentType: 'article',
      capturedAt: '2026-08-03T12:04:00.000Z',
      ingestedAt: '2026-08-03T12:04:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
    {
      id: 'triage-item-6',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-6',
      sourceUrl: 'https://example.com/sixth-article',
      title: 'Sixth saved article',
      contentType: 'article',
      capturedAt: '2026-08-03T12:05:00.000Z',
      ingestedAt: '2026-08-03T12:05:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
  ]);
  await db.insert(triageItems).values({
    id: 'triage-item-2',
    sourcePlatform: 'reddit',
    sourceId: 'reddit:item-2',
    sourceUrl: 'https://example.com/second-article',
    title: 'Second saved article',
    contentType: 'article',
    capturedAt: '2026-08-03T12:01:00.000Z',
    ingestedAt: '2026-08-03T12:01:00.000Z',
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 50,
    aiUrgency: 'evergreen',
    rawMetadata: {},
    actionsTaken: [],
  });
});

describe('triage task action idempotency', () => {
  it('undoes only the exact latest state-changing action', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-undo',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-undo',
      sourceUrl: 'https://example.com/undo',
      title: 'Undo swipe',
      contentType: 'article',
      capturedAt: '2026-08-03T12:06:00.000Z',
      ingestedAt: '2026-08-03T12:06:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
    const dismissed = await applyTriageAction('triage-item-undo', 'dismiss');
    const action = dismissed!.actionsTaken.at(-1)!;

    const undone = await undoTriageAction(
      'triage-item-undo',
      action.actionType,
      action.id!,
    );

    expect(undone).toMatchObject({
      status: 'pending',
      actionsTaken: [],
    });
    expect(undone?.snoozedUntil).toBeUndefined();
  });

  it('does not let a stale undo revert a newer action', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-stale-undo',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-stale-undo',
      sourceUrl: 'https://example.com/stale-undo',
      title: 'Stale undo swipe',
      contentType: 'article',
      capturedAt: '2026-08-03T12:07:00.000Z',
      ingestedAt: '2026-08-03T12:07:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
    const dismissed = await applyTriageAction('triage-item-stale-undo', 'dismiss');
    const dismissAction = dismissed!.actionsTaken.at(-1)!;
    await applyTriageAction('triage-item-stale-undo', 'snooze');

    const undone = await undoTriageAction(
      'triage-item-stale-undo',
      dismissAction.actionType,
      dismissAction.id!,
    );

    expect(undone).toBeNull();
    const [item] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-stale-undo'));
    expect(item.status).toBe('snoozed');
    expect(item.actionsTaken).toHaveLength(2);
  });

  it('restores the state that preceded the latest action', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-state-undo',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-state-undo',
      sourceUrl: 'https://example.com/state-undo',
      title: 'Restore previous state',
      contentType: 'article',
      capturedAt: '2026-08-03T12:08:00.000Z',
      ingestedAt: '2026-08-03T12:08:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
    await applyTriageAction('triage-item-state-undo', 'dismiss');
    const snoozed = await applyTriageAction('triage-item-state-undo', 'snooze');
    const snoozeAction = snoozed!.actionsTaken.at(-1)!;

    const undone = await undoTriageAction(
      'triage-item-state-undo',
      snoozeAction.actionType,
      snoozeAction.id!,
    );

    expect(undone?.status).toBe('dismissed');
    expect(undone?.actionsTaken).toHaveLength(1);
  });

  it('serializes concurrent swipe actions with unique undo tokens', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-concurrent-swipes',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:item-concurrent-swipes',
      sourceUrl: 'https://example.com/concurrent-swipes',
      title: 'Concurrent swipe actions',
      contentType: 'article',
      capturedAt: '2026-08-03T12:09:00.000Z',
      ingestedAt: '2026-08-03T12:09:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });

    await Promise.all([
      applyTriageAction('triage-item-concurrent-swipes', 'dismiss'),
      applyTriageAction('triage-item-concurrent-swipes', 'snooze'),
    ]);

    const [item] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-concurrent-swipes'));
    const [firstAction, secondAction] = item.actionsTaken as TriageActionRecord[];
    const firstStatus = firstAction.actionType === 'dismiss' ? 'dismissed' : 'snoozed';
    expect(firstAction.id).toBeTruthy();
    expect(secondAction.id).toBeTruthy();
    expect(secondAction.id).not.toBe(firstAction.id);
    expect(secondAction.metadata).toMatchObject({ undoPreviousStatus: firstStatus });
  });

  it('reverses Document Intelligence completion during undo', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-di-undo',
      sourcePlatform: 'document-intelligence',
      sourceId: 'di-action-1',
      sourceUrl: 'https://example.com/di-action-1',
      title: 'Complete document action',
      contentType: 'document',
      capturedAt: '2026-08-03T12:10:00.000Z',
      ingestedAt: '2026-08-03T12:10:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: { connectorInstanceId: 'di-connector' },
      actionsTaken: [],
    });
    const completed = await applyTriageAction('triage-item-di-undo', 'complete_action');
    const action = completed!.actionsTaken.at(-1)!;

    const undone = await undoTriageAction('triage-item-di-undo', action.actionType, action.id!);

    expect(documentConnector.completeTask).toHaveBeenCalledWith('di-action-1');
    expect(documentConnector.reopenTask).toHaveBeenCalledWith('di-action-1');
    expect(undone).toMatchObject({ status: 'pending', actionsTaken: [] });
  });

  it('rolls back a failed DI reversal and permits retry', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-di-retry',
      sourcePlatform: 'document-intelligence',
      sourceId: 'di-action-2',
      sourceUrl: 'https://example.com/di-action-2',
      title: 'Retry document undo',
      contentType: 'document',
      capturedAt: '2026-08-03T12:11:00.000Z',
      ingestedAt: '2026-08-03T12:11:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: { connectorInstanceId: 'di-connector' },
      actionsTaken: [],
    });
    const completed = await applyTriageAction('triage-item-di-retry', 'complete_action');
    const action = completed!.actionsTaken.at(-1)!;
    documentConnector.reopenTask.mockRejectedValueOnce(new Error('DI unavailable'));

    await expect(
      undoTriageAction('triage-item-di-retry', action.actionType, action.id!),
    ).rejects.toThrow('DI unavailable');

    const [rolledBack] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-di-retry'));
    const rolledBackActions = rolledBack.actionsTaken as TriageActionRecord[];
    expect(rolledBack.status).toBe('actioned');
    expect(rolledBackActions.at(-1)?.metadata?.undoInProgress).toBeUndefined();

    await expect(
      undoTriageAction('triage-item-di-retry', action.actionType, action.id!),
    ).resolves.toMatchObject({ status: 'pending', actionsTaken: [] });
  });

  it('resumes an interrupted DI undo claim', async () => {
    await db.insert(triageItems).values({
      id: 'triage-item-di-resume',
      sourcePlatform: 'document-intelligence',
      sourceId: 'di-action-3',
      sourceUrl: 'https://example.com/di-action-3',
      title: 'Resume document undo',
      contentType: 'document',
      capturedAt: '2026-08-03T12:12:00.000Z',
      ingestedAt: '2026-08-03T12:12:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: { connectorInstanceId: 'di-connector' },
      actionsTaken: [],
    });
    const completed = await applyTriageAction('triage-item-di-resume', 'complete_action');
    const action = completed!.actionsTaken.at(-1)!;
    await db.update(triageItems).set({
      actionsTaken: [{
        ...action,
        metadata: {
          ...action.metadata,
          undoInProgress: true,
          undoClaimId: 'abandoned-claim',
          undoClaimedAt: '2020-01-01T00:00:00.000Z',
        },
      }],
    }).where(eq(triageItems.id, 'triage-item-di-resume'));

    const undone = await undoTriageAction('triage-item-di-resume', action.actionType, action.id!);

    expect(undone).toMatchObject({ status: 'pending', actionsTaken: [] });
  });

  it('creates one external task and one history record for concurrent requests', async () => {
    await Promise.all([
      applyTriageAction('triage-item-1', 'create_task_todo'),
      applyTriageAction('triage-item-1', 'create_task_todo'),
    ]);

    expect(createTodoTaskFromTriageItem).toHaveBeenCalledOnce();

    const [item] = await db.select().from(triageItems);
    expect(item.status).toBe('actioned');
    expect(item.actionsTaken).toEqual([
      expect.objectContaining({
        actionType: 'create_task_todo',
        metadata: expect.objectContaining({ todoTaskId: 'todo-task-1' }),
      }),
    ]);

    const claims = await db.select().from(triageActionClaims);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual(expect.objectContaining({
      triageItemId: 'triage-item-1',
      actionType: 'create_task_todo',
      state: 'completed',
    }));
  });

  it('does not recreate a task when the completed action is replayed', async () => {
    await applyTriageAction('triage-item-1', 'create_task_todo');

    expect(createTodoTaskFromTriageItem).toHaveBeenCalledOnce();
  });

  it('releases the claim when external creation fails so a retry can succeed', async () => {
    createTodoTaskFromTriageItem.mockRejectedValueOnce(new Error('Graph unavailable'));

    await expect(
      applyTriageAction('triage-item-2', 'create_task_todo'),
    ).rejects.toThrow('Graph unavailable');
    expect(await db.select().from(triageActionClaims)).toHaveLength(1);

    await applyTriageAction('triage-item-2', 'create_task_todo');

    expect(createTodoTaskFromTriageItem).toHaveBeenCalledTimes(3);
    expect(await db.select().from(triageActionClaims)).toHaveLength(2);
  });

  it('preserves distinct concurrent action history records', async () => {
    await Promise.all([
      applyTriageAction('triage-item-3', 'dismiss'),
      applyTriageAction('triage-item-3', 'snooze'),
    ]);

    const [item] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-3'));
    expect(item.actionsTaken).toHaveLength(2);
    expect(item.actionsTaken).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionType: 'dismiss' }),
      expect.objectContaining({ actionType: 'snooze' }),
    ]));
  });

  it('reconciles an ambiguous external outcome without posting a second task', async () => {
    const callsBefore = createTodoTaskFromTriageItem.mock.calls.length;
    createTodoTaskFromTriageItem.mockRejectedValueOnce(
      new TodoTaskCreationError('Response lost', true),
    );
    findTodoTaskFromTriageItem.mockResolvedValueOnce({
      taskId: 'todo-task-recovered',
      taskTitle: 'Recovered task',
      listId: 'todo-list-1',
      listName: 'Tasks',
    });

    await expect(
      applyTriageAction('triage-item-4', 'create_task_todo'),
    ).rejects.toThrow('Response lost');

    await applyTriageAction('triage-item-4', 'create_task_todo');

    expect(createTodoTaskFromTriageItem).toHaveBeenCalledTimes(callsBefore + 1);
    expect(findTodoTaskFromTriageItem).toHaveBeenCalledOnce();
    const [claim] = (await db.select().from(triageActionClaims))
      .filter((entry) => entry.triageItemId === 'triage-item-4');
    expect(claim).toEqual(expect.objectContaining({
      state: 'completed',
      result: expect.objectContaining({
        metadata: expect.objectContaining({ todoTaskId: 'todo-task-recovered' }),
      }),
    }));
  });

  it('retries an old ambiguous claim only after reconciliation proves no task exists', async () => {
    createTodoTaskFromTriageItem.mockRejectedValueOnce(
      new TodoTaskCreationError('Request outcome unknown', true),
    );
    findTodoTaskFromTriageItem.mockResolvedValueOnce(null);

    await expect(
      applyTriageAction('triage-item-5', 'create_task_todo'),
    ).rejects.toThrow('Request outcome unknown');

    await db.update(triageActionClaims).set({
      claimedAt: '2020-01-01T00:00:00.000Z',
    }).where(eq(triageActionClaims.triageItemId, 'triage-item-5'));

    await applyTriageAction('triage-item-5', 'create_task_todo');

    const [item] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-5'));
    expect(item.actionsTaken).toEqual([
      expect.objectContaining({ actionType: 'create_task_todo' }),
    ]);
    expect(findTodoTaskFromTriageItem).toHaveBeenCalledTimes(2);
  });

  it('reconciles against the originally resolved list when retry options change', async () => {
    createTodoTaskFromTriageItem.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as {
        onTargetResolved?: (target: { listId: string; listName: string }) => Promise<void>;
      };
      await options.onTargetResolved?.({ listId: 'original-list', listName: 'Original' });
      throw new TodoTaskCreationError('Response lost after create', true);
    });
    findTodoTaskFromTriageItem.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[1] as { listId?: string; listName?: string };
      expect(options).toEqual(expect.objectContaining({
        listId: 'original-list',
        listName: 'Original',
      }));
      return {
        taskId: 'todo-task-original-list',
        taskTitle: 'Recovered from original list',
        listId: 'original-list',
        listName: 'Original',
      };
    });

    await expect(
      applyTriageAction(
        'triage-item-6',
        'create_task_todo',
        undefined,
        undefined,
        { listId: 'original-list', listName: 'Original' },
      ),
    ).rejects.toThrow('Response lost after create');

    await applyTriageAction(
      'triage-item-6',
      'create_task_todo',
      undefined,
      undefined,
      { listId: 'different-list', listName: 'Different' },
    );

    const [item] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-item-6'));
    expect(item.actionsTaken).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ todoTaskId: 'todo-task-original-list' }),
      }),
    ]);
  });
});
