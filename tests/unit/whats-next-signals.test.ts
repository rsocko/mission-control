import { describe, expect, it } from 'vitest';
import { describeWhatsNextTask } from '@/lib/ai/features/whats-next';
import type { ScoreInputTask, ScoredTask } from '@/lib/smart-score';

const TASK: ScoreInputTask = {
  id: 'task-1',
  title: 'Prepare launch',
  priority: 'high',
  dueDate: null,
  planningHorizon: 'next',
  effort: 2,
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListName: 'Product',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z',
};

const SCORE: ScoredTask = {
  taskId: TASK.id,
  score: {
    priorityBase: 15,
    entityTier: 0,
    urgency: 0,
    planningHorizon: 10,
    sourceRank: 5,
    freshness: 6,
    executionFit: 4,
    snoozePenalty: 0,
    total: 40,
  },
  matchedEntities: [],
};

describe('what is next signal explanations', () => {
  it('describes deadline pressure and Horizon as separate signals', () => {
    expect(describeWhatsNextTask(TASK, SCORE, '2026-09-17', 'high')).toBe(
      '- "Prepare launch" | importance: high | deadline: none (0/20) | '
      + 'Horizon: next (10/10) | effort: 2 | Smart Score: 40 | energy: high | source: local',
    );
  });
});
