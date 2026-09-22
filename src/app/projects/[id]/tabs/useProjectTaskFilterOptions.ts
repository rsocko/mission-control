import { useMemo } from 'react';
import type {
  DashboardProjectViewModel as FilterHubProject,
  DashboardTaskTagViewModel as TaskTag,
  EnabledSource,
  SourceList,
} from '@/types/dashboard';
import type {
  ProjectDetailViewModel,
  ProjectPhaseViewModel,
  ProjectTaskViewModel,
} from '../types';

interface ProjectTaskFilterOptionsInput {
  connectorLabels: Record<string, string>;
  phases: ProjectPhaseViewModel[];
  project: ProjectDetailViewModel | null;
  tasks: ProjectTaskViewModel[];
}

export function useProjectTaskFilterOptions({
  connectorLabels,
  phases,
  project,
  tasks,
}: ProjectTaskFilterOptionsInput) {
  const sources = useMemo<EnabledSource[]>(() => {
    const connectorTypes = [...new Set(tasks.map((task) => task.connectorType))];
    return connectorTypes.map((connectorType) => ({
      type: connectorType,
      name: connectorLabels[connectorType] || connectorType,
      icon: '',
    }));
  }, [connectorLabels, tasks]);

  const sourceLists = useMemo<SourceList[]>(() => {
    const lists = new Map<string, SourceList>();
    for (const task of tasks) {
      if (!task.sourceListName) continue;
      const sourceId = task.sourceListId || task.sourceListName.toLowerCase();
      const key = `${task.connectorInstanceId}:${sourceId}`;
      const existing = lists.get(key);
      lists.set(key, {
        id: key,
        sourceId,
        connectorInstanceId: task.connectorInstanceId,
        name: task.sourceListName,
        taskCount: (existing?.taskCount ?? 0) + 1,
        groupId: null,
      });
    }
    return [...lists.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [tasks]);

  const tags = useMemo<TaskTag[]>(() => {
    const taskTags = new Map<string, TaskTag>();
    for (const task of tasks) {
      for (const tag of task.tags ?? []) {
        const existing = taskTags.get(tag.slug);
        taskTags.set(tag.slug, { ...tag, count: (existing?.count ?? 0) + 1 });
      }
    }
    return [...taskTags.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [tasks]);

  const assignees = useMemo(
    () => [...new Set(tasks
      .map((task) => task.assignee?.trim())
      .filter((value): value is string => Boolean(value)))].sort(),
    [tasks],
  );

  const projects = useMemo<FilterHubProject[]>(() => (
    project
      ? [{
          id: project.id,
          name: project.name,
          color: project.color,
          icon: project.icon,
          phases: phases.map((phase) => ({ id: phase.id, name: phase.name })),
        }]
      : []
  ), [phases, project]);

  return { assignees, projects, sourceLists, sources, tags };
}
