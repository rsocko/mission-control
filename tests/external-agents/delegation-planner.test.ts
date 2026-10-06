import { describe, expect, it } from 'vitest';
import { normalizeDelegationPlanOutput } from '@/lib/external-agents/delegation-planner';

describe('delegation planner normalization', () => {
  it('enforces repository boundaries and assigns every valid task exactly once', () => {
    const groups = normalizeDelegationPlanOutput({
      output: {
        groups: [
          {
            taskIds: ['task-1', 'task-2', 'task-1'],
            strategy: 'combined',
            rationale: 'These tasks share one implementation outcome.',
            confidence: 0.9,
          },
          {
            taskIds: ['task-3', 'task-4'],
            strategy: 'combined',
            rationale: 'The model grouped these despite different repositories.',
            confidence: 0.7,
          },
        ],
      },
      taskIds: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'],
      repositories: new Map([
        ['task-1', 'octo/api'],
        ['task-2', 'octo/api'],
        ['task-3', 'octo/web'],
        ['task-4', 'octo/api'],
        ['task-5', 'octo/api'],
      ]),
    });

    expect(groups).toEqual([
      expect.objectContaining({
        taskIds: ['task-1', 'task-2'],
        strategy: 'combined',
        repository: 'octo/api',
      }),
      expect.objectContaining({ taskIds: ['task-3'], strategy: 'separate' }),
      expect.objectContaining({ taskIds: ['task-4'], strategy: 'separate' }),
      expect.objectContaining({ taskIds: ['task-5'], strategy: 'separate' }),
    ]);
    expect(groups.flatMap(({ taskIds }) => taskIds).sort())
      .toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5']);
  });
});
