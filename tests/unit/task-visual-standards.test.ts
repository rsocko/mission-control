import { describe, expect, it } from 'vitest';
import {
  getTaskPriorityVisual,
  getTaskStatusVisual,
  TASK_PRIORITY_VISUALS,
  TASK_STATUS_VISUALS,
} from '@/lib/constants/task-formatting';

describe('task visual standards', () => {
  it('defines the canonical priority palette', () => {
    expect(Object.fromEntries(
      Object.entries(TASK_PRIORITY_VISUALS).map(([priority, visual]) => [
        priority,
        { shortLabel: visual.shortLabel, color: visual.color, textClass: visual.textClass, dotClass: visual.dotClass },
      ]),
    )).toEqual({
      critical: { shortLabel: 'P0', color: '#f43f5e', textClass: 'text-rose-400', dotClass: 'bg-rose-500' },
      high: { shortLabel: 'P1', color: '#fb923c', textClass: 'text-orange-400', dotClass: 'bg-orange-400' },
      medium: { shortLabel: 'P2', color: '#fbbf24', textClass: 'text-amber-300', dotClass: 'bg-amber-400' },
      low: { shortLabel: 'P3', color: '#38bdf8', textClass: 'text-sky-400', dotClass: 'bg-sky-400' },
      none: { shortLabel: '—', color: '#64748b', textClass: 'text-[var(--text-muted)]', dotClass: 'bg-slate-500' },
    });
  });

  it('defines the canonical task status palette', () => {
    expect(Object.fromEntries(
      Object.entries(TASK_STATUS_VISUALS).map(([status, visual]) => [status, visual.color]),
    )).toEqual({
      todo: '#94a3b8',
      in_progress: '#3b82f6',
      blocked: '#f59e0b',
      done: '#10b981',
      cancelled: '#64748b',
    });
    expect(TASK_STATUS_VISUALS.in_progress.textClass).toBe('text-[var(--accent-400)]');
    expect(TASK_STATUS_VISUALS.cancelled.textClass).toBe('text-[var(--text-muted)]');
  });

  it('uses neutral fallbacks for unknown values', () => {
    expect(getTaskPriorityVisual('unexpected')).toBe(TASK_PRIORITY_VISUALS.none);
    expect(getTaskStatusVisual('unexpected')).toBe(TASK_STATUS_VISUALS.todo);
  });
});
