import { describe, expect, it } from 'vitest';
import {
  getQuickFilterDefinition,
  getQuickFilterVisibility,
  isQuickFilterVisible,
} from '@/lib/tasks/quick-filters';
import type { TaskListStatsDto } from '@/types/api';

const stats: TaskListStatsDto = {
  totalOpen: 2,
  overdue: 0,
  dueToday: 1,
  dueThisWeek: 1,
  noDate: 0,
  highPriority: 0,
  assignedToMe: 0,
  myDay: 0,
  recentlyCreated: 0,
  recentlyClosed: 0,
  waiting: 0,
  inbox: 1,
};

describe('quick filter visibility', () => {
  it('uses catalog defaults and preserves legacy hidden preferences', () => {
    const inbox = getQuickFilterDefinition('inbox')!;

    expect(getQuickFilterVisibility(inbox, {})).toBe('always');
    expect(getQuickFilterVisibility(inbox, {}, ['inbox'])).toBe('hidden');
    expect(getQuickFilterVisibility(inbox, { inbox: 'when-not-empty' }, ['inbox']))
      .toBe('when-not-empty');
  });

  it('auto-hides empty conditional filters but keeps active and loading filters visible', () => {
    const high = getQuickFilterDefinition('high')!;

    expect(isQuickFilterVisible(high, stats, {})).toBe(false);
    expect(isQuickFilterVisible(high, stats, {}, { activeFilter: 'high' })).toBe(true);
    expect(isQuickFilterVisible(high, stats, {}, { loading: true })).toBe(true);
    expect(isQuickFilterVisible(high, stats, {}, { countsAvailable: false })).toBe(true);
  });

  it('keeps an active filter visible even when its configured mode is hidden', () => {
    const today = getQuickFilterDefinition('today')!;

    expect(isQuickFilterVisible(today, stats, { today: 'hidden' }, {
      activeFilter: 'today',
      loading: true,
    })).toBe(true);
    expect(isQuickFilterVisible(today, stats, { today: 'hidden' }, {
      loading: true,
    })).toBe(false);
  });
});
