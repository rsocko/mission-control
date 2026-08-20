import { describe, expect, it } from 'vitest';
import { needsMicrosoftTodoLinkedResourceHydration } from '@/lib/sync/task-metadata-hydration';

describe('Microsoft To Do linked-resource hydration', () => {
  it('hydrates existing personal tasks when a full sync first supplies linked resources', () => {
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'microsoft-todo',
      { graphId: 'task-1' },
      { graphId: 'task-1', linkedResources: [] },
    )).toBe(true);
  });

  it('does not repeatedly update hydrated tasks or affect other connectors', () => {
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'microsoft-todo',
      { graphId: 'task-1', linkedResources: [] },
      { graphId: 'task-1', linkedResources: [] },
    )).toBe(false);
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'github-issues',
      {},
      { linkedResources: [] },
    )).toBe(false);
  });
});
