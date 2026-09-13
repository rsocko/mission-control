import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageItem } from '@/types';

const { graphFetch } = vi.hoisted(() => ({
  graphFetch: vi.fn(),
}));

vi.mock('@/lib/connectors/microsoft-todo/graph-client', () => ({
  createGraphClient: () => ({ graphFetch }),
}));

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    connectors: {
      listEnabled: async () => [{
        id: 'todo-test',
        type: 'microsoft-todo',
      }],
    },
  }),
}));

const item = {
  id: 'triage-item',
  sourcePlatform: 'reddit',
  sourceId: 'reddit:item',
  sourceUrl: 'https://example.com/item',
  title: 'Saved item',
  contentType: 'article',
  capturedAt: '2026-09-06T12:00:00.000Z',
  ingestedAt: '2026-09-06T12:00:00.000Z',
  status: 'pending',
  aiCategories: [],
  aiSuggestedActions: [],
  aiRelevanceScore: 50,
  aiUrgency: 'evergreen',
  rawMetadata: {},
  actionsTaken: [],
} satisfies TriageItem;

describe('Microsoft To Do triage actions', () => {
  beforeEach(() => {
    graphFetch.mockReset();
  });

  it('encodes opaque list IDs while reconciling existing tasks', async () => {
    graphFetch.mockResolvedValue(Response.json({ value: [] }));
    const { findTodoTaskFromTriageItem } = await import('@/lib/triage/actions/ms-todo');

    await expect(findTodoTaskFromTriageItem(item, {
      listId: 'AQMk/list+=',
    })).resolves.toBeNull();

    expect(graphFetch).toHaveBeenCalledWith(
      '/me/todo/lists/AQMk%2Flist%2B%3D/tasks?$top=100',
    );
  });

  it('encodes opaque list IDs while creating tasks', async () => {
    graphFetch.mockResolvedValue(Response.json({
      id: 'created-task',
      title: 'Review saved item',
    }, { status: 201 }));
    const { createTodoTaskFromTriageItem } = await import('@/lib/triage/actions/ms-todo');

    await createTodoTaskFromTriageItem(item, {
      listId: 'AQMk/list+=',
    });

    expect(graphFetch).toHaveBeenCalledWith(
      '/me/todo/lists/AQMk%2Flist%2B%3D/tasks',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
