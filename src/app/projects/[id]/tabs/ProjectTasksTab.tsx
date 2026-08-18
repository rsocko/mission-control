'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { TaskContextMenu } from '@/components/task-list/TaskContextMenu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { fadeSlideUp } from '@/lib/motion';
import {
  countTaskFilters,
  EMPTY_TASK_FILTER_CONTEXT,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { cn } from '@/lib/utils';
import type {
  DashboardProjectViewModel as FilterHubProject,
  DashboardTaskTagViewModel as TaskTag,
  EnabledSource,
  SourceList,
} from '@/types/dashboard';
import {
  PhaseAddTaskMenu,
  PriorityDot,
  TaskDisplayId,
  TaskInfoBadges,
  TaskStatusBadge,
} from '../components';
import { BUTTON_TRANSITION, PRIORITY_LABELS } from '../constants';
import {
  useProjectPageData,
  useProjectPageTaskInteractions,
} from '../context';
import type { TaskEffortFilter } from '../types';
import {
  filterProjectTasks,
  formatDateLabel,
  formatRelativeTime,
  getConnectorIcon,
  sortTasks,
} from '../utils';
import type { ProjectTaskOverlayActions } from './contracts';

type TaskSortField = 'priority' | 'dueDate' | 'updated' | 'title';

interface ProjectTasksTabProps {
  /** True while this tab is the visible Activity boundary. */
  active: boolean;
  /** Shared create/link overlays owned by the shell. */
  taskOverlayActions: ProjectTaskOverlayActions;
  /** Display labels for connector types, keyed by connector type. */
  connectorLabels: Record<string, string>;
}

export function ProjectTasksTab({
  active,
  connectorLabels,
  taskOverlayActions,
}: ProjectTasksTabProps) {
  const {
    phaseMenuItems,
    phases,
    project,
    projectId,
    tasks,
    taskToPhase,
  } = useProjectPageData();
  const {
    allProjects,
    completingIds,
    getTaskContextActions,
    handleCompleteTask,
    myDayTaskIds,
    selectedTaskId,
    toggleTask,
  } = useProjectPageTaskInteractions();

  const [taskFilterContext, setTaskFilterContext] = useState<TaskFilterContext>(
    EMPTY_TASK_FILTER_CONTEXT,
  );
  const [taskEffortFilter, setTaskEffortFilter] = useState<TaskEffortFilter>('all');
  const [taskSortBy, setTaskSortBy] = useState<TaskSortField>('priority');
  const [taskSortDir, setTaskSortDir] = useState<'asc' | 'desc'>('asc');
  const [addTaskMenuOpen, setAddTaskMenuOpen] = useState(false);
  const taskFilterProjectIdRef = useRef(projectId);

  useEffect(() => {
    if (taskFilterProjectIdRef.current === projectId) return;
    taskFilterProjectIdRef.current = projectId;
    setTaskFilterContext(EMPTY_TASK_FILTER_CONTEXT);
    setTaskEffortFilter('all');
  }, [projectId]);

  const projectTaskSources = useMemo<EnabledSource[]>(() => {
    const connectorTypes = [...new Set(tasks.map((task) => task.connectorType))];
    return connectorTypes.map((connectorType) => ({
      type: connectorType,
      name: connectorLabels[connectorType] || connectorType,
      icon: '',
    }));
  }, [connectorLabels, tasks]);
  const projectTaskSourceLists = useMemo<SourceList[]>(() => {
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
  const projectTaskTags = useMemo<TaskTag[]>(() => {
    const tags = new Map<string, TaskTag>();
    for (const task of tasks) {
      for (const tag of task.tags ?? []) {
        const existing = tags.get(tag.slug);
        tags.set(tag.slug, { ...tag, count: (existing?.count ?? 0) + 1 });
      }
    }
    return [...tags.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [tasks]);
  const projectTaskAssignees = useMemo(
    () => [...new Set(tasks.map((task) => task.assignee?.trim()).filter((value): value is string => Boolean(value)))].sort(),
    [tasks],
  );
  const projectTaskFilterProjects = useMemo<FilterHubProject[]>(() => (
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
  const filteredTasks = useMemo(() => {
    const filtered = filterProjectTasks(tasks, taskFilterContext, projectId)
      .filter((task) => taskEffortFilter === 'all' || task.effort === taskEffortFilter);
    return sortTasks(filtered, taskSortBy, taskSortDir);
  }, [projectId, taskEffortFilter, taskFilterContext, taskSortBy, taskSortDir, tasks]);
  const hasProjectTaskFilters = (
    countTaskFilters(taskFilterContext)
    - (taskFilterContext.completion === 'all' ? 1 : 0)
  ) > 0
    || taskEffortFilter !== 'all';
  const clearProjectTaskFilters = useCallback(() => {
    setTaskFilterContext((current) => ({
      ...EMPTY_TASK_FILTER_CONTEXT,
      completion: current.completion,
    }));
    setTaskEffortFilter('all');
  }, []);

  // The Activity boundary keeps filter, sort, and menu state alive while the
  // user works in another tab; only the active tab contributes markup.
  if (!active) return null;

  return (
    <motion.section variants={fadeSlideUp} className="space-y-6">
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>Project tasks</CardTitle>
            <CardDescription>
              {!hasProjectTaskFilters
                ? taskFilterContext.completion === 'all'
                  ? `${tasks.length} tasks assigned to this project, with their current phase mapping.`
                  : `${filteredTasks.length} open project tasks. Turn on Done to review inactive work.`
                : `Showing ${filteredTasks.length} of ${tasks.length} project tasks.`}
            </CardDescription>
          </div>
          <div className="relative" data-phase-add-menu>
            <Button
              onClick={() => setAddTaskMenuOpen((current) => !current)}
              aria-expanded={addTaskMenuOpen}
              aria-haspopup="menu"
            >
              <Plus size={14} />
              Add task
              <ChevronDown size={14} />
            </Button>
            <AnimatePresence>
              {addTaskMenuOpen && (
                <PhaseAddTaskMenu
                  onCreateNew={() => {
                    setAddTaskMenuOpen(false);
                    taskOverlayActions.requestCreateTask({ phaseId: null });
                  }}
                  onLinkExisting={() => {
                    setAddTaskMenuOpen(false);
                    taskOverlayActions.requestLinkTasks({ phaseId: null });
                  }}
                  onClose={() => setAddTaskMenuOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>
        </CardHeader>
        <CardContent>
          <TaskKeywordFilter
            filteredCount={filteredTasks.length}
            sources={projectTaskSources}
            sourceLists={projectTaskSourceLists}
            tags={projectTaskTags}
            assignees={projectTaskAssignees}
            projects={projectTaskFilterProjects}
            listGroups={[]}
            controller={{
              context: taskFilterContext,
              setContext: setTaskFilterContext,
              clear: clearProjectTaskFilters,
            }}
            hiddenBuilderFilters={['project']}
            placeholder="Filter project tasks... (press / to focus, ? for help)"
            className="mb-4"
            secondaryContent={
              <div className="flex items-center gap-1">
                <ShowCompletedToggle
                  showCompleted={taskFilterContext.completion === 'all'}
                  onShowCompletedChange={(showCompleted) => {
                    setTaskFilterContext((current) => updateTaskFilterContext(current, {
                      completion: showCompleted ? 'all' : 'open',
                    }));
                  }}
                />
                <label className={cn(
                  'flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2 text-xs cursor-pointer',
                  BUTTON_TRANSITION,
                  taskEffortFilter !== 'all'
                    ? 'border-[var(--accent-500)]/40 bg-[var(--accent-900)]/30 text-[var(--accent-300)]'
                    : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
                )}>
                  <span className="hidden xl:inline">Effort</span>
                  <Select value={String(taskEffortFilter)} onValueChange={(value) => setTaskEffortFilter(value === 'all' ? 'all' : Number.parseInt(value, 10))}>
                    <SelectTrigger className="h-auto min-h-0 w-auto border-0 bg-transparent p-0 text-xs text-[var(--text-primary)] outline-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="1">XS</SelectItem>
                      <SelectItem value="2">S</SelectItem>
                      <SelectItem value="3">M</SelectItem>
                      <SelectItem value="4">L</SelectItem>
                      <SelectItem value="5">XL</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 text-xs text-[var(--text-secondary)]">
                  <ArrowUpDown size={13} />
                  <Select value={taskSortBy} onValueChange={(value) => setTaskSortBy(value as TaskSortField)}>
                    <SelectTrigger className="h-auto min-h-0 w-auto border-0 bg-transparent p-0 text-xs text-[var(--text-primary)] outline-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="priority">Priority</SelectItem>
                      <SelectItem value="dueDate">Due date</SelectItem>
                      <SelectItem value="updated">Recently updated</SelectItem>
                      <SelectItem value="title">Alphabetical</SelectItem>
                    </SelectContent>
                  </Select>
                  <button type="button" onClick={() => setTaskSortDir((direction) => direction === 'asc' ? 'desc' : 'asc')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={`Sort ${taskSortDir === 'asc' ? 'descending' : 'ascending'}`}>
                    {taskSortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  </button>
                </label>
              </div>
            }
          />
          {filteredTasks.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-8 text-center">
              <Search size={24} className="mx-auto text-[var(--text-muted)] mb-3" />
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {tasks.length > 0 && !hasProjectTaskFilters ? 'No open project tasks' : 'No tasks match the current filters'}
              </p>
              <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                {tasks.length > 0 && !hasProjectTaskFilters
                  ? 'Turn on Done to review completed and cancelled tasks.'
                  : 'Try adjusting your filter criteria or clear all filters.'}
              </p>
              {hasProjectTaskFilters && (
                <button type="button" onClick={clearProjectTaskFilters} className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--accent-500)]/30 bg-[var(--accent-900)]/20 px-3 py-1.5 text-sm font-medium text-[var(--accent-400)] hover:bg-[var(--accent-900)]/40 transition-colors">
                  <X size={12} />
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTasks.map((task) => {
                const phase = taskToPhase.get(task.id);
                const ConnectorIcon = getConnectorIcon(task.connectorType);
                const isDone = task.status === 'done' || completingIds.has(task.id);
                const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                return (
                  <TaskContextMenu
                    key={task.id}
                    task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, sourceId: task.sourceId, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                    isInMyDay={myDayTaskIds.has(task.id)}
                    projectPhases={phaseMenuItems}
                    projects={allProjects}
                    taskProjectIds={task.hubProjectIds}
                    taskProjectPhaseMemberships={task.projectPhaseMemberships}
                    actions={getTaskContextActions(task)}
                  >
                  <div
                    className={cn(
                      'flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)] lg:flex-row lg:items-center lg:justify-between cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                      selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                      isInactive && 'opacity-50',
                    )}
                    onClick={() => toggleTask(task.id)}
                  >
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <CompletionBurst celebrating={completingIds.has(task.id)}>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleCompleteTask(task.id); }}
                            disabled={completingIds.has(task.id)}
                            className={cn(
                              'flex-shrink-0 h-[18px] w-[18px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                              isDone
                                ? 'bg-green-400 border-green-400 text-white'
                                : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                            )}
                            aria-label={isDone ? 'Completed' : 'Mark complete'}
                          >
                            {isDone && <CheckCircle2 size={14} />}
                          </button>
                        </CompletionBurst>
                        <PriorityDot priority={task.priority} />
                        <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                        <p className={cn('truncate text-sm font-medium text-[var(--text-primary)]', isDone && 'line-through')}>{task.title}</p>
                        <TaskDisplayId task={task} />
                        <TaskInfoBadges task={task} />
                        {(task.tags ?? []).slice(0, 3).map((tag) => (
                          <Badge key={tag.id} variant="outline">{tag.name}</Badge>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
                        <span>Phase: {phase?.name || 'Unassigned'}</span>
                        <span>•</span>
                        <span>{PRIORITY_LABELS[task.priority]}</span>
                        {task.sourceListName ? (
                          <>
                            <span>•</span>
                            <span>{task.sourceListName}</span>
                          </>
                        ) : null}
                        {task.dueDate ? (
                          <>
                            <span>•</span>
                            <span>Due {formatDateLabel(task.dueDate)}</span>
                          </>
                        ) : null}
                        <span>•</span>
                        <span>Updated {formatRelativeTime(task.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {phase ? <Badge variant="outline">{phase.name}</Badge> : null}
                      <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                    </div>
                  </div>
                  </TaskContextMenu>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.section>
  );
}
