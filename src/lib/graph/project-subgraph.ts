import type {
  GraphEdge,
  GraphNode,
  GraphNodeStatus,
  ProjectGraphRecords,
  ProjectSubgraph,
} from './types';
import { boundGraph, canonicalizeExplicitEdge } from './query';

const PROJECT_NODE_PREFIX = 'project:';
const PHASE_NODE_PREFIX = 'phase:';
const TASK_NODE_PREFIX = 'task:';

function normalizeStatus(status: string, microStatus?: string | null): GraphNodeStatus {
  if (
    status === 'blocked'
    || microStatus === 'blocked_external'
    || microStatus === 'started_but_stuck'
    || microStatus === 'waiting_on_someone'
  ) return 'blocked';
  if (status === 'done' || status === 'completed') return 'done';
  if (status === 'in_progress' || status === 'active') return 'in_progress';
  return 'todo';
}

export function wouldCreateBlockingCycle(
  dependencies: Array<{ taskId: string; dependsOnTaskId: string; type: string }>,
  sourceTaskId: string,
  targetTaskId: string,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (dependency.type !== 'blocks') continue;
    const targets = outgoing.get(dependency.dependsOnTaskId) ?? [];
    targets.push(dependency.taskId);
    outgoing.set(dependency.dependsOnTaskId, targets);
  }

  const pending = [targetTaskId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (!taskId || visited.has(taskId)) continue;
    if (taskId === sourceTaskId) return true;
    visited.add(taskId);
    pending.push(...(outgoing.get(taskId) ?? []));
  }
  return false;
}

export function hasDuplicateDependency(
  dependencies: Array<{ taskId: string; dependsOnTaskId: string; type: string }>,
  sourceTaskId: string,
  targetTaskId: string,
  type: 'blocks' | 'related',
): boolean {
  return dependencies.some((dependency) =>
    dependency.type === type
    && (
      (
        dependency.dependsOnTaskId === sourceTaskId
        && dependency.taskId === targetTaskId
      )
      || (
        type === 'related'
        && dependency.dependsOnTaskId === targetTaskId
        && dependency.taskId === sourceTaskId
      )
    ));
}

export function buildProjectSubgraph(
  records: ProjectGraphRecords,
  maxNodes = 500,
  maxEdges = Math.min(maxNodes * 4, 2_000),
): ProjectSubgraph {
  const phaseTaskCounts = new Map<string, number>();
  for (const item of records.phaseItems) {
    phaseTaskCounts.set(item.phaseId, (phaseTaskCounts.get(item.phaseId) ?? 0) + 1);
  }

  const allNodes: GraphNode[] = [
    {
      id: `${PROJECT_NODE_PREFIX}${records.project.id}`,
      entityId: records.project.id,
      kind: 'project' as const,
      label: records.project.name,
      description: records.project.description,
      status: normalizeStatus(records.project.status),
      color: records.project.color,
      taskCount: records.tasks.length,
    },
    ...records.phases.map((phase) => ({
      id: `${PHASE_NODE_PREFIX}${phase.id}`,
      entityId: phase.id,
      kind: 'phase' as const,
      label: phase.name,
      description: phase.description,
      status: normalizeStatus(phase.status),
      color: phase.color,
      taskCount: phaseTaskCounts.get(phase.id) ?? 0,
    })),
    ...records.tasks.map((task) => ({
      id: `${TASK_NODE_PREFIX}${task.id}`,
      entityId: task.id,
      kind: 'task' as const,
      label: task.title,
      description: task.description,
      status: normalizeStatus(task.status, task.microStatus),
    })),
  ];

  const assignedTaskIds = new Set(records.phaseItems.map((item) => item.taskId));

  const allEdges: GraphEdge[] = [
    ...records.phases.map((phase) => ({
      id: `contains:project:${records.project.id}:phase:${phase.id}`,
      source: `${PROJECT_NODE_PREFIX}${records.project.id}`,
      target: `${PHASE_NODE_PREFIX}${phase.id}`,
      type: 'contains' as const,
      provenance: 'derived' as const,
    })),
    ...records.phaseItems.map((item) => ({
      id: `contains:phase:${item.phaseId}:task:${item.taskId}`,
      source: `${PHASE_NODE_PREFIX}${item.phaseId}`,
      target: `${TASK_NODE_PREFIX}${item.taskId}`,
      type: 'contains' as const,
      provenance: 'derived' as const,
    })),
    ...records.tasks
      .filter((task) => !assignedTaskIds.has(task.id))
      .map((task) => ({
        id: `contains:project:${records.project.id}:task:${task.id}`,
        source: `${PROJECT_NODE_PREFIX}${records.project.id}`,
        target: `${TASK_NODE_PREFIX}${task.id}`,
        type: 'contains' as const,
        provenance: 'derived' as const,
      })),
    ...records.phases
      .filter((phase) => phase.startAfterPhaseId)
      .map((phase) => ({
        id: `blocks:phase:${phase.startAfterPhaseId}:phase:${phase.id}`,
        source: `${PHASE_NODE_PREFIX}${phase.startAfterPhaseId}`,
        target: `${PHASE_NODE_PREFIX}${phase.id}`,
        type: 'blocks' as const,
        provenance: 'explicit' as const,
      })),
    ...records.taskDependencies.map((dependency): GraphEdge => canonicalizeExplicitEdge({
      id: `dependency:${dependency.id}`,
      source: `${TASK_NODE_PREFIX}${dependency.dependsOnTaskId}`,
      target: `${TASK_NODE_PREFIX}${dependency.taskId}`,
      type: dependency.type,
      provenance: 'explicit' as const,
      syncStatus: dependency.syncStatus,
      syncAction: dependency.syncAction,
      syncError: dependency.syncError,
      lastSyncedAt: dependency.lastSyncedAt,
    })),
  ];

  return boundGraph(allNodes, allEdges, { maxNodes, maxEdges });
}
