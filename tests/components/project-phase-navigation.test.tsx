import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import ProjectDetailPage from '@/app/projects/[id]/page';

const phase = {
  id: 'phase-discovery',
  projectId: 'project-1',
  name: 'Discovery',
  description: null,
  status: 'pending' as const,
  color: '#8b5cf6',
  estimatedDays: null,
  targetStart: null,
  targetEnd: null,
  startAfterPhaseId: null,
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const hierarchy: ProjectHierarchySnapshot = {
  projectId: 'project-1',
  revision: 1,
  phases: [phase],
  phaseItemsByPhase: { [phase.id]: [] },
};

const syncState = vi.hoisted(() => ({ refetchKey: 0 }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'project-1' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/projects/hierarchy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects/hierarchy-client')>();
  return {
    ...actual,
    loadProjectHierarchy: vi.fn(async () => hierarchy),
  };
});

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: syncState.refetchKey } }),
}));

vi.mock('@/lib/hooks/useQuickAddContext', () => ({
  useQuickAddContext: () => ({
    setQuickAddFilter: vi.fn(),
    clearQuickAddFilter: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/useTaskSelection', () => ({
  useTaskSelection: () => ({
    selectedTaskId: null,
    toggleTask: vi.fn(),
    closeTask: vi.fn(),
  }),
}));

vi.mock('@/components/graph/ProjectStructureGraph', () => ({
  default: () => <div data-testid="project-structure-graph" />,
}));

vi.mock('motion/react', () => {
  type MotionProps<T extends HTMLElement> = React.HTMLAttributes<T> & {
    animate?: unknown;
    initial?: unknown;
    variants?: unknown;
  };
  const MotionDiv = React.forwardRef<HTMLDivElement, MotionProps<HTMLDivElement>>(
    ({ animate, initial, variants, ...props }, ref) => {
      void animate;
      void initial;
      void variants;
      return <div ref={ref} {...props} />;
    },
  );
  MotionDiv.displayName = 'MotionDiv';
  const MotionSection = React.forwardRef<HTMLElement, MotionProps<HTMLElement>>(
    ({ animate, initial, variants, ...props }, ref) => {
      void animate;
      void initial;
      void variants;
      return <section ref={ref} {...props} />;
    },
  );
  MotionSection.displayName = 'MotionSection';
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv, section: MotionSection },
    useReducedMotion: () => false,
  };
});

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { height: 72 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

describe('project phase navigation', () => {
  beforeEach(() => {
    syncState.refetchKey = 0;
    localStorage.clear();
    localStorage.setItem('project-phases-collapsed:project-1', JSON.stringify([phase.id]));
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 72,
    } as DOMRect);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url === '/api/hub-projects/project-1'
        ? {
            project: {
              id: 'project-1',
              name: 'Test Project',
              description: null,
              color: '#3b82f6',
              icon: null,
              iconColor: null,
              sourceBindings: [],
              autoIncludeRules: [],
              kanbanColumns: [],
              defaultView: 'list',
              status: 'active',
              statusOverride: null,
              category: null,
              targetDate: null,
              startedAt: null,
              completedAt: null,
              sortOrder: 0,
              metadata: {},
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          }
        : url.startsWith('/api/tasks?')
          ? { tasks: [] }
          : url === '/api/hub-projects?includePhases=true'
            ? { projects: [] }
            : {};

      return {
        ok: true,
        json: async () => payload,
      } as Response;
    }));
  });

  it('opens a collapsed overview phase in Plan, scrolls it below the toolbars, and moves focus', async () => {
    render(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open Discovery in Plan' }));

    const phaseRegion = await screen.findByRole('region', { name: 'Discovery phase' });
    await waitFor(() => {
      expect(phaseRegion).toHaveFocus();
      expect(phaseRegion.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
      });
    });

    expect(screen.getByRole('button', { name: 'Collapse phase tasks' })).toBeInTheDocument();
    expect(phaseRegion.style.scrollMarginTop).toBe('168px');
    expect(localStorage.getItem('project-phases-collapsed:project-1')).toBe('[]');
  });

  it('loads only top-level tasks for the project plan', async () => {
    render(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );

    await screen.findByText('Test Project');

    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks?projectId=project-1&parentOnly=true&sortBy=updated&limit=200&offset=0',
      undefined,
    );
  });

  it('keeps only the graph toolbar non-sticky and omits its unused search field', async () => {
    render(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Plan (1)' }));

    const getPlanToolbar = () => screen.getByRole('heading', { name: 'Plan' }).parentElement?.parentElement;
    expect(getPlanToolbar()).toHaveClass('sticky');
    expect(getPlanToolbar()).toHaveStyle({ top: '72px' });
    expect(screen.getByPlaceholderText('Filter tasks…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^graph$/i }));
    expect(getPlanToolbar()).toHaveClass('relative');
    expect(getPlanToolbar()).not.toHaveClass('sticky');
    expect(getPlanToolbar()).not.toHaveStyle({ top: '72px' });
    expect(screen.queryByPlaceholderText('Filter tasks…')).not.toBeInTheDocument();
    expect(await screen.findByTestId('project-structure-graph')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^gantt$/i }));
    expect(getPlanToolbar()).toHaveClass('sticky');
    expect(getPlanToolbar()).toHaveStyle({ top: '72px' });
    expect(screen.getByPlaceholderText('Filter tasks…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    expect(getPlanToolbar()).toHaveClass('sticky');
    expect(getPlanToolbar()).toHaveStyle({ top: '72px' });
    expect(screen.queryByPlaceholderText('Filter tasks…')).not.toBeInTheDocument();
  });

  it('keeps the Plan visible while a sync refreshes project data', async () => {
    const view = render(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );
    expect(await screen.findByText('Test Project')).toBeInTheDocument();

    const previousFetch = vi.mocked(fetch).getMockImplementation();
    let resolveProjectRefresh!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/hub-projects/project-1') {
        return new Promise<Response>((resolve) => {
          resolveProjectRefresh = resolve;
        });
      }
      if (!previousFetch) throw new Error('Missing fetch implementation');
      return previousFetch(input, init);
    });

    syncState.refetchKey = 1;
    view.rerender(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );

    await waitFor(() => expect(resolveProjectRefresh).toBeTypeOf('function'));
    expect(screen.getByText('Test Project')).toBeInTheDocument();

    resolveProjectRefresh({
      ok: true,
      json: async () => ({
        project: {
          id: 'project-1',
          name: 'Test Project',
          sourceBindings: [],
          autoIncludeRules: [],
          kanbanColumns: [],
          metadata: {},
        },
      }),
    } as Response);
  });

  it('hides a local project from its settings', async () => {
    render(
      <TooltipProvider>
        <ProjectDetailPage />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/you can unhide it from all projects/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide project' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/hub-projects/project-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
    });
  });
});
