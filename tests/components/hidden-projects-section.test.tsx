import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage, { HiddenProjectsSection } from '@/app/projects/page';

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));

describe('HiddenProjectsSection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects-overview') {
        return {
          ok: true,
          json: async () => ({
            categories: [],
            uncategorized: [],
            recentProjects: [],
            recentCompletedItems: [],
            summary: {
              totalProjects: 0,
              activeProjects: 0,
              completedProjects: 0,
              atRiskProjects: 0,
              totalTasks: 0,
              completedTasks: 0,
              inProgressTasks: 0,
              portfolioPercent: 0,
              completedThisWeek: 0,
            },
          }),
        } as Response;
      }
      if (url === '/api/hub-projects?includeHidden=true') {
        return {
          ok: true,
          json: async () => ({
            projects: [{
              id: 'project-1',
              name: 'Only Project',
              icon: null,
              color: '#3b82f6',
              hidden: true,
            }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('keeps the only hidden project recoverable', () => {
    const onExpandedChange = vi.fn();
    const onUnhide = vi.fn();

    const { rerender } = render(
      <HiddenProjectsSection
        projects={[{
          id: 'project-1',
          name: 'Only Project',
          icon: null,
          color: '#3b82f6',
        }]}
        expanded={false}
        onExpandedChange={onExpandedChange}
        onUnhide={onUnhide}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '1 hidden project' }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    rerender(
      <HiddenProjectsSection
        projects={[{
          id: 'project-1',
          name: 'Only Project',
          icon: null,
          color: '#3b82f6',
        }]}
        expanded
        onExpandedChange={onExpandedChange}
        onUnhide={onUnhide}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unhide Only Project' }));

    expect(onUnhide).toHaveBeenCalledWith('project-1');
  });

  it('renders recovery controls when the portfolio has no visible projects', async () => {
    render(<ProjectsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '1 hidden project' }));

    expect(screen.getByRole('button', { name: 'Unhide Only Project' })).toBeInTheDocument();
  });
});
