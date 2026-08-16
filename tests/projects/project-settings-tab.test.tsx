import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_PRESETS } from '@/lib/constants/colors';
import {
  installProjectPageHarness,
  makeRuleMatch,
  navigationState,
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

const PROJECT_PATCHES = '/api/hub-projects/project-1';

function settingsScenario(overrides: Parameters<typeof installProjectPageHarness>[0] = {}) {
  const { project, ...rest } = overrides;
  return installProjectPageHarness({
    phases: [],
    tasks: [],
    categories: ['Work', 'Personal'],
    ...rest,
    project: {
      name: 'Settings Project',
      description: 'Original description',
      category: 'Work',
      targetDate: '2027-05-04',
      ...project,
    },
  });
}

function patchBodies(harness: ProjectPageHarness) {
  return harness.requestsFor(PROJECT_PATCHES, 'PATCH').map((request) => request.body);
}

function autoIncludeCard() {
  return screen.getByRole('heading', { name: 'Auto-Include Rules' })
    .closest('div')!.parentElement!;
}

describe('project settings tab', () => {
  let harness: ProjectPageHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = settingsScenario();
  });

  it('saves general project fields with the exact patch payloads', async () => {
    await renderProjectTab('Settings');

    const name = await screen.findByDisplayValue('Settings Project');
    fireEvent.blur(name, { target: { value: '  Renamed Project  ' } });
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ name: 'Renamed Project' });
    });

    const description = screen.getByPlaceholderText('What is this project about?');
    fireEvent.blur(description, { target: { value: 'Updated description' } });
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ description: 'Updated description' });
    });

    fireEvent.click(screen.getByRole('button', { name: `Select ${COLOR_PRESETS[1]} color` }));
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({
        color: COLOR_PRESETS[1],
        iconColor: COLOR_PRESETS[1],
      });
    });
  });

  it('does not re-save unchanged general fields', async () => {
    await renderProjectTab('Settings');

    const name = await screen.findByDisplayValue('Settings Project');
    fireEvent.blur(name, { target: { value: 'Settings Project' } });
    fireEvent.click(screen.getByRole('button', { name: `Select ${COLOR_PRESETS[0]} color` }));

    await waitFor(() => expect(screen.getByDisplayValue('Settings Project')).toBeInTheDocument());
    expect(harness.requestsFor(PROJECT_PATCHES, 'PATCH')).toHaveLength(0);
  });

  it('saves lifecycle status, category, and target date changes', async () => {
    await renderProjectTab('Settings');
    await screen.findByRole('heading', { name: 'Project Status' });

    const status = screen.getAllByRole('combobox')
      .find((element) => element.textContent?.trim() === 'Active')!;
    fireEvent.click(status);
    fireEvent.click(screen.getByRole('option', { name: 'On hold' }));
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ statusOverride: 'on_hold' });
    });

    const category = screen.getByPlaceholderText('e.g. Personal, Work');
    fireEvent.blur(category, { target: { value: 'Personal' } });
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ category: 'Personal' });
    });

    const targetDate = document.querySelector<HTMLInputElement>('input[type="date"]')!;
    fireEvent.blur(targetDate, { target: { value: '2027-09-09' } });
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ targetDate: '2027-09-09' });
    });
  });

  it('keeps sync-managed fields read-only and explains why', async () => {
    harness = settingsScenario({ project: { metadata: { syncManaged: true } } });
    await renderProjectTab('Settings');

    expect(await screen.findByDisplayValue('Settings Project')).toBeDisabled();
    expect(screen.getByPlaceholderText('What is this project about?')).toBeDisabled();
    expect(screen.getAllByText('Managed by GitHub sync')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });

  it('describes source bindings and warns when a required target list is missing', async () => {
    harness = settingsScenario({
      project: {
        sourceBindings: [
          { connectorInstanceId: 'todo-work', sourceListId: null, filter: null },
          { connectorInstanceId: 'todo-personal', sourceListId: 'list-1', filter: 'label:mc' },
        ] as never,
      },
      taskDestinations: [
        { id: 'todo-work', type: 'microsoft-todo', name: 'Work To Do', listSelectionMode: 'required' },
        { id: 'todo-personal', type: 'microsoft-todo', name: 'Personal To Do', listSelectionMode: 'optional' },
      ],
    });
    await renderProjectTab('Settings');

    expect(await screen.findByText('todo-work')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/No default list set/)).toBeInTheDocument();
    });
    expect(screen.getByText('Source list: All lists')).toBeInTheDocument();
    expect(screen.getByText('Source list: list-1')).toBeInTheDocument();
    expect(screen.getByText('Filter: label:mc')).toBeInTheDocument();
  });

  it('reports when a project has no source bindings', async () => {
    await renderProjectTab('Settings');

    expect(await screen.findByText('No source bindings configured for this project.'))
      .toBeInTheDocument();
  });

  it('adds a rule locally and only saves it once it has a value', async () => {
    await renderProjectTab('Settings');
    await screen.findByRole('heading', { name: 'Auto-Include Rules' });

    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));

    const ruleValue = await screen.findByPlaceholderText('e.g. di-mc-integration');
    expect(harness.requestsFor(PROJECT_PATCHES, 'PATCH')).toHaveLength(0);

    fireEvent.blur(ruleValue, { target: { value: 'design' } });

    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({
        autoIncludeRules: [{ type: 'tag', value: 'design' }],
      });
    });
    expect(harness.requestsFor('/rule-matches').length).toBeGreaterThan(1);
  });

  it('removes an existing rule and reloads the qualifying preview', async () => {
    harness = settingsScenario({
      project: {
        autoIncludeRules: [
          { type: 'tag', value: 'design' },
          { type: 'title_contains', value: 'Phase 0' },
        ],
      },
    });
    await renderProjectTab('Settings');

    const card = autoIncludeCard();
    await waitFor(() => {
      expect(within(card).getAllByRole('button', { name: 'Remove rule' })).toHaveLength(2);
    });
    fireEvent.click(within(card).getAllByRole('button', { name: 'Remove rule' })[0]);

    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({
        autoIncludeRules: [{ type: 'title_contains', value: 'Phase 0' }],
      });
    });
  });

  it('previews qualifying and excluded tasks and restores an excluded task', async () => {
    harness = settingsScenario({
      project: { autoIncludeRules: [{ type: 'tag', value: 'design' }] },
      ruleMatches: [
        makeRuleMatch('task-included', { title: 'Included task', alreadyAssigned: true }),
        makeRuleMatch('task-pending', { title: 'Pending task' }),
        makeRuleMatch('task-excluded', {
          title: 'Excluded task',
          excluded: true,
          excludedAt: '2026-08-10T00:00:00.000Z',
        }),
      ],
    });
    await renderProjectTab('Settings');

    expect(await screen.findByText('Qualifying tasks (3)')).toBeInTheDocument();
    expect(screen.getByText('Included')).toBeInTheDocument();
    expect(screen.getByText('Not added')).toBeInTheDocument();
    expect(screen.getByText('Excluded from auto-include (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(harness.requestsFor('/api/hub-projects/project-1/tasks', 'POST')).toContainEqual(
        expect.objectContaining({ body: { taskId: 'task-excluded' } }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry include' }));
    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({
        autoIncludeRules: [{ type: 'tag', value: 'design' }],
      });
    });
  });

  it('reports an empty and a failing qualifying-task preview', async () => {
    await renderProjectTab('Settings');

    expect(await screen.findByText('No tasks currently match these rules.')).toBeInTheDocument();

    harness.failOnce('/rule-matches', { error: 'Rule preview unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh qualifying tasks' }));

    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Rule preview unavailable' });
    });
  });

  it('confirms hiding a project and returns to the project list', async () => {
    await renderProjectTab('Settings');

    fireEvent.click(await screen.findByRole('button', { name: 'Hide project' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/unhide it from All Projects/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide project' }));

    await waitFor(() => {
      expect(patchBodies(harness)).toContainEqual({ hidden: true });
    });
    await waitFor(() => expect(navigationState.push).toHaveBeenCalledWith('/projects'));
  });

  it('confirms deleting a project and keeps the page when the request fails', async () => {
    harness.fail(PROJECT_PATCHES, { method: 'DELETE', error: 'Delete blocked' });
    await renderProjectTab('Settings');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/This cannot be undone/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    await waitFor(() => {
      expect(harness.requestsFor(PROJECT_PATCHES, 'DELETE')).toHaveLength(1);
    });
    expect(navigationState.push).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Failed to delete project' });
    });
  });

  it('surfaces a failed field save without dropping the edited value', async () => {
    harness.fail(PROJECT_PATCHES, { method: 'PATCH', error: 'Name rejected' });
    await renderProjectTab('Settings');

    const name = await screen.findByDisplayValue('Settings Project');
    fireEvent.blur(name, { target: { value: 'Rejected name' } });

    await waitFor(() => {
      expect(toasts).toContainEqual({ level: 'error', message: 'Failed to update name' });
    });
    expect(screen.getByDisplayValue('Rejected name')).toBeInTheDocument();
  });
});
