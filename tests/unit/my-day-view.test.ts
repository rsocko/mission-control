import type { MyDayItem } from '@/components/today/types';
import {
  applyMyDayItemOrder,
  createOptimisticMyDayItem,
  filterMyDayItems,
  getMyDayCompletionPercentage,
  groupMyDayItems,
  mergeMyDaySmartScores,
  partitionMyDayItems,
  reorderMyDayItems,
  resolveMyDayGroupSelection,
  resolveMyDaySortSelection,
  sortCompletedMyDayItems,
  sortMyDayItems,
} from '@/lib/utils/my-day-view';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

function makeItem(overrides: Partial<MyDayItem> = {}): MyDayItem {
  return {
    id: 'my-day-1',
    taskId: 'task-1',
    order: 1,
    isAutoIncluded: false,
    addedAt: '2026-08-05T12:00:00.000Z',
    title: 'Default task',
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    connectorType: 'github-issues',
    connectorInstanceId: 'github-1',
    sourceId: 'source-1',
    sourceListName: 'Mission Control',
    createdAt: '2026-08-01T12:00:00.000Z',
    completedAt: null,
    tags: [],
    hasDescription: false,
    localDisposition: 'active',
    taskSourceModel: 'remote-managed',
    editPolicy: editableTaskPolicy,
    ...overrides,
  };
}

describe('My Day view helpers', () => {
  it('only creates optimistic items when the edit policy is available', () => {
    expect(createOptimisticMyDayItem({
      taskId: 'task-2',
      title: 'Added from search',
    }, 2)).toBeNull();

    expect(createOptimisticMyDayItem({
      taskId: 'task-2',
      title: 'Added from search',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceId: 'remote-task-2',
      editPolicy: editableTaskPolicy,
    }, 2, '2026-08-05T13:00:00.000Z')).toMatchObject({
      id: 'optimistic-task-2',
      taskId: 'task-2',
      order: 2,
      title: 'Added from search',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceId: 'remote-task-2',
      editPolicy: editableTaskPolicy,
    });
  });

  it('applies Dashboard keyword and structured filters to My Day items', () => {
    const items = [
      makeItem({
        taskId: 'active',
        title: 'Review connector retries',
        status: 'in_progress',
        sourceListId: 'list-1',
        assignee: 'Alice Smith',
        tags: [{ id: 'tag-1', name: 'Area UI', slug: 'area-ui', type: 'label', color: null }],
      }),
      makeItem({ taskId: 'todo', title: 'Write release notes', connectorType: 'microsoft-todo' }),
    ];

    expect(filterMyDayItems(items, 'connector').map((item) => item.taskId)).toEqual(['active']);
    expect(filterMyDayItems(items, 'status:in_progress tag:area-ui').map((item) => item.taskId)).toEqual(['active']);
    expect(filterMyDayItems(items, 'source:microsoft-todo').map((item) => item.taskId)).toEqual(['todo']);
    expect(filterMyDayItems(items, 'listid:github-1:list-1').map((item) => item.taskId)).toEqual(['active']);
    expect(filterMyDayItems(items, 'assignee:alice').map((item) => item.taskId)).toEqual(['active']);
  });

  it('sorts without mutating the source array', () => {
    const items = [
      makeItem({ taskId: 'low', priority: 'low' }),
      makeItem({ taskId: 'critical', priority: 'critical' }),
    ];

    const sorted = sortMyDayItems(items, 'priority', 'asc');

    expect(sorted.map((item) => item.taskId)).toEqual(['critical', 'low']);
    expect(items.map((item) => item.taskId)).toEqual(['low', 'critical']);
  });

  it('sorts and groups planning horizons with unreviewed tasks last', () => {
    const items = [
      makeItem({ taskId: 'unset', planningHorizon: null }),
      makeItem({ taskId: 'later', planningHorizon: 'later' }),
      makeItem({ taskId: 'next', planningHorizon: 'next' }),
    ];

    expect(sortMyDayItems(items, 'planningHorizon', 'asc').map((item) => item.taskId))
      .toEqual(['next', 'later', 'unset']);
    expect(groupMyDayItems(items, 'planningHorizon', []).map((group) => group.label))
      .toEqual(['Next', 'Later', 'Not set']);
  });

  it('merges canonical Smart Scores into My Day items', () => {
    const items = [
      makeItem({ taskId: 'scored' }),
      makeItem({ taskId: 'unscored', id: 'my-day-2' }),
    ];

    const merged = mergeMyDaySmartScores(items, [{
      taskId: 'scored',
      smartScore: 82,
      scoreBreakdown: {
        priority: 20,
        organizationalContext: 15,
        urgency: 15,
        planningHorizon: 12,
        momentum: 10,
        sourceTrust: 10,
        snoozePenalty: 0,
        total: 82,
        audit: {
          confidence: { level: 'high', percentage: 90 },
          evidence: [],
          missingSignals: [],
          sessionFit: {
            estimatedDuration: null,
            effort: null,
            status: 'todo',
            note: 'Test',
          },
          ranking: {
            scope: {
              label: 'My Day',
              rank: 1,
              total: 2,
              topPercent: 50,
            },
          },
        },
      },
    }]);

    expect(merged[0]).toMatchObject({ taskId: 'scored', smartScore: 82 });
    expect(merged[1]).toEqual(items[1]);
    expect(items[0].smartScore).toBeUndefined();
  });

  it('sorts Smart Score percentile best-first regardless of prior direction', () => {
    const items = [
      makeItem({
        taskId: 'top-half',
        scoreBreakdown: {
          priority: 0,
          organizationalContext: 0,
          urgency: 0,
          planningHorizon: 0,
          momentum: 0,
          sourceTrust: 0,
          snoozePenalty: 0,
          total: 50,
          audit: {
            confidence: { level: 'medium', percentage: 70 },
            evidence: [],
            missingSignals: [],
            sessionFit: {
              estimatedDuration: null,
              effort: null,
              status: 'todo',
              note: 'Test',
            },
            ranking: {
              scope: { label: 'My Day', rank: 2, total: 4, topPercent: 50 },
            },
          },
        },
      }),
      makeItem({
        taskId: 'top-quarter',
        id: 'my-day-2',
        scoreBreakdown: {
          priority: 0,
          organizationalContext: 0,
          urgency: 0,
          planningHorizon: 0,
          momentum: 0,
          sourceTrust: 0,
          snoozePenalty: 0,
          total: 80,
          audit: {
            confidence: { level: 'medium', percentage: 70 },
            evidence: [],
            missingSignals: [],
            sessionFit: {
              estimatedDuration: null,
              effort: null,
              status: 'todo',
              note: 'Test',
            },
            ranking: {
              scope: { label: 'My Day', rank: 1, total: 4, topPercent: 25 },
            },
          },
        },
      }),
      makeItem({ taskId: 'unranked', id: 'my-day-3' }),
    ];

    expect(sortMyDayItems(items, 'smartScorePercentile', 'desc').map((item) => item.taskId))
      .toEqual(['top-quarter', 'top-half', 'unranked']);
  });

  it('sorts completed tasks by most recent completion without mutating the source array', () => {
    const items = [
      makeItem({
        taskId: 'first-completed',
        status: 'done',
        completedAt: '2026-08-05T13:00:00.000Z',
      }),
      makeItem({
        taskId: 'last-completed',
        status: 'done',
        completedAt: '2026-08-05T15:00:00.000Z',
      }),
      makeItem({
        taskId: 'missing-completion-time',
        status: 'done',
        addedAt: '2026-08-05T14:00:00.000Z',
      }),
    ];

    const sorted = sortCompletedMyDayItems(items);

    expect(sorted.map((item) => item.taskId)).toEqual([
      'last-completed',
      'first-completed',
      'missing-completion-time',
    ]);
    expect(items.map((item) => item.taskId)).toEqual([
      'first-completed',
      'last-completed',
      'missing-completion-time',
    ]);
  });

  it('preserves and updates manual order without mutating the source array', () => {
    const items = [
      makeItem({ id: 'first', taskId: 'first', order: 1 }),
      makeItem({ id: 'second', taskId: 'second', order: 2 }),
      makeItem({ id: 'third', taskId: 'third', order: 3 }),
    ];

    expect(sortMyDayItems(items, 'manual', 'desc').map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);

    const reordered = reorderMyDayItems(items, 'first', 'third');
    expect(reordered.map((item) => [item.id, item.order])).toEqual([
      ['second', 1],
      ['third', 2],
      ['first', 3],
    ]);
    expect(items.map((item) => item.id)).toEqual(['first', 'second', 'third']);

    expect(applyMyDayItemOrder(reordered, ['first', 'second', 'third']).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps manual ordering and grouping mutually exclusive', () => {
    expect(resolveMyDaySortSelection('manual', 'priority')).toEqual({
      sortBy: 'manual',
      groupBy: 'none',
    });
    expect(resolveMyDayGroupSelection('project', 'manual', 'dueDate')).toEqual({
      sortBy: 'dueDate',
      groupBy: 'project',
    });
    expect(resolveMyDayGroupSelection('none', 'manual', 'priority')).toEqual({
      sortBy: 'manual',
      groupBy: 'none',
    });
  });

  it('groups status and project labels for the toolbar group control', () => {
    const items = [
      makeItem({
        taskId: 'project',
        projectPhaseMemberships: [{
          projectId: 'project-1',
          phaseId: 'phase-1',
          phaseName: 'Build',
        }],
      }),
      makeItem({ taskId: 'active', status: 'in_progress' }),
    ];

    expect(groupMyDayItems(items, 'status', []).map((group) => group.label)).toEqual([
      'In Progress',
      'To Do',
    ]);
    expect(groupMyDayItems(items, 'project', [{
      id: 'project-1',
      name: 'Mission Control',
      color: '#3b82f6',
      icon: null,
    }]).map((group) => group.label)).toEqual([
      'Mission Control / Build',
      'No Project',
    ]);
  });

  it('separates cancelled tasks from open and completed work', () => {
    const items = [
      makeItem({ taskId: 'todo', status: 'todo' }),
      makeItem({ taskId: 'active', status: 'in_progress' }),
      makeItem({ taskId: 'done', status: 'done' }),
      makeItem({ taskId: 'cancelled', status: 'cancelled' }),
      makeItem({ taskId: 'normalized-cancellation', status: 'done', statusReason: 'not_planned' }),
    ];

    const buckets = partitionMyDayItems(items);

    expect(buckets.open.map((item) => item.taskId)).toEqual(['todo', 'active']);
    expect(buckets.completed.map((item) => item.taskId)).toEqual(['done']);
    expect(buckets.cancelled.map((item) => item.taskId)).toEqual([
      'cancelled',
      'normalized-cancellation',
    ]);
    expect(getMyDayCompletionPercentage(items)).toBe(33);
  });

  it('excludes cancelled tasks from an otherwise complete day percentage', () => {
    const items = [
      makeItem({ taskId: 'done', status: 'done' }),
      makeItem({ taskId: 'cancelled', status: 'cancelled' }),
    ];

    expect(getMyDayCompletionPercentage(items)).toBe(100);
  });

  it('orders semantic groups independently of task sort order', () => {
    const items = [
      makeItem({ taskId: 'low', title: 'Alpha', priority: 'low' }),
      makeItem({ taskId: 'critical', title: 'Zulu', priority: 'critical' }),
      makeItem({ taskId: 'none', title: 'Middle', priority: 'none' }),
    ];

    expect(groupMyDayItems(items, 'priority', []).map((group) => group.label)).toEqual([
      'Critical',
      'Low',
      'None',
    ]);
  });

  it('groups by every visible tag while hiding synthetic tags', () => {
    const item = makeItem({
      tags: [
        { id: 'tag-1', name: 'P1', slug: 'p1', type: 'label', color: null },
        { id: 'tag-2', name: 'Area UI', slug: 'area-ui', type: 'label', color: null },
        { id: 'tag-3', name: 'Needs Review', slug: 'needs-review', type: 'label', color: null },
      ],
    });

    expect(groupMyDayItems([item], 'tag', []).map((group) => group.label)).toEqual([
      'Area UI',
      'Needs Review',
    ]);
  });
});
