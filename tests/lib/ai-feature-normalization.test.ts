import { describe, expect, it } from 'vitest';
import {
  mapNotificationLevelToRecommendation,
  normalizeEnergyTagSuggestions,
  normalizeMicroStatusSuggestions,
  normalizeNotificationClassifications,
  normalizeSmartPriorityRankings,
} from '@/lib/ai/features/normalization';

describe('AI feature result normalization', () => {
  it('maps smart-priority indexes and drops unknown tasks', () => {
    const rankings = normalizeSmartPriorityRankings(
      '{"rankings":[{"index":2,"score":88,"reason":"due soon"},{"index":9,"score":99,"reason":"invalid"}]}',
      [
        { id: 'task-1', title: 'First', priority: 'low', dueDate: null },
        { id: 'task-2', title: 'Second', priority: 'high', dueDate: '2026-08-20' },
      ],
      '2026-08-19',
    );

    expect(rankings).toEqual([{
      taskId: 'task-2',
      title: 'Second',
      score: 88,
      reason: 'due soon',
    }]);
  });

  it('preserves the deterministic smart-priority fallback', () => {
    const rankings = normalizeSmartPriorityRankings(
      'not json',
      [{ id: 'task-1', title: 'Overdue', priority: 'critical', dueDate: '2026-08-18' }],
      '2026-08-19',
    );

    expect(rankings).toEqual([{
      taskId: 'task-1',
      title: 'Overdue',
      score: 95,
      reason: 'critical priority, OVERDUE',
    }]);
  });

  it('normalizes notification classification labels without content-triage naming', () => {
    expect(mapNotificationLevelToRecommendation('urgent')).toBe('act_now');
    expect(mapNotificationLevelToRecommendation('heads_up')).toBe('schedule');
    expect(mapNotificationLevelToRecommendation('fyi')).toBe('dismiss');

    const actions = normalizeNotificationClassifications(
      '{"actions":[{"index":1,"recommendation":"action_needed","reason":"reply required"}]}',
      [{ id: 'notification-1', title: 'Reply', level: 'fyi' }],
    );

    expect(actions).toEqual([{
      notificationId: 'notification-1',
      title: 'Reply',
      recommendation: 'schedule',
      reason: 'reply required',
    }]);
  });

  it('filters low-confidence and invalid energy suggestions', () => {
    const suggestions = normalizeEnergyTagSuggestions(
      'Result: [{"taskId":"task-1","energyLevel":"high","confidence":0.9,"reason":"deep work"},{"taskId":"task-2","energyLevel":"low","confidence":0.4,"reason":"uncertain"},{"taskId":"task-3","energyLevel":"extreme","confidence":1,"reason":"invalid"}]',
      [
        { id: 'task-1', title: 'Design API' },
        { id: 'task-2', title: 'Read email' },
      ],
    );

    expect(suggestions).toEqual([{
      taskId: 'task-1',
      title: 'Design API',
      energyLevel: 'high',
      confidence: 0.9,
      reason: 'deep work',
    }]);
  });

  it('returns no micro-status suggestions for malformed output', () => {
    expect(normalizeMicroStatusSuggestions('not json', [])).toEqual([]);
  });
});
