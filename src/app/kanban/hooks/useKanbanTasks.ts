'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { pushUndoWithToast } from '@/lib/stores/undoStore';
import { kanbanLogger } from '@/lib/client-logger';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import type {
  KanbanColumnViewModel as KanbanColumnType,
  KanbanProjectViewModel,
  KanbanTaskViewModel,
  SwimlaneMode,
} from '../components';
import { toKanbanProjectViewModel } from '../components';
import type {
  HubProjectListResponseDto,
  TaskListResponseDto,
} from '@/types/api';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';
import { TASK_PRIORITY_VISUALS } from '@/lib/constants/task-formatting';

type ColumnResolver = KanbanColumnType[] | (() => KanbanColumnType[]);
type BooleanResolver = boolean | (() => boolean);

function formatSnoozeLabel(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  if (date >= tomorrow && date < dayAfterTomorrow) return 'tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface UseKanbanTasksOptions {
  selectedProject: string;
  selectedSources: string[];
  columns: ColumnResolver;
  isProjectView?: BooleanResolver;
}

export interface SwimlaneGroup {
  key: string;
  label: string;
  color?: string;
}

const PRIORITY_SWIMLANES: SwimlaneGroup[] = [
  ...(['critical', 'high', 'medium', 'low'] as const).map((key) => ({
    key,
    label: TASK_PRIORITY_VISUALS[key].label,
    color: TASK_PRIORITY_VISUALS[key].color,
  })),
  { key: 'none', label: 'No Priority', color: TASK_PRIORITY_VISUALS.none.color },
];

export function useKanbanTasks({
  selectedProject,
  selectedSources,
  columns,
  isProjectView = false,
}: UseKanbanTasksOptions) {
  const { progress: syncProgress } = useSyncStream();
  const [tasks, setTasks] = useState<KanbanTaskViewModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<KanbanProjectViewModel[]>([]);
  const [scores, setScores] = useState<Map<string, number>>(new Map());
  const [scoreSortEnabled, setScoreSortEnabled] = useState(true);
  const [scoreRefetchKey, setScoreRefetchKey] = useState(0);

  const resolveColumns = useCallback(
    () => typeof columns === 'function' ? columns() : columns,
    [columns],
  );
  const resolveProjectView = useCallback(
    () => typeof isProjectView === 'function' ? isProjectView() : isProjectView,
    [isProjectView],
  );

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ parentOnly: 'true', limit: '0' });
      if (selectedProject !== 'all') params.set('projectId', selectedProject);

      const [tasksRes, projectsRes] = await Promise.all([
        fetch(`/api/tasks?${params}`),
        fetch('/api/hub-projects'),
      ]);
      const tasksData: TaskListResponseDto = await tasksRes.json();
      const projectsData: HubProjectListResponseDto = await projectsRes.json();
      let filteredTasks: KanbanTaskViewModel[] = tasksData.tasks || [];

      if (selectedSources.length > 0) {
        const connectorFilters = selectedSources
          .filter(source => source.startsWith('connector:'))
          .map(source => source.replace('connector:', ''));
        const listFilters = selectedSources
          .filter(source => source.startsWith('list:'))
          .map(source => source.replace('list:', ''));

        filteredTasks = filteredTasks.filter(task => {
          if (connectorFilters.length > 0 && connectorFilters.includes(task.connectorType)) return true;
          if (listFilters.length > 0 && task.sourceListId && listFilters.includes(task.sourceListId)) return true;
          return false;
        });
      }

      setTasks(filteredTasks);
      setProjects((projectsData.projects || []).map(toKanbanProjectViewModel));
      setScoreRefetchKey(prev => prev + 1);
    } catch (err) {
      kanbanLogger.error('Failed to fetch kanban data', { err });
      if (!silent) toast.error('Failed to load board data');
    } finally {
      setLoading(false);
    }
  }, [selectedProject, selectedSources]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [fetchData]);

  useEffect(() => {
    if (!scoreSortEnabled) {
      const timeoutId = window.setTimeout(() => {
        setScores(new Map());
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    fetch('/api/smart-score?limit=500&status=open')
      .then(r => r.json())
      .then(data => {
        const nextScores = new Map<string, number>();
        for (const score of (data.scores || [])) {
          nextScores.set(score.taskId, score.score.total);
        }
        setScores(nextScores);
      })
      .catch(err => {
        kanbanLogger.error('Failed to fetch smart scores', { err });
      });
  }, [scoreSortEnabled, scoreRefetchKey]);

  useEffect(() => {
    if (syncProgress.refetchKey > 0) {
      const timeoutId = window.setTimeout(() => {
        void fetchData(true);
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [fetchData, syncProgress.refetchKey]);

  const getTasksForColumn = useCallback((column: KanbanColumnType) => {
    const now = new Date().toISOString();
    const activeColumns = resolveColumns();

    return tasks
      .filter(task => {
        if (task.snoozedUntil && task.snoozedUntil > now) return false;
        if (task.kanbanColumn) return task.kanbanColumn === column.id;
        if (column.statusMapping?.length) return column.statusMapping.includes(task.status);
        return column.id === activeColumns[0]?.id && !task.kanbanColumn;
      })
      .sort((left, right) => {
        if (!scoreSortEnabled || scores.size === 0) return 0;
        return (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
      })
      .map(task => scoreSortEnabled ? { ...task, smartScore: scores.get(task.id) ?? null } : task);
  }, [resolveColumns, scoreSortEnabled, scores, tasks]);

  const taskMatchesSearch = useCallback((task: KanbanTaskViewModel, searchQuery: string) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      task.title.toLowerCase().includes(query)
      || (task.description?.toLowerCase().includes(query) ?? false)
      || task.tags.some(tag => tag.name.toLowerCase().includes(query))
    );
  }, []);

  const getSwimlaneGroups = useCallback((swimlaneMode: SwimlaneMode) => {
    if (swimlaneMode === 'none') return [{ key: 'all', label: '' }];
    if (swimlaneMode === 'priority') return PRIORITY_SWIMLANES;
    return [
      ...projects.map(project => ({ key: project.id, label: project.name, color: project.color })),
      { key: '__none', label: 'No Project', color: '#374151' },
    ];
  }, [projects]);

  const getTasksForSwimlane = useCallback((columnTasks: KanbanTaskViewModel[], swimlaneMode: SwimlaneMode, groupKey: string) => {
    if (swimlaneMode === 'none') return columnTasks;
    if (swimlaneMode === 'priority') return columnTasks.filter(task => task.priority === groupKey);
    if (groupKey === '__none') return columnTasks;
    return columnTasks;
  }, []);

  const moveTask = useCallback(async (taskId: string, targetColumn: string) => {
    const currentTask = tasks.find(t => t.id === taskId);
    if (!canEditTaskField(currentTask?.editPolicy, 'kanbanPlacement')) {
      toast.error(taskFieldBlockedReason(currentTask?.editPolicy, 'kanbanPlacement'));
      return;
    }
    const previousColumn = currentTask?.kanbanColumn;
    setTasks(prev => prev.map(task => (
      task.id === taskId ? { ...task, kanbanColumn: targetColumn } : task
    )));

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kanbanColumn: targetColumn }),
      });
      if (!res.ok) throw new Error('Failed');
      if (previousColumn && previousColumn !== targetColumn) {
        pushUndoWithToast(`Moved to ${targetColumn}`, async () => {
          setTasks(prev => prev.map(task => (
            task.id === taskId ? { ...task, kanbanColumn: previousColumn } : task
          )));
          const undoRes = await fetch(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kanbanColumn: previousColumn }),
          });
          if (!undoRes.ok) throw new Error('Undo failed');
        }, { type: 'info' });
      }
    } catch {
      toast.error('Failed to move task');
      await fetchData();
    }
  }, [fetchData, tasks]);

  const handleDrop = useCallback((columnId: string, dragging: string | null, onDropComplete: () => void) => {
    if (!dragging) return;
    void moveTask(dragging, columnId);
    onDropComplete();
  }, [moveTask]);

  const snoozeTask = useCallback(async (taskId: string, until: string) => {
    const currentTask = tasks.find((task) => task.id === taskId);
    if (!canEditTaskField(currentTask?.editPolicy, 'snoozedUntil')) {
      toast.error(taskFieldBlockedReason(currentTask?.editPolicy, 'snoozedUntil'));
      return;
    }
    const snoozePenalty = 15;
    const previousTasks = [...tasks];
    const previousScores = new Map(scores);

    setScores(prev => {
      const nextScores = new Map(prev);
      const currentScore = nextScores.get(taskId) ?? 0;
      nextScores.set(taskId, Math.max(0, currentScore - snoozePenalty));
      return nextScores;
    });

    await new Promise(resolve => setTimeout(resolve, 800));
    setTasks(prev => prev.map(task => (
      task.id === taskId ? { ...task, snoozedUntil: until } : task
    )));

    const untilDate = new Date(until);
    const label = formatSnoozeLabel(untilDate);

    pushUndoWithToast(`Snoozed until ${label}`, () => {
      setTasks(previousTasks);
      setScores(previousScores);
      fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozedUntil: null }),
      }).catch(() => toast.error('Failed to undo snooze'));
    }, { type: 'info' });

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozedUntil: until }),
      });
      if (!response.ok) throw new Error('Failed to snooze task');
    } catch {
      toast.error('Failed to snooze task');
      await fetchData();
    }
  }, [fetchData, tasks, scores]);

  const quickAddTask = useCallback(async (columnId: string, title: string) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return false;

    try {
      const body: Record<string, unknown> = { title: trimmedTitle, priority: 'none' };
      if (resolveProjectView()) body.projectIds = [selectedProject];

      const taskResponse = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!taskResponse.ok) {
        toast.error('Failed to create task');
        return false;
      }

      const { id } = await taskResponse.json();
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kanbanColumn: columnId }),
      });
      await fetchData();
      toast.success('Task created');
      return true;
    } catch {
      toast.error('Failed to create task');
      return false;
    }
  }, [fetchData, resolveProjectView, selectedProject]);

  return {
    tasks,
    setTasks,
    loading,
    projects,
    setProjects,
    scores,
    scoreSortEnabled,
    setScoreSortEnabled,
    fetchData,
    getTasksForColumn,
    taskMatchesSearch,
    getSwimlaneGroups,
    getTasksForSwimlane,
    moveTask,
    handleDrop,
    snoozeTask,
    quickAddTask,
  };
}
