'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, Plus, Search, X } from 'lucide-react';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import {
  DEFAULT_GROUP_OPTIONS,
  GroupByDropdown,
  type GroupOption,
} from '@/components/toolbar/GroupByDropdown';
import { SortDropdown, type SortOption } from '@/components/toolbar/SortDropdown';
import {
  ViewDensityToggle,
  type ViewDensity,
} from '@/components/toolbar/ViewDensityToggle';
import { TaskContextMenu } from '@/components/task-list/TaskContextMenu';
import { TaskRow } from '@/components/task-list/TaskRow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buildTaskListRows } from '@/lib/hooks/useTaskListVirtualization';
import {
  countTaskFilters,
  EMPTY_TASK_FILTER_CONTEXT,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { cn } from '@/lib/utils';
import { EMPTY_TASK_RESPONSE } from '@/types/dashboard';
import { fadeSlideUp } from '@/lib/motion';
import { PhaseAddTaskMenu } from '../components';
import {
  useProjectPageData,
  useProjectPageTaskInteractions,
} from '../context';
import {
  filterProjectTasks,
  sortTasks,
} from '../utils';
import type { ProjectTaskOverlayActions } from './contracts';
import { useProjectTaskFilterOptions } from './useProjectTaskFilterOptions';

type TaskSortField = 'priority' | 'dueDate' | 'updated' | 'title';

const PROJECT_GROUP_OPTIONS: readonly GroupOption[] = DEFAULT_GROUP_OPTIONS.map((option) => (
  option.value === 'project'
    ? { value: 'phase', label: 'Phase' }
    : option
));

const PROJECT_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due Date' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'title', label: 'Alphabetical' },
];

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
  } = useProjectPageData();
  const {
    allProjects,
    completingIds,
    getTaskContextActions,
    myDayTaskIds,
    selectedTaskId,
    setDetailMode,
    setSelectedTaskId,
    toggleTask,
  } = useProjectPageTaskInteractions();

  const [taskFilterContext, setTaskFilterContext] = useState<TaskFilterContext>(
    EMPTY_TASK_FILTER_CONTEXT,
  );
  const [taskSortBy, setTaskSortBy] = useState<TaskSortField>('priority');
  const [taskSortDir, setTaskSortDir] = useState<'asc' | 'desc'>('asc');
  const [taskGroupBy, setTaskGroupBy] = useState('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [viewDensity, setViewDensity] = useState<ViewDensity>('comfortable');
  const [addTaskMenuOpen, setAddTaskMenuOpen] = useState(false);
  const taskFilterProjectIdRef = useRef(projectId);

  useEffect(() => {
    if (taskFilterProjectIdRef.current === projectId) return;
    taskFilterProjectIdRef.current = projectId;
    setTaskFilterContext(EMPTY_TASK_FILTER_CONTEXT);
    setCollapsedGroups(new Set());
  }, [projectId]);

  const {
    assignees: projectTaskAssignees,
    projects: projectTaskFilterProjects,
    sourceLists: projectTaskSourceLists,
    sources: projectTaskSources,
    tags: projectTaskTags,
  } = useProjectTaskFilterOptions({
    connectorLabels,
    phases,
    project,
    tasks,
  });
  const filteredTasks = useMemo(() => (
    sortTasks(
      filterProjectTasks(tasks, taskFilterContext, projectId),
      taskSortBy,
      taskSortDir,
    )
  ), [projectId, taskFilterContext, taskSortBy, taskSortDir, tasks]);
  const taskRows = useMemo(() => buildTaskListRows({
    taskResponse: {
      ...EMPTY_TASK_RESPONSE,
      tasks: filteredTasks,
      total: filteredTasks.length,
      hasMore: false,
    },
    groupBy: taskGroupBy,
    collapsedGroups,
    groupProjectId: projectId,
  }), [collapsedGroups, filteredTasks, projectId, taskGroupBy]);
  const filteredTaskById = useMemo(
    () => new Map(filteredTasks.map((task) => [task.id, task])),
    [filteredTasks],
  );
  const hasProjectTaskFilters = (
    countTaskFilters(taskFilterContext)
    - (taskFilterContext.completion === 'all' ? 1 : 0)
  ) > 0;
  const clearProjectTaskFilters = useCallback(() => {
    setTaskFilterContext((current) => ({
      ...EMPTY_TASK_FILTER_CONTEXT,
      completion: current.completion,
    }));
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
          <PhaseAddTaskMenu
            open={addTaskMenuOpen}
            onOpenChange={setAddTaskMenuOpen}
            trigger={(
              <Button>
                <Plus size={14} />
                Add task
                <ChevronDown size={14} />
              </Button>
            )}
            onCreateNew={() => {
              taskOverlayActions.requestCreateTask({ phaseId: null });
            }}
            onLinkExisting={() => {
              taskOverlayActions.requestLinkTasks({ phaseId: null });
            }}
          />
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
                <ViewDensityToggle value={viewDensity} onChange={setViewDensity} />
                <GroupByDropdown
                  options={PROJECT_GROUP_OPTIONS}
                  value={taskGroupBy}
                  onChange={(groupBy) => {
                    setTaskGroupBy(groupBy);
                    setCollapsedGroups(new Set());
                  }}
                />
                <SortDropdown
                  options={PROJECT_SORT_OPTIONS}
                  value={taskSortBy}
                  direction={taskSortDir}
                  onChange={(sortBy, direction) => {
                    setTaskSortBy(sortBy as TaskSortField);
                    setTaskSortDir(direction);
                  }}
                />
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
            <div
              role="list"
              aria-label="Project task list"
              className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)]"
            >
              {taskRows.map((row, index) => {
                if (row.type === 'header') {
                  const isCollapsed = collapsedGroups.has(row.label);
                  return (
                    <button
                      key={`header-${row.label}`}
                      type="button"
                      onClick={() => {
                        setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(row.label)) next.delete(row.label);
                          else next.add(row.label);
                          return next;
                        });
                      }}
                      className="flex w-full items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 py-2 text-left hover:bg-[var(--surface-1)]"
                    >
                      <span className={cn(
                        'text-xs text-[var(--text-muted)] transition-transform duration-150',
                        !isCollapsed && 'rotate-90',
                      )}>▶</span>
                      <span className="text-sm font-bold uppercase tracking-wide text-[var(--accent-400)]">{row.label}</span>
                      <span className="text-xs text-[var(--text-muted)]">({row.count})</span>
                    </button>
                  );
                }
                if (row.type !== 'task') return null;

                const task = filteredTaskById.get(row.task.id);
                if (!task) return null;
                const phaseName = task.projectPhaseMemberships?.find((membership) => (
                  membership.projectId === projectId
                ))?.phaseName || 'Unassigned';
                const contextActions = getTaskContextActions(task);
                return (
                  <TaskContextMenu
                    key={`${task.id}-${index}`}
                    task={{
                      id: task.id,
                      title: task.title,
                      status: task.status,
                      priority: task.priority,
                      connectorType: task.connectorType,
                      connectorInstanceId: task.connectorInstanceId,
                      sourceId: task.sourceId,
                      dueDate: task.dueDate,
                      localDisposition: task.localDisposition,
                      taskSourceModel: task.taskSourceModel,
                      editPolicy: task.editPolicy,
                    }}
                    isInMyDay={myDayTaskIds.has(task.id)}
                    projectPhases={phaseMenuItems}
                    projects={allProjects}
                    taskProjectIds={task.hubProjectIds}
                    taskProjectPhaseMemberships={task.projectPhaseMemberships}
                    actions={contextActions}
                  >
                    <div
                      role="listitem"
                      className="cursor-pointer"
                      onClick={() => toggleTask(task.id)}
                    >
                      <TaskRow
                        task={task}
                        onComplete={contextActions.onComplete}
                        onSetDueDate={(date) => {
                          if (date) contextActions.onPickDate(date);
                          else contextActions.onClearDueDate?.();
                        }}
                        onSetPriority={contextActions.onSetPriority}
                        onSetStatus={(status) => contextActions.onSetStatus?.(status)}
                        onSetLocalDisposition={(disposition) => (
                          contextActions.onSetLocalDisposition?.(disposition)
                        )}
                        onOpenNotes={() => {
                          setDetailMode('panel');
                          setSelectedTaskId(task.id);
                        }}
                        onAddToMyDay={() => contextActions.onAddToMyDay?.()}
                        onRemoveFromMyDay={() => contextActions.onRemoveFromMyDay?.()}
                        isInMyDay={myDayTaskIds.has(task.id)}
                        hideSourceListName={taskGroupBy === 'list'}
                        compact={viewDensity === 'compact'}
                        isCompleting={completingIds.has(task.id)}
                        isSelected={selectedTaskId === task.id}
                        showDivider={index < taskRows.length - 1}
                        secondaryMetadata={(
                          <span className="shrink-0 text-xs text-[var(--text-muted)]">
                            Phase: {phaseName}
                          </span>
                        )}
                        filterController={{
                          tagSlugs: taskFilterContext.tagSlugs,
                          projectId: null,
                          onToggleTag: (slug) => {
                            setTaskFilterContext((current) => updateTaskFilterContext(current, {
                              tagSlugs: current.tagSlugs.includes(slug)
                                ? current.tagSlugs.filter((tagSlug) => tagSlug !== slug)
                                : [...current.tagSlugs, slug],
                            }));
                          },
                          onFilterPriority: (priority) => {
                            setTaskFilterContext((current) => updateTaskFilterContext(current, {
                              priorities: [priority],
                            }));
                          },
                          onFilterStatus: (status) => {
                            setTaskFilterContext((current) => updateTaskFilterContext(current, {
                              statuses: [status],
                            }));
                          },
                        }}
                      />
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
