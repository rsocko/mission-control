import { describe, expect, it } from 'vitest';
import {
  getTaskStatusGroupFilter,
  getTaskStatusGroupLabel,
} from '@/lib/tasks/task-status-groups';

describe('task status groups', () => {
  it.each([
    ['done', 'Completed'],
    ['cancelled', 'Cancelled'],
    ['in_progress', 'In Progress'],
    ['todo', 'To Do'],
    ['waiting', 'To Do'],
  ])('groups %s as %s', (status, groupLabel) => {
    expect(getTaskStatusGroupLabel(status)).toBe(groupLabel);
  });

  it('loads every status represented by the To Do fallback group', () => {
    expect(getTaskStatusGroupFilter('To Do')).toEqual({
      mode: 'exclude',
      statuses: ['done', 'cancelled', 'in_progress'],
    });
  });
});
