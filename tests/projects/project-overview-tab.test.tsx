import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installProjectPageHarness,
  makePhase,
  makePhaseItem,
  makeTask,
  openProjectTab,
  overlayState,
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

const phases = [
  makePhase('phase-discovery', { name: 'Discovery', sortOrder: 0 }),
  makePhase('phase-build', { name: 'Build', sortOrder: 1, status: 'in_progress' }),
];

const tasks = [
  makeTask('task-alpha', { title: 'Alpha task', updatedAt: '2026-08-14T18:00:00.000Z' }),
  makeTask('task-beta', { title: 'Beta task', status: 'done', updatedAt: '2026-08-14T17:00:00.000Z' }),
  makeTask('task-gamma', { title: 'Gamma task', updatedAt: '2026-08-14T16:00:00.000Z' }),
  makeTask('task-delta', { title: 'Delta task', status: 'done', updatedAt: '2026-08-14T15:00:00.000Z' }),
  makeTask('task-epsilon', { title: 'Epsilon task', updatedAt: '2026-08-10T09:00:00.000Z' }),
];

function populatedScenario() {
  return installProjectPageHarness({
    project: {
      name: 'Overview Project',
      description: 'Delivery of the reporting workspace.',
      startedAt: '2026-03-02',
      targetDate: '2027-11-30',
      completedAt: null,
    },
    phases,
    phaseItems: {
      'phase-discovery': [
        makePhaseItem('phase-discovery', 'task-alpha', 0),
        makePhaseItem('phase-discovery', 'task-beta', 1),
      ],
      'phase-build': [makePhaseItem('phase-build', 'task-gamma', 0)],
    },
    tasks,
  });
}

describe('project overview tab', () => {
  let harness: ProjectPageHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    overlayState.reportTaskId = 'task-alpha';
    harness = populatedScenario();
  });

  it('summarizes progress, description, key dates, and the four most recent tasks', async () => {
    await renderProjectTab('Overview');

    expect(await screen.findByRole('heading', { name: 'Description' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '40% of project tasks complete' })).toBeInTheDocument();
    expect(screen.getByText('Delivery of the reporting workspace.')).toBeInTheDocument();
    expect(screen.getByLabelText('Progress reports')).toBeInTheDocument();

    const keyDates = screen.getByRole('heading', { name: 'Key dates' }).closest('div')!.parentElement!;
    expect(within(keyDates).getByText('Mar 2, 2026')).toBeInTheDocument();
    expect(within(keyDates).getByText('Nov 30, 2027')).toBeInTheDocument();
    expect(within(keyDates).getAllByText('—')).toHaveLength(1);

    const activity = screen.getByRole('heading', { name: 'Recent activity' })
      .closest('div')!.parentElement!;
    expect(within(activity).getByText('Alpha task')).toBeInTheDocument();
    expect(within(activity).getByText('Delta task')).toBeInTheDocument();
    expect(within(activity).queryByText('Epsilon task')).not.toBeInTheDocument();
  });

  it('reports per-phase completion and opens a phase in Plan', async () => {
    await renderProjectTab('Overview');

    const discovery = await screen.findByRole('button', { name: 'Open Discovery in Plan' });
    expect(within(discovery).getByText('1/2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Build in Plan' })).toBeInTheDocument();

    fireEvent.click(discovery);

    expect(await screen.findByRole('region', { name: 'Discovery phase' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
  });

  it('shares task selection with the task detail panel from activity and reports', async () => {
    await renderProjectTab('Overview');

    fireEvent.click(await screen.findByText('Gamma task'));
    expect(await screen.findByTestId('task-detail-task-gamma')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open reported task' }));
    expect(await screen.findByTestId('task-detail-task-alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close task detail' }));
    await waitFor(() => {
      expect(screen.queryByTestId('task-detail-task-alpha')).not.toBeInTheDocument();
    });
  });

  it('keeps the selected task while the user moves between tabs', async () => {
    await renderProjectTab('Overview');

    fireEvent.click(await screen.findByText('Alpha task'));
    expect(await screen.findByTestId('task-detail-task-alpha')).toBeInTheDocument();

    await openProjectTab('Project Tasks');
    expect(screen.getByTestId('task-detail-task-alpha')).toBeInTheDocument();

    await openProjectTab('Overview');
    expect(screen.getByTestId('task-detail-task-alpha')).toBeInTheDocument();
  });

  it('refreshes the report scope key when project tasks change', async () => {
    await renderProjectTab('Overview');

    const report = await screen.findByLabelText('Progress reports');
    const initialKey = report.dataset.refreshKey;
    expect(initialKey).toContain('task-alpha:todo');

    await openProjectTab('Plan');
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark task complete' })[0]);
    await openProjectTab('Overview');

    await waitFor(() => {
      expect(screen.getByLabelText('Progress reports').dataset.refreshKey)
        .not.toBe(initialKey);
    });
  });

  it('guides setup when the project has no phases or task activity', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Empty Project' },
      phases: [],
      tasks: [],
    });
    await renderProjectTab('Overview');

    expect(await screen.findByText('No recent task activity yet.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '0% of project tasks complete' })).toBeInTheDocument();
    expect(screen.getByText(/No phases defined yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up phases →' }));

    expect(await screen.findByText('No phases yet')).toBeInTheDocument();
    expect(harness.requestsFor('/api/project-phases', 'POST')).toHaveLength(0);
  });
});
