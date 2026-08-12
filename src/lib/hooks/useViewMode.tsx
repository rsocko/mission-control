'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type ViewMode = 'normal' | 'zen' | 'calm';

export interface CalmScope {
  type: 'global' | 'project' | 'my-day' | 'focus3';
  projectId?: string;
  /** Pre-loaded task IDs for scopes like focus3/my-day where items are already known */
  taskIds?: string[];
  label?: string;
}

interface ViewModeContextValue {
  viewMode: ViewMode;
  calmScope: CalmScope;
  setViewMode: (mode: ViewMode) => void;
  toggleZen: () => void;
  toggleCalm: (scope?: CalmScope) => void;
}

const DEFAULT_CALM_SCOPE: CalmScope = { type: 'global' };

const ViewModeContext = createContext<ViewModeContextValue>({
  viewMode: 'normal',
  calmScope: DEFAULT_CALM_SCOPE,
  setViewMode: () => {},
  toggleZen: () => {},
  toggleCalm: () => {},
});

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  const [calmScope, setCalmScope] = useState<CalmScope>(DEFAULT_CALM_SCOPE);

  const toggleZen = useCallback(() => {
    setViewMode((prev) => (prev === 'zen' ? 'normal' : 'zen'));
  }, []);

  const toggleCalm = useCallback((scope?: CalmScope) => {
    setViewMode((prev) => {
      if (prev === 'calm') return 'normal';
      setCalmScope(scope || DEFAULT_CALM_SCOPE);
      return 'calm';
    });
  }, []);

  return (
    <ViewModeContext.Provider value={{ viewMode, calmScope, setViewMode, toggleZen, toggleCalm }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode() {
  return useContext(ViewModeContext);
}
