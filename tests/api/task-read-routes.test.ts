import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const taskReads = vi.hoisted(() => ({
  listLinkedSources: vi.fn(),
  getQuickSortSuggestionInputs: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
  taskReads.listLinkedSources.mockReset();
  taskReads.getQuickSortSuggestionInputs.mockReset();
  taskReads.listLinkedSources.mockResolvedValue([]);
  taskReads.getQuickSortSuggestionInputs.mockResolvedValue({
    tasks: [],
    sourceRankings: [],
    tags: [],
    taskTags: [],
  });
  registerFakeTaskCorePersistence({ taskReads });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/tasks/[id]/linked-sources', () => {
  it('preserves empty results for unknown tasks', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/linked-sources/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/missing/linked-sources'),
      { params: Promise.resolve({ id: 'missing' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ linkedSources: [] });
    expect(taskReads.listLinkedSources).toHaveBeenCalledWith('missing');
  });

  it('returns the repository DTO unchanged', async () => {
    const linkedSource = {
      id: 'linked-1',
      taskId: 'task-1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      sourceId: 'issue:1',
      title: 'Issue 1',
      linkedAt: '2026-08-10T00:00:00.000Z',
      matchConfidence: 0.9,
      metadata: { repository: 'owner/repo' },
    };
    taskReads.listLinkedSources.mockResolvedValue([linkedSource]);
    const { GET } = await import('@/app/api/tasks/[id]/linked-sources/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/linked-sources'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    await expect(response.json()).resolves.toEqual({ linkedSources: [linkedSource] });
  });
});

describe('GET /api/tasks/quick-sort/suggestions', () => {
  it('preserves raw split, duplicate, empty, and 50-item request parsing', async () => {
    const taskIds = ['task-1', '', 'task-1', ...Array.from(
      { length: 60 },
      (_, index) => `task-${index + 2}`,
    )];
    const { GET } = await import('@/app/api/tasks/quick-sort/suggestions/route');
    const response = await GET(new Request(
      `http://localhost/api/tasks/quick-sort/suggestions?taskIds=${taskIds.join(',')}`,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ suggestions: {} });
    expect(taskReads.getQuickSortSuggestionInputs).toHaveBeenCalledWith(taskIds.slice(0, 50));
  });

  it('keeps deterministic priority, effort, and tag suggestions', async () => {
    taskReads.getQuickSortSuggestionInputs.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Urgent fix billing bug',
        description: null,
        priority: 'none',
        dueDate: '2026-08-09',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListName: 'Billing',
        assignee: null,
        snoozedUntil: null,
        effort: null,
      }],
      sourceRankings: [{
        id: 'local',
        connectorType: 'local',
        name: 'Local',
        rank: 1,
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
      tags: [
        { id: 'tag-billing', name: 'Billing' },
        { id: 'tag-other', name: 'Other' },
      ],
      taskTags: [{ taskId: 'other-task', tagId: 'tag-billing' }],
    });

    const { GET } = await import('@/app/api/tasks/quick-sort/suggestions/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/quick-sort/suggestions?taskIds=task-1',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      suggestions: {
        'task-1': {
          priority: {
            value: 'critical',
            confidence: 0.75,
            reason: 'Urgency keywords detected',
          },
          effort: {
            value: 1,
            confidence: 0.6,
            reason: 'Quick fix keywords',
          },
          tags: [{
            id: 'tag-billing',
            name: 'Billing',
            confidence: 0.7,
          }],
        },
      },
    });
  });

  it('rejects a missing taskIds parameter', async () => {
    const { GET } = await import('@/app/api/tasks/quick-sort/suggestions/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/quick-sort/suggestions',
    ));

    expect(response.status).toBe(400);
    expect(taskReads.getQuickSortSuggestionInputs).not.toHaveBeenCalled();
  });
});
