'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProjectsSidebar } from '@/components/projects/ProjectsSidebar';
import { ProjectsSidebarProvider } from '@/components/projects/ProjectsSidebarContext';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

const MIN_WIDTH = 180;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 40;
const WIDTH_KEY = 'projects-sidebar-width';
const COLLAPSED_KEY = 'projects-sidebar-collapsed';

function getInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
}

function getInitialWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const saved = localStorage.getItem(WIDTH_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const [width, setWidth] = useState(getInitialWidth);
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (collapsed) return;
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width, collapsed]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (e.clientX - startX.current)));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [width]);

  const handleCollapsedChange = useCallback((next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
  }, []);

  const sidebarContext = useMemo(() => ({
    collapsed,
    expandSidebar: () => handleCollapsedChange(false),
  }), [collapsed, handleCollapsedChange]);

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

  return (
    <ProjectsSidebarProvider value={sidebarContext}>
      <div className="flex h-full overflow-hidden">
        {/* Hide sidebar on mobile — projects page renders its own mobile view */}
        {!isMobile && (
          <div
            className="relative flex-shrink-0 transition-[width] duration-200 ease-out"
            style={{ width: effectiveWidth }}
          >
            <ProjectsSidebar collapsed={collapsed} onCollapsedChange={handleCollapsedChange} />
            {/* Resize handle (hidden when collapsed) */}
            {!collapsed && (
              <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -right-[2px] w-[5px] cursor-col-resize z-10 group"
              >
                <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-full opacity-0 group-hover:opacity-100 group-active:opacity-100 bg-[var(--accent-400)] transition-opacity duration-150" />
              </div>
            )}
          </div>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {children}
        </main>
      </div>
    </ProjectsSidebarProvider>
  );
}
