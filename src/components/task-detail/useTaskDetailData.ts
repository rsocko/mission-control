'use client';

import { useEffect, useRef, useState } from 'react';
import { taskLogger } from '@/lib/client-logger';
import { loadProjectHierarchy } from '@/lib/projects/hierarchy-client';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import type { DuplicateCandidate } from './DuplicateTaskPreview';
import {
  fetchConnectorSupport,
  fetchDuplicateCandidates,
  fetchHubProjects,
  fetchTaskDetail,
  fetchWritableConnectors,
  isLocalTaskSource,
} from './task-detail-api';
import type {
  HubProject,
  TagConnectorCaps,
  TaskDetail,
  TaskTag,
  WritableConnector,
} from './task-detail-types';

export interface UseTaskDetailDataOptions {
  taskId: string;
  /** Runs synchronously whenever a new task starts loading, so hosts can reset editors. */
  onTaskReset?: () => void;
  /** Runs once the task record arrives. */
  onTaskLoaded?: (task: TaskDetail) => void;
}

export interface UseTaskDetailDataResult {
  task: TaskDetail | null;
  setTask: React.Dispatch<React.SetStateAction<TaskDetail | null>>;
  loading: boolean;
  connectorCaps: TagConnectorCaps | null;
  supportsAttachments: boolean;
  supportsSubtasks: boolean;
  extraTags: TaskTag[];
  setExtraTags: React.Dispatch<React.SetStateAction<TaskTag[]>>;
  potentialDuplicates: DuplicateCandidate[];
  setPotentialDuplicates: React.Dispatch<React.SetStateAction<DuplicateCandidate[]>>;
  hubProjects: HubProject[];
  projectHierarchies: Record<string, ProjectHierarchySnapshot | null>;
  setProjectHierarchies: React.Dispatch<
    React.SetStateAction<Record<string, ProjectHierarchySnapshot | null>>
  >;
  writableConnectors: WritableConnector[];
}

/**
 * Loads everything the task detail panel renders: the task itself, connector
 * capabilities, duplicates, hub projects, project phase hierarchies, and the
 * connectors a task can be moved to.
 */
export function useTaskDetailData({
  taskId,
  onTaskReset,
  onTaskLoaded,
}: UseTaskDetailDataOptions): UseTaskDetailDataResult {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectorCaps, setConnectorCaps] = useState<TagConnectorCaps | null>(null);
  const [supportsAttachments, setSupportsAttachments] = useState(false);
  const [supportsSubtasks, setSupportsSubtasks] = useState(false);
  const [extraTags, setExtraTags] = useState<TaskTag[]>([]);
  const [potentialDuplicates, setPotentialDuplicates] = useState<DuplicateCandidate[]>([]);
  const [hubProjects, setHubProjects] = useState<HubProject[]>([]);
  const [projectHierarchies, setProjectHierarchies] = useState<
    Record<string, ProjectHierarchySnapshot | null>
  >({});
  const [writableConnectors, setWritableConnectors] = useState<WritableConnector[]>([]);

  // Keep host callbacks out of effect dependencies so a new task only reloads
  // when its identifier actually changes.
  const onTaskResetRef = useRef(onTaskReset);
  const onTaskLoadedRef = useRef(onTaskLoaded);
  useEffect(() => {
    onTaskResetRef.current = onTaskReset;
    onTaskLoadedRef.current = onTaskLoaded;
  });

  const taskConnectorInstanceId = task?.connectorInstanceId;
  const taskConnectorType = task?.connectorType;
  const taskSourceId = task?.sourceId;
  const taskProjectIds = task?.projectIds;
  const loadedTaskId = task?.id;
  const taskStatus = task?.status;

  // Fetch full task details
  useEffect(() => {
    setLoading(true);
    setExtraTags([]);
    setConnectorCaps(null);
    setPotentialDuplicates([]);
    onTaskResetRef.current?.();
    fetchTaskDetail(taskId)
      .then((loaded) => {
        if (loaded) {
          setTask(loaded);
          onTaskLoadedRef.current?.(loaded);
        }
      })
      .catch((err) => { taskLogger.error('Failed to fetch task details', { err, taskId }); })
      .finally(() => setLoading(false));
  }, [taskId]);

  // Auto-detect potential duplicates for open tasks
  useEffect(() => {
    if (!loadedTaskId || (taskStatus !== 'todo' && taskStatus !== 'in_progress')) return;
    fetchDuplicateCandidates(loadedTaskId)
      .then((duplicates) => {
        if (duplicates.length) setPotentialDuplicates(duplicates);
      })
      .catch(() => { /* non-critical, ignore */ });
  }, [loadedTaskId, taskStatus]);

  // Fetch connector capabilities for tag editing when task loads
  useEffect(() => {
    if (!taskConnectorInstanceId || !taskConnectorType) {
      setConnectorCaps(null);
      setSupportsAttachments(false);
      setSupportsSubtasks(false);
      return;
    }
    const isLocal = isLocalTaskSource({
      connectorType: taskConnectorType,
      sourceId: taskSourceId,
    });
    setConnectorCaps(null);
    setSupportsAttachments(isLocal);
    setSupportsSubtasks(isLocal);
    const controller = new AbortController();
    const applySupport = (support: {
      connectorCaps: TagConnectorCaps | null;
      supportsAttachments: boolean;
      supportsSubtasks: boolean;
    }) => {
      setConnectorCaps(support.connectorCaps);
      setSupportsAttachments(support.supportsAttachments);
      setSupportsSubtasks(support.supportsSubtasks);
    };
    fetchConnectorSupport(taskConnectorInstanceId, isLocal, controller.signal)
      .then(applySupport)
      .catch(() => {
        if (controller.signal.aborted) return;
        applySupport({
          connectorCaps: null,
          supportsAttachments: isLocal,
          supportsSubtasks: isLocal,
        });
      });
    return () => controller.abort();
  }, [taskConnectorInstanceId, taskConnectorType, taskSourceId]);

  // Fetch hub projects for project assignment
  useEffect(() => {
    fetchHubProjects()
      .then(setHubProjects)
      .catch(() => setHubProjects([]));
  }, []);

  useEffect(() => {
    const projectIds = taskProjectIds ?? [];
    if (!loadedTaskId || projectIds.length === 0) {
      setProjectHierarchies({});
      return;
    }

    let cancelled = false;
    setProjectHierarchies({});
    projectIds.forEach((projectId) => {
      void loadProjectHierarchy(projectId).then((hierarchy) => {
        if (cancelled) return;
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: hierarchy }));
      }).catch((error) => {
        taskLogger.error('Failed to load project phases', { err: error, projectId, taskId });
        if (cancelled) return;
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: null }));
      });
    });
    return () => { cancelled = true; };
  }, [loadedTaskId, taskProjectIds, taskId]);

  // Fetch writable connectors for cross-source move dialog
  useEffect(() => {
    fetchWritableConnectors()
      .then(setWritableConnectors)
      .catch(() => setWritableConnectors([]));
  }, [taskConnectorInstanceId]);

  return {
    task,
    setTask,
    loading,
    connectorCaps,
    supportsAttachments,
    supportsSubtasks,
    extraTags,
    setExtraTags,
    potentialDuplicates,
    setPotentialDuplicates,
    hubProjects,
    projectHierarchies,
    setProjectHierarchies,
    writableConnectors,
  };
}

/** Find the phase a task currently sits in for a project hierarchy. */
export function taskPhaseInProject(
  hierarchy: ProjectHierarchySnapshot | null | undefined,
  taskId: string,
) {
  if (!hierarchy) return null;
  return hierarchy.phases.find((phase) => (
    hierarchy.phaseItemsByPhase[phase.id]?.some((item) => item.taskId === taskId)
  )) ?? null;
}
