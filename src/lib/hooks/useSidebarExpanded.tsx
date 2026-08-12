'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type SidebarMode = 'collapsed' | 'normal' | 'expanded';

interface SidebarExpandedContextValue {
  sidebarExpanded: boolean;
  sidebarMode: SidebarMode;
  setSidebarExpanded: (expanded: boolean) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebar: () => void;
  collapseSidebar: () => void;
  notificationsPanelVisible: boolean;
  setNotificationsPanelVisible: (visible: boolean) => void;
  toggleNotificationsPanel: () => void;
}

const SidebarExpandedContext = createContext<SidebarExpandedContextValue>({
  sidebarExpanded: false,
  sidebarMode: 'normal',
  setSidebarExpanded: () => {},
  setSidebarMode: () => {},
  toggleSidebar: () => {},
  collapseSidebar: () => {},
  notificationsPanelVisible: true,
  setNotificationsPanelVisible: () => {},
  toggleNotificationsPanel: () => {},
});

export function SidebarExpandedProvider({ children }: { children: ReactNode }) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('normal');
  const [notificationsPanelVisible, setNotificationsPanelVisible] = useState(true);

  // Backwards compat: sidebarExpanded maps to 'expanded' mode
  const sidebarExpanded = sidebarMode === 'expanded';
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    setSidebarMode(expanded ? 'expanded' : 'normal');
  }, []);

  // Toggle cycles: collapsed → normal → expanded → collapsed
  const toggleSidebar = useCallback(() => {
    setSidebarMode(prev => {
      if (prev === 'collapsed') return 'normal';
      if (prev === 'normal') return 'expanded';
      return 'collapsed';
    });
  }, []);

  const collapseSidebar = useCallback(() => {
    setSidebarMode('collapsed');
  }, []);

  const toggleNotificationsPanel = useCallback(() => {
    setNotificationsPanelVisible(prev => !prev);
  }, []);

  return (
    <SidebarExpandedContext.Provider value={{
      sidebarExpanded,
      sidebarMode,
      setSidebarExpanded,
      setSidebarMode,
      toggleSidebar,
      collapseSidebar,
      notificationsPanelVisible,
      setNotificationsPanelVisible,
      toggleNotificationsPanel,
    }}>
      {children}
    </SidebarExpandedContext.Provider>
  );
}

export function useSidebarExpanded() {
  return useContext(SidebarExpandedContext);
}
