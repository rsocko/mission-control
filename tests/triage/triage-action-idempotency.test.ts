import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { TriageActionRecord } from '@/types';
import {
  createSqliteTriagePersistenceRepositories,
} from '@/db/persistence/sqlite-triage-repositories';
import {
  describeTriageActionPersistenceContract,
  TRIAGE_ACTION_NOW,
  type TriageActionContractHarness,
} from '../contracts/scout-ingestion-reconciliation-persistence.contract';

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
let sqlite: typeof import('@/db').sqlite;
let triageItems: typeof import('@/db/schema').triageItems;
let triageActionClaims: typeof import('@/db/schema').triageActionClaims;
let applyTriageAction: typeof import('@/lib/triage').applyTriageAction;
let undoTriageAction: typeof import('@/lib/triage').undoTriageAction;
let TodoTaskCreationError: typeof import('@/lib/triage/actions/ms-todo').TodoTaskCreationError;

beforeAll(async () => {
  ({ default: db, sqlite } = await import('@/db'));
  ({ triageItems, triageActionClaims } = await import('@/db/schema'));
  const { createSqliteTriagePersistenceRepositories } = await import(
    '@/db/persistence/sqlite-triage-repositories'
  );
  const { registerTriagePersistenceRepositories } = await import('@/lib/triage/persistence');
  registerTriagePersistenceRepositories(
    createSqliteTriagePersistenceRepositories(sqlite),
  );
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

// ─── Shared SQLite/PostgreSQL contract ───────────────────────────────────────

function createSqliteTriageActionContractHarness(): TriageActionContractHarness {
  const contractSqlite = new BetterSqlite3(':memory:');
  contractSqlite.exec(`
    CREATE TABLE triage_items (
      id TEXT PRIMARY KEY, source_platform TEXT NOT NULL, source_id TEXT NOT NULL,
      source_url TEXT NOT NULL, canonical_url TEXT, title TEXT NOT NULL,
      description TEXT, thumbnail_url TEXT, content_type TEXT NOT NULL DEFAULT 'link',
      captured_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', snoozed_until TEXT, ai_summary TEXT,
      ai_categories TEXT NOT NULL DEFAULT '[]',
      ai_suggested_actions TEXT NOT NULL DEFAULT '[]',
      ai_relevance_score INTEGER NOT NULL DEFAULT 0,
      ai_urgency TEXT NOT NULL DEFAULT 'evergreen',
      raw_metadata TEXT NOT NULL DEFAULT '{}',
      actions_taken TEXT NOT NULL DEFAULT '[]', source_order INTEGER
    );
    CREATE UNIQUE INDEX idx_triage_items_source ON triage_items(source_platform, source_id);
    CREATE TABLE triage_action_claims (
      id TEXT PRIMARY KEY, triage_item_id TEXT NOT NULL, action_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT NOT NULL,
      completed_at TEXT, result TEXT
    );
    CREATE UNIQUE INDEX idx_triage_action_claims_item_action
      ON triage_action_claims(triage_item_id, action_type);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'none',
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT, status_reason TEXT, snoozed_until TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', sync_status TEXT NOT NULL DEFAULT 'synced',
      last_synced_at TEXT NOT NULL
    );
  `);
  contractDatabase = contractSqlite;
  const repositories = createSqliteTriagePersistenceRepositories(contractSqlite);

  return {
    actions: repositories.actions,
    documentTaskActions: repositories.documentTaskActions,
    async reset() {
      contractSqlite.exec(`
        DELETE FROM triage_action_claims;
        DELETE FROM triage_items;
        DELETE FROM tasks;
      `);
    },
    async seedItem(item) {
      contractSqlite.prepare(`
        INSERT INTO triage_items (
          id, source_platform, source_id, source_url, canonical_url, title,
          description, thumbnail_url, content_type, captured_at, ingested_at,
          status, snoozed_until, ai_summary, ai_categories, ai_suggested_actions,
          ai_relevance_score, ai_urgency, raw_metadata, actions_taken, source_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id,
        item.sourcePlatform,
        item.sourceId,
        item.sourceUrl,
        item.canonicalUrl ?? null,
        item.title,
        item.description ?? null,
        item.thumbnailUrl ?? null,
        item.contentType,
        item.capturedAt,
        item.ingestedAt,
        item.status,
        item.snoozedUntil ?? null,
        item.aiSummary ?? null,
        JSON.stringify(item.aiCategories),
        JSON.stringify(item.aiSuggestedActions),
        item.aiRelevanceScore,
        item.aiUrgency,
        JSON.stringify(item.rawMetadata),
        JSON.stringify(item.actionsTaken),
        item.sourceOrder ?? null,
      );
    },
    async seedTask(task) {
      contractSqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          created_at, updated_at, last_synced_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.sourceId,
        task.connectorType,
        task.connectorInstanceId,
        task.title,
        task.status,
        TRIAGE_ACTION_NOW,
        TRIAGE_ACTION_NOW,
        TRIAGE_ACTION_NOW,
        JSON.stringify(task.metadata),
      );
    },
    async readItem(id) {
      return repositories.actions.getActionSnapshot(id);
    },
    async countClaims() {
      return (contractSqlite.prepare('SELECT COUNT(*) AS count FROM triage_action_claims')
        .get() as { count: number }).count;
    },
  };
}

let contractDatabase: BetterSqlite3.Database | null = null;
let triageActionHarness: TriageActionContractHarness | null = null;

afterAll(() => {
  contractDatabase?.close();
  contractDatabase = null;
});

describeTriageActionPersistenceContract('SQLite', () => {
  triageActionHarness ??= createSqliteTriageActionContractHarness();
  return triageActionHarness;
});
