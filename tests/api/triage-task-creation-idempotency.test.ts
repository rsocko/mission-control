import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('@/db');
vi.unmock('@/db/schema');
vi.unmock('drizzle-orm');
vi.unmock('crypto');

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(async () => undefined),
}));

let db: typeof import('@/db').default;
let tasks: typeof import('@/db/schema').tasks;
let triageItems: typeof import('@/db/schema').triageItems;
let triageActionClaims: typeof import('@/db/schema').triageActionClaims;

beforeAll(async () => {
  const dbModule = await import('@/db');
  db = dbModule.default;
  ({ tasks, triageItems, triageActionClaims } = await import('@/db/schema'));
  await dbModule.initializeSqlitePersistenceComposition();

  await db.insert(triageItems).values([
    {
      id: 'triage-route-item',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:route-item',
      sourceUrl: 'https://example.com/route-item',
      title: 'Route item',
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
    },
    {
      id: 'triage-invalid-item',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:invalid-item',
      sourceUrl: 'https://example.com/invalid-item',
      title: 'Invalid request item',
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
    },
  ]);
});

describe('POST /api/tasks triage idempotency', () => {
  it('persists one task for concurrent requests from the same triage item', async () => {
    const { POST } = await import('@/app/api/tasks/route');
    const makeRequest = () => new Request('http://localhost:3099/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Create from triage',
        connectorType: 'local',
        triageItemId: 'triage-route-item',
      }),
    });

    const responses = await Promise.all([POST(makeRequest()), POST(makeRequest())]);
    const payloads = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(payloads[0].id).toBe(payloads[1].id);

    const persisted = await db.select().from(tasks)
      .where(eq(tasks.sourceId, 'local:triage:triage-route-item'));
    expect(persisted).toHaveLength(1);

    const [triageItem] = await db.select().from(triageItems)
      .where(eq(triageItems.id, 'triage-route-item'));
    expect(triageItem.actionsTaken).toEqual([
      expect.objectContaining({
        actionType: 'create_task_todo',
        metadata: expect.objectContaining({ mcTaskId: persisted[0].id }),
      }),
    ]);
  });

  it('does not claim a triage item for an invalid task request', async () => {
    const { POST } = await import('@/app/api/tasks/route');
    const response = await POST(new Request('http://localhost:3099/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorType: 'local', triageItemId: 'triage-invalid-item' }),
    }));

    expect(response.status).toBe(400);
    const claims = await db.select().from(triageActionClaims)
      .where(eq(triageActionClaims.triageItemId, 'triage-invalid-item'));
    expect(claims).toHaveLength(0);
  });
});
