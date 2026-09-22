import { describe, expect, it } from 'vitest';
import {
  getInboxTaskActionMutation,
  getInboxTaskMetadata,
  getInboxTaskStatus,
  isInboxTask,
  isOtherContentType,
  toInboxTaskItem,
  type InboxTaskDto,
} from '@/lib/inbox/items';

function makeTask(overrides: Partial<InboxTaskDto> = {}): InboxTaskDto {
  return {
    id: 'task-1',
    sourceId: 'source-1',
    connectorType: 'microsoft-todo',
    connectorInstanceId: 'connector-1',
    title: 'File captured idea',
    status: 'todo',
    priority: 'high',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
    sourceListName: 'Tasks',
    hubProjectIds: [],
    tags: [{ id: 'tag-needs-triage', name: 'Needs triage', slug: 'needs-triage' }],
    ...overrides,
  };
}

describe('Inbox task presentation', () => {
  it('adapts a task without changing its underlying identity', () => {
    const item = toInboxTaskItem(makeTask());

    expect(item).toMatchObject({
      id: 'task:task-1',
      sourcePlatform: 'task',
      contentType: 'task',
      title: 'File captured idea',
      status: 'pending',
      aiUrgency: 'time_sensitive',
      aiCategories: ['Needs triage'],
    });
    expect(isInboxTask(item)).toBe(true);
    expect(getInboxTaskMetadata(item)).toMatchObject({
      taskId: 'task-1',
      connectorType: 'microsoft-todo',
      sourceListName: 'Tasks',
      projectIds: [],
      localDisposition: 'active',
      tagIds: ['tag-needs-triage'],
      needsTriageTagIds: ['tag-needs-triage'],
    });
  });

  it('derives snoozed state only while the snooze is active', () => {
    const now = Date.parse('2026-08-02T10:00:00.000Z');

    expect(getInboxTaskStatus(makeTask({ snoozedUntil: '2026-08-03T10:00:00.000Z' }), now)).toBe('snoozed');
    expect(getInboxTaskStatus(makeTask({ snoozedUntil: '2026-08-01T10:00:00.000Z' }), now)).toBe('pending');
    expect(getInboxTaskStatus(makeTask({ snoozedUntil: 'not-a-date' }), now)).toBe('pending');
  });

  it('uses Other only for unrecognized content classifications', () => {
    expect(isOtherContentType('podcast')).toBe(true);
    expect(isOtherContentType('article')).toBe(false);
    expect(isOtherContentType('task')).toBe(false);
  });

  it('files local tasks with a planning horizon and clears explicit triage tags', () => {
    const metadata = getInboxTaskMetadata(toInboxTaskItem(makeTask({
      connectorType: 'local',
      connectorInstanceId: 'local',
      planningHorizon: null,
      tags: [
        { id: 'tag-needs-triage', name: 'Needs triage', slug: 'needs-triage' },
        { id: 'tag-ideas', name: 'Ideas', slug: 'ideas' },
      ],
      editPolicy: { sourceModel: 'mc-owned', localDispositionSupported: false },
    })));

    expect(metadata && getInboxTaskActionMutation(metadata, 'complete_action')).toEqual({
      update: { planningHorizon: 'next', tags: ['tag-ideas'] },
      undoPatch: { planningHorizon: null, tags: ['tag-needs-triage', 'tag-ideas'] },
    });
  });

  it('files remote mirrors with a local disposition', () => {
    const metadata = getInboxTaskMetadata(toInboxTaskItem(makeTask({
      tags: [],
      editPolicy: { sourceModel: 'remote-mirror', localDispositionSupported: true },
    })));

    expect(metadata && getInboxTaskActionMutation(metadata, 'complete_action')).toEqual({
      update: { localDisposition: 'handled' },
      undoPatch: { localDisposition: 'active' },
    });
  });

  it('only clears the triage tag when the task is already filed', () => {
    const metadata = getInboxTaskMetadata(toInboxTaskItem(makeTask({
      planningHorizon: 'later',
      hubProjectIds: ['project-1'],
      editPolicy: { sourceModel: 'mc-owned', localDispositionSupported: false },
    })));

    expect(metadata && getInboxTaskActionMutation(metadata, 'complete_action')).toEqual({
      update: { tags: [] },
      undoPatch: { tags: ['tag-needs-triage'] },
    });
  });

  it('dismisses local tasks by cancelling them and restores their prior lifecycle state', () => {
    const metadata = getInboxTaskMetadata(toInboxTaskItem(makeTask({
      connectorType: 'local',
      connectorInstanceId: 'local',
      status: 'in_progress',
      statusReason: null,
      editPolicy: { sourceModel: 'mc-owned', localDispositionSupported: false },
    })));

    expect(metadata && getInboxTaskActionMutation(metadata, 'dismiss')).toEqual({
      update: { status: 'cancelled', statusReason: 'not_planned' },
      undoPatch: { status: 'in_progress', statusReason: null },
    });
  });
});
