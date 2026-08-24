import type { MyDayItem } from '@/components/today/types';
import {
  applyMyDayItemOrder,
  filterMyDayItems,
  getMyDayCompletionPercentage,
  groupMyDayItems,
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
