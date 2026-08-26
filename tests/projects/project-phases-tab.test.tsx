import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireDragEnd,
  installProjectPageHarness,
  makePhase,
  makePhaseItem,
  makeTask,
  openProjectTab,
  overlayState,
  renderProjectTab,
  toasts,
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
vi.mock('@dnd-kit/core', async () => (
  (await import('./project-tab-fixtures')).dndKitCoreModule()
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

const PHASE_ENDPOINT = '/api/project-phases';
const HIERARCHY_ENDPOINT = '/api/projects/project-1/hierarchy';

function planScenario() {
  return installProjectPageHarness({
    project: { name: 'Plan Project' },
    phases: [
      makePhase('phase-discovery', { name: 'Discovery', sortOrder: 0 }),
      makePhase('phase-build', {
        name: 'Build',
        sortOrder: 1,
        status: 'in_progress',
        description: 'Ship the first slice',
      }),
    ],
    phaseItems: {
      'phase-discovery': [makePhaseItem('phase-discovery', 'task-alpha', 0)],
      'phase-build': [makePhaseItem('phase-build', 'task-beta', 0)],
    },
    tasks: [
      makeTask('task-alpha', { title: 'Alpha migration' }),
      makeTask('task-beta', { title: 'Beta cleanup', status: 'done' }),
      makeTask('task-gamma', { title: 'Gamma rollout' }),
    ],
  });
}

function phaseRegion(name: string) {
  return screen.getByRole('region', { name: `${name} phase` });
}

function renderedPhaseOrder() {
  return screen.getAllByRole('region')
    .map((region) => region.getAttribute('aria-label'))
    .filter((label): label is string => Boolean(label?.endsWith(' phase')));
}

function phaseRequests(harness: ProjectPageHarness, method: string) {
  return harness.requestsFor(/^\/api\/project-phases/, method);
}

describe('project phases (Plan) tab', () => {
  let harness: ProjectPageHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    overlayState.createdTaskId = 'task-new';
    overlayState.pickedTaskIds = ['task-linked'];
    overlayState.graphDependencyPhaseId = 'phase-discovery';
    harness = planScenario();
  });

  it('lays out phases, their task rollups, and unassigned project work', async () => {
    await renderProjectTab('Plan');

    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });
    expect(within(discovery).getByText('Alpha migration')).toBeInTheDocument();
    expect(within(discovery).getByText('1 task')).toBeInTheDocument();
    expect(within(discovery).getByText('0%')).toBeInTheDocument();
    expect(within(discovery).getByRole('button', { name: 'Drag to reorder phase' }))
      .toBeInTheDocument();
    expect(within(discovery).getByRole('button', { name: 'Drag task to another phase' }))
      .toBeInTheDocument();

    const build = phaseRegion('Build');
    expect(within(build).getByText('Ship the first slice')).toBeInTheDocument();
    expect(within(build).getByText('100%')).toBeInTheDocument();

    const unassigned = screen.getByRole('heading', { name: 'Unassigned Tasks' }).parentElement!;
    expect(within(unassigned).getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag task to a phase' })).toBeInTheDocument();
  });

  it('switches plan views and drops bulk selection when the list is left', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha migration' }));
    expect(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByText('1 selected'))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^gantt$/i }));
    expect(await screen.findByText('Phase timeline')).toBeInTheDocument();
    expect(screen.getByText(/Zoom by week/)).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^graph$/i }));
    expect(await screen.findByTestId('project-structure-graph')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    expect(await screen.findByRole('heading', { name: 'Phases' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^list$/i }));
    expect(await screen.findByRole('region', { name: 'Discovery phase' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument();
  });

  it('creates the first phase from the empty state and opens it for renaming', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Plan Project' },
      phases: [],
      tasks: [],
    });
    await renderProjectTab('Plan');

    expect(await screen.findByText('No phases yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'AI Plan' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add first phase' }));

    await waitFor(() => {
      expect(phaseRequests(harness, 'POST')[0]?.body).toEqual({
        projectId: 'project-1',
        name: 'Phase 1',
        color: '#3b82f6',
        sortOrder: 0,
      });
    });

    expect(await screen.findByDisplayValue('Phase 1')).toBeInTheDocument();
  });

  it('collects guidance when generating the first plan', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Plan Project' },
      phases: [],
      tasks: [makeTask('task-alpha', { title: 'Alpha migration' })],
    });
    await renderProjectTab('Plan');

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'AI Plan' }));
    fireEvent.click(await screen.findByText('Generate plan'));

    const guidanceDialog = await screen.findByRole('dialog', { name: 'Generate plan from tasks' });
    fireEvent.change(within(guidanceDialog).getByLabelText(/What should this plan optimize for/), {
      target: { value: 'Prioritize the launch path.' },
    });
    fireEvent.click(within(guidanceDialog).getByRole('button', { name: 'Generate proposal' }));

    await waitFor(() => {
      expect(harness.requestsFor(`${PHASE_ENDPOINT}/ai-suggest`, 'POST')[0]?.body).toEqual({
        projectId: 'project-1',
        context: 'Prioritize the launch path.',
      });
    });
  });

  it('renames a phase inline and abandons the edit on Escape', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: 'Discovery' }));
    const editor = screen.getByDisplayValue('Discovery');
    fireEvent.change(editor, { target: { value: 'Discovery & research' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ name: 'Discovery & research' });
    });
    expect(await screen.findByRole('region', { name: 'Discovery & research phase' }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Build' }));
    const buildEditor = screen.getByDisplayValue('Build');
    fireEvent.change(buildEditor, { target: { value: 'Abandoned' } });
    fireEvent.keyDown(buildEditor, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Build' })).toBeInTheDocument();
    expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
      .not.toContainEqual({ name: 'Abandoned' });
  });

  it('saves phase description, estimate, and schedule edits', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(within(discovery).getByRole('button', { name: 'Add description' }));
    const description = within(discovery).getByPlaceholderText('Add a description…');
    fireEvent.change(description, { target: { value: 'Frame the problem' } });
    fireEvent.blur(description);
    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ description: 'Frame the problem' });
    });

    const estimate = within(discovery).getByRole('spinbutton');
    fireEvent.blur(estimate, { target: { value: '5' } });
    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ estimatedDays: 5 });
    });

    const [start, end] = within(discovery).getAllByDisplayValue('');
    fireEvent.change(start, { target: { value: '2026-09-01' } });
    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ targetStart: '2026-09-01' });
    });
    fireEvent.change(end, { target: { value: '2026-09-30' } });
    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ targetEnd: '2026-09-30' });
    });
  });

  it('cycles the phase status through the badge', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(within(discovery).getByRole('button', { name: 'Pending' }));

    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ status: 'in_progress', completedAt: null });
    });
    expect(await within(phaseRegion('Discovery')).findByRole('button', { name: 'In progress' }))
      .toBeInTheDocument();
  });

  it('sets a phase dependency and reflects removals made in the graph', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    const dependency = within(discovery).getByRole('combobox');
    fireEvent.click(dependency);
    fireEvent.click(within(discovery).getByRole('option', { name: 'After: Build' }));

    await waitFor(() => {
      expect(phaseRequests(harness, 'PATCH').map((request) => request.body))
        .toContainEqual({ startAfterPhaseId: 'phase-build' });
    });
    await waitFor(() => {
      expect(within(phaseRegion('Discovery')).getByRole('combobox'))
        .toHaveTextContent('After: Build');
    });

    fireEvent.click(screen.getByRole('button', { name: /^graph$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove graph dependency' }));
    fireEvent.click(screen.getByRole('button', { name: /^list$/i }));

    await waitFor(() => {
      expect(within(phaseRegion('Discovery')).getByRole('combobox'))
        .toHaveTextContent('No dependency');
    });
  });

  it('deletes a phase after the confirmation is accepted', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Discovery' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Tasks in this phase will be unassigned/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(harness.requestsFor('/api/project-phases/phase-discovery', 'DELETE')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Discovery phase' })).not.toBeInTheDocument();
    });
  });

  it('moves a task between phases and records the hierarchy command', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    await fireDragEnd({
      activeId: 'task:task-alpha',
      activeType: 'task',
      overId: 'phase-drop:phase-build',
      overType: 'phase-drop',
    });

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'move_tasks',
        taskIds: ['task-alpha'],
        toPhaseId: 'phase-build',
        toIndex: 1,
      });
    });
    await waitFor(() => {
      expect(within(phaseRegion('Build')).getByText('Alpha migration')).toBeInTheDocument();
    });
    expect(within(phaseRegion('Discovery')).queryByText('Alpha migration')).not.toBeInTheDocument();
    expect(harness.hierarchy().phaseItemsByPhase['phase-build'].map((item) => item.taskId))
      .toEqual(['task-beta', 'task-alpha']);
  });

  it('rolls the plan back when a task move is rejected', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });
    harness.fail(HIERARCHY_ENDPOINT, { method: 'POST', error: 'Move rejected' });

    await fireDragEnd({
      activeId: 'task:task-alpha',
      activeType: 'task',
      overId: 'phase-drop:phase-build',
      overType: 'phase-drop',
    });

    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Move rejected' });
    });
    expect(within(phaseRegion('Discovery')).getByText('Alpha migration')).toBeInTheDocument();
    expect(within(phaseRegion('Build')).queryByText('Alpha migration')).not.toBeInTheDocument();
  });

  it('reconciles with the authoritative plan when the hierarchy revision moved on', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });
    harness.conflictNextCommand();

    await fireDragEnd({
      activeId: 'task:task-alpha',
      activeType: 'task',
      overId: 'phase-drop:phase-build',
      overType: 'phase-drop',
    });

    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Hierarchy revision conflict' });
    });
    await waitFor(() => {
      expect(within(phaseRegion('Discovery')).getByText('Alpha migration')).toBeInTheDocument();
    });
    expect(within(phaseRegion('Build')).queryByText('Alpha migration')).not.toBeInTheDocument();

    await fireDragEnd({
      activeId: 'task:task-alpha',
      activeType: 'task',
      overId: 'phase-drop:phase-build',
      overType: 'phase-drop',
    });

    await waitFor(() => {
      expect(within(phaseRegion('Build')).getByText('Alpha migration')).toBeInTheDocument();
    });
  });

  it('reorders phases by drag and restores the order when the command fails', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    await fireDragEnd({
      activeId: 'phase:phase-build',
      activeType: 'phase',
      overId: 'phase:phase-discovery',
    });

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'reorder_phases',
        orderedPhaseIds: ['phase-build', 'phase-discovery'],
      });
    });
    expect(renderedPhaseOrder()).toEqual(['Build phase', 'Discovery phase']);

    harness.fail(HIERARCHY_ENDPOINT, { method: 'POST', error: 'Reorder rejected' });
    await fireDragEnd({
      activeId: 'phase:phase-discovery',
      activeType: 'phase',
      overId: 'phase:phase-build',
    });

    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Reorder rejected' });
    });
    expect(renderedPhaseOrder()).toEqual(['Build phase', 'Discovery phase']);
  });

  it('remembers collapsed phases across tab visits', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all phases' }));

    await waitFor(() => {
      expect(localStorage.getItem('project-phases-collapsed:project-1'))
        .toBe(JSON.stringify(['phase-discovery', 'phase-build']));
    });
    expect(screen.queryByText('Alpha migration')).not.toBeInTheDocument();

    await openProjectTab('Overview');
    await openProjectTab('Plan');
    expect(screen.queryByText('Alpha migration')).not.toBeInTheDocument();

    fireEvent.click(within(phaseRegion('Discovery')).getByRole('button', { name: 'Expand phase tasks' }));
    expect(await screen.findByText('Alpha migration')).toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem('project-phases-collapsed:project-1'))
        .toBe(JSON.stringify(['phase-build']));
    });
  });

  it('filters phase tasks by title and reports the filtered count', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.change(screen.getByPlaceholderText(/Filter Plan tasks/), {
      target: { value: 'beta' },
    });

    await waitFor(() => {
      expect(within(phaseRegion('Discovery')).getByText('0/1 task')).toBeInTheDocument();
    });
    expect(within(phaseRegion('Discovery')).queryByText('Alpha migration')).not.toBeInTheDocument();
    expect(within(phaseRegion('Build')).getByText('Beta cleanup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Filter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all phases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all phases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to compact view' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Group by:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sort by:/ })).not.toBeInTheDocument();
  });

  it('bulk selects a range of plan tasks and moves them to another phase', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(screen.getByText('Alpha migration'), { ctrlKey: true });
    fireEvent.click(screen.getByText('Gamma rollout'), { shiftKey: true });

    const bulkBar = await screen.findByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bulkBar).getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(within(bulkBar).getByRole('button', { name: /Phase/ }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Move to phase' }))
      .getByRole('button', { name: 'Build' }));

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'move_tasks',
        taskIds: ['task-alpha', 'task-beta', 'task-gamma'],
        toPhaseId: 'phase-build',
        toIndex: 1,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument();
    });
  });

  it('opens and closes an embedded phase progress report', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(within(discovery).getByRole('button', { name: 'Report' }));

    expect(await screen.findByLabelText('Discovery progress report')).toBeInTheDocument();
    expect(within(phaseRegion('Discovery')).getByRole('button', { name: 'Report' }))
      .toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(phaseRegion('Discovery')).getByRole('button', { name: 'Report' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Discovery progress report')).not.toBeInTheDocument();
    });
  });

  it('collects guidance for improving the current plan or starting over', async () => {
    await renderProjectTab('Plan');
    await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'AI Plan' }));
    fireEvent.click(await screen.findByText('Improve current plan'));

    const guidanceDialog = await screen.findByRole('dialog', { name: 'Improve current plan' });
    fireEvent.change(within(guidanceDialog).getByLabelText(/What should change or improve/), {
      target: { value: 'Keep Discovery and target a two-week launch.' },
    });
    fireEvent.click(within(guidanceDialog).getByRole('button', { name: 'Generate proposal' }));

    await waitFor(() => {
      expect(harness.requestsFor(`${PHASE_ENDPOINT}/ai-refine`, 'POST')[0]?.body).toEqual({
        projectId: 'project-1',
        currentPhases: [
          { name: 'Discovery', taskIds: ['task-alpha'] },
          { name: 'Build', taskIds: ['task-beta'] },
        ],
        instruction: 'Keep Discovery and target a two-week launch.',
      });
    });
    const refinedProposal = await screen.findByRole('dialog', { name: 'Phase proposal' });
    expect(within(refinedProposal).getByText('Refined plan reasoning')).toBeInTheDocument();
    fireEvent.click(within(refinedProposal).getByRole('button', { name: 'Dismiss proposal' }));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'AI Plan' }));
    fireEvent.click(await screen.findByText('Start over from tasks'));
    const startOverDialog = await screen.findByRole('dialog', { name: 'Generate plan from tasks' });
    fireEvent.change(within(startOverDialog).getByLabelText(/What should this plan optimize for/), {
      target: { value: 'Separate frontend and backend work.' },
    });
    fireEvent.click(within(startOverDialog).getByRole('button', { name: 'Generate proposal' }));

    await waitFor(() => {
      expect(harness.requestsFor(`${PHASE_ENDPOINT}/ai-suggest`, 'POST')[0]?.body).toEqual({
        projectId: 'project-1',
        context: 'Separate frontend and backend work.',
      });
    });
    expect(await screen.findByText('Suggested plan reasoning')).toBeInTheDocument();
  });

  it('creates and links tasks straight into a phase', async () => {
    await renderProjectTab('Plan');
    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });

    fireEvent.click(within(discovery).getByRole('button', { name: 'Add task' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add task' }))
      .getByRole('menuitem', { name: 'Create new task' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Create task' }))
      .getByRole('button', { name: 'Confirm new task' }));

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'assign_tasks',
        taskIds: ['task-new'],
        toPhaseId: 'phase-discovery',
        toIndex: 1,
      });
    });

    fireEvent.click(within(phaseRegion('Discovery')).getByRole('button', { name: 'Add task' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link existing task' }));
    const picker = await screen.findByRole('dialog', { name: 'Add tasks to Discovery' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Confirm linked tasks' }));

    await waitFor(() => {
      expect(harness.hierarchyCommands()).toContainEqual({
        type: 'assign_tasks',
        taskIds: ['task-linked'],
        toPhaseId: 'phase-discovery',
        toIndex: 2,
      });
    });
  });

  it('offers an add-task entry point for an empty phase', async () => {
    harness = installProjectPageHarness({
      project: { name: 'Plan Project' },
      phases: [makePhase('phase-discovery', { name: 'Discovery' })],
      phaseItems: { 'phase-discovery': [] },
      tasks: [],
    });
    await renderProjectTab('Plan');

    const discovery = await screen.findByRole('region', { name: 'Discovery phase' });
    expect(within(discovery).getByText('No tasks in this phase yet.')).toBeInTheDocument();

    fireEvent.click(within(discovery).getByRole('button', { name: 'Add task' }));
    expect(screen.getByRole('menu', { name: 'Add task' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Create new task' })).toHaveFocus();
  });
});
