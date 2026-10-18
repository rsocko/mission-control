import { describe, expect, it } from 'vitest';
import {
  applyMyDayTaskFieldUpdate,
  applySuggestionTaskFieldUpdate,
  shouldRefreshMyDayAfterTaskDetailUpdate,
} from '@/components/today/apply-task-field-update';
import type { MyDayItem, SuggestionTask } from '@/components/today/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

describe('applyMyDayTaskFieldUpdate', () => {
  it('updates the title and removes detached tags from the My Day row', () => {
    const item = {
      taskId: 'task-1',
      title: 'Review plan #NEEDS-TRIAGE',
      tags: [
        { id: 'tag-1', name: 'NEEDS TRIAGE' },
        { id: 'tag-2', name: 'work' },
      ],
    } as MyDayItem;

    const updated = applyMyDayTaskFieldUpdate(item, 'task-1', {
      title: 'Review plan',
      tagIds: ['tag-2'],
    });

    expect(updated.title).toBe('Review plan');
    expect(updated.tags).toEqual([{ id: 'tag-2', name: 'work' }]);
  });

  it('applies task properties reported by the detail panel', () => {
    const item: MyDayItem = {
      id: 'my-day-1',
      taskId: 'task-1',
      order: 1,
      isAutoIncluded: false,
      addedAt: '2026-10-07T12:00:00.000Z',
      title: 'Review plan',
      status: 'todo',
      priority: 'medium',
      dueDate: null,
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceListName: 'Inbox',
      createdAt: '2026-10-07T12:00:00.000Z',
      completedAt: null,
      effort: 2,
      estimatedDuration: 30,
      microStatus: null,
      localDisposition: 'active',
      tags: [],
      hasDescription: false,
      taskSourceModel: 'mc-owned',
      editPolicy: editableTaskPolicy,
    };

    const updated = applyMyDayTaskFieldUpdate(item, 'task-1', {
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-10-08',
      effort: 4,
      estimatedDuration: 90,
      microStatus: 'Drafting',
      localDisposition: 'handled',
    });

    expect(updated).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-10-08',
      effort: 4,
      estimatedDuration: 90,
      microStatus: 'Drafting',
      localDisposition: 'handled',
    });
  });

  it('updates suggestion fields immediately when the detail panel clears a due date', () => {
    const suggestion = {
      id: 'task-1',
      title: 'Recently overdue task',
      status: 'todo',
      priority: 'medium',
      dueDate: '2026-10-17',
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceListName: 'Inbox',
      localDisposition: 'active',
      taskSourceModel: 'mc-owned',
      editPolicy: editableTaskPolicy,
    } satisfies SuggestionTask;

    expect(applySuggestionTaskFieldUpdate(suggestion, 'task-1', { dueDate: null }))
      .toMatchObject({ dueDate: null });
  });

  it('reconciles only after persistence, not during optimistic field updates', () => {
    expect(shouldRefreshMyDayAfterTaskDetailUpdate({ dueDate: null })).toBe(false);
    expect(shouldRefreshMyDayAfterTaskDetailUpdate()).toBe(true);
  });
});
