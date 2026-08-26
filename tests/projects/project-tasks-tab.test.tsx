import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installProjectPageHarness,
  makePhase,
  makePhaseItem,
  makeTask,
  navigationState,
  openProjectTab,
  overlayState,
  projectPageElement,
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

const phases = [makePhase('phase-discovery', { name: 'Discovery' })];

const tasks = [
  makeTask('task-alpha', {
    title: 'Alpha migration',
    priority: 'high',
    effort: 2,
    sourceListName: 'Backlog',
    tags: [{ id: 'tag-design', name: 'Design', slug: 'design', type: 'label', color: null }],
    updatedAt: '2026-08-14T18:00:00.000Z',
  }),
  makeTask('task-beta', {
    title: 'Beta cleanup',
    status: 'done',
    priority: 'medium',
    effort: 3,
    updatedAt: '2026-08-14T17:00:00.000Z',
  }),
  makeTask('task-gamma', {
    title: 'Gamma rollout',
    status: 'in_progress',
    priority: 'low',
    effort: 5,
    updatedAt: '2026-08-14T16:00:00.000Z',
  }),
] as ReturnType<typeof makeTask>[];

function scenario() {
  return installProjectPageHarness({
    project: { name: 'Tasks Project' },
    phases,
    phaseItems: {
      'phase-discovery': [makePhaseItem('phase-discovery', 'task-alpha', 0)],
    },
    tasks,
  });
}

function taskList() {
  return screen.getByRole('heading', { name: 'Project tasks' })
    .closest('div')!.parentElement!.parentElement!;
}

function renderedTaskTitles() {
  return screen
    .getAllByText(/^(Alpha migration|Beta cleanup|Gamma rollout)$/)
    .map((element) => element.textContent);
}

function keywordInput() {
  return screen.getByRole('textbox', { name: 'Filter tasks by keyword' });
}

describe('project tasks tab', () => {
  let harness: ProjectPageHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    overlayState.createdTaskId = 'task-new';
    overlayState.pickedTaskIds = ['task-linked'];
    harness = scenario();
  });

  it('lists open project tasks with their phase mapping and hides inactive work', async () => {
    await renderProjectTab('Project Tasks');

    expect(await screen.findByRole('heading', { name: 'Project tasks' })).toBeInTheDocument();
    expect(screen.getByText('2 open project tasks. Turn on Done to review inactive work.'))
      .toBeInTheDocument();
    expect(renderedTaskTitles()).toEqual(['Alpha migration', 'Gamma rollout']);
    expect(within(taskList()).getByText('Phase: Discovery')).toBeInTheDocument();
    expect(within(taskList()).getByText('Phase: Unassigned')).toBeInTheDocument();
    expect(within(taskList()).getByText('Design')).toBeInTheDocument();
  });

  it('reveals completed work through the Done toggle', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.click(screen.getByRole('button', { name: 'Show completed tasks' }));

    expect(await screen.findByText('Beta cleanup')).toBeInTheDocument();
    expect(screen.getByText('3 tasks assigned to this project, with their current phase mapping.'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide completed tasks' })).toBeInTheDocument();
  });

  it('narrows the list by keyword and restores it from the empty state', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.change(keywordInput(), { target: { value: 'Alpha' } });

    await waitFor(() => expect(renderedTaskTitles()).toEqual(['Alpha migration']));
    expect(screen.getByText('Showing 1 of 3 project tasks.')).toBeInTheDocument();

    fireEvent.change(keywordInput(), { target: { value: 'nothing matches' } });

    expect(await screen.findByText('No tasks match the current filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(renderedTaskTitles()).toEqual(['Alpha migration', 'Gamma rollout']));
  });

  it('uses the shared group toolbar with project-scoped phase grouping', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.click(screen.getByRole('button', { name: 'Group by: None' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Phase' }));

    expect(screen.getByRole('button', { name: 'Group by: Phase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discovery \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unassigned \(1\)/ })).toBeInTheDocument();
  });

  it('reorders the list when the sort direction changes', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    expect(renderedTaskTitles()).toEqual(['Alpha migration', 'Gamma rollout']);

    fireEvent.click(screen.getByRole('button', { name: 'Sort direction: ascending' }));

    await waitFor(() => expect(renderedTaskTitles()).toEqual(['Gamma rollout', 'Alpha migration']));
    expect(screen.getByRole('button', { name: 'Sort direction: descending' })).toBeInTheDocument();
  });

  it('keeps filter and sort state while the user visits another tab', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.change(keywordInput(), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sort direction: ascending' }));
    await waitFor(() => expect(renderedTaskTitles()).toEqual(['Alpha migration']));

    await openProjectTab('Plan');
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    await openProjectTab('Project Tasks');

    expect(keywordInput()).toHaveValue('Alpha');
    expect(screen.getByRole('button', { name: 'Sort direction: descending' })).toBeInTheDocument();
    expect(renderedTaskTitles()).toEqual(['Alpha migration']);
  });

  it('resets filters when the route points at a different project', async () => {
    const view = await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.change(keywordInput(), { target: { value: 'Alpha' } });
    await waitFor(() => expect(renderedTaskTitles()).toEqual(['Alpha migration']));

    navigationState.projectId = 'project-2';
    view.rerender(await projectPageElement());

    expect(await screen.findByText('Project project-2')).toBeInTheDocument();
    await openProjectTab('Project Tasks');
    expect(keywordInput()).toHaveValue('');
  });

  it('opens the task detail panel for a selected task', async () => {
    await renderProjectTab('Project Tasks');

    fireEvent.click(await screen.findByText('Alpha migration'));

    expect(await screen.findByTestId('task-detail-task-alpha')).toBeInTheDocument();
  });

  it('creates a new project task from the add menu without a phase target', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const menu = screen.getByRole('menu', { name: 'Add task' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Create new task' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create task' });
    expect(within(dialog).getByText('Creating in project-1')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm new task' }));

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'assign_tasks',
        taskIds: ['task-new'],
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Create task' })).not.toBeInTheDocument();
    });
  });

  it('links existing tasks to the project from the add menu', async () => {
    await renderProjectTab('Project Tasks');
    await screen.findByRole('heading', { name: 'Project tasks' });

    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link existing task' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add tasks to Tasks Project' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm linked tasks' }));

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'assign_tasks',
        taskIds: ['task-linked'],
      });
    });
  });

  it('explains an empty list when every project task is inactive', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Tasks Project' },
      phases: [],
      tasks: [makeTask('task-beta', { title: 'Beta cleanup', status: 'done' })],
    });
    await renderProjectTab('Project Tasks');

    expect(await screen.findByText('No open project tasks')).toBeInTheDocument();
    expect(screen.getByText('Turn on Done to review completed and cancelled tasks.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });
});
