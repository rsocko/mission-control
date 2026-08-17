'use client';

import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import type { ProjectHealth } from '@/types';
import { BurnReportCard } from '@/components/projects/BurnReportCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import {
  PhaseStatusBadge,
  ProjectOverviewKpis,
  TaskDisplayId,
  TaskInfoBadges,
  TaskStatusBadge,
} from '../components';
import {
  useProjectPageData,
  useProjectPageTaskInteractions,
} from '../context';
import {
  formatDateLabel,
  formatRelativeTime,
  getConnectorIcon,
  getHealthSummary,
  getPhaseColor,
} from '../utils';

interface ProjectOverviewTabProps {
  /** True while this tab is the visible Activity boundary. */
  active: boolean;
  /** Opens the Plan tab, revealing `phaseId` when one is supplied. */
  onOpenPhase: (phaseId: string | null) => void;
}

export function ProjectOverviewTab({ active, onOpenPhase }: ProjectOverviewTabProps) {
  const {
    phaseEntries,
    phases,
    progress,
    project,
    projectId,
    reportRefreshKey,
    tasks,
  } = useProjectPageData();
  const {
    handleGraphTaskSelect,
    selectedTaskId,
    toggleTask,
  } = useProjectPageTaskInteractions();

  const health = useMemo(() => {
    if (!project) {
      return { health: 'on_track' as ProjectHealth, message: 'Loading health…' };
    }
    return getHealthSummary(project, phases, tasks, progress);
  }, [phases, progress, project, tasks]);

  const recentActivity = useMemo(
    () => [...tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, 4),
    [tasks],
  );

  const lastUpdated = useMemo(() => {
    const timestamps = [project?.updatedAt, ...phases.map((phase) => phase.updatedAt), ...tasks.map((task) => task.updatedAt)]
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => !Number.isNaN(value));
    return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
  }, [phases, project?.updatedAt, tasks]);

  // The Activity boundary keeps this tab mounted so its derivations stay warm,
  // but only the active tab contributes markup.
  if (!active || !project) return null;

  return (
    <motion.section variants={fadeSlideUp} className="space-y-6">
      <ProjectOverviewKpis progress={progress} health={health} />

      <BurnReportCard
        projectId={projectId}
        scopeName={project.name}
        refreshKey={reportRefreshKey}
        onTaskSelect={handleGraphTaskSelect}
      />

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
            <CardDescription>Project context and current direction.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6 text-[var(--text-secondary)] text-pretty">
              {project.description || 'No project description has been added yet.'}
            </p>
            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">Progress snapshot</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Completion rolls up from all tasks currently assigned to this project.</p>
                </div>
                <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{progress.percentComplete}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${progress.percentComplete}%`, backgroundColor: project.color }} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest task updates plus overall freshness.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-secondary)]">
              Last updated <span className="font-medium text-[var(--text-primary)]">{formatRelativeTime(lastUpdated)}</span>
            </div>
            <div className="space-y-2">
              {recentActivity.length === 0 ? (
                <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
                  No recent task activity yet.
                </div>
              ) : (
                recentActivity.map((task) => {
                  const ConnectorIcon = getConnectorIcon(task.connectorType);
                  return (
                    <div
                      key={task.id}
                      className={cn(
                        'flex min-h-10 items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                        selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                      )}
                      onClick={() => toggleTask(task.id)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                          <p className="truncate text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
                          <TaskDisplayId task={task} />
                          <TaskInfoBadges task={task} />
                        </div>
                        <p className="mt-1 text-xs text-[var(--text-tertiary)]">Updated {formatRelativeTime(task.updatedAt)}</p>
                      </div>
                      <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Phase progress</CardTitle>
            <CardDescription>Status of each project phase.</CardDescription>
          </CardHeader>
          <CardContent>
            {phases.length === 0 ? (
              <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
                No phases defined yet. <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => onOpenPhase(null)}>Set up phases →</button>
              </div>
            ) : (
              <div className="space-y-3">
                {phases.map((phase) => {
                  const entries = phaseEntries[phase.id] ?? [];
                  const doneTasks = entries.filter(({ task }) => task.status === 'done').length;
                  const pct = entries.length > 0 ? Math.round((doneTasks / entries.length) * 100) : 0;
                  const phaseColor = getPhaseColor(phase, project);
                  return (
                    <button
                      key={phase.id}
                      type="button"
                      onClick={() => onOpenPhase(phase.id)}
                      className="block w-full space-y-1.5 rounded-[var(--radius-md)] p-1 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                      aria-label={`Open ${phase.name} in Plan`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: phaseColor }} />
                          <span className="text-sm font-medium text-[var(--text-primary)]">{phase.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <PhaseStatusBadge status={phase.status} />
                          <span className="text-xs text-[var(--text-tertiary)] tabular-nums">{doneTasks}/{entries.length}</span>
                        </div>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%`, backgroundColor: phaseColor }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Key dates</CardTitle>
            <CardDescription>Current schedule anchors for the project lifecycle.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
              <span className="text-sm text-[var(--text-secondary)]">Started</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.startedAt)}</span>
            </div>
            <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
              <span className="text-sm text-[var(--text-secondary)]">Target date</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.targetDate)}</span>
            </div>
            <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
              <span className="text-sm text-[var(--text-secondary)]">Completed</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.completedAt)}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </motion.section>
  );
}
