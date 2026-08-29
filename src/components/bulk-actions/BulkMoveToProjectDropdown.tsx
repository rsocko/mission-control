'use client';

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight, Clock, FolderKanban, Layers3, Loader2 } from 'lucide-react';
import {
  groupProjectTargets,
  saveRecentProjectTarget,
} from '@/lib/projects/project-targets';
import type { DashboardProjectViewModel as HubProject } from '@/types/dashboard';

interface BulkMoveToProjectDropdownProps {
  projects: HubProject[];
  onMove: (projectId: string, phaseId: string | null) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

const itemClassName = 'flex min-h-8 cursor-default items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-xs text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-2)]';
const contentClassName = 'z-50 min-w-52 max-h-72 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-1)] p-1 shadow-lg';

export function BulkMoveToProjectDropdown({
  projects,
  onMove,
  disabled = false,
  disabledReason,
}: BulkMoveToProjectDropdownProps) {
  const [moving, setMoving] = useState(false);
  const { recentProjects, categories } = groupProjectTargets(projects);
  const isDisabled = disabled || projects.length === 0 || moving;

  function handleSelect(projectId: string, phaseId: string | null) {
    saveRecentProjectTarget(projectId);
    setMoving(true);
    void onMove(projectId, phaseId).finally(() => setMoving(false));
  }

  function renderProject(project: HubProject, recent = false) {
    const phases = project.phases ?? [];
    const projectLabel = (
      <>
        {recent && <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />}
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: project.color }}
        />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </>
    );

    if (phases.length === 0) {
      return (
        <DropdownMenu.Item
          key={project.id}
          className={itemClassName}
          onSelect={() => handleSelect(project.id, null)}
        >
          {projectLabel}
        </DropdownMenu.Item>
      );
    }

    return (
      <DropdownMenu.Sub key={project.id}>
        <DropdownMenu.SubTrigger className={itemClassName}>
          {projectLabel}
          <ChevronRight size={12} className="shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent sideOffset={4} className={contentClassName}>
            <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Move to {project.name}
            </DropdownMenu.Label>
            <DropdownMenu.Item
              className={itemClassName}
              onSelect={() => handleSelect(project.id, null)}
            >
              <FolderKanban size={12} className="shrink-0 text-[var(--text-muted)]" />
              No phase
            </DropdownMenu.Item>
            {phases.map((phase) => (
              <DropdownMenu.Item
                key={phase.id}
                className={itemClassName}
                onSelect={() => handleSelect(project.id, phase.id)}
              >
                <Layers3 size={12} className="shrink-0 text-[var(--text-muted)]" />
                {phase.name}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Project / phase"
          disabled={isDisabled}
          title={disabled ? disabledReason : projects.length === 0 ? 'No projects available' : undefined}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-purple-800/40 bg-purple-900/30 px-2 py-1 text-xs text-purple-300 transition-colors duration-100 hover:bg-purple-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {moving
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : <FolderKanban size={12} aria-hidden="true" />}
          {moving ? 'Moving...' : 'Project / phase'}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={contentClassName}>
          {recentProjects.length > 0 && (
            <>
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Recent
              </DropdownMenu.Label>
              {recentProjects.map((project) => renderProject(project, true))}
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
            </>
          )}
          {categories.map(({ category, projects: categoryProjects }, index) => (
            <div key={category || '__uncategorized'}>
              {index > 0 && <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />}
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {category || 'Projects'}
              </DropdownMenu.Label>
              {categoryProjects.map((project) => renderProject(project))}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
