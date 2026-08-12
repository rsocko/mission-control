'use client';

import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'dashboard_collapsed_sections';

export type DashboardSectionId = 'one-thing' | 'kpis' | 'recent-wins' | 'routines' | 'triage-queue';

function getStoredCollapsed(): Set<DashboardSectionId> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as DashboardSectionId[]);
  } catch {
    return new Set();
  }
}

function persistCollapsed(collapsed: Set<DashboardSectionId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // silent
  }
}

export function useDashboardSections() {
  const [collapsed, setCollapsed] = useState<Set<DashboardSectionId>>(new Set());

  useEffect(() => {
    setCollapsed(getStoredCollapsed());
  }, []);

  const toggleSection = useCallback((id: DashboardSectionId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      persistCollapsed(next);
      return next;
    });
  }, []);

  const isCollapsed = useCallback(
    (id: DashboardSectionId) => collapsed.has(id),
    [collapsed],
  );

  return { collapsed, toggleSection, isCollapsed };
}
