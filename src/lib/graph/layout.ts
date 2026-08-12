import type { GraphNodeKind, ProjectSubgraph } from './types';

export const GRAPH_NODE_DIMENSIONS: Record<GraphNodeKind, { width: number; height: number }> = {
  project: { width: 240, height: 96 },
  phase: { width: 220, height: 86 },
  task: { width: 210, height: 76 },
};

export type GraphLayoutDirection = 'horizontal' | 'vertical';

const MARGIN = 36;
const RANK_GAP = 80;
const CLUSTER_GAP = 48;
const TASK_COLUMN_GAP = 24;
const TASK_ROW_GAP = 18;

interface TaskCluster {
  phaseId: string | null;
  taskIds: string[];
  columns: number;
  width: number;
  height: number;
}

function taskColumnCount(taskCount: number) {
  if (taskCount <= 1) return 1;
  return taskCount <= 6 ? 2 : 3;
}

function createTaskCluster(phaseId: string | null, taskIds: string[]): TaskCluster {
  const columns = taskColumnCount(taskIds.length);
  const rows = Math.ceil(taskIds.length / columns);
  return {
    phaseId,
    taskIds,
    columns,
    width: taskIds.length === 0
      ? GRAPH_NODE_DIMENSIONS.phase.width
      : columns * GRAPH_NODE_DIMENSIONS.task.width + (columns - 1) * TASK_COLUMN_GAP,
    height: rows === 0
      ? GRAPH_NODE_DIMENSIONS.phase.height
      : rows * GRAPH_NODE_DIMENSIONS.task.height + (rows - 1) * TASK_ROW_GAP,
  };
}

function getTaskClusters(graph: ProjectSubgraph) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const phases = graph.nodes.filter((node) => node.kind === 'phase');
  const tasks = graph.nodes.filter((node) => node.kind === 'task');
  const tasksByPhase = new Map(phases.map((phase) => [phase.id, [] as string[]]));
  const assignedTaskIds = new Set<string>();

  for (const edge of graph.edges) {
    if (
      edge.type === 'contains'
      && nodesById.get(edge.source)?.kind === 'phase'
      && nodesById.get(edge.target)?.kind === 'task'
      && tasksByPhase.has(edge.source)
    ) {
      tasksByPhase.get(edge.source)?.push(edge.target);
      assignedTaskIds.add(edge.target);
    }
  }

  const clusters = phases.map((phase) => createTaskCluster(
    phase.id,
    tasksByPhase.get(phase.id) ?? [],
  ));
  const unassignedTaskIds = tasks
    .filter((task) => !assignedTaskIds.has(task.id))
    .map((task) => task.id);
  if (unassignedTaskIds.length > 0) {
    clusters.push(createTaskCluster(null, unassignedTaskIds));
  }
  return clusters;
}

function layoutHorizontal(graph: ProjectSubgraph, clusters: TaskCluster[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const project = graph.nodes.find((node) => node.kind === 'project');
  const phaseX = project
    ? MARGIN + GRAPH_NODE_DIMENSIONS.project.width + RANK_GAP
    : MARGIN;
  const taskX = phaseX + GRAPH_NODE_DIMENSIONS.phase.width + CLUSTER_GAP;
  const clusterHeights = clusters.map((cluster) => Math.max(
    cluster.phaseId ? GRAPH_NODE_DIMENSIONS.phase.height : 0,
    cluster.height,
  ));
  const contentHeight = clusterHeights.reduce((sum, height) => sum + height, 0)
    + Math.max(0, clusters.length - 1) * CLUSTER_GAP;
  const totalHeight = Math.max(contentHeight, project ? GRAPH_NODE_DIMENSIONS.project.height : 0);
  let clusterY = MARGIN + (totalHeight - contentHeight) / 2;

  if (project) {
    positions.set(project.id, {
      x: MARGIN,
      y: MARGIN + (totalHeight - GRAPH_NODE_DIMENSIONS.project.height) / 2,
    });
  }

  clusters.forEach((cluster, clusterIndex) => {
    const clusterHeight = clusterHeights[clusterIndex];
    if (cluster.phaseId) {
      positions.set(cluster.phaseId, {
        x: phaseX,
        y: clusterY + (clusterHeight - GRAPH_NODE_DIMENSIONS.phase.height) / 2,
      });
    }

    const gridY = clusterY + (clusterHeight - cluster.height) / 2;
    cluster.taskIds.forEach((taskId, taskIndex) => {
      const column = taskIndex % cluster.columns;
      const row = Math.floor(taskIndex / cluster.columns);
      positions.set(taskId, {
        x: taskX + column * (GRAPH_NODE_DIMENSIONS.task.width + TASK_COLUMN_GAP),
        y: gridY + row * (GRAPH_NODE_DIMENSIONS.task.height + TASK_ROW_GAP),
      });
    });
    clusterY += clusterHeight + CLUSTER_GAP;
  });

  return positions;
}

function layoutVertical(graph: ProjectSubgraph, clusters: TaskCluster[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const project = graph.nodes.find((node) => node.kind === 'project');
  const phaseY = project
    ? MARGIN + GRAPH_NODE_DIMENSIONS.project.height + RANK_GAP
    : MARGIN;
  const taskY = phaseY + GRAPH_NODE_DIMENSIONS.phase.height + CLUSTER_GAP;
  const clusterWidths = clusters.map((cluster) => Math.max(
    cluster.phaseId ? GRAPH_NODE_DIMENSIONS.phase.width : 0,
    cluster.width,
  ));
  const contentWidth = clusterWidths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, clusters.length - 1) * CLUSTER_GAP;
  const totalWidth = Math.max(contentWidth, project ? GRAPH_NODE_DIMENSIONS.project.width : 0);
  let clusterX = MARGIN + (totalWidth - contentWidth) / 2;

  if (project) {
    positions.set(project.id, {
      x: MARGIN + (totalWidth - GRAPH_NODE_DIMENSIONS.project.width) / 2,
      y: MARGIN,
    });
  }

  clusters.forEach((cluster, clusterIndex) => {
    const clusterWidth = clusterWidths[clusterIndex];
    if (cluster.phaseId) {
      positions.set(cluster.phaseId, {
        x: clusterX + (clusterWidth - GRAPH_NODE_DIMENSIONS.phase.width) / 2,
        y: phaseY,
      });
    }

    const gridX = clusterX + (clusterWidth - cluster.width) / 2;
    cluster.taskIds.forEach((taskId, taskIndex) => {
      const column = taskIndex % cluster.columns;
      const row = Math.floor(taskIndex / cluster.columns);
      positions.set(taskId, {
        x: gridX + column * (GRAPH_NODE_DIMENSIONS.task.width + TASK_COLUMN_GAP),
        y: taskY + row * (GRAPH_NODE_DIMENSIONS.task.height + TASK_ROW_GAP),
      });
    });
    clusterX += clusterWidth + CLUSTER_GAP;
  });

  return positions;
}

export function layoutProjectHierarchy(
  graph: ProjectSubgraph,
  direction: GraphLayoutDirection = 'horizontal',
) {
  const clusters = getTaskClusters(graph);
  return direction === 'vertical'
    ? layoutVertical(graph, clusters)
    : layoutHorizontal(graph, clusters);
}
