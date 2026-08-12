'use client';

import { createContext, useContext } from 'react';

interface ProjectsSidebarContextValue {
  collapsed: boolean;
  expandSidebar: () => void;
}

const ProjectsSidebarContext = createContext<ProjectsSidebarContextValue>({
  collapsed: false,
  expandSidebar: () => {},
});

export const ProjectsSidebarProvider = ProjectsSidebarContext.Provider;

export function useProjectsSidebar() {
  return useContext(ProjectsSidebarContext);
}
