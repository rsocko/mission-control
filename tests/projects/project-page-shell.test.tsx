import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installProjectPageHarness,
  graphRender,
  makePhase,
  makePhaseItem,
  makeTask,
  navigationState,
  openProjectTab,
  overlayState,
  renderProjectPage,
  renderProjectTab,
  type ProjectPageHarness,
} from './project-tab-fixtures';

vi.mock('next/navigation', async () => (
  (await import('./project-tab-fixtures')).nextNavigationModule()
));
vi.mock('motion/react', async () => (
  (await import('./project-tab-fixtures')).motionReactModule()
));
vi.mock('@/components/ui/select', async () => (
  (await import('./project-tab-fixtures')).uiSelectModule()
));
vi.mock('sonner', async () => (
  (await import('./project-tab-fixtures')).sonnerModule()
));
vi.mock('@/lib/hooks/useSyncStream', async () => (
  (await import('./project-tab-fixtures')).syncStreamModule()
));
vi.mock('@/lib/hooks/useQuickAddContext', async () => (
  (await import('./project-tab-fixtures')).quickAddContextModule()
));
vi.mock('@/components/task-detail/TaskDetailPanel', async () => (
  (await import('./project-tab-fixtures')).taskDetailPanelModule()
));
vi.mock('@/components/projects/BurnReportCard', async () => (
  (await import('./project-tab-fixtures')).burnReportCardModule()
));
vi.mock('@/components/graph/ProjectStructureGraph', async () => (
  (await import('./project-tab-fixtures')).projectStructureGraphModule()
));
vi.mock('@/components/projects/PhaseProposalReview', async () => (
  (await import('./project-tab-fixtures')).phaseProposalReviewModule()
));
vi.mock('@/components/add-task', async () => (
  (await import('./project-tab-fixtures')).addTaskModalModule()
));
vi.mock('@/components/projects/TaskPickerDialog', async () => (
  (await import('./project-tab-fixtures')).taskPickerDialogModule()
));

function shellScenario() {
  return installProjectPageHarness({
    project: { name: 'Shell Project' },
    categories: ['Operations'],
    phases: [makePhase('phase-discovery', { name: 'Discovery' })],
    phaseItems: {
      'phase-discovery': [makePhaseItem('phase-discovery', 'task-alpha', 0)],
    },
    tasks: [
      makeTask('task-alpha', { title: 'Alpha migration' }),
      makeTask('task-gamma', { title: 'Gamma rollout' }),
    ],
  });
}

describe('project detail shell', () => {
  let harness: ProjectPageHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    overlayState.reportTaskId = 'task-alpha';
    overlayState.createdTaskId = 'task-new';
    harness = shellScenario();
  });

  it('shows a loading placeholder until the project resolves', async () => {
    const release = harness.hold('/api/hub-projects/project-1');
    const view = await renderProjectPage();

    await waitFor(() => {
      expect(view.container.querySelector('.animate-pulse')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();

    await act(async () => {
      release();
    });

    expect(await screen.findByText('Shell Project')).toBeInTheDocument();
    expect(view.container.querySelector('.animate-pulse')).not.toBeInTheDocument();
  });

  it('offers a way back when the project cannot be located', async () => {
    harness = installProjectPageHarness({ missingProject: true });
    await renderProjectPage();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
  });

  it('opens the tab named in the route query', async () => {
    navigationState.search = 'tab=settings';
    await renderProjectPage();

    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Description' })).not.toBeInTheDocument();
  });

  it('keeps the header usable for an unknown tab query and recovers on selection', async () => {
    navigationState.search = 'tab=not-a-tab';
    await renderProjectPage();

    expect(await screen.findByText('Shell Project')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Description' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument();

    await openProjectTab('Overview');
    expect(await screen.findByRole('heading', { name: 'Description' })).toBeInTheDocument();
    expect(navigationState.push).not.toHaveBeenCalled();
  });

  it('runs the route-triggered AI proposal while another tab is active', async () => {
    navigationState.search = 'tab=tasks&action=ai-suggest';
    await renderProjectPage();

    expect(await screen.findByRole('heading', { name: 'Project tasks' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Phase proposal' })).toBeInTheDocument();
    expect(harness.requestsFor('/api/project-phases/ai-suggest', 'POST')).toHaveLength(1);
  });

  it('keeps one task detail panel in sync across every tab', async () => {
    await renderProjectTab('Plan');

    fireEvent.click(await screen.findByText('Alpha migration'));
    expect(await screen.findByTestId('task-detail-task-alpha')).toBeInTheDocument();

    await openProjectTab('Project Tasks');
    fireEvent.click(screen.getByText('Gamma rollout'));
    expect(await screen.findByTestId('task-detail-task-gamma')).toBeInTheDocument();
    expect(screen.queryByTestId('task-detail-task-alpha')).not.toBeInTheDocument();

    await openProjectTab('Settings');
    expect(screen.getByTestId('task-detail-task-gamma')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close task detail' }));
    await waitFor(() => {
      expect(screen.queryByTestId('task-detail-task-gamma')).not.toBeInTheDocument();
    });
  });

  it('shares one create-task overlay between the Plan and Project Tasks tabs', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(within(discovery).getByRole('button', { name: 'Add task' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create new task' }));
    expect(await screen.findByRole('dialog', { name: 'Create task' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new task' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Create task' })).not.toBeInTheDocument();
    });

    await openProjectTab('Project Tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create new task' }));

    expect(await screen.findAllByRole('dialog', { name: 'Create task' })).toHaveLength(1);
  });

  it('shares one confirmation dialog between phase deletion and project settings', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Discovery' }));
    expect(within(screen.getByRole('alertdialog')).getByText('Delete phase?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    await openProjectTab('Settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Hide project' }));

    const dialogs = screen.getAllByRole('alertdialog');
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]).getByText('Hide project?')).toBeInTheDocument();
  });

  it('remembers each tab view state while the user moves between tabs', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: /^gantt$/i }));
    expect(await screen.findByText('Phase timeline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^month$/i }));
    expect(screen.getByText(/Zoom by month/)).toBeInTheDocument();

    await openProjectTab('Overview');
    await openProjectTab('Plan');

    expect(await screen.findByText('Phase timeline')).toBeInTheDocument();
    expect(screen.getByText(/Zoom by month/)).toBeInTheDocument();
  });

  it('refreshes visible Settings effects without refetching loaded portfolio categories', async () => {
    const releaseCategories = harness.hold('/api/projects-overview');
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });
    expect(harness.requestsFor('/rule-matches')).toHaveLength(0);
    expect(harness.requestsFor('/api/projects-overview')).toHaveLength(0);

    await openProjectTab('Settings');
    await screen.findByRole('heading', { name: 'Auto-Include Rules' });
    await waitFor(() => expect(harness.requestsFor('/rule-matches')).toHaveLength(1));
    await waitFor(() => expect(harness.requestsFor('/api/projects-overview')).toHaveLength(1));

    await openProjectTab('Overview');
    await openProjectTab('Settings');
    await waitFor(() => expect(harness.requestsFor('/rule-matches')).toHaveLength(2));
    expect(harness.requestsFor('/api/projects-overview')).toHaveLength(1);

    await act(async () => {
      releaseCategories();
    });
    expect(document.querySelector(
      '#project-category-options option[value="Operations"]',
    )).toBeInTheDocument();

    await openProjectTab('Overview');
    expect(await screen.findByRole('heading', { name: 'Description' })).toBeInTheDocument();
    expect(harness.requestsFor('/rule-matches')).toHaveLength(2);
    expect(harness.requestsFor('/api/projects-overview')).toHaveLength(1);

    await openProjectTab('Settings');
    await waitFor(() => expect(harness.requestsFor('/rule-matches')).toHaveLength(3));
    expect(harness.requestsFor('/api/projects-overview')).toHaveLength(1);
    expect(document.querySelector(
      '#project-category-options option[value="Operations"]',
    )).toBeInTheDocument();
  });

  it('retries a failed portfolio category load on the next Settings activation', async () => {
    harness.failOnce('/api/projects-overview', { error: 'Portfolio unavailable' });
    await renderProjectTab('Settings');
    await waitFor(() => expect(harness.requestsFor('/api/projects-overview')).toHaveLength(1));

    await openProjectTab('Overview');
    await openProjectTab('Settings');
    await waitFor(() => expect(harness.requestsFor('/api/projects-overview')).toHaveLength(2));
    expect(document.querySelector(
      '#project-category-options option[value="Operations"]',
    )).toBeInTheDocument();

    await openProjectTab('Overview');
    await openProjectTab('Settings');
    expect(harness.requestsFor('/api/projects-overview')).toHaveLength(2);
  });

  it('applies an Overview phase reveal once instead of on every return to Plan', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Shell Project' },
      phases: [makePhase('phase-discovery', { name: 'Discovery' })],
      phaseItems: {
        'phase-discovery': [makePhaseItem('phase-discovery', 'task-alpha', 0)],
      },
      tasks: [makeTask('task-alpha', { title: 'Alpha migration' })],
      collapsedPhaseIds: ['phase-discovery'],
    });

    await renderProjectTab('Overview');

    fireEvent.click(await screen.findByRole('button', { name: 'Open Discovery in Plan' }));

    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });
    await waitFor(() => expect(discovery).toHaveFocus());
    expect(await screen.findByText('Alpha migration')).toBeInTheDocument();

    fireEvent.click(within(discovery).getByRole('button', { name: 'Collapse phase tasks' }));
    await waitFor(() => {
      expect(screen.queryByText('Alpha migration')).not.toBeInTheDocument();
    });

    await openProjectTab('Overview');
    await openProjectTab('Plan');

    expect(within(await screen.findByRole('region', { name: 'Discovery phase' }))
      .getByRole('button', { name: 'Expand phase tasks' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha migration')).not.toBeInTheDocument();
  });

  it('opens an Overview phase directly in the Plan list without remounting the previous graph view', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: /^graph$/i }));
    await screen.findByTestId('project-structure-graph');
    expect(graphRender).toHaveBeenCalledTimes(1);

    await openProjectTab('Overview');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Discovery in Plan' }));

    expect(await screen.findByRole('region', { name: 'Discovery phase' })).toBeInTheDocument();
    expect(screen.queryByTestId('project-structure-graph')).not.toBeInTheDocument();
    expect(graphRender).toHaveBeenCalledTimes(1);
  });

  it('keeps the full-height graph layout scoped to a visible Plan tab', async () => {
    const scrollContainer = () => (
      screen.getByRole('heading', { name: 'Shell Project' }).closest('section')!.parentElement!
    );

    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });
    expect(scrollContainer()).toHaveClass('space-y-6');

    fireEvent.click(screen.getByRole('button', { name: /^graph$/i }));
    await screen.findByTestId('project-structure-graph');
    await waitFor(() => expect(scrollContainer()).toHaveClass('flex'));
    expect(scrollContainer()).not.toHaveClass('space-y-6');

    await openProjectTab('Project Tasks');
    expect(await screen.findByRole('heading', { name: 'Project tasks' })).toBeInTheDocument();
    expect(scrollContainer()).toHaveClass('space-y-6');
    expect(scrollContainer()).not.toHaveClass('flex-col');
  });
});
