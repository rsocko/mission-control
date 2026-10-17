import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECENT_TASK_SHORTCUTS,
  PINNED_TASK_SHORTCUTS_STORAGE_KEY,
  RECENT_TASK_SHORTCUTS_STORAGE_KEY,
  buildTaskShortcutHref,
  readPinnedTaskShortcuts,
  readRecentTaskShortcuts,
  recordRecentTaskShortcut,
  taskShortcutFromList,
  taskShortcutFromSavedView,
  taskShortcutFromSource,
  togglePinnedTaskShortcut,
} from '@/lib/navigation/task-shortcuts';

const source = {
  type: 'microsoft-todo',
  name: 'Microsoft To Do',
  icon: 'todo',
};

const list = {
  id: 'list-row',
  sourceId: 'groceries',
  connectorInstanceId: 'todo-personal',
  name: 'Groceries',
  taskCount: 4,
  groupId: null,
};

describe('task shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('builds source, list, and saved-view shortcuts with restorable filters', () => {
    const sourceShortcut = taskShortcutFromSource(source);
    const listShortcut = taskShortcutFromList(source, list);
    const savedViewShortcut = taskShortcutFromSavedView({
      id: 'weekly',
      name: 'Weekly planning',
      icon: 'bookmark',
      filters: { priority: 'high' },
      presentation: {
        sortBy: 'dueDate',
        sortDirection: 'asc',
        groupBy: 'source',
        viewDensity: 'compact',
      },
    });

    expect(sourceShortcut.context.sources).toEqual(['microsoft-todo']);
    expect(listShortcut.context.listIds).toEqual(['groceries']);
    expect(savedViewShortcut.context.priorities).toEqual(['high']);
    expect(buildTaskShortcutHref(savedViewShortcut)).toContain('/all-tasks?tf=');
    expect(buildTaskShortcutHref(savedViewShortcut)).toContain('&tp=');
  });

  it('toggles pinned shortcuts and rejects malformed stored entries', () => {
    const shortcut = taskShortcutFromList(source, list);
    localStorage.setItem(PINNED_TASK_SHORTCUTS_STORAGE_KEY, JSON.stringify([
      null,
      { id: 'broken' },
    ]));

    expect(readPinnedTaskShortcuts()).toEqual([]);
    expect(togglePinnedTaskShortcut(shortcut)).toBe(true);
    expect(readPinnedTaskShortcuts()).toEqual([shortcut]);
    expect(togglePinnedTaskShortcut(shortcut)).toBe(false);
    expect(readPinnedTaskShortcuts()).toEqual([]);
  });

  it('keeps recent shortcuts unique and bounded with newest first', () => {
    for (let index = 0; index < MAX_RECENT_TASK_SHORTCUTS + 2; index += 1) {
      recordRecentTaskShortcut({
        ...taskShortcutFromSource(source),
        id: `source:${index}`,
        label: `Source ${index}`,
      });
    }

    const recent = readRecentTaskShortcuts();
    expect(recent).toHaveLength(MAX_RECENT_TASK_SHORTCUTS);
    expect(recent[0]?.label).toBe(`Source ${MAX_RECENT_TASK_SHORTCUTS + 1}`);

    recordRecentTaskShortcut(recent[2]);
    expect(readRecentTaskShortcuts()[0]?.id).toBe(recent[2].id);
    expect(JSON.parse(localStorage.getItem(RECENT_TASK_SHORTCUTS_STORAGE_KEY) || '[]')).toHaveLength(
      MAX_RECENT_TASK_SHORTCUTS,
    );
  });
});
