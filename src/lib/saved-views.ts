'use client';

import { useState, useEffect } from 'react';
import { NEXT_7_DAYS_LABEL } from '@/lib/tasks/due-window';

export interface SavedView {
  id: string;
  name: string;
  icon: string;
  filters: {
    source?: string;
    tag?: string;
    projectId?: string;
    status?: string;
    priority?: string;
  };
}

const STORAGE_KEY = 'mission-control:saved-views';

const DEFAULT_VIEWS: SavedView[] = [
  { id: 'overdue-all', name: 'All Overdue', icon: '🔥', filters: { tag: '__overdue' } },
  { id: 'high-priority', name: 'High Priority', icon: '⭐', filters: { tag: '__high' } },
  { id: 'due-this-week', name: NEXT_7_DAYS_LABEL, icon: '🕐', filters: { tag: '__week' } },
];

export function useSavedViews() {
  const [views, setViews] = useState<SavedView[]>(DEFAULT_VIEWS);

  // Load from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setViews([...DEFAULT_VIEWS, ...parsed]);
      }
    } catch {}
  }, []);

  const saveView = (view: Omit<SavedView, 'id'>) => {
    const newView: SavedView = { ...view, id: `custom-${Date.now()}` };
    const custom = views.filter(v => v.id.startsWith('custom-'));
    const updated = [...custom, newView];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setViews([...DEFAULT_VIEWS, ...updated]);
    return newView;
  };

  const deleteView = (id: string) => {
    const custom = views.filter(v => v.id.startsWith('custom-') && v.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    setViews([...DEFAULT_VIEWS, ...custom]);
  };

  return { views, saveView, deleteView };
}
