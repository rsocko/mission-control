import { describe, expect, it } from 'vitest';
import {
  recommendTagsForTask,
  type TagRecommendation,
} from '@/lib/tags/recommendations';
import type {
  TaskQuickSortSuggestionInputs,
  TaskQuickSortSuggestionTask,
} from '@/lib/tasks/core/contracts';

const task: TaskQuickSortSuggestionTask = {
  id: 'target',
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
};

function inputs(
  overrides: Partial<Pick<TaskQuickSortSuggestionInputs, 'tags' | 'taskTags' | 'projectAffinities'>>,
) {
  return {
    tags: [],
    taskTags: [],
    projectAffinities: [],
    ...overrides,
  };
}

function assignment(
  taskId: string,
  tagId: string,
  overrides: Partial<TaskQuickSortSuggestionInputs['taskTags'][number]> = {},
): TaskQuickSortSuggestionInputs['taskTags'][number] {
  return {
    taskId,
    tagId,
    title: `Task ${taskId}`,
    connectorInstanceId: 'local',
    sourceListId: 'launch',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

function names(recommendations: TagRecommendation[]) {
  return recommendations.map((recommendation) => recommendation.name);
}

describe('contextual tag recommendations', () => {
  it('prefers explicit title matches', () => {
    const recommendations = recommendTagsForTask(task, inputs({
      tags: [
        { id: 'tag-launch', name: 'Launch' },
        { id: 'tag-random', name: 'Random' },
      ],
    }), new Date('2026-10-17T00:00:00.000Z'));

    expect(recommendations).toEqual([{
      id: 'tag-launch',
      name: 'Launch',
      confidence: 0.92,
      reason: 'Tag name appears in the task title',
    }]);
  });

  it('uses repeated same-list behavior instead of global popularity', () => {
    const recommendations = recommendTagsForTask(task, inputs({
      tags: [
        { id: 'tag-release', name: 'Release' },
        { id: 'tag-popular', name: 'Popular everywhere' },
      ],
      taskTags: [
        assignment('list-1', 'tag-release'),
        assignment('list-2', 'tag-release'),
        assignment('list-3', 'tag-popular'),
        assignment('global-1', 'tag-popular', {
          connectorInstanceId: 'other',
          sourceListId: 'other',
        }),
        assignment('global-2', 'tag-popular', {
          connectorInstanceId: 'other',
          sourceListId: 'other',
        }),
      ],
    }), new Date('2026-10-17T00:00:00.000Z'));

    expect(names(recommendations)).toEqual(['Release']);
    expect(recommendations[0].reason).toContain('Launch');
  });

  it('uses similar task titles when list evidence is sparse', () => {
    const recommendations = recommendTagsForTask(task, inputs({
      tags: [{ id: 'tag-release', name: 'Release' }],
      taskTags: [
        assignment('peer', 'tag-release', {
          title: 'Review launch checklist',
          sourceListId: 'other-list',
        }),
      ],
    }), new Date('2026-10-17T00:00:00.000Z'));

    expect(recommendations[0]).toMatchObject({
      id: 'tag-release',
      reason: 'Used on a similarly named task',
    });
  });

  it('does not recommend unrelated globally frequent tags', () => {
    const recommendations = recommendTagsForTask(task, inputs({
      tags: [{ id: 'tag-popular', name: 'Popular' }],
      taskTags: [
        assignment('global-1', 'tag-popular', {
          connectorInstanceId: 'other',
          sourceListId: 'other',
        }),
        assignment('global-2', 'tag-popular', {
          connectorInstanceId: 'other',
          sourceListId: 'other',
        }),
      ],
    }), new Date('2026-10-17T00:00:00.000Z'));

    expect(recommendations).toEqual([]);
  });

  it('deduplicates same-name tags from different sources', () => {
    const recommendations = recommendTagsForTask(task, inputs({
      tags: [
        { id: 'tag-launch-a', name: 'Launch' },
        { id: 'tag-launch-b', name: 'launch' },
      ],
    }));

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].name.toLowerCase()).toBe('launch');
  });

  it('skips tasks that already have tags', () => {
    expect(recommendTagsForTask(task, inputs({
      tags: [{ id: 'tag-launch', name: 'Launch' }],
      taskTags: [assignment('target', 'tag-launch')],
    }))).toEqual([]);
  });
});
