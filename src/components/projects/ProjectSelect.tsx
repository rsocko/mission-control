'use client';

import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Clock, FolderOpen, Search, X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconRenderer } from '@rsocko/icon-picker/renderer';
import {
  groupProjectTargets,
  saveRecentProjectTarget,
} from '@/lib/projects/project-targets';
import { cn } from '@/lib/utils';

export interface ProjectSelectOption {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  category?: string | null;
}

interface ProjectSelectProps {
  value: string;
  projects: ProjectSelectOption[];
  onValueChange: (projectId: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  title?: string;
  suggestedProjectIds?: string[];
  includeEmptyOption?: boolean;
  emptyLabel?: string;
  triggerClassName?: string;
  triggerPrefix?: ReactNode;
}

export function ProjectSelect({
  value,
  projects,
  onValueChange,
  ariaLabel,
  disabled = false,
  title,
  suggestedProjectIds = [],
  includeEmptyOption = false,
  emptyLabel = 'No project',
  triggerClassName,
  triggerPrefix,
}: ProjectSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedProject = projects.find((project) => project.id === value) ?? null;
  const suggestedProjectIdSet = useMemo(
    () => new Set(suggestedProjectIds),
    [suggestedProjectIds],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = useMemo(
    () => projects.filter((project) => (
      !normalizedQuery || project.name.toLocaleLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, projects],
  );
  const suggestedProjects = filteredProjects.filter((project) => suggestedProjectIdSet.has(project.id));
  const remainingProjects = filteredProjects.filter((project) => !suggestedProjectIdSet.has(project.id));
  const { recentProjects, categories } = groupProjectTargets(remainingProjects);

  function handleSelect(projectId: string) {
    if (projectId) saveRecentProjectTarget(projectId);
    onValueChange(projectId);
    setOpen(false);
    setQuery('');
  }

  function renderProject(project: ProjectSelectOption, recent = false) {
    const selected = project.id === value;
    return (
      <button
        key={project.id}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => handleSelect(project.id)}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        {recent && <Clock size={11} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />}
        {project.icon ? (
          <IconRenderer
            value={project.icon}
            size={14}
            color={project.color ?? undefined}
            fallback={<FolderOpen size={14} aria-hidden="true" />}
          />
        ) : (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--text-muted)]"
            style={project.color ? { backgroundColor: project.color } : undefined}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {selected && <Check size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          title={title}
          className={cn(
            'flex h-8 min-h-0 max-w-full items-center justify-between gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50',
            triggerClassName,
          )}
        >
          {triggerPrefix}
          <span className="min-w-0 truncate">
            {selectedProject ? selectedProject.name : emptyLabel}
          </span>
          <ChevronDown size={12} className="shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className="z-[210] w-[min(22rem,var(--radix-popover-content-available-width))] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-[var(--shadow-lg)]"
        >
          <div className="flex h-9 items-center gap-2 border-b border-[var(--border-subtle)] px-2">
            <Search size={13} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return;
                const firstOption = listRef.current?.querySelector<HTMLButtonElement>(
                  '[role="option"]:not(:disabled)',
                );
                if (!firstOption) return;
                event.preventDefault();
                firstOption.focus();
              }}
              placeholder="Search projects..."
              aria-label="Search projects"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear project search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
              );
              if (options.length === 0) return;
              const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
              let nextIndex: number;
              if (event.key === 'Home') nextIndex = 0;
              else if (event.key === 'End') nextIndex = options.length - 1;
              else if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, options.length - 1);
              else nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
              event.preventDefault();
              options[nextIndex]?.focus();
            }}
            className="max-h-64 overflow-y-auto overscroll-contain p-1"
          >
            {includeEmptyOption && !normalizedQuery && (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => handleSelect('')}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{emptyLabel}</span>
                {!value && <Check size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
              </button>
            )}
            {suggestedProjects.length > 0 && (
              <ProjectGroup label="Suggested">
                {suggestedProjects.map((project) => renderProject(project))}
              </ProjectGroup>
            )}
            {recentProjects.length > 0 && (
              <ProjectGroup label="Recent">
                {recentProjects.map((project) => renderProject(project, true))}
              </ProjectGroup>
            )}
            {categories.map(({ category, projects: categoryProjects }) => (
              <ProjectGroup key={category || '__uncategorized'} label={category || 'Uncategorized'}>
                {categoryProjects.map((project) => renderProject(project))}
              </ProjectGroup>
            ))}
            {filteredProjects.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-[var(--text-muted)]">
                No projects match &ldquo;{query.trim()}&rdquo;.
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProjectGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-[var(--border-subtle)] first:border-t-0">
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}
