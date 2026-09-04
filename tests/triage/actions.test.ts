/**
 * Tests for the triage actions domain module (`@/lib/triage/actions`).
 *
 * The end-to-end create_task_todo idempotency and undo semantics are already
 * covered thoroughly by `tests/triage/triage-action-idempotency.test.ts`
 * (exercised through the `@/lib/triage` compatibility barrel). This file
 * focuses on the pieces of the actions module not already covered there:
 * the pure `isUndoableTriageAction` classifier and the low-level task-claim
 * reservation primitives used to make `create_task_todo` idempotent.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

vi.mock('@/lib/triage/actions/ms-todo', () => ({
  createTodoTaskFromTriageItem: vi.fn(),
  findTodoTaskFromTriageItem: vi.fn(),
  TodoTaskCreationError: class TodoTaskCreationError extends Error {},
}));
vi.mock('@/lib/triage/actions/karakeep', () => ({ saveToKarakeep: vi.fn() }));
vi.mock('@/lib/triage/actions/model-catalog', () => ({ saveToModelCatalog: vi.fn() }));
vi.mock('@/lib/triage/actions/knowledge-base', () => ({
  saveToKnowledgeBase: vi.fn(),
  buildKnowledgeBaseActionRecord: vi.fn(),
}));
vi.mock('@/lib/triage/actions/document-intelligence', () => ({
  completeDocumentAction: vi.fn(),
  deferDocumentAction: vi.fn(),
  reopenDocumentAction: vi.fn(),
}));

let db: typeof import('@/db').default;
let sqlite: typeof import('@/db').sqlite;
let triageItems: typeof import('@/db/schema').triageItems;
let triageActionClaims: typeof import('@/db/schema').triageActionClaims;
let isUndoableTriageAction: typeof import('@/lib/triage/actions').isUndoableTriageAction;
let reserveTriageTaskCreation: typeof import('@/lib/triage/actions').reserveTriageTaskCreation;
let completeTriageTaskCreation: typeof import('@/lib/triage/actions').completeTriageTaskCreation;
let releaseTriageTaskCreation: typeof import('@/lib/triage/actions').releaseTriageTaskCreation;
let TriageActionInProgressError: typeof import('@/lib/triage/actions').TriageActionInProgressError;

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
  ({
    isUndoableTriageAction,
    reserveTriageTaskCreation,
    completeTriageTaskCreation,
    releaseTriageTaskCreation,
    TriageActionInProgressError,
  } = await import('@/lib/triage/actions'));
});

describe('isUndoableTriageAction', () => {
  it('classifies complete_action, dismiss, and snooze as undoable', () => {
    expect(isUndoableTriageAction('complete_action')).toBe(true);
    expect(isUndoableTriageAction('dismiss')).toBe(true);
    expect(isUndoableTriageAction('snooze')).toBe(true);
  });

  it('classifies other action types as not undoable', () => {
    expect(isUndoableTriageAction('create_task_todo')).toBe(false);
    expect(isUndoableTriageAction('save_karakeep')).toBe(false);
    expect(isUndoableTriageAction('bogus')).toBe(false);
  });
});

describe('TriageActionInProgressError', () => {
  it('carries the triage item id and a stable name', () => {
    const error = new TriageActionInProgressError('item-123');
    expect(error.triageItemId).toBe('item-123');
    expect(error.name).toBe('TriageActionInProgressError');
    expect(error.message).toMatch(/still in progress/i);
  });
});

describe('task creation claim primitives', () => {
  it('reserves a claim for a fresh item and returns kind=claimed', async () => {
    await db.insert(triageItems).values({
      id: 'actions-claim-fresh',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:actions-claim-fresh',
      sourceUrl: 'https://example.com/actions-claim-fresh',
      title: 'Fresh item',
      contentType: 'article',
      capturedAt: '2026-08-08T12:00:00.000Z',
      ingestedAt: '2026-08-08T12:00:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });

    const claim = await reserveTriageTaskCreation('actions-claim-fresh');

    expect(claim?.kind).toBe('claimed');
    if (claim?.kind === 'claimed') {
      expect(claim.item.id).toBe('actions-claim-fresh');
      const [row] = await db.select().from(triageActionClaims)
        .where(eq(triageActionClaims.triageItemId, 'actions-claim-fresh'));
      expect(row.state).toBe('pending');
    }
  });

  it('returns null when reserving for an unknown item', async () => {
    const claim = await reserveTriageTaskCreation('does-not-exist');
    expect(claim).toBeNull();
  });

  it('completeTriageTaskCreation marks the claim completed and records the action', async () => {
    await db.insert(triageItems).values({
      id: 'actions-claim-complete',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:actions-claim-complete',
      sourceUrl: 'https://example.com/actions-claim-complete',
      title: 'Completable item',
      contentType: 'article',
      capturedAt: '2026-08-08T12:01:00.000Z',
      ingestedAt: '2026-08-08T12:01:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
    const claim = await reserveTriageTaskCreation('actions-claim-complete');
    if (claim?.kind !== 'claimed') throw new Error('expected a fresh claim');

    const updated = await completeTriageTaskCreation('actions-claim-complete', claim.claimId, {
      id: 'record-1',
      actionType: 'create_task_todo',
      appliedAt: '2026-08-08T12:02:00.000Z',
      note: 'Created task',
    });

    expect(updated.status).toBe('actioned');
    expect(updated.actionsTaken).toHaveLength(1);
    const [claimRow] = await db.select().from(triageActionClaims).where(eq(triageActionClaims.id, claim.claimId));
    expect(claimRow.state).toBe('completed');
  });

  it('releaseTriageTaskCreation removes a pending claim so it can be retried', async () => {
    await db.insert(triageItems).values({
      id: 'actions-claim-release',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:actions-claim-release',
      sourceUrl: 'https://example.com/actions-claim-release',
      title: 'Releasable item',
      contentType: 'article',
      capturedAt: '2026-08-08T12:03:00.000Z',
      ingestedAt: '2026-08-08T12:03:00.000Z',
      status: 'pending',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 50,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
    const claim = await reserveTriageTaskCreation('actions-claim-release');
    if (claim?.kind !== 'claimed') throw new Error('expected a fresh claim');

    const released = await releaseTriageTaskCreation(claim.claimId);

    expect(released).toBe(true);
    const rows = await db.select().from(triageActionClaims).where(eq(triageActionClaims.id, claim.claimId));
    expect(rows).toHaveLength(0);
  });

  it('releaseTriageTaskCreation returns false for an unknown claim', async () => {
    const released = await releaseTriageTaskCreation('unknown-claim-id');
    expect(released).toBe(false);
  });
});
