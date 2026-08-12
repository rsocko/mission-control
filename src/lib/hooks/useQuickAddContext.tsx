'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface QuickAddFilterContext {
  /** Active connector type filter (e.g. 'microsoft-todo', 'github-issues') */
  sourceFilter: string | null;
  /** Active list filter — sourceId from the sidebar */
  listFilter: string | null;
  /** Display name for the filtered list */
  listFilterName: string | null;
  /** Connector type that owns the filtered list */
  listFilterConnectorType: string | null;
  /** Active project filter ID */
  projectFilter: string | null;
  /** Display name for the active project */
  projectFilterName: string | null;
  /** Tags to auto-apply when creating a task from this context (e.g. ['goal']) */
  defaultTags: string[] | null;
  /** Custom placeholder text for the quick-add input */
  placeholderOverride: string | null;
  /** When true, newly created tasks are automatically added to My Day */
  addToMyDay: boolean;
}

interface QuickAddContextValue extends QuickAddFilterContext {
  setQuickAddFilter: (filter: Partial<QuickAddFilterContext>) => void;
  clearQuickAddFilter: () => void;
}

const DEFAULT_FILTER: QuickAddFilterContext = {
  sourceFilter: null,
  listFilter: null,
  listFilterName: null,
  listFilterConnectorType: null,
  projectFilter: null,
  projectFilterName: null,
  defaultTags: null,
  placeholderOverride: null,
  addToMyDay: false,
};

const QuickAddContext = createContext<QuickAddContextValue>({
  ...DEFAULT_FILTER,
  setQuickAddFilter: () => {},
  clearQuickAddFilter: () => {},
});

export function QuickAddProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<QuickAddFilterContext>(DEFAULT_FILTER);

  const setQuickAddFilter = useCallback((partial: Partial<QuickAddFilterContext>) => {
    setFilter(prev => ({ ...prev, ...partial }));
  }, []);

  const clearQuickAddFilter = useCallback(() => {
    setFilter(DEFAULT_FILTER);
  }, []);

  return (
    <QuickAddContext.Provider value={{ ...filter, setQuickAddFilter, clearQuickAddFilter }}>
      {children}
    </QuickAddContext.Provider>
  );
}

export function useQuickAddContext() {
  return useContext(QuickAddContext);
}
