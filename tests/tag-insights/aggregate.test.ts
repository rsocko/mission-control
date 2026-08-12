import { describe, expect, it } from 'vitest';
import {
  buildTagInsights,
  normalizeTagInsightOptions,
} from '@/lib/tag-insights/aggregate';
import type { TagInsightRecord } from '@/lib/tag-insights/types';

function record(
  taskId: string,
  tagId: string,
  tagName: string,
): TagInsightRecord {
  return {
    taskId,
    taskTitle: `Task ${taskId}`,
    taskStatus: 'todo',
    tagId,
    tagName,
    tagColor: null,
  };
}

describe('buildTagInsights', () => {
  it('deduplicates repeated tag assignments and retains exact pair provenance', () => {
    const result = buildTagInsights([
      record('1', 'a', 'API'),
      record('1', 'a', 'API'),
      record('1', 'b', 'Backend'),
      record('2', 'a', 'API'),
      record('2', 'b', 'Backend'),
    ], { minCooccurrence: 1 });

    expect(result.tags.map((tag) => [tag.name, tag.taskCount])).toEqual([
      ['API', 2],
      ['Backend', 2],
    ]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ count: 2, taskIds: ['1', '2'] });
  });

  it('counts one-tag tasks on the diagonal without creating a pair', () => {
    const result = buildTagInsights([record('1', 'a', 'Solo')], {
      minCooccurrence: 1,
    });

    expect(result.tags[0]).toMatchObject({ name: 'Solo', taskCount: 1, taskIds: ['1'] });
    expect(result.pairs).toEqual([]);
  });

  it('applies stable top-N ordering before the pair threshold', () => {
    const result = buildTagInsights([
      record('1', 'z', 'Zulu'),
      record('1', 'a', 'Alpha'),
      record('2', 'z', 'Zulu'),
      record('2', 'b', 'Beta'),
      record('3', 'a', 'Alpha'),
      record('4', 'b', 'Beta'),
    ], { topN: 2, minCooccurrence: 2 });

    expect(result.tags.map((tag) => tag.name)).toEqual(['Alpha', 'Beta']);
    expect(result.pairs).toEqual([]);
  });

  it('excludes synthetic tags before counting tasks and pairs', () => {
    const result = buildTagInsights([
      record('1', 'priority', 'priority:high'),
      record('1', 'a', 'API'),
      record('1', 'b', 'Backend'),
      record('2', 'effort', 'effort:3'),
    ], { minCooccurrence: 1 });

    expect(result.tags.map((tag) => tag.name)).toEqual(['API', 'Backend']);
    expect(result.meta.processedTaskCount).toBe(1);
  });

  it('returns deterministic empty data', () => {
    expect(buildTagInsights([])).toEqual({
      tags: [],
      pairs: [],
      tasks: {},
      meta: {
        topN: 15,
        minCooccurrence: 2,
        taskLimit: 2000,
        processedTaskCount: 0,
        truncated: false,
      },
    });
  });

  it('bounds top-N, threshold, and task limits', () => {
    expect(normalizeTagInsightOptions({
      topN: '999',
      minCooccurrence: '0',
      taskLimit: '99999',
    })).toEqual({
      topN: 30,
      minCooccurrence: 1,
      taskLimit: 5000,
    });
    expect(normalizeTagInsightOptions({
      topN: null,
      minCooccurrence: null,
      taskLimit: null,
    })).toEqual({
      topN: 15,
      minCooccurrence: 2,
      taskLimit: 2000,
    });
  });

  it('truncates on a deterministic task boundary', () => {
    const result = buildTagInsights([
      record('1', 'a', 'API'),
      record('2', 'a', 'API'),
      record('3', 'a', 'API'),
    ], { taskLimit: 2 });

    expect(result.tags[0].taskIds).toEqual(['1', '2']);
    expect(result.meta).toMatchObject({
      processedTaskCount: 2,
      taskLimit: 2,
      truncated: true,
    });
  });
});
