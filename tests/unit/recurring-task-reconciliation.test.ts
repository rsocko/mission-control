import { describe, expect, it } from 'vitest';
import {
  findOpenRecurringTaskDuplicates,
  findOrphanedRecurringTasks,
  getRecurringSeriesKey,
  getRecurringTitleKey,
  inferRecurringTitleKeys,
  isMatchingRecurringSuccessor,
  shouldSuppressNonRecurringDuplicate,
  shouldSuppressRecurringMyDaySuccessor,
} from '@/lib/sync/recurring-task-reconciliation';

const dailyIdentity = '{"type":"daily","interval":1,"daysOfWeek":[],"dayOfMonth":null,"month":null}';
const recurringMetadata = JSON.stringify({ recurrence: 'daily', recurrenceIdentity: dailyIdentity });

describe('recurring task reconciliation', () => {
  it('uses recurrence cadence as part of completed-series identity', () => {
    const base = { title: 'Take out trash', sourceListId: 'list' };

    expect(getRecurringSeriesKey({ ...base, metadata: { recurrence: 'daily', recurrenceIdentity: dailyIdentity } }))
      .not.toBe(getRecurringSeriesKey({
        ...base,
        metadata: { recurrence: 'weekly', recurrenceIdentity: '{"type":"weekly","interval":1,"daysOfWeek":["monday"],"dayOfMonth":null,"month":null}' },
      }));
    expect(getRecurringSeriesKey({ ...base, metadata: {} })).toBeNull();
  });

  it('keeps the nearest upcoming occurrence and removes stale and later copies', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'stale', sourceId: 'source-stale', title: 'Take medicine', sourceListId: 'list', dueDate: '2026-08-01', updatedAt: '2026-08-01', metadata: recurringMetadata },
      { id: 'current', sourceId: 'source-current', title: 'Take medicine', sourceListId: 'list', dueDate: '2026-08-03', updatedAt: '2026-08-02', metadata: recurringMetadata },
      { id: 'later', sourceId: 'source-later', title: 'Take medicine', sourceListId: 'list', dueDate: '2026-08-04', updatedAt: '2026-08-02', metadata: recurringMetadata },
    ], '2026-08-02');

    expect(groups).toHaveLength(1);
    expect(groups[0].keeper.id).toBe('current');
    expect(groups[0].duplicates.map(task => task.id)).toEqual(['later', 'stale']);
  });

  it('keeps the recurring row and removes an exact-title copy that lost recurrence metadata', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'minimal-my-day-row', sourceId: 'source-minimal', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-08-01', updatedAt: '2026-08-01', metadata: '{}' },
      { id: 'recurring-row', sourceId: 'source-recurring', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-08-02', updatedAt: '2026-08-02', metadata: recurringMetadata },
    ], '2026-08-02');

    expect(groups).toHaveLength(1);
    expect(groups[0].keeper.id).toBe('recurring-row');
    expect(groups[0].duplicates.map(task => task.id)).toEqual(['minimal-my-day-row']);
  });

  it('uses the recurrence label shown by the UI when pattern identity is absent', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'stale', sourceId: 'source-stale', title: 'Rosey: Ear Spray', sourceListId: 'dog-tasks', dueDate: '2026-08-09', updatedAt: '2026-08-09', metadata: '{}' },
      { id: 'daily', sourceId: 'source-daily', title: 'Rosey: Ear Spray', sourceListId: 'dog-tasks', dueDate: '2026-08-11', updatedAt: '2026-08-11', metadata: '{"recurrence":"daily"}' },
    ], '2026-08-11');

    expect(groups).toHaveLength(1);
    expect(groups[0].keeper.id).toBe('daily');
    expect(groups[0].duplicates.map(task => task.id)).toEqual(['stale']);
  });

  it('does not classify same-titled ordinary tasks without a known recurring series', () => {
    const tasks = [
      { id: 'first', sourceId: 'source-first', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-08-01', updatedAt: '2026-08-01', metadata: '{}' },
      { id: 'second', sourceId: 'source-second', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-08-02', updatedAt: '2026-08-02', metadata: '{}' },
    ];

    expect(findOpenRecurringTaskDuplicates(tasks, '2026-08-02')).toEqual([]);
  });

  it('suppresses a new metadata-free copy when its exact-title series is known', () => {
    const task = {
      title: 'Walk dog',
      sourceListId: 'list',
      metadata: '{}',
    };

    expect(shouldSuppressNonRecurringDuplicate(
      task,
      new Set([getRecurringTitleKey(task)]),
    )).toBe(true);
  });

  it('keeps the most recent occurrence when every copy is overdue', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'oldest', sourceId: 'source-oldest', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-07-28', updatedAt: '2026-07-28', metadata: recurringMetadata },
      { id: 'newest', sourceId: 'source-newest', title: 'Walk dog', sourceListId: 'list', dueDate: '2026-07-31', updatedAt: '2026-07-31', metadata: recurringMetadata },
    ], '2026-08-02');

    expect(groups[0].keeper.id).toBe('newest');
  });

  it('infers a recurring series from three completed due-date occurrences', () => {
    const history = ['2026-06-15', '2026-06-16', '2026-06-17'].map(dueDate => ({
      title: 'Rosey: Ear Spray 1x/day (both ears?)',
      sourceListId: 'dog-tasks',
      status: 'done',
      dueDate,
      completedAt: `${dueDate}T20:00:00Z`,
      metadata: '{}',
    }));
    const keys = inferRecurringTitleKeys(history);

    expect(keys).toEqual(new Set([
      'rosey: ear spray 1x/day (both ears?)::dog-tasks',
    ]));
    expect(shouldSuppressNonRecurringDuplicate({
      title: history[0].title,
      sourceListId: 'dog-tasks',
      metadata: '{}',
    }, keys)).toBe(true);
    expect(keys.has(getRecurringTitleKey({
      title: history[0].title,
      sourceListId: 'dog-tasks',
    }))).toBe(true);
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'old', sourceId: 'source-old', title: history[0].title, sourceListId: 'dog-tasks', dueDate: '2026-08-09', updatedAt: '2026-08-09T17:28:08Z', metadata: '{}' },
      { id: 'current', sourceId: 'source-current', title: history[0].title, sourceListId: 'dog-tasks', dueDate: '2026-08-11', updatedAt: '2026-08-11T18:38:35Z', metadata: '{}' },
    ], '2026-08-11', keys);

    expect(groups[0].keeper.id).toBe('current');
    expect(groups[0].duplicates.map(task => task.id)).toEqual(['old']);
  });

  it('does not infer recurrence from fewer than three completed due dates', () => {
    const history = ['2026-06-15', '2026-06-16'].map(dueDate => ({
      title: 'Ordinary repeated task',
      sourceListId: 'list',
      status: 'done',
      dueDate,
      completedAt: `${dueDate}T20:00:00Z`,
      metadata: '{}',
    }));

    expect(inferRecurringTitleKeys(history)).toEqual(new Set());
  });

  it('does not merge same-titled tasks with distinct recurrence patterns', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'daily', sourceId: 'source-daily', title: 'Review', sourceListId: 'list', dueDate: '2026-08-02', updatedAt: '2026-08-02', metadata: recurringMetadata },
      { id: 'weekly', sourceId: 'source-weekly', title: 'Review', sourceListId: 'list', dueDate: '2026-08-03', updatedAt: '2026-08-02', metadata: JSON.stringify({ recurrence: 'weekly', recurrenceIdentity: '{"type":"weekly","interval":1,"daysOfWeek":["monday"],"dayOfMonth":null,"month":null}' }) },
    ], '2026-08-02');

    expect(groups).toEqual([]);
  });

  it('does not merge distinct plain recurrence labels without identities', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'daily', sourceId: 'source-daily', title: 'Review', sourceListId: 'list', dueDate: '2026-08-02', updatedAt: '2026-08-02', metadata: '{"recurrence":"daily"}' },
      { id: 'weekly', sourceId: 'source-weekly', title: 'Review', sourceListId: 'list', dueDate: '2026-08-03', updatedAt: '2026-08-02', metadata: '{"recurrence":"weekly"}' },
    ], '2026-08-02');

    expect(groups).toEqual([]);
  });

  it('does not merge same-titled weekly tasks scheduled for different days', () => {
    const groups = findOpenRecurringTaskDuplicates([
      { id: 'monday', sourceId: 'source-monday', title: 'Review', sourceListId: 'list', dueDate: '2026-08-03', updatedAt: '2026-08-02', metadata: JSON.stringify({ recurrence: 'weekly', recurrenceIdentity: '{"type":"weekly","interval":1,"daysOfWeek":["monday"],"dayOfMonth":null,"month":null}' }) },
      { id: 'friday', sourceId: 'source-friday', title: 'Review', sourceListId: 'list', dueDate: '2026-08-07', updatedAt: '2026-08-02', metadata: JSON.stringify({ recurrence: 'weekly', recurrenceIdentity: '{"type":"weekly","interval":1,"daysOfWeek":["friday"],"dayOfMonth":null,"month":null}' }) },
    ], '2026-08-02');

    expect(groups).toEqual([]);
  });

  it('flags a stale open recurrence whose series has already completed a later occurrence', () => {
    // Mirrors two independent Microsoft To Do recurrence chains for the same
    // title: an old chain stuck open since June/July that nobody ever
    // completed, while a separate, newer chain kept cycling and has already
    // completed an occurrence dated after the stale one's due date.
    const openTasks = [
      { id: 'stale-open', sourceId: 'source-stale-open', title: 'Dog Poop (Side, Hill, Patio transition)', sourceListId: 'list', dueDate: '2026-07-23', updatedAt: '2026-08-22', metadata: recurringMetadata },
    ];
    const historyTasks = [
      { title: 'Dog Poop (Side, Hill, Patio transition)', sourceListId: 'list', status: 'done', dueDate: '2026-08-23', completedAt: '2026-08-23T04:00:00', metadata: recurringMetadata },
    ];

    const orphaned = findOrphanedRecurringTasks(openTasks, historyTasks);
    expect(orphaned).toEqual(openTasks);
  });

  it('does not flag an open recurrence with no later completion in its series', () => {
    const openTasks = [
      { id: 'current', sourceId: 'source-current', title: 'Water plants', sourceListId: 'list', dueDate: '2026-08-20', updatedAt: '2026-08-19', metadata: recurringMetadata },
    ];
    const historyTasks = [
      { title: 'Water plants', sourceListId: 'list', status: 'done', dueDate: '2026-08-19', completedAt: '2026-08-19T20:00:00Z', metadata: recurringMetadata },
    ];

    expect(findOrphanedRecurringTasks(openTasks, historyTasks)).toEqual([]);
  });

  it('does not flag an open recurrence against a later completion from a distinct recurrence pattern', () => {
    const openTasks = [
      { id: 'daily-open', sourceId: 'source-daily-open', title: 'Review', sourceListId: 'list', dueDate: '2026-08-02', updatedAt: '2026-08-01', metadata: recurringMetadata },
    ];
    const historyTasks = [
      {
        title: 'Review',
        sourceListId: 'list',
        status: 'done',
        dueDate: '2026-08-10',
        completedAt: '2026-08-10T20:00:00Z',
        metadata: JSON.stringify({ recurrence: 'weekly', recurrenceIdentity: '{"type":"weekly","interval":1,"daysOfWeek":["monday"],"dayOfMonth":null,"month":null}' }),
      },
    ];

    expect(findOrphanedRecurringTasks(openTasks, historyTasks)).toEqual([]);
  });

  it('suppresses the successor for the rest of the day after its sibling was completed in My Day', () => {
    expect(shouldSuppressRecurringMyDaySuccessor({
      isRecurring: true,
      dueDate: '2026-08-02',
      today: '2026-08-02',
      successorCreatedAfterMyDayCompletion: true,
    })).toBe(true);
  });

  it('does not suppress an unrelated recurrence due today', () => {
    expect(shouldSuppressRecurringMyDaySuccessor({
      isRecurring: true,
      dueDate: '2026-08-02',
      today: '2026-08-02',
      successorCreatedAfterMyDayCompletion: false,
    })).toBe(false);
  });

  it('matches a successor only to a completed sibling with the same recurrence pattern', () => {
    const successor = {
      incomingRecurrence: 'daily',
      successorCreatedAt: '2026-08-02T15:01:00Z',
      completedAt: '2026-08-02T15:00:00Z',
    };

    expect(isMatchingRecurringSuccessor({
      ...successor,
      completedSiblingMetadata: { recurrence: 'daily' },
    })).toBe(true);
    expect(isMatchingRecurringSuccessor({
      ...successor,
      completedSiblingMetadata: { recurrence: 'weekly' },
    })).toBe(false);
    expect(isMatchingRecurringSuccessor({
      ...successor,
      completedSiblingMetadata: {},
    })).toBe(false);
  });
});
