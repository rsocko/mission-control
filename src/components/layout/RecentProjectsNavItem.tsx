'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { ChevronDown, FolderKanban } from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { Tooltip } from '@/components/ui/Tooltip';
import { uiLogger } from '@/lib/client-logger';
import {
  addRecentProjectId,
  getProjectIdFromPathname,
  parseRecentProjectIds,
  RECENT_PROJECT_IDS_STORAGE_KEY,
} from '@/lib/navigation/recent-projects';
import { cn } from '@/lib/utils';

interface RecentProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
}

interface RecentProjectsNavItemProps {
  active: boolean;
  expanded: boolean;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor?: string;
  open: boolean;
  pathname: string;
  onOpenChange: (open: boolean) => void;
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.id === 'string'
    && typeof project.name === 'string'
    && typeof project.color === 'string'
    && (typeof project.icon === 'string' || project.icon === null)
  );
}

function readRecentIds(): string[] {
  try {
    return parseRecentProjectIds(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeRecentIds(ids: string[]) {
  try {
    localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Navigation history remains available for the current render when storage is unavailable.
  }
}

export function RecentProjectsNavItem({
  active,
  expanded,
  icon: Icon,
  iconColor,
  open,
  pathname,
  onOpenChange,
}: RecentProjectsNavItemProps) {
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const storedIds = readRecentIds();
    const currentProjectId = getProjectIdFromPathname(pathname);
    const nextIds = currentProjectId
      ? addRecentProjectId(storedIds, currentProjectId)
      : storedIds;

    setRecentIds(nextIds);
    if (currentProjectId) writeRecentIds(nextIds);
  }, [pathname]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === RECENT_PROJECT_IDS_STORAGE_KEY) {
        setRecentIds(parseRecentProjectIds(event.newValue));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const loadProjects = useCallback(async (signal: AbortSignal) => {
    if (recentIds.length === 0) {
      setProjects([]);
      setLoadState('ready');
      return;
    }

    setLoadState('loading');
    try {
      const response = await fetch('/api/hub-projects', { signal });
      if (!response.ok) {
        throw new Error(`Failed to load recent projects (${response.status})`);
      }

      const payload: unknown = await response.json();
      const rows = (
        payload
        && typeof payload === 'object'
        && Array.isArray((payload as Record<string, unknown>).projects)
      )
        ? (payload as { projects: unknown[] }).projects.filter(isRecentProject)
        : [];
      const projectsById = new Map(rows.map((project) => [project.id, project]));

      setProjects(
        recentIds
          .map((id) => projectsById.get(id))
          .filter((project): project is RecentProject => project !== undefined),
      );
      setLoadState('ready');
    } catch (error) {
      if (signal.aborted) return;
      setProjects([]);
      setLoadState('error');
      uiLogger.error('Failed to load recent projects navigation', { error });
    }
  }, [recentIds]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadProjects(controller.signal);
    return () => controller.abort();
  }, [loadProjects, open]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <div
        className={cn(
          'relative mx-2 flex h-10 items-center rounded-lg text-[13px] font-medium transition-colors duration-200',
          active
            ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
        )}
      >
        <Tooltip content="Projects" placement="right" disabled={expanded}>
          <Link
            href="/projects"
            aria-current={active ? 'page' : undefined}
            className="relative flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-1)]"
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-[var(--accent)]" />
            )}
            <span className="relative flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center">
              <Icon
                size={22}
                className={cn(
                  'flex-shrink-0',
                  iconColor && (active ? iconColor.replace('400', '300') : iconColor),
                )}
              />
            </span>
            <span
              className={cn(
                'overflow-hidden text-ellipsis whitespace-nowrap transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                expanded ? 'max-w-[112px] opacity-100' : 'max-w-0 opacity-0',
              )}
            >
              Projects
            </span>
          </Link>
        </Tooltip>

        {expanded && (
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Open recent projects"
              title="Recent projects"
              className="mr-1 flex h-8 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        )}
      </div>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Recent projects"
          className="z-50 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1.5 shadow-2xl"
        >
          <DropdownMenu.Label className="px-2.5 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Recently viewed
          </DropdownMenu.Label>

          {loadState === 'loading' && (
            <div className="px-2.5 py-3 text-xs text-[var(--text-muted)]" role="status">
              Loading recent projects…
            </div>
          )}
          {loadState === 'error' && (
            <div className="px-2.5 py-3 text-xs text-[var(--danger)]" role="status">
              Recent projects are unavailable.
            </div>
          )}
          {loadState === 'ready' && projects.length === 0 && (
            <div className="px-2.5 py-3 text-xs leading-5 text-[var(--text-muted)]">
              Projects you visit will appear here.
            </div>
          )}
          {loadState === 'ready' && projects.map((project) => (
            <DropdownMenu.Item key={project.id} asChild>
              <Link
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]"
              >
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                  <IconRenderer
                    value={project.icon}
                    size={16}
                    color={project.color}
                    fallback={<FolderKanban size={16} style={{ color: project.color }} />}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </Link>
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          <DropdownMenu.Item asChild>
            <Link
              href="/projects"
              className="flex cursor-default items-center rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--accent-400)] outline-none data-[highlighted]:bg-[var(--surface-2)]"
            >
              View all projects
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
