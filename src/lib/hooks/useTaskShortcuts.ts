'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PINNED_TASK_SHORTCUTS_STORAGE_KEY,
  RECENT_TASK_SHORTCUTS_STORAGE_KEY,
  TASK_SHORTCUTS_CHANGED_EVENT,
  readPinnedTaskShortcuts,
  readRecentTaskShortcuts,
  togglePinnedTaskShortcut,
  type TaskShortcut,
} from '@/lib/navigation/task-shortcuts';

export function useTaskShortcuts() {
  const [pinned, setPinned] = useState<TaskShortcut[]>([]);
  const [recent, setRecent] = useState<TaskShortcut[]>([]);

  const refresh = useCallback(() => {
    setPinned(readPinnedTaskShortcuts());
    setRecent(readRecentTaskShortcuts());
  }, []);

  useEffect(() => {
    refresh();
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === PINNED_TASK_SHORTCUTS_STORAGE_KEY
        || event.key === RECENT_TASK_SHORTCUTS_STORAGE_KEY
      ) {
        refresh();
      }
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(TASK_SHORTCUTS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(TASK_SHORTCUTS_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  const togglePinned = useCallback((shortcut: TaskShortcut) => {
    const nextPinned = togglePinnedTaskShortcut(shortcut);
    refresh();
    return nextPinned;
  }, [refresh]);

  return {
    pinned,
    recent,
    pinnedIds: new Set(pinned.map((shortcut) => shortcut.id)),
    togglePinned,
  };
}
