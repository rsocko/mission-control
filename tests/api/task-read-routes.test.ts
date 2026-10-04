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
    projectAffinities: [],
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
        sourceListId: 'billing',
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
      projectAffinities: [],
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
          projects: [],
        },
      },
    });
  });

  it('suggests projects when a list cohort has a clear assignment pattern', async () => {
    taskReads.getQuickSortSuggestionInputs.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Ship billing update',
        description: null,
        priority: 'medium',
        dueDate: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-work',
        sourceListId: 'billing',
        sourceListName: 'Billing',
        assignee: null,
        snoozedUntil: null,
        effort: 2,
      }],
      sourceRankings: [],
      tags: [],
      taskTags: [],
      projectAffinities: [
        {
          taskId: 'peer-1',
          connectorInstanceId: 'todo-work',
          sourceListId: 'billing',
          projectId: 'project-billing',
          projectName: 'Billing Platform',
          projectColor: '#06b6d4',
        },
        {
          taskId: 'peer-2',
          connectorInstanceId: 'todo-work',
          sourceListId: 'billing',
          projectId: 'project-billing',
          projectName: 'Billing Platform',
          projectColor: '#06b6d4',
        },
        {
          taskId: 'peer-3',
          connectorInstanceId: 'todo-work',
          sourceListId: 'billing',
          projectId: 'project-other',
          projectName: 'Operations',
          projectColor: '#64748b',
        },
      ],
    });

    const { GET } = await import('@/app/api/tasks/quick-sort/suggestions/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/quick-sort/suggestions?taskIds=task-1',
    ));

    await expect(response.json()).resolves.toMatchObject({
      suggestions: {
        'task-1': {
          projects: [{
            id: 'project-billing',
            name: 'Billing Platform',
            color: '#06b6d4',
            confidence: 0.67,
            reason: '2 of 3 items on Billing list',
          }],
        },
      },
    });
  });

  it('falls back to source peers when list evidence is sparse', async () => {
    taskReads.getQuickSortSuggestionInputs.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'New work item',
        description: null,
        priority: 'medium',
        dueDate: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-work',
        sourceListId: 'new-repo',
        sourceListName: 'New Repo',
        assignee: null,
        snoozedUntil: null,
        effort: 2,
      }],
      sourceRankings: [],
      tags: [],
      taskTags: [],
      projectAffinities: [
        {
          taskId: 'peer-1',
          connectorInstanceId: 'github-work',
          sourceListId: 'other-repo',
          projectId: 'project-dev',
          projectName: 'Development',
          projectColor: '#6366f1',
        },
        {
          taskId: 'peer-2',
          connectorInstanceId: 'github-work',
          sourceListId: 'third-repo',
          projectId: 'project-dev',
          projectName: 'Development',
          projectColor: '#6366f1',
        },
      ],
    });

    const { GET } = await import('@/app/api/tasks/quick-sort/suggestions/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/quick-sort/suggestions?taskIds=task-1',
    ));

    await expect(response.json()).resolves.toMatchObject({
      suggestions: {
        'task-1': {
          projects: [{
            id: 'project-dev',
            confidence: 1,
            reason: '2 of 2 items on this source',
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
