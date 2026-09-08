import { describe, expect, it } from 'vitest';
import { applyMyDayTaskFieldUpdate } from '@/components/today/apply-task-field-update';
import type { MyDayItem } from '@/components/today/types';

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
});
