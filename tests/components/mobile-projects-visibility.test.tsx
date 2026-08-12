import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileProjectsView } from '@/components/projects/MobileProjectsView';

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));

vi.mock('@/lib/hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    containerRef: { current: null },
    isRefreshing: false,
    pullDistance: 0,
    containerProps: {},
    contentStyle: {},
  }),
}));

vi.mock('motion/react', () => {
  const MotionButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => <button ref={ref} {...props}>{children}</button>,
  );
  MotionButton.displayName = 'MotionButton';
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { button: MotionButton },
    useReducedMotion: () => false,
  };
});

vi.mock('@/components/ui/MobileSheet', () => ({
  MobileSheet: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
  }) => isOpen ? <section aria-label={title}>{children}</section> : null,
}));

const visibleProject = {
  id: 'project-1',
  name: 'Visible Project',
  color: '#3b82f6',
  icon: null,
  category: null,
  status: 'active',
  progress: {
    totalTasks: 0,
    completedTasks: 0,
    inProgressTasks: 0,
    percentComplete: 0,
    health: 'on_track',
    lastActivity: null,
  },
  targetDate: null,
  metadata: {},
};

describe('MobileProjectsView visibility controls', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects-overview') {
        return {
          ok: true,
          json: async () => ({
            categories: [{ category: 'Work', projects: [visibleProject] }],
            uncategorized: [],
            summary: {
              totalProjects: 1,
              activeProjects: 1,
              completedProjects: 0,
              atRiskProjects: 0,
            },
          }),
        } as Response;
      }
      if (url === '/api/hub-projects?includeHidden=true') {
        return {
          ok: true,
          json: async () => ({
            projects: [{
              id: 'hidden-1',
              name: 'Hidden Project',
              color: '#8b5cf6',
              icon: null,
              hidden: true,
              metadata: {},
            }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/tasks?')) {
        return { ok: true, json: async () => ({ tasks: [] }) } as Response;
      }
      if (url.startsWith('/api/hub-projects/') && init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('hides a visible project and can unhide a hidden project', async () => {
    render(<MobileProjectsView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open project Visible Project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide project' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/hub-projects/project-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Unhide Hidden Project' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/hub-projects/hidden-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
      });
    });
  });

  it('renders recovery controls when every project is hidden', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects-overview') {
        return {
          ok: true,
          json: async () => ({
            categories: [],
            uncategorized: [],
            summary: {
              totalProjects: 0,
              activeProjects: 0,
              completedProjects: 0,
              atRiskProjects: 0,
            },
          }),
        } as Response;
      }
      if (url === '/api/hub-projects?includeHidden=true') {
        return {
          ok: true,
          json: async () => ({
            projects: [{
              id: 'hidden-1',
              name: 'Hidden Project',
              color: '#8b5cf6',
              icon: null,
              hidden: true,
              metadata: {},
            }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<MobileProjectsView />);

    expect(await screen.findByRole('button', { name: 'Unhide Hidden Project' })).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('keeps visible projects usable when hidden projects fail to load', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects-overview') {
        return {
          ok: true,
          json: async () => ({
            categories: [{ category: 'Work', projects: [visibleProject] }],
            uncategorized: [],
            summary: {
              totalProjects: 1,
              activeProjects: 1,
              completedProjects: 0,
              atRiskProjects: 0,
            },
          }),
        } as Response;
      }
      if (url === '/api/hub-projects?includeHidden=true') {
        throw new Error('Hidden projects unavailable');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<MobileProjectsView />);

    expect(await screen.findByRole('button', { name: 'Open project Visible Project' })).toBeInTheDocument();
  });
});
