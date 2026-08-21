'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Clock, FolderOpen, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  Select,
  SelectGroup,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from '@/components/ui/select';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import {
  groupProjectTargets,
  saveRecentProjectTarget,
} from '@/lib/projects/project-targets';
import { cn } from '@/lib/utils';
import { taskPhaseInProject } from './useTaskDetailData';
import type { HubProject, TaskDetailMode } from './task-detail-types';

export interface TaskProjectAssignmentSectionProps {
  mode: TaskDetailMode;
  taskId: string;
  /** Projects the task is assigned to, in assignment order. */
  projectIds: string[];
  /** Every known project, including hidden ones, used to resolve names. */
  hubProjects: HubProject[];
  /** Projects that may be newly assigned (hidden projects excluded). */
  assignableProjects: HubProject[];
  /** Phase snapshot per project; null means phases failed to load. */
  projectHierarchies: Record<string, ProjectHierarchySnapshot | null>;
  /** Projects with an in-flight phase change. */
  updatingProjectPhaseIds: Set<string>;
  canEditProjects: boolean;
  canEditPhases: boolean;
  /** Explains why projects cannot be edited, when they cannot. */
  projectsBlockedReason?: string;
  projectsSaveLabel?: string;
  onAddProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onProjectPhaseChange: (projectId: string, phaseId: string | null) => void;
}

/** Hub project assignments and their phase placement. */
export function TaskProjectAssignmentSection({
  mode,
  taskId,
  projectIds,
  hubProjects,
  assignableProjects,
  projectHierarchies,
  updatingProjectPhaseIds,
  canEditProjects,
  canEditPhases,
  projectsBlockedReason,
  projectsSaveLabel,
  onAddProject,
  onRemoveProject,
  onProjectPhaseChange,
}: TaskProjectAssignmentSectionProps) {
  const allProjectsAdded = assignableProjects.every((project) => projectIds.includes(project.id));
  const availableProjects = assignableProjects.filter((project) => !projectIds.includes(project.id));
  const { recentProjects, categories } = groupProjectTargets(availableProjects);

  function handleAddProject(projectId: string) {
    saveRecentProjectTarget(projectId);
    onAddProject(projectId);
  }

  function renderProject(project: HubProject, recent = false) {
    return (
      <SelectItem key={project.id} value={project.id}>
        <span className="inline-flex items-center gap-1.5">
          {recent && <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />}
          <IconRenderer value={project.icon} size={14} color={project.color} fallback={<span>📁</span>} />
          {project.name}
        </span>
      </SelectItem>
    );
  }

  return (
    <section className={cn(
      'overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
      (mode === 'panel' || mode === 'mobile') && 'order-3',
      mode === 'dialog' && 'col-start-2 row-start-2',
      mode === 'workspace' && 'col-start-2 row-start-2',
    )}>
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Projects &amp; phases</h3>
        <Select
          value=""
          onValueChange={handleAddProject}
          disabled={!canEditProjects || allProjectsAdded}
        >
          <SelectTrigger
            aria-label="Add project"
            variant="inline"
            className="min-h-8"
            title={!canEditProjects
              ? projectsBlockedReason
              : allProjectsAdded
                ? 'All projects added'
                : projectsSaveLabel}
          >
            <span className="flex items-center gap-1"><Plus size={11} />Add project</span>
          </SelectTrigger>
          <SelectContent>
            {recentProjects.length > 0 && (
              <>
                <SelectGroup>
                  <SelectLabel className="text-xs uppercase tracking-wider">Recent</SelectLabel>
                  {recentProjects.map((project) => renderProject(project, true))}
                </SelectGroup>
                <SelectSeparator />
              </>
            )}
            {categories.map(({ category, projects: categoryProjects }, index) => (
              <SelectGroup key={category || '__uncategorized'}>
                {index > 0 && <SelectSeparator />}
                <SelectLabel className="text-xs uppercase tracking-wider">
                  {category || 'Uncategorized'}
                </SelectLabel>
                {categoryProjects.map((project) => renderProject(project))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2 p-3">
        {projectIds.length === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">No projects</p>
        ) : projectIds.map((projectId) => {
          const project = hubProjects.find((candidate) => candidate.id === projectId);
          if (!project) return null;
          const hierarchy = projectHierarchies[projectId];
          const updating = updatingProjectPhaseIds.has(projectId);
          return (
            <div key={projectId} className="flex min-h-12 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5">
              <IconRenderer value={project.icon} size={14} color={project.color} fallback={<FolderOpen size={14} />} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-[var(--text-secondary)]">{project.name}</div>
                <div className="truncate text-[10px] text-[var(--text-muted)]">
                  Phase: <strong className="font-medium text-[var(--text-secondary)]">
                    {hierarchy
                      ? taskPhaseInProject(hierarchy, taskId)?.name ?? 'No phase'
                      : hierarchy === null ? 'Unavailable' : 'Loading...'}
                  </strong>
                </div>
              </div>
              {canEditProjects && canEditPhases && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      disabled={updating}
                      className="flex min-h-8 min-w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Edit phase for ${project.name}`}
                    >
                      {updating
                        ? <Loader2 size={12} className="animate-spin" />
                        : <ChevronDown size={12} />}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={4}
                      className="z-[130] min-w-52 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-2xl"
                    >
                      <DropdownMenu.Label className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                        Assign phase
                      </DropdownMenu.Label>
                      {hierarchy ? (
                        <DropdownMenu.RadioGroup
                          value={taskPhaseInProject(hierarchy, taskId)?.id ?? '__no_phase__'}
                          onValueChange={(value) => onProjectPhaseChange(
                            projectId,
                            value === '__no_phase__' ? null : value,
                          )}
                        >
                          <DropdownMenu.RadioItem
                            value="__no_phase__"
                            className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-[var(--text-secondary)] outline-none focus:bg-[var(--surface-2)]"
                          >
                            <span className="w-3">
                              <DropdownMenu.ItemIndicator><Check size={12} /></DropdownMenu.ItemIndicator>
                            </span>
                            No phase
                          </DropdownMenu.RadioItem>
                          {hierarchy.phases.map((phase) => (
                            <DropdownMenu.RadioItem
                              key={phase.id}
                              value={phase.id}
                              className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-[var(--text-secondary)] outline-none focus:bg-[var(--surface-2)]"
                            >
                              <span className="w-3">
                                <DropdownMenu.ItemIndicator><Check size={12} /></DropdownMenu.ItemIndicator>
                              </span>
                              {phase.name}
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      ) : (
                        <DropdownMenu.Item
                          disabled
                          className="flex min-h-9 cursor-not-allowed items-center rounded-lg px-2 text-xs text-[var(--text-muted)] opacity-60"
                        >
                          Phases unavailable
                        </DropdownMenu.Item>
                      )}
                      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
                      <DropdownMenu.Item
                        onSelect={() => onRemoveProject(projectId)}
                        className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-red-400 outline-none focus:bg-red-500/10"
                      >
                        <Trash2 size={12} />
                        Remove project
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
