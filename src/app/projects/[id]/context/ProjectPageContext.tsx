'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import type { HubProject, TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type {
  TaskDetailMode,
  TaskNotesOpenRequest,
} from '@/components/task-detail/task-detail-types';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
  ProjectHierarchyClientError,
  ProjectHierarchyUndoTracker,
} from '@/lib/projects/hierarchy-client';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from '@/lib/projects/hierarchy-types';
import { pushUndoWithToast, useUndoStore } from '@/lib/stores/undoStore';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import type {
  PhaseTaskEntry,
  ProgressSummary,
  ProjectDetailViewModel as ProjectRecord,
  ProjectPhaseItemViewModel as PhaseItem,
  ProjectPhaseViewModel as ProjectPhase,
  ProjectTaskViewModel as ProjectTask,
} from '../types';
import type { ProjectDetailResponseDto } from '@/types/api';
import {
  getProgressSummary,
  syncTaskPhaseMemberships,
} from '../utils';
import {
  useProjectTaskActions,
  type RunProjectHierarchyCommand,
} from '../useProjectTaskActions';
import { notifyTaskChanged } from '@/lib/task-change-events';

function hierarchyCommandTaskIds(command: ProjectHierarchyCommand): string[] {
  switch (command.type) {
    case 'move_tasks':
    case 'assign_tasks':
    case 'remove_tasks':
      return command.taskIds;
    case 'restore_task_positions':
      return command.placements.map((placement) => placement.taskId);
    case 'restore_project_tasks':
      return command.states.map((state) => state.taskId);
    case 'update_phase_item':
      return [command.taskId];
    case 'reorder_phases':
      return [];
  }
}

interface ProjectPageDataContextValue {
  projectId: string;
  project: ProjectRecord | null;
  phases: ProjectPhase[];
  tasks: ProjectTask[];
  phaseItemsByPhase: Record<string, PhaseItem[]>;
  loading: boolean;
  error: string | null;
  progress: ProgressSummary;
  phaseEntries: Record<string, PhaseTaskEntry[]>;
  taskToPhase: Map<string, ProjectPhase>;
  phaseMenuItems: Array<{ id: string; name: string }>;
  reportRefreshKey: string;
}

interface ProjectPageMutationsContextValue {
  setProject: Dispatch<SetStateAction<ProjectRecord | null>>;
  setPhases: Dispatch<SetStateAction<ProjectPhase[]>>;
  setTasks: Dispatch<SetStateAction<ProjectTask[]>>;
  setPhaseItemsByPhase: Dispatch<SetStateAction<Record<string, PhaseItem[]>>>;
  hierarchyAnnouncement: string;
  loadProjectDetail: (options?: { background?: boolean }) => Promise<void>;
  refreshProjectHierarchy: () => Promise<void>;
  runHierarchyCommand: RunProjectHierarchyCommand;
}

interface ProjectPageTaskInteractionsContextValue {
  selectedTaskId: string | null;
  setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
  detailMode: Exclude<TaskDetailMode, 'mobile'>;
  setDetailMode: Dispatch<SetStateAction<Exclude<TaskDetailMode, 'mobile'>>>;
  notesOpenRequest: TaskNotesOpenRequest | null;
  openTaskNotes: (taskId: string, mode: 'read' | 'edit') => void;
  clearTaskNotesRequest: () => void;
  toggleTask: (taskId: string) => void;
  handleTaskClick: (taskId: string) => void;
  handleTaskDoubleClick: (taskId: string) => void;
  cancelPendingDeselect: () => void;
  handleGraphTaskSelect: (taskId: string | null) => void;
  allProjects: HubProject[];
  completingIds: Set<string>;
  myDayTaskIds: Set<string>;
  getTaskContextActions: (task: ProjectTask) => TaskContextMenuActions;
  handleCompleteTask: (taskId: string) => Promise<void>;
  handleAddToMyDay: (taskId: string) => Promise<void>;
  handleRemoveFromMyDay: (taskId: string) => Promise<void>;
}

const ProjectPageDataContext = createContext<ProjectPageDataContextValue | null>(null);
const ProjectPageMutationsContext = createContext<ProjectPageMutationsContextValue | null>(null);
const ProjectPageTaskInteractionsContext =
  createContext<ProjectPageTaskInteractionsContextValue | null>(null);

function requireProjectPageContext<T>(value: T | null, hookName: string): T {
  if (!value) {
    throw new Error(`${hookName} must be used within ProjectPageProvider`);
  }
  return value;
}

export function useProjectPageData() {
  return requireProjectPageContext(useContext(ProjectPageDataContext), 'useProjectPageData');
}

export function useProjectPageMutations() {
  return requireProjectPageContext(
    useContext(ProjectPageMutationsContext),
    'useProjectPageMutations',
  );
}

export function useProjectPageTaskInteractions() {
  return requireProjectPageContext(
    useContext(ProjectPageTaskInteractionsContext),
    'useProjectPageTaskInteractions',
  );
}

export function ProjectPageProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [phases, setPhases] = useState<ProjectPhase[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [phaseItemsByPhase, setPhaseItemsByPhase] =
    useState<Record<string, PhaseItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hierarchyAnnouncement, setHierarchyAnnouncement] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [detailMode, setDetailMode] =
    useState<Exclude<TaskDetailMode, 'mobile'>>('panel');
  const [notesOpenRequest, setNotesOpenRequest] = useState<TaskNotesOpenRequest | null>(null);
  const [allProjects, setAllProjects] = useState<HubProject[]>([]);
  const hierarchyRevisionRef = useRef(0);
  const hierarchyProjectIdRef = useRef<string | null>(null);
  const hierarchyUndoTrackerRef = useRef(new ProjectHierarchyUndoTracker());
  const loadRequestIdRef = useRef(0);
  const notesRequestIdRef = useRef(0);
  const loadedProjectIdRef = useRef<string | null>(null);
  const { setQuickAddFilter, clearQuickAddFilter } = useQuickAddContext();

  const {
    cancelPendingDeselect,
    handleTaskClick,
    handleTaskDoubleClick,
    toggleTask,
  } = useTaskSelection({
    selectedTaskId,
    onSelectionChange: (taskId) => {
      setNotesOpenRequest(null);
      setDetailMode('panel');
      setSelectedTaskId(taskId);
    },
    onDoubleClick: () => setDetailMode('dialog'),
  });

  const handleGraphTaskSelect = useCallback((taskId: string | null) => {
    cancelPendingDeselect();
    setNotesOpenRequest(null);
    setDetailMode('panel');
    setSelectedTaskId(taskId);
  }, [cancelPendingDeselect]);

  const openTaskNotes = useCallback((taskId: string, mode: 'read' | 'edit') => {
    cancelPendingDeselect();
    setDetailMode('panel');
    setSelectedTaskId(taskId);
    notesRequestIdRef.current += 1;
    setNotesOpenRequest({
      requestId: notesRequestIdRef.current,
      taskId,
      mode,
    });
  }, [cancelPendingDeselect, setSelectedTaskId]);

  const clearTaskNotesRequest = useCallback(() => {
    setNotesOpenRequest(null);
  }, []);

  const applyHierarchySnapshot = useCallback((snapshot: ProjectHierarchySnapshot) => {
    if (snapshot.projectId !== currentProjectIdRef.current) return;
    if (
      hierarchyProjectIdRef.current === snapshot.projectId
      && snapshot.revision < hierarchyRevisionRef.current
    ) {
      return;
    }
    hierarchyProjectIdRef.current = snapshot.projectId;
    hierarchyRevisionRef.current = snapshot.revision;
    setPhases(snapshot.phases);
    setPhaseItemsByPhase(snapshot.phaseItemsByPhase);
    setTasks((current) => syncTaskPhaseMemberships(current, snapshot));
  }, []);

  const loadProjectTasks = useCallback(async () => {
    return fetchAllTasks<ProjectTask>(
      `/api/tasks?projectId=${projectId}&parentOnly=true&sortBy=updated`,
    );
  }, [projectId]);

  const discardHierarchyUndos = useCallback(() => {
    const undoEntryIds = hierarchyUndoTrackerRef.current.clear();
    for (const undoEntryId of undoEntryIds) {
      useUndoStore.getState().removeEntry(undoEntryId);
      toast.dismiss(undoEntryId);
    }
  }, []);

  const reconcileHierarchyConflict = useCallback(async (
    snapshot: ProjectHierarchySnapshot,
  ) => {
    if (snapshot.projectId !== currentProjectIdRef.current) return;
    discardHierarchyUndos();
    applyHierarchySnapshot(snapshot);
    try {
      const currentTasks = await loadProjectTasks();
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error
          ? caughtError.message
          : 'Failed to reconcile project tasks',
      );
    }
  }, [applyHierarchySnapshot, discardHierarchyUndos, loadProjectTasks, projectId]);

  const runHierarchyCommand = useCallback(async (
    command: ProjectHierarchyCommand,
    options: { undoLabel: string; announcement: string },
  ): Promise<ProjectHierarchyCommandResult> => {
    const commandId = crypto.randomUUID();
    try {
      const result = await executeProjectHierarchyCommand({
        projectId,
        expectedRevision: hierarchyRevisionRef.current,
        command,
        commandId,
      });
      if (projectId !== currentProjectIdRef.current) return result;
      applyHierarchySnapshot(result.hierarchy);
      for (const taskId of hierarchyCommandTaskIds(command)) notifyTaskChanged(taskId);
      hierarchyUndoTrackerRef.current.push(commandId, result.revision);
      setHierarchyAnnouncement(options.announcement);
      const undoEntryId = pushUndoWithToast(options.undoLabel, async () => {
        try {
          const undoResult = await executeProjectHierarchyCommand({
            projectId,
            expectedRevision: hierarchyUndoTrackerRef.current.expectedRevision(commandId),
            command: result.inverseCommand,
          });
          applyHierarchySnapshot(undoResult.hierarchy);
          for (const taskId of hierarchyCommandTaskIds(result.inverseCommand)) {
            notifyTaskChanged(taskId);
          }
          hierarchyUndoTrackerRef.current.complete(commandId, undoResult.revision);
          setHierarchyAnnouncement(`Undid: ${options.announcement}`);
        } catch (caughtError) {
          if (caughtError instanceof ProjectHierarchyClientError && caughtError.current) {
            await reconcileHierarchyConflict(caughtError.current);
          }
          throw caughtError;
        }
      }, {
        validationError: () => hierarchyUndoTrackerRef.current.validationError(commandId),
      });
      hierarchyUndoTrackerRef.current.attachUndoEntry(commandId, undoEntryId);
      return result;
    } catch (caughtError) {
      if (caughtError instanceof ProjectHierarchyClientError && caughtError.current) {
        await reconcileHierarchyConflict(caughtError.current);
      }
      throw caughtError;
    }
  }, [applyHierarchySnapshot, projectId, reconcileHierarchyConflict]);

  const loadProjectDetail = useCallback(async (
    { background = false }: { background?: boolean } = {},
  ) => {
    if (!projectId) return;
    const requestId = ++loadRequestIdRef.current;
    const refreshInBackground = background && loadedProjectIdRef.current === projectId;

    if (!refreshInBackground) {
      setLoading(true);
      setError(null);
    }

    try {
      const [projectResponse, hierarchy, currentTasks] = await Promise.all([
        fetch(`/api/hub-projects/${projectId}`),
        loadProjectHierarchy(projectId),
        loadProjectTasks(),
      ]);

      if (!projectResponse.ok) {
        const payload = (await projectResponse.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error || 'Failed to load project');
      }
      const projectPayload: ProjectDetailResponseDto<ProjectRecord> =
        await projectResponse.json();
      if (
        requestId !== loadRequestIdRef.current
        || projectId !== currentProjectIdRef.current
      ) {
        return;
      }

      setProject(projectPayload.project);
      loadedProjectIdRef.current = projectId;
      if (
        hierarchyProjectIdRef.current === hierarchy.projectId
        && hierarchy.revision !== hierarchyRevisionRef.current
      ) {
        discardHierarchyUndos();
      }
      applyHierarchySnapshot(hierarchy);
      setTasks(syncTaskPhaseMemberships(currentTasks, hierarchy));
    } catch (caughtError) {
      if (
        requestId !== loadRequestIdRef.current
        || projectId !== currentProjectIdRef.current
      ) {
        return;
      }
      const message = caughtError instanceof Error
        ? caughtError.message
        : 'Failed to load project detail';
      if (!refreshInBackground) setError(message);
      toast.error(message);
    } finally {
      if (
        requestId === loadRequestIdRef.current
        && projectId === currentProjectIdRef.current
      ) {
        setLoading(false);
      }
    }
  }, [applyHierarchySnapshot, discardHierarchyUndos, loadProjectTasks, projectId]);

  const refreshProjectHierarchy = useCallback(async () => {
    const hierarchy = await loadProjectHierarchy(projectId);
    if (hierarchy.revision !== hierarchyRevisionRef.current) discardHierarchyUndos();
    applyHierarchySnapshot(hierarchy);
  }, [applyHierarchySnapshot, discardHierarchyUndos, projectId]);

  const removeTaskFromView = useCallback((taskId: string) => {
    setTasks((current) => current.filter((task) => task.id !== taskId));
    setPhaseItemsByPhase((current) => {
      const next: Record<string, PhaseItem[]> = {};
      for (const [phaseId, items] of Object.entries(current)) {
        next[phaseId] = items.filter((item) => item.taskId !== taskId);
      }
      return next;
    });
    setSelectedTaskId((current) => current === taskId ? null : current);
  }, []);

  const stageProjectTaskRemoval = useCallback((taskId: string) => {
    const previousTasks = tasks;
    const previousPhaseItems = phaseItemsByPhase;
    const previousSelectedTaskId = selectedTaskId;

    removeTaskFromView(taskId);
    return () => {
      setTasks(previousTasks);
      setPhaseItemsByPhase(previousPhaseItems);
      setSelectedTaskId(previousSelectedTaskId);
    };
  }, [
    phaseItemsByPhase,
    removeTaskFromView,
    selectedTaskId,
    tasks,
  ]);

  const taskActions = useProjectTaskActions({
    projectId,
    tasks,
    setTasks,
    phases,
    phaseItemsByPhase,
    projects: allProjects,
    removeTaskFromView,
    stageProjectTaskRemoval,
    refreshProjectHierarchy,
    runHierarchyCommand,
  });

  const quickAddProjectId = project?.id;
  const quickAddProjectName = project?.name;
  useEffect(() => {
    if (!quickAddProjectId || quickAddProjectId !== projectId || !quickAddProjectName) return;
    setQuickAddFilter({
      projectFilter: quickAddProjectId,
      projectFilterName: quickAddProjectName,
    });
    return () => clearQuickAddFilter();
  }, [
    clearQuickAddFilter,
    projectId,
    quickAddProjectId,
    quickAddProjectName,
    setQuickAddFilter,
  ]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      discardHierarchyUndos();
      void loadProjectDetail();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [discardHierarchyUndos, loadProjectDetail]);

  const { progress: syncProgress } = useSyncStream();
  const prevRefetchKeyRef = useRef(syncProgress.refetchKey);
  useEffect(() => {
    if (syncProgress.refetchKey <= prevRefetchKeyRef.current) return;
    prevRefetchKeyRef.current = syncProgress.refetchKey;
    const timeoutId = window.setTimeout(() => {
      void loadProjectDetail({ background: true });
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [syncProgress.refetchKey, loadProjectDetail]);

  useEffect(() => {
    fetch('/api/hub-projects?includePhases=true')
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (payload?.projects) setAllProjects(payload.projects as HubProject[]);
      })
      .catch(() => {
        // The project list only supplements context-menu actions.
      });
  }, []);

  const progress = useMemo(() => getProgressSummary(tasks), [tasks]);
  const taskMap = useMemo(
    () => new Map(tasks.map((task) => [task.id, task] as const)),
    [tasks],
  );
  const phaseEntries = useMemo(() => (
    phases.reduce<Record<string, PhaseTaskEntry[]>>((accumulator, phase) => {
      accumulator[phase.id] = (phaseItemsByPhase[phase.id] ?? [])
        .map((item) => {
          const task = taskMap.get(item.taskId);
          return task ? { item, task } : null;
        })
        .filter((entry): entry is PhaseTaskEntry => entry !== null);
      return accumulator;
    }, {})
  ), [phaseItemsByPhase, phases, taskMap]);
  const taskToPhase = useMemo(() => {
    const mapping = new Map<string, ProjectPhase>();
    for (const phase of phases) {
      for (const item of phaseItemsByPhase[phase.id] ?? []) {
        if (!mapping.has(item.taskId)) mapping.set(item.taskId, phase);
      }
    }
    return mapping;
  }, [phaseItemsByPhase, phases]);
  const phaseMenuItems = useMemo(
    () => phases.map((phase) => ({ id: phase.id, name: phase.name })),
    [phases],
  );
  const reportRefreshKey = useMemo(() => [
    ...tasks.map((task) => (
      `${task.id}:${task.status}:${task.effort ?? ''}:${task.updatedAt}`
    )),
    ...Object.entries(phaseItemsByPhase)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phaseId, items]) => (
        `${phaseId}:${items.map((item) => item.taskId).sort().join(',')}`
      )),
  ].join('|'), [phaseItemsByPhase, tasks]);

  const dataValue = useMemo<ProjectPageDataContextValue>(() => ({
    projectId,
    project,
    phases,
    tasks,
    phaseItemsByPhase,
    loading,
    error,
    progress,
    phaseEntries,
    taskToPhase,
    phaseMenuItems,
    reportRefreshKey,
  }), [
    error,
    loading,
    phaseEntries,
    phaseItemsByPhase,
    phaseMenuItems,
    phases,
    progress,
    project,
    projectId,
    reportRefreshKey,
    taskToPhase,
    tasks,
  ]);

  const mutationsValue = useMemo<ProjectPageMutationsContextValue>(() => ({
    setProject,
    setPhases,
    setTasks,
    setPhaseItemsByPhase,
    hierarchyAnnouncement,
    loadProjectDetail,
    refreshProjectHierarchy,
    runHierarchyCommand,
  }), [
    hierarchyAnnouncement,
    loadProjectDetail,
    refreshProjectHierarchy,
    runHierarchyCommand,
  ]);

  const taskInteractionsValue = useMemo<ProjectPageTaskInteractionsContextValue>(() => ({
    selectedTaskId,
    setSelectedTaskId,
    detailMode,
    setDetailMode,
    notesOpenRequest,
    openTaskNotes,
    clearTaskNotesRequest,
    toggleTask,
    handleTaskClick,
    handleTaskDoubleClick,
    cancelPendingDeselect,
    handleGraphTaskSelect,
    allProjects,
    completingIds: taskActions.completingIds,
    myDayTaskIds: taskActions.myDayTaskIds,
    getTaskContextActions: taskActions.getTaskContextActions,
    handleCompleteTask: taskActions.handleCompleteTask,
    handleAddToMyDay: taskActions.handleAddToMyDay,
    handleRemoveFromMyDay: taskActions.handleRemoveFromMyDay,
  }), [
    allProjects,
    clearTaskNotesRequest,
    detailMode,
    handleGraphTaskSelect,
    handleTaskClick,
    handleTaskDoubleClick,
    notesOpenRequest,
    openTaskNotes,
    selectedTaskId,
    taskActions.completingIds,
    taskActions.getTaskContextActions,
    taskActions.handleAddToMyDay,
    taskActions.handleCompleteTask,
    taskActions.handleRemoveFromMyDay,
    taskActions.myDayTaskIds,
    cancelPendingDeselect,
    toggleTask,
  ]);

  return (
    <ProjectPageDataContext.Provider value={dataValue}>
      <ProjectPageMutationsContext.Provider value={mutationsValue}>
        <ProjectPageTaskInteractionsContext.Provider value={taskInteractionsValue}>
          {children}
        </ProjectPageTaskInteractionsContext.Provider>
      </ProjectPageMutationsContext.Provider>
    </ProjectPageDataContext.Provider>
  );
}
