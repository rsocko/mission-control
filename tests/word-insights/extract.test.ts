import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_LENGTH,
  MAX_TOKENS_PER_VALUE,
  MAX_VALUES_PER_SOURCE_PER_TASK,
  extractWordInsights,
  normalizeToken,
  tokenize,
} from '@/lib/word-insights/extract';
import type { WordInsightTaskRecord } from '@/lib/word-insights/types';

const records: WordInsightTaskRecord[] = [
  {
    id: 'task-b',
    title: 'Deploy API',
    status: 'todo',
    values: [
      { source: 'title', id: 'task-b', label: 'Task title', text: 'Deploy the API API' },
      { source: 'notes', id: 'task-b', label: 'Task notes', text: 'Review deployment plan' },
      { source: 'tag', id: 'tag-1', label: 'Backend', text: 'Backend' },
    ],
  },
  {
    id: 'task-a',
    title: 'Review API',
    status: 'in_progress',
    values: [
      { source: 'title', id: 'task-a', label: 'Task title', text: 'Review API' },
      { source: 'project', id: 'project-1', label: 'API Migration', text: 'API Migration' },
    ],
  },
];

describe('word insight tokenization', () => {
  it('normalizes Unicode, possessives, punctuation, and filters stop words and numbers', () => {
    expect(normalizeToken('Planner’s')).toBe('planner');
    expect(tokenize("The PLANNER'S 123 café 3d-print and API don't won’t")).toEqual([
      'planner',
      'café',
      '3d-print',
      'api',
    ]);
  });

  it('enforces text and token bounds', () => {
    const manyWords = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ');
    const tokens = tokenize(`${manyWords}${' ignored'.repeat(MAX_TEXT_LENGTH)}`);
    expect(tokens).toHaveLength(MAX_TOKENS_PER_VALUE);
    expect(tokens.at(-1)).toBe('word63');
  });
});

describe('extractWordInsights', () => {
  it('orders by frequency then word and preserves source and task provenance', () => {
    const result = extractWordInsights({ records, wordLimit: 10, taskLimit: 10 });

    expect(result.words.map((word) => [word.text, word.count])).toEqual([
      ['api', 4],
      ['review', 2],
      ['backend', 1],
      ['deploy', 1],
      ['deployment', 1],
      ['migration', 1],
      ['plan', 1],
    ]);
    const api = result.words[0];
    expect(api.sources).toEqual({ title: 3, project: 1 });
    expect(api.taskIds).toEqual(['task-a', 'task-b']);
    expect(api.provenance).toEqual([
      {
        taskId: 'task-a',
        sources: [
          { source: 'project', count: 1, labels: ['API Migration'] },
          { source: 'title', count: 1, labels: ['Task title'] },
        ],
      },
      {
        taskId: 'task-b',
        sources: [
          { source: 'title', count: 2, labels: ['Task title'] },
        ],
      },
    ]);
  });

  it('applies source toggles without losing exact task connections', () => {
    const result = extractWordInsights({
      records,
      enabledSources: ['tag', 'project'],
      wordLimit: 10,
      taskLimit: 10,
    });

    expect(result.enabledSources).toEqual(['tag', 'project']);
    expect(result.words.map((word) => word.text)).toEqual(['api', 'backend', 'migration']);
    expect(result.words.find((word) => word.text === 'api')?.taskIds).toEqual(['task-a']);
    expect(result.tasks).toEqual([
      {
        id: 'task-b',
        title: 'Deploy API',
        status: 'todo',
        words: ['backend'],
      },
      {
        id: 'task-a',
        title: 'Review API',
        status: 'in_progress',
        words: ['api', 'migration'],
      },
    ]);
  });

  it('clamps word and task limits and reports truncation', () => {
    const result = extractWordInsights({
      records,
      wordLimit: 1,
      taskLimit: 1,
    });

    expect(result.words).toHaveLength(1);
    expect(result.analyzedTaskCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.totalWordCount).toBe(6);
    expect(result.wordTruncated).toBe(true);
    expect(result.limits).toMatchObject({
      taskLimit: 1,
      wordLimit: 1,
      maxTextLength: MAX_TEXT_LENGTH,
      maxTokensPerValue: MAX_TOKENS_PER_VALUE,
      maxValuesPerSourcePerTask: MAX_VALUES_PER_SOURCE_PER_TASK,
    });
  });

  it('caps dense values for each source on every task', () => {
    const denseRecord: WordInsightTaskRecord = {
      id: 'dense',
      title: 'Dense task',
      status: 'todo',
      values: Array.from({ length: MAX_VALUES_PER_SOURCE_PER_TASK + 5 }, (_, index) => ({
        source: 'tag',
        id: `tag-${index}`,
        label: `Tag ${index}`,
        text: 'bounded',
      })),
    };

    const result = extractWordInsights({ records: [denseRecord], wordLimit: 10 });
    expect(result.words[0].count).toBe(MAX_VALUES_PER_SOURCE_PER_TASK);
    expect(result.words[0].provenance[0].sources[0].labels).toHaveLength(
      MAX_VALUES_PER_SOURCE_PER_TASK,
    );
  });
});
