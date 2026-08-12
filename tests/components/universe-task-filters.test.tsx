import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  UniverseFilterPanel,
} from '@/components/graph/universe/UniverseTaskFilters';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { UniverseSidebarFilters } from '@/components/graph/universe/UniverseSidebarFilters';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  countTaskFilters,
  normalizeTaskFilterContext,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { getLocalToday } from '@/lib/utils/client-date';

const options = {
  sources: [
    { type: 'github-issues', name: 'GitHub', icon: '' },
    { type: 'local', name: 'Local', icon: '' },
  ],
  sourceLists: [{
    id: 'source-list-1',
    sourceId: 'repo',
    connectorInstanceId: 'work',
    name: 'Repository',
    taskCount: 4,
    groupId: 'group-work',
    connectorType: 'github-issues',
  }, {
    id: 'source-list-2',
    sourceId: 'repo',
    connectorInstanceId: 'personal',
    name: 'Personal Repository',
    taskCount: 2,
    groupId: null,
    connectorType: 'local',
  }],
  listGroups: [{
    id: 'group-work',
    name: 'Work',
    icon: null,
    iconColor: null,
    sortOrder: 0,
    createdAt: '2026-08-01',
  }],
  tags: [{
    id: 'tag-graph',
    name: 'Graph',
    slug: 'graph',
    type: 'hub',
    color: null,
  }],
  projects: [{
    id: 'project-graph',
    name: 'Graph project',
    color: '#3b82f6',
    icon: null,
  }],
  assignees: ['alice'],
  savedViews: [{
    id: 'saved-graph',
    name: 'Graph work',
    icon: 'pin',
    filters: { priorities: 'critical', query: 'assignee:alice' },
  }],
  loading: false,
  error: null,
  retry: vi.fn(),
};

function Harness() {
  const [context, setContext] = useState<TaskFilterContext>(EMPTY_TASK_FILTER_CONTEXT);
  const [panelOpen, setPanelOpen] = useState(true);
  const update = (patch: Partial<Omit<TaskFilterContext, 'version'>>) => {
    setContext((current) => updateTaskFilterContext(current, patch));
  };
  const clear = () => setContext(EMPTY_TASK_FILTER_CONTEXT);
  return (
    <>
      <TaskKeywordFilter
        filteredCount={7}
        sources={options.sources}
        sourceLists={options.sourceLists}
        tags={options.tags}
        assignees={options.assignees}
        projects={options.projects}
        listGroups={options.listGroups}
        controller={{
          context,
          setContext: (next) => setContext(normalizeTaskFilterContext(next)),
          clear,
        }}
        onOpenFilters={() => setPanelOpen(true)}
      />
      <UniverseFilterPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        context={context}
        activeFilterCount={countTaskFilters(context)}
        filteredTaskCount={7}
        update={update}
        setContext={(next) => setContext(normalizeTaskFilterContext(next))}
        clear={clear}
        options={options}
      />
    </>
  );
}

function SidebarHarness() {
  const [context, setContext] = useState<TaskFilterContext>(EMPTY_TASK_FILTER_CONTEXT);
  const update = (patch: Partial<Omit<TaskFilterContext, 'version'>>) => {
    setContext((current) => updateTaskFilterContext(current, patch));
  };
  return (
    <>
      <UniverseSidebarFilters
        context={context}
        update={update}
        setContext={(next) => setContext(normalizeTaskFilterContext(next))}
        options={options}
        filteredTaskCount={7}
      />
      <output data-testid="sidebar-context">{JSON.stringify(context)}</output>
    </>
  );
}

function MobileSourceHarness() {
  const [context, setContext] = useState(() => normalizeTaskFilterContext({
    sources: ['github-issues', 'local'],
    listIds: ['work:repo', 'personal:repo'],
  }));
  const update = (patch: Partial<Omit<TaskFilterContext, 'version'>>) => {
    setContext((current) => updateTaskFilterContext(current, patch));
  };
  return (
    <>
      <UniverseFilterPanel
        open
        onClose={() => {}}
        context={context}
        activeFilterCount={countTaskFilters(context)}
        filteredTaskCount={2}
        update={update}
        setContext={setContext}
        clear={() => setContext(EMPTY_TASK_FILTER_CONTEXT)}
        options={options}
      />
      <output data-testid="mobile-source-context">{JSON.stringify(context)}</output>
    </>
  );
}

describe('Universe task filter surfaces', () => {
  it('synchronizes panel choices, toolbar chips, individual removal, query editing, and clear all', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'P1' }));
    expect(screen.getByText(/priority:.*high/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task filters' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove priority:.*high filter/i }));
    expect(screen.queryByText(/priority:.*high/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', {
      name: 'Filter tasks by keyword',
    }), { target: { value: 'assignee:alice due:today' } });
    await waitFor(() => {
      expect(screen.getByText('assignee:alice')).toBeInTheDocument();
      expect(screen.getByText('due:today')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(screen.queryByText('assignee:alice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task filters' })).toBeInTheDocument();
  });

  it('applies saved views without mutating them and closes the drawer with Escape', () => {
    const onClose = vi.fn();
    const setContext = vi.fn();
    render(
      <UniverseFilterPanel
        open
        onClose={onClose}
        context={EMPTY_TASK_FILTER_CONTEXT}
        activeFilterCount={0}
        filteredTaskCount={null}
        update={vi.fn()}
        setContext={setContext}
        clear={vi.fn()}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Graph work' }));
    expect(setContext).toHaveBeenCalledWith(
      expect.objectContaining({ priorities: ['critical'], query: 'assignee:alice' }),
      'push',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses the shared dashboard sidebar to update canonical Universe filters', () => {
    render(<SidebarHarness />);

    expect(screen.getByRole('complementary', { name: 'Task filters' })).toBeInTheDocument();
    const githubButton = screen.getByRole('button', { name: /GitHub/ });
    expect(githubButton.tagName).toBe('BUTTON');
    fireEvent.click(githubButton);
    fireEvent.click(screen.getByRole('button', { name: /P1 high/i }));

    expect(screen.getByTestId('sidebar-context')).toHaveTextContent('"sources":["github-issues"]');
    expect(screen.getByTestId('sidebar-context')).toHaveTextContent('"priorities":["high"]');
  });

  it('keeps canonical multi-value filters out of the controlled query', async () => {
    function MultiValueHarness() {
      const [context, setContext] = useState(() => normalizeTaskFilterContext({
        sources: ['github-issues', 'local'],
        listIds: ['work:repo', 'personal:repo'],
        query: 'due:today',
      }));
      return (
        <>
          <TaskKeywordFilter
            filteredCount={2}
            sources={options.sources}
            sourceLists={options.sourceLists}
            tags={options.tags}
            assignees={options.assignees}
            projects={options.projects}
            listGroups={options.listGroups}
            controller={{ context, setContext }}
          />
          <output data-testid="multi-context">{JSON.stringify(context)}</output>
        </>
      );
    }

    render(<MultiValueHarness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter tasks by keyword' }), {
      target: { value: 'due:week' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('multi-context')).toHaveTextContent(
        '"query":"due:today due:week"',
      );
    });
    expect(screen.getByTestId('multi-context')).toHaveTextContent(
      '"sources":["github-issues","local"]',
    );
    expect(screen.getByTestId('multi-context')).not.toHaveTextContent('source:github-issues');

    fireEvent.click(screen.getByRole('button', {
      name: 'Remove source:github-issues filter',
    }));
    expect(screen.getByTestId('multi-context')).toHaveTextContent('"sources":["local"]');
    expect(screen.getByTestId('multi-context')).toHaveTextContent(
      '"listIds":["personal:repo"]',
    );
    expect(screen.getByTestId('multi-context')).toHaveTextContent(
      '"query":"due:today due:week"',
    );
  });

  it('resolves a list against the source selected in the same sidebar interaction', () => {
    render(<SidebarHarness />);

    fireEvent.click(screen.getByText('Local'));
    fireEvent.click(screen.getByText('Personal Repository'));

    expect(screen.getByTestId('sidebar-context')).toHaveTextContent('"sources":["local"]');
    expect(screen.getByTestId('sidebar-context')).toHaveTextContent(
      '"listIds":["personal:repo"]',
    );
  });

  it('prunes incompatible list filters when a source is removed in the mobile panel', () => {
    render(<MobileSourceHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));

    expect(screen.getByTestId('mobile-source-context')).toHaveTextContent(
      '"sources":["local"]',
    );
    expect(screen.getByTestId('mobile-source-context')).toHaveTextContent(
      '"listIds":["personal:repo"]',
    );
  });

  it('applies complete My Day semantics from the shared desktop sidebar', () => {
    render(<SidebarHarness />);

    fireEvent.click(screen.getByRole('button', { name: /My Day/ }));

    expect(screen.getByTestId('sidebar-context')).toHaveTextContent('"quickFilter":"myDay"');
    expect(screen.getByTestId('sidebar-context')).toHaveTextContent(
      `"myDayDate":"${getLocalToday()}"`,
    );
    expect(screen.getByTestId('sidebar-context')).toHaveTextContent('"completion":"all"');
  });

  it('surfaces desktop option-load failures with retry', () => {
    const retry = vi.fn();
    render(
      <UniverseSidebarFilters
        context={EMPTY_TASK_FILTER_CONTEXT}
        update={vi.fn()}
        setContext={vi.fn()}
        options={{ ...options, error: 'Filter options failed', retry }}
        filteredTaskCount={null}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Filter options failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
