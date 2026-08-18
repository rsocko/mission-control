import { describe, expect, it } from 'vitest';
import { toKanbanProjectViewModel } from '@/app/kanban/components';

describe('toKanbanProjectViewModel', () => {
  it('supplies an empty column list when a project summary omits columns', () => {
    expect(toKanbanProjectViewModel({
      id: 'project-1',
      name: 'Project',
      color: '#3b82f6',
      icon: null,
    })).toMatchObject({
      id: 'project-1',
      kanbanColumns: [],
    });
  });
});
