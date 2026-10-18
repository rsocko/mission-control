import { beforeEach, describe, expect, it, vi } from 'vitest';

const recommendations = vi.hoisted(() => ({
  listTagInferenceTasks: vi.fn(),
  listTaggedTaskIds: vi.fn(),
}));
const getQuickSortSuggestionInputs = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/workflow-persistence', () => ({
  getAIWorkflowPersistence: async () => ({ recommendations }),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    taskReads: { getQuickSortSuggestionInputs },
  }),
}));

describe('deterministic tag inference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recommendations.listTagInferenceTasks.mockResolvedValue([
      {
        id: 'task-1',
        title: 'Prepare launch checklist',
        connectorType: 'local',
        sourceListName: 'Launch',
      },
      {
        id: 'task-tagged',
        title: 'Already tagged',
        connectorType: 'local',
        sourceListName: 'Launch',
      },
    ]);
    recommendations.listTaggedTaskIds.mockResolvedValue(['task-tagged']);
    getQuickSortSuggestionInputs.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Prepare launch checklist',
        description: null,
        priority: 'none',
        dueDate: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListId: 'launch',
        sourceListName: 'Launch',
        assignee: null,
        snoozedUntil: null,
        effort: null,
      }],
      sourceRankings: [],
      tags: [
        { id: 'tag-launch', name: 'Launch' },
        { id: 'tag-other', name: 'Other' },
      ],
      taskTags: [],
      projectAffinities: [],
    });
  });

  it('uses the shared contextual engine without model output', async () => {
    const { inferTags } = await import('@/lib/ai/features/tag-inference');

    await expect(inferTags()).resolves.toEqual({
      suggestions: [{
        taskId: 'task-1',
        title: 'Prepare launch checklist',
        tags: [{
          id: 'tag-launch',
          name: 'Launch',
          confidence: 0.92,
          reason: 'Tag name appears in the task title',
        }],
        suggestedTags: ['Launch'],
        confidence: 0.92,
      }],
      availableTags: [
        { id: 'tag-launch', name: 'Launch' },
        { id: 'tag-other', name: 'Other' },
      ],
    });
    expect(getQuickSortSuggestionInputs).toHaveBeenCalledWith(['task-1']);
  });
});
