import { describe, expect, it } from 'vitest';
import { describeWhatsNextTask, excludeWhatsNextTasks } from '@/lib/ai/features/whats-next';
import type { ScoreInputTask, ScoredTask } from '@/lib/smart-score';

const TASK: ScoreInputTask = {
  id: 'task-1',
  title: 'Prepare launch',
  status: 'todo',
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
    priority: 19,
    organizationalContext: 0,
    urgency: 0,
    planningHorizon: 20,
    momentum: 6,
    sourceTrust: 3,
    snoozePenalty: 0,
    total: 48,
    audit: {
      confidence: { level: 'medium', percentage: 70 },
      evidence: [],
      missingSignals: [],
      sessionFit: {
        estimatedDuration: null,
        effort: 2,
        status: 'todo',
        note: 'Duration and effort inform contextual planning, not Smart Score.',
      },
    },
  },
  matchedEntities: [],
};

describe('what is next signal explanations', () => {
  it('describes deadline pressure and Horizon as separate signals', () => {
    expect(describeWhatsNextTask(TASK, SCORE, '2026-09-17', 'high')).toBe(
      '- [Prepare launch](/tasks/task-1) | importance: high | deadline: none (0/20) | '
      + 'Horizon: next (20/20) | momentum: 6/10 | effort: 2 | '
      + 'score confidence: medium (70%) | Smart Score: 48 | energy: high | source: local',
    );
  });

  it('escapes task titles before placing them in Markdown links', () => {
    expect(describeWhatsNextTask(
      { ...TASK, id: 'task/2', title: String.raw`Review [Q4]\plan` },
      { ...SCORE, taskId: 'task/2' },
      '2026-09-17',
      undefined,
    )).toContain(String.raw`[Review \[Q4\]\\plan](/tasks/task%2F2)`);
  });

  it('omits tasks hidden from today from AI next-task candidates', () => {
    expect(excludeWhatsNextTasks(
      [TASK, { ...TASK, id: 'task-2', title: 'Second task' }],
      ['task-1'],
    ).map((task) => task.id)).toEqual(['task-2']);
  });
});
