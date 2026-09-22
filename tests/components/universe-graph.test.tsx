import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UniverseGraph from '@/components/graph/universe/UniverseGraph';
import {
  DEFAULT_UNIVERSE_DIMENSIONS,
  type UniverseEdge,
  type UniverseNode,
  type UniverseSubgraph,
} from '@/lib/graph/universe-types';
import { useUniverseGraphStore } from '@/lib/stores/universeGraphStore';
import { serializeTaskFilterContext } from '@/lib/task-filter-context';

const navigation = vi.hoisted(() => ({
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/graph/universe',
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
  }),
}));

type ForceGraphProps = {
  graphData: { nodes: UniverseNode[]; links: UniverseEdge[] };
  nodeCanvasObject: (
    node: UniverseNode,
    context: CanvasRenderingContext2D,
    scale: number,
  ) => void;
  nodeVisibility: (node: UniverseNode) => boolean;
  linkColor: (link: UniverseEdge) => string;
  linkWidth: (link: UniverseEdge) => number;
  d3AlphaDecay: number;
  d3VelocityDecay: number;
  warmupTicks: number;
  cooldownTicks: number;
  width: number;
  height: number;
  onEngineTick: () => void;
  onEngineStop: () => void;
  onNodeClick: (node: UniverseNode, event: MouseEvent) => void;
  onNodeHover: (node: UniverseNode | null) => void;
  onBackgroundClick: () => void;
  onZoom: (transform: { k: number; x: number; y: number }) => void;
};

const graphMocks = vi.hoisted(() => ({
  props: null as ForceGraphProps | null,
  centerAt: vi.fn(),
  d3Force: vi.fn(),
  d3ReheatSimulation: vi.fn(),
  getGraphBbox: vi.fn(() => ({ x: [0, 100] as [number, number], y: [0, 100] as [number, number] })),
  zoom: vi.fn(),
  graph2ScreenCoords: vi.fn(() => ({ x: 100, y: 100 })),
  zoomToFit: vi.fn(),
}));

vi.mock('react-force-graph-2d', async () => {
  const ReactModule = await import('react');
  return {
    default: ReactModule.forwardRef(function MockForceGraph(
      props: ForceGraphProps,
      ref: React.ForwardedRef<{
        centerAt: typeof graphMocks.centerAt;
        d3Force: typeof graphMocks.d3Force;
        d3ReheatSimulation: typeof graphMocks.d3ReheatSimulation;
        getGraphBbox: typeof graphMocks.getGraphBbox;
        zoom: typeof graphMocks.zoom;
        graph2ScreenCoords: typeof graphMocks.graph2ScreenCoords;
        zoomToFit: typeof graphMocks.zoomToFit;
      }>,
    ) {
      graphMocks.props = props;
      ReactModule.useImperativeHandle(ref, () => ({
        centerAt: graphMocks.centerAt,
        d3Force: graphMocks.d3Force,
        d3ReheatSimulation: graphMocks.d3ReheatSimulation,
        getGraphBbox: graphMocks.getGraphBbox,
        zoom: graphMocks.zoom,
        graph2ScreenCoords: graphMocks.graph2ScreenCoords,
        zoomToFit: graphMocks.zoomToFit,
      }));
      return <div>Canvas renderer</div>;
    }),
  };
});

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div>
      Task details for {taskId}
      <button type="button" onClick={onClose}>Close task details</button>
    </div>
  ),
}));

const graph: UniverseSubgraph = {
  nodes: [
    {
      id: 'task:task-1',
      entityId: 'task-1',
      kind: 'task',
      label: 'Refactor auth middleware',
      color: '#e2e8f0',
      status: 'in_progress',
      x: 10,
      y: 10,
    },
    {
      id: 'tag:backend',
      entityId: 'backend',
      kind: 'tag',
      dimension: 'tags',
      value: 'backend',
      label: 'Backend',
      color: '#22c55e',
      taskCount: 1,
      x: 50,
      y: 50,
    },
    {
      id: 'task:task-2',
      entityId: 'task-2',
      kind: 'task',
      label: 'Write release notes',
      color: '#e2e8f0',
      status: 'todo',
      x: 90,
      y: 90,
    },
  ],
  edges: [{
    id: 'has-tag:task:task-1:tag:backend',
    source: 'task:task-1',
    target: 'tag:backend',
    type: 'has-tag',
    provenance: 'derived',
    dimension: 'tags',
  }],
  stats: { taskCount: 2, filteredTaskCount: 2, attributeCount: 1 },
  facets: { priorities: [], statuses: ['in_progress'], sources: [], lists: [] },
  pageInfo: {
    nodeLimit: 180,
    edgeLimit: 720,
    returnedNodes: 2,
    returnedEdges: 1,
    truncated: true,
    truncationReasons: ['node-limit'],
  },
  truncated: true,
};

function jsonGraph() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ graph }),
  });
}

let graphResponse: () => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}> = jsonGraph;
type MockJsonResponse = Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;
let canvasWidth = 900;

let neighborResponse: (
  input?: RequestInfo | URL,
  init?: RequestInit,
) => MockJsonResponse = () => Promise.resolve({
  ok: true,
  json: async () => ({
    graph: {
      nodes: [
        {
          id: 'task:task-1',
          entityId: 'task-1',
          kind: 'task',
          label: 'Refactor auth middleware',
          status: 'in_progress',
        },
        {
          id: 'task:task-3',
          entityId: 'task-3',
          kind: 'task',
          label: 'Add audit logging',
          status: 'todo',
        },
      ],
      edges: [{
        id: 'dependency:task-1-task-3',
        source: 'task:task-1',
        target: 'task:task-3',
        type: 'related',
        provenance: 'explicit',
      }],
      pageInfo: {
        nodeLimit: 80,
        edgeLimit: 240,
        returnedNodes: 2,
        returnedEdges: 1,
        truncated: false,
        truncationReasons: [],
      },
      truncated: false,
    },
  }),
});

function mockFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  if (url.startsWith('/api/graph/universe')) return graphResponse();
  if (url.startsWith('/api/graph/nodes/')) return neighborResponse(input, init);
  return Promise.resolve({
    ok: true,
    json: async () => {
      if (url === '/api/features') return { enabledSources: [] };
      if (url === '/api/connectors') return { sourceLists: [] };
      if (url === '/api/list-groups') return { groups: [] };
      if (url === '/api/tags') return { tags: [] };
      if (url === '/api/hub-projects') return { projects: [] };
      return { assignees: [] };
    },
  });
}

function renderedNodeIds(): string[] {
  const props = graphMocks.props;
  if (!props) return [];
  return props.graphData.nodes.filter(props.nodeVisibility).map((node) => node.id);
}

async function renderOverview() {
  render(<UniverseGraph />);
  fireEvent.click(screen.getByRole('button', { name: 'Explore all tasks' }));
  await waitFor(() => expect(screen.getByText('Canvas renderer')).toBeInTheDocument());
}

describe('UniverseGraph', () => {
  beforeEach(() => {
    graphMocks.props = null;
    graphMocks.centerAt.mockReset();
    graphMocks.d3Force.mockReset();
    graphMocks.d3ReheatSimulation.mockReset();
    graphMocks.getGraphBbox.mockClear();
    graphMocks.zoom.mockReset();
    graphMocks.graph2ScreenCoords.mockReset();
    graphMocks.graph2ScreenCoords.mockReturnValue({ x: 100, y: 100 });
    graphMocks.zoomToFit.mockReset();
    canvasWidth = 900;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => canvasWidth);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(620);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    graphResponse = jsonGraph;
    neighborResponse = () => Promise.resolve({
      ok: true,
      json: async () => ({
        graph: {
          nodes: [
            {
              id: 'task:task-1',
              entityId: 'task-1',
              kind: 'task',
              label: 'Refactor auth middleware',
              status: 'in_progress',
            },
            {
              id: 'task:task-3',
              entityId: 'task-3',
              kind: 'task',
              label: 'Add audit logging',
              status: 'todo',
            },
          ],
          edges: [{
            id: 'dependency:task-1-task-3',
            source: 'task:task-1',
            target: 'task:task-3',
            type: 'related',
            provenance: 'explicit',
          }],
          pageInfo: {
            nodeLimit: 80,
            edgeLimit: 240,
            returnedNodes: 2,
            returnedEdges: 1,
            truncated: false,
            truncationReasons: [],
          },
          truncated: false,
        },
      }),
    });
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
    useUniverseGraphStore.setState({
      dimensions: [...DEFAULT_UNIVERSE_DIMENSIONS],
      neighborLayers: ['explicit', 'derived'],
      legacyFilters: null,
      selectedNodeIds: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders task dots and attribute pills without converting close tasks to cards', async () => {
    await renderOverview();
    const props = graphMocks.props;
    expect(props).not.toBeNull();
    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      restore: vi.fn(),
      roundRect: vi.fn(),
      save: vi.fn(),
      setLineDash: vi.fn(),
      stroke: vi.fn(),
      strokeText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    props?.nodeCanvasObject(props.graphData.nodes[0], context, 2);
    expect(context.arc).toHaveBeenCalled();
    expect(context.roundRect).not.toHaveBeenCalled();

    props?.nodeCanvasObject(props.graphData.nodes[1], context, 2);
    expect(context.roundRect).toHaveBeenCalled();
  });

  it('shows a clear initial state before loading an unfiltered universe', () => {
    render(<UniverseGraph />);

    expect(screen.getByRole('heading', { name: 'Choose a task universe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explore all tasks' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Find within rendered graph' })).toHaveAttribute(
      'title',
      expect.stringContaining('does not change the task universe'),
    );
  });

  it('renders safe contextual back navigation and reports dropped transferred criteria', () => {
    const serialized = serializeTaskFilterContext({
      version: 1,
      query: '',
      sources: [],
      listIds: [],
      listGroupId: null,
      tagSlugs: [],
      projectId: null,
      priorities: ['high'],
      statuses: [],
      quickFilter: null,
      myDayDate: null,
      completion: 'open',
      ageMinDays: null,
      ageMaxDays: null,
    }).replace('"high"', '"obsolete"');
    const params = new URLSearchParams({
      tf: serialized,
      from: '/today',
      fromLabel: 'My Day',
    });
    navigation.search = params.toString();

    render(<UniverseGraph />);

    expect(screen.getByRole('link', { name: /back to my day/i })).toHaveAttribute('href', '/today');
    expect(screen.getByText(/Dropped unsupported priorities: obsolete/)).toBeInTheDocument();
  });

  it('shows no-match and retryable error states', async () => {
    graphResponse = () => Promise.resolve({
      ok: true,
      json: async () => ({
        graph: {
          ...graph,
          nodes: [],
          edges: [],
          stats: { taskCount: 0, filteredTaskCount: 0, attributeCount: 0 },
          truncated: false,
        },
      }),
    });
    const { unmount } = render(<UniverseGraph />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore all tasks' }));
    await waitFor(() => expect(screen.getByText('No tasks match these filters.')).toBeInTheDocument());
    unmount();

    graphResponse = () => Promise.resolve({
      ok: false,
      json: async () => ({ error: 'Graph query failed' }),
    });
    render(<UniverseGraph />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore all tasks' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Graph query failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('opens task details directly while preserving selection context during hover', async () => {
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0];
    const otherTask = graphMocks.props?.graphData.nodes[2];
    const edge = graphMocks.props?.graphData.links[0];
    const graphData = graphMocks.props?.graphData;
    expect(task).toBeDefined();
    expect(otherTask).toBeDefined();
    expect(edge).toBeDefined();

    act(() => graphMocks.props?.onNodeHover(task ?? null));
    expect(graphMocks.props?.graphData).toBe(graphData);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Refactor auth middleware');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Backend');
    expect(graphMocks.props?.linkWidth(edge as UniverseEdge)).toBe(1.1);
    expect(graphMocks.props?.linkColor(edge as UniverseEdge)).toBe('#34d39980');

    const propsBeforePointerMove = graphMocks.props;
    const tooltipPosition = screen.getByRole('tooltip').getAttribute('style');
    fireEvent.pointerMove(screen.getByTestId('universe-canvas'), { clientX: 800, clientY: 600 });
    expect(graphMocks.props).toBe(propsBeforePointerMove);
    expect(screen.getByRole('tooltip')).toHaveAttribute('style', tooltipPosition);

    act(() => graphMocks.props?.onNodeClick(task as UniverseNode, { detail: 1 } as MouseEvent));
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open task details' })).not.toBeInTheDocument();

    act(() => graphMocks.props?.onNodeHover(otherTask ?? null));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Write release notes');
    expect(graphMocks.props?.linkWidth(edge as UniverseEdge)).toBe(1.8);
    expect(graphMocks.props?.linkColor(edge as UniverseEdge)).toBe('#34d399cc');

    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setLineDash: vi.fn(),
      stroke: vi.fn(),
      strokeText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    graphMocks.props?.nodeCanvasObject(otherTask as UniverseNode, context, 1);
    expect(context.setLineDash).toHaveBeenCalledWith([3, 2]);
    expect(context.globalAlpha).toBe(1);

    act(() => graphMocks.props?.onNodeHover(null));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    expect(screen.queryByText('Task details for task-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open task details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Open task Refactor auth middleware',
    })).toHaveAttribute('aria-current', 'true');
  });

  it('opens tasks on click and Enter from the accessible graph', async () => {
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;

    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    const accessibleTask = screen.getByRole('button', { name: 'Open task Refactor auth middleware' });
    fireEvent.click(accessibleTask);
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();
    expect(accessibleTask).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    accessibleTask.focus();
    fireEvent.click(accessibleTask, { detail: 0 });
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();
  });

  it('clears persistent selection when the graph background is clicked', async () => {
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;

    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();

    act(() => graphMocks.props?.onBackgroundClick());
    expect(screen.queryByText('Task details for task-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Open task Refactor auth middleware',
    })).not.toHaveAttribute('aria-current');

    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();

    act(() => graphMocks.props?.onBackgroundClick());
    expect(screen.queryByText('Task details for task-1')).not.toBeInTheDocument();
  });

  it('offers progressive reveal, a working viewport reset, and keyboard-accessible data', async () => {
    await renderOverview();
    const graphRequests = vi.mocked(fetch).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/graph/universe'));
    expect(graphRequests[0]).toContain('maxNodes=180');
    expect(screen.getByText('Showing an initial 180-node overview.')).toBeInTheDocument();
    expect(screen.getByText(/Accessible graph list/)).toBeInTheDocument();
    expect(graphMocks.props).toMatchObject({
      d3AlphaDecay: 0.04,
      d3VelocityDecay: 0.5,
      warmupTicks: 80,
      cooldownTicks: 100,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reveal more' }));
    await waitFor(() => expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/graph/universe')),
    ).toHaveLength(2));
    const updatedGraphRequests = vi.mocked(fetch).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/graph/universe'));
    expect(updatedGraphRequests[1]).toContain('maxNodes=300');

    act(() => graphMocks.props?.onEngineStop());
    expect(graphMocks.zoomToFit).toHaveBeenCalledWith(300, 56);
    graphMocks.zoomToFit.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Reset graph focus' }));
    expect(graphMocks.zoomToFit).toHaveBeenCalledWith(300, 56);

    const accessibleTask = screen.getByRole('button', { name: 'Open task Refactor auth middleware' });
    fireEvent.click(accessibleTask);
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();
  });

  it('groups graph growth separately from a reversible focus view', async () => {
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));

    const toolbar = screen.getByRole('toolbar', { name: /neighborhood actions/i });
    expect(toolbar).toHaveTextContent('1 selected');
    expect(screen.getByRole('group', { name: 'Grow graph' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Change view' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add connected' }));
    expect(toolbar).toHaveTextContent('2 selected');
    expect(useUniverseGraphStore.getState().selectedNodeIds).toEqual([
      'task:task-1',
      'tag:backend',
    ]);
    const canonicalGraphData = graphMocks.props?.graphData;
    const reheatCalls = graphMocks.d3ReheatSimulation.mock.calls.length;

    const focusButton = screen.getByRole('button', { name: 'Focus' });
    expect(focusButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(focusButton);
    expect(graphMocks.props?.graphData).toBe(canonicalGraphData);
    expect(graphMocks.d3ReheatSimulation).toHaveBeenCalledTimes(reheatCalls);
    expect(renderedNodeIds()).toEqual([
      'task:task-1',
      'tag:backend',
    ]);
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(renderedNodeIds()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'How neighborhood actions work' }));
    expect(screen.getByText(/fetches more graph data around the selection/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('toolbar', { name: /neighborhood actions/i })).not.toBeInTheDocument();
    expect(renderedNodeIds()).toHaveLength(3);
  });

  it('merges bounded neighbor expansion without duplicates and reports failures', async () => {
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    expect(await screen.findByText('Added 1 node and 1 connection.')).toBeInTheDocument();
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).toContain('task:task-3');
    expect(graphMocks.props?.graphData.nodes).toHaveLength(4);
    expect(renderedNodeIds()).toEqual([
      'task:task-1',
      'tag:backend',
      'task:task-3',
    ]);
    expect(graphMocks.props?.graphData.nodes[0]).toMatchObject({
      fx: expect.any(Number),
      fy: expect.any(Number),
    });
    act(() => graphMocks.props?.onEngineStop());
    expect(graphMocks.props?.graphData.nodes[0].fx).toBeUndefined();
    expect(graphMocks.props?.graphData.nodes[0].fy).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(renderedNodeIds()).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).not.toContain('task:task-3');
    expect(graphMocks.props?.graphData.links).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).toContain('task:task-3');
    fireEvent.click(screen.getByRole('button', { name: 'Attributes' }));
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).not.toContain('tag:backend');
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).toContain('task:task-1');
    fireEvent.click(screen.getByRole('button', { name: 'Attributes' }));
    expect(graphMocks.props?.graphData.nodes.map((node) => node.id)).toContain('tag:backend');
    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    expect(await screen.findByText('No additional neighbors were found.')).toBeInTheDocument();
    expect(graphMocks.props?.graphData.nodes).toHaveLength(4);

    neighborResponse = () => Promise.resolve({
      ok: false,
      json: async () => ({ error: 'Neighborhood unavailable' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Neighborhood unavailable');
  });

  it('expands attribute selections and retains partial multi-selection successes', async () => {
    await renderOverview();
    const tag = graphMocks.props?.graphData.nodes[1] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(tag, { detail: 1 } as MouseEvent));
    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    await screen.findByText('Added 1 node and 1 connection.');
    expect(vi.mocked(fetch).mock.calls.some(([url]) =>
      String(url).startsWith('/api/graph/nodes/tag%3Abackend/neighbors'))).toBe(true);

    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    fireEvent.click(screen.getByRole('button', { name: 'Add connected' }));
    const successResponse = neighborResponse;
    neighborResponse = (input, init) =>
      String(input).includes('tag%3Abackend')
        ? Promise.resolve({
            ok: false,
            json: async () => ({ error: 'Tag expansion failed' }),
          })
        : successResponse(input, init);

    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    expect(await screen.findByText(/1 selected node failed to expand/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports truncated expansion and fits selection in the reserved graph viewport by keyboard', async () => {
    neighborResponse = () => Promise.resolve({
      ok: true,
      json: async () => ({
        graph: {
          nodes: [{
            id: 'task:task-1',
            entityId: 'task-1',
            kind: 'task',
            label: 'Refactor auth middleware',
            status: 'in_progress',
          }],
          edges: [],
          pageInfo: {
            nodeLimit: 1,
            edgeLimit: 1,
            returnedNodes: 1,
            returnedEdges: 0,
            truncated: true,
            truncationReasons: ['node-limit'],
          },
          truncated: true,
        },
      }),
    });
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));

    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));
    expect(await screen.findByText('No additional neighbors were found; the neighborhood was bounded.'))
      .toBeInTheDocument();

    const fitButton = screen.getByRole('button', { name: 'Fit' });
    fitButton.focus();
    fireEvent.click(fitButton, { detail: 0 });
    expect(graphMocks.getGraphBbox).toHaveBeenCalled();
    expect(graphMocks.zoom).toHaveBeenCalledWith(expect.any(Number), 300);
    expect(graphMocks.centerAt).toHaveBeenLastCalledWith(50, 50, 300);
  });

  it('discards an in-flight expansion when dimensions load a new canonical graph', async () => {
    let expansionSignal: AbortSignal | null = null;
    const deferred: {
      resolve?: (response: {
        ok: boolean;
        json: () => Promise<unknown>;
      }) => void;
    } = {};
    neighborResponse = (_input, init) => {
      expansionSignal = init?.signal ?? null;
      return new Promise((resolve) => {
        deferred.resolve = resolve;
      });
    };
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    fireEvent.click(screen.getByRole('button', { name: 'Load neighbors' }));

    const statusDimension = screen.getAllByRole('button', { name: 'Status' })
      .find((button) => button.hasAttribute('aria-pressed'));
    if (!statusDimension) throw new Error('Status dimension toggle not found');
    fireEvent.click(statusDimension);
    await waitFor(() => expect(expansionSignal?.aborted).toBe(true));
    if (!deferred.resolve) throw new Error('Expansion resolver was not initialized');
    deferred.resolve({
      ok: true,
      json: async () => ({
        graph: {
          nodes: [{
            id: 'task:stale',
            entityId: 'stale',
            kind: 'task',
            label: 'Stale result',
            status: 'todo',
          }],
          edges: [],
          pageInfo: {
            nodeLimit: 80,
            edgeLimit: 240,
            returnedNodes: 1,
            returnedEdges: 0,
            truncated: false,
            truncationReasons: [],
          },
          truncated: false,
        },
      }),
    });

    await waitFor(() => expect(
      graphMocks.props?.graphData.nodes.some((node) => node.id === 'task:stale'),
    ).toBe(false));
  });

  it('closes an obstructing detail overlay before fitting on a narrow viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    await renderOverview();
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;
    act(() => graphMocks.props?.onNodeClick(task, { detail: 1 } as MouseEvent));
    expect(screen.getByText('Task details for task-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));

    expect(screen.queryByText('Task details for task-1')).not.toBeInTheDocument();
    expect(screen.getByText('Details closed to fit the selection in the available viewport.'))
      .toBeInTheDocument();
    expect(graphMocks.centerAt).toHaveBeenCalledWith(50, 50, 300);
  });

  it('keeps initial auto-fit subordinate to user viewport gestures', async () => {
    await renderOverview();
    const canvas = screen.getByTestId('universe-canvas');

    fireEvent.pointerDown(canvas);
    act(() => graphMocks.props?.onZoom({ k: 1.5, x: 12, y: 18 }));
    fireEvent.pointerUp(canvas);
    act(() => graphMocks.props?.onEngineStop());
    expect(graphMocks.zoomToFit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset graph focus' }));
    expect(graphMocks.zoomToFit).toHaveBeenCalledWith(300, 56);
  });

  it('treats double-click zoom as user-owned viewport interaction', async () => {
    await renderOverview();
    const canvas = screen.getByTestId('universe-canvas');

    fireEvent.doubleClick(canvas);
    act(() => graphMocks.props?.onZoom({ k: 1.5, x: 12, y: 18 }));
    act(() => graphMocks.props?.onEngineStop());

    expect(graphMocks.zoomToFit).not.toHaveBeenCalled();
  });

  it('anchors the tooltip inside the usable graph viewport', async () => {
    graphMocks.graph2ScreenCoords.mockReturnValue({ x: 895, y: 615 });
    await renderOverview();

    act(() => graphMocks.props?.onNodeHover(graphMocks.props?.graphData.nodes[0] ?? null));

    expect(screen.getByRole('tooltip')).toHaveStyle({
      left: '593px',
      top: '436px',
    });
    expect(screen.getByRole('tooltip')).toHaveClass('pointer-events-none');
  });

  it('reserves graph space for either detail panel without reheating the simulation', async () => {
    await renderOverview();
    const initialReheatCount = graphMocks.d3ReheatSimulation.mock.calls.length;
    expect(graphMocks.props?.width).toBe(900);
    const task = graphMocks.props?.graphData.nodes[0] as UniverseNode;

    act(() => graphMocks.props?.onNodeClick(
      task,
      { detail: 1 } as MouseEvent,
    ));
    expect(graphMocks.props?.width).toBe(510);
    expect(graphMocks.centerAt).toHaveBeenCalledWith(task.x, task.y, 300);
    expect(screen.getByRole('button', { name: 'Reset graph focus' })).toHaveStyle({ right: '402px' });

    graphMocks.zoomToFit.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reset graph focus' }));
    expect(graphMocks.props?.width).toBe(900);
    expect(graphMocks.zoomToFit).toHaveBeenCalledWith(300, 56);

    const attribute = graphMocks.props?.graphData.nodes[1] as UniverseNode;
    fireEvent.click(screen.getByRole('button', { name: /Backend.*1 connected/ }));
    expect(graphMocks.props?.width).toBe(560);
    expect(graphMocks.centerAt).toHaveBeenLastCalledWith(attribute.x, attribute.y, 300);
    expect(screen.getByRole('button', { name: 'Reset graph focus' })).toHaveStyle({ right: '352px' });

    const fitCountAfterReset = graphMocks.zoomToFit.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Close node details' }));
    expect(graphMocks.props?.width).toBe(900);
    expect(graphMocks.zoomToFit).toHaveBeenCalledTimes(fitCountAfterReset);
    expect(graphMocks.d3ReheatSimulation).toHaveBeenCalledTimes(initialReheatCount);
  });

  it('uses the full narrow viewport for a detail panel and restores the graph on close', async () => {
    canvasWidth = 500;
    await renderOverview();
    expect(graphMocks.props?.width).toBe(500);

    act(() => graphMocks.props?.onNodeClick(
      graphMocks.props?.graphData.nodes[0] as UniverseNode,
      { detail: 1 } as MouseEvent,
    ));
    expect(graphMocks.props?.width).toBe(1);
    expect(screen.getByText('Task details for task-1').parentElement).toHaveStyle({
      width: '500px',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    expect(graphMocks.props?.width).toBe(500);
  });
});
