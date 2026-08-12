'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AnimatePresence } from 'motion/react';
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Pause,
  Plus,
  Search,
  Zap,
} from 'lucide-react';
import Image from 'next/image';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { ProjectModal } from '@/components/projects/ProjectModal';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ProjectHealth, ProjectProgress } from '@/types';
import { cn } from '@/lib/utils';
import { useSyncStream } from '@/lib/hooks/useSyncStream';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SidebarProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  category: string | null;
  status: string;
  progress: ProjectProgress;
  phaseCount?: number;
  metadata?: Record<string, unknown>;
}

interface CategoryGroup {
  category: string;
  projects: SidebarProject[];
}

interface ProjectsOverviewData {
  categories: CategoryGroup[];
  uncategorized: SidebarProject[];
  summary: {
    totalProjects: number;
    activeProjects: number;
    completedProjects: number;
    atRiskProjects: number;
  };
}

// ─── Sub-components ─────────────────────────────────────────────────────────

const HEALTH_LABELS: Record<ProjectHealth, string> = {
  on_track: 'On Track',
  at_risk: 'At Risk',
  behind: 'Behind',
};

function HealthDot({ health, status }: { health: ProjectHealth; status?: string }) {
  if (status === 'completed') {
    return (
      <Tooltip content="Completed">
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-sky-400/30 bg-sky-500/15 text-sky-400 shadow-sm shadow-sky-950/20 flex-shrink-0"
          aria-label="Completed"
        >
          <CheckCircle2 size={14} strokeWidth={2.5} />
        </span>
      </Tooltip>
    );
  }

  const color =
    health === 'on_track'
      ? 'var(--success)'
      : health === 'at_risk'
        ? 'var(--warning)'
        : 'var(--danger)';

  return (
    <Tooltip content={HEALTH_LABELS[health]}>
      <span
        className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
        aria-label={HEALTH_LABELS[health]}
      />
    </Tooltip>
  );
}

// ─── Status filter ────────────────────────────────────────────────────────────

type ProjectStatusValue = 'active' | 'completed' | 'not_started' | 'on_hold' | 'cancelled';

const STATUS_OPTIONS: { value: ProjectStatusValue; label: string; icon: typeof Zap; color: string; activeColor: string }[] = [
  { value: 'active', label: 'Active', icon: Zap, color: 'text-emerald-400', activeColor: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400' },
  { value: 'on_hold', label: 'On Hold', icon: Pause, color: 'text-amber-400', activeColor: 'bg-amber-500/15 border-amber-500/40 text-amber-400' },
  { value: 'not_started', label: 'Not Started', icon: Circle, color: 'text-zinc-400', activeColor: 'bg-zinc-500/15 border-zinc-500/40 text-zinc-400' },
  { value: 'cancelled', label: 'Cancelled', icon: Ban, color: 'text-rose-400', activeColor: 'bg-rose-500/15 border-rose-500/40 text-rose-400' },
  { value: 'completed', label: 'Done', icon: CheckCircle2, color: 'text-sky-400', activeColor: 'bg-sky-500/15 border-sky-500/40 text-sky-400' },
];

const STATUS_FILTER_KEY = 'projects-sidebar-status-filter';

function getInitialStatusFilter(): Set<ProjectStatusValue> {
  if (typeof window === 'undefined') return new Set();
  try {
    const stored = localStorage.getItem(STATUS_FILTER_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function StatusFilterPills({
  selected,
  onChange,
}: {
  selected: Set<ProjectStatusValue>;
  onChange: (next: Set<ProjectStatusValue>) => void;
}) {
  function toggle(value: ProjectStatusValue) {
    const next = new Set(selected);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    try { localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
    onChange(next);
  }

  return (
    <div className="flex justify-between mt-1.5">
      {STATUS_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const isSelected = selected.has(opt.value);
        return (
          <Tooltip key={opt.value} content={opt.label}>
            <button
              aria-label={opt.label}
              onClick={() => toggle(opt.value)}
              className={cn(
                'rounded-md p-1.5 transition-colors border',
                isSelected
                  ? opt.activeColor
                  : `bg-transparent border-[var(--border)] ${opt.color} opacity-60 hover:opacity-90`,
              )}
            >
              <Icon size={16} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ProjectItem({ project, isActive }: { project: SidebarProject; isActive: boolean }) {
  const phaseLabel = project.phaseCount !== undefined
    ? `${project.phaseCount} phase${project.phaseCount !== 1 ? 's' : ''} · `
    : '';
  const isSyncManaged = !!project.metadata?.syncManaged;
  const isCompleted = project.status === 'completed';

  return (
    <Link
      href={`/projects/${project.id}`}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-150',
        isActive
          ? 'bg-[var(--accent-500)]/10 border border-[var(--accent-500)]/20'
          : isCompleted
            ? 'border border-sky-500/10 bg-sky-500/[0.04] hover:bg-sky-500/[0.08]'
            : 'hover:bg-[var(--surface-2)] border border-transparent',
      )}
    >
      {isSyncManaged ? (
        <Image src="/icons/connectors/github.svg" alt="GitHub" width={12} height={12} className="flex-shrink-0 opacity-80" />
      ) : project.icon ? (
        <IconRenderer value={project.icon} size={16} color={project.color} />
      ) : (
        <span
          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: project.color }}
        />
      )}
      <div className="flex-1 min-w-0">
        <span
          className={cn(
            'block truncate text-sm font-medium',
            isActive ? 'text-[var(--accent-400)]' : 'text-[var(--text-primary)]',
          )}
        >
          {project.name}
        </span>
        <div
          className="my-1 h-px overflow-hidden rounded-full bg-[var(--surface-3)]"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${Math.min(100, Math.max(0, project.progress.percentComplete))}%`,
              backgroundColor: isCompleted ? 'rgb(56 189 248)' : project.color,
              opacity: isActive ? 0.9 : 0.55,
            }}
          />
        </div>
        <span className="text-[12px] text-[var(--text-muted)]">
          {phaseLabel}{project.progress.totalTasks} tasks · {project.progress.percentComplete}%
        </span>
      </div>
      <HealthDot health={project.progress.health} status={project.status} />
    </Link>
  );
}

// ─── Storage ────────────────────────────────────────────────────────────────

const CATEGORY_COLLAPSED_KEY = 'projects-sidebar-categories-collapsed';

function getInitialCollapsedCategories(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const stored = localStorage.getItem(CATEGORY_COLLAPSED_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

// ─── Main Sidebar ───────────────────────────────────────────────────────────

interface ProjectsSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function ProjectsSidebar({ collapsed, onCollapsedChange }: ProjectsSidebarProps) {
  const params = useParams();
  const router = useRouter();
  const activeProjectId = params?.id as string | undefined;
  const [data, setData] = useState<ProjectsOverviewData | null>(null);
  const [phaseCounts, setPhaseCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState(getInitialCollapsedCategories);
  const [statusFilter, setStatusFilter] = useState(getInitialStatusFilter);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const [overviewRes, phasesRes] = await Promise.all([
        fetch('/api/projects-overview'),
        fetch('/api/project-phases'),
      ]);

      if (overviewRes.ok) {
        const overviewData = await overviewRes.json();
        setData(overviewData);
      }

      if (phasesRes.ok) {
        const phasesData = await phasesRes.json();
        const counts: Record<string, number> = {};
        for (const phase of phasesData.phases || []) {
          if (phase.projectId) {
            counts[phase.projectId] = (counts[phase.projectId] || 0) + 1;
          }
        }
        setPhaseCounts(counts);
      }
    } catch {
      // Silently fail — sidebar is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [fetchData]);

  // Re-fetch when other components signal a project was updated (e.g. category change)
  useEffect(() => {
    const handler = () => void fetchData();
    window.addEventListener('projects-updated', handler);
    return () => window.removeEventListener('projects-updated', handler);
  }, [fetchData]);

  // Re-fetch when a sync completes (refetchKey increments)
  const { progress: syncProgress } = useSyncStream();
  const prevRefetchKeyRef = useRef(syncProgress.refetchKey);
  useEffect(() => {
    if (syncProgress.refetchKey > prevRefetchKeyRef.current) {
      prevRefetchKeyRef.current = syncProgress.refetchKey;
      const timeoutId = window.setTimeout(() => {
        void fetchData();
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [syncProgress.refetchKey, fetchData]);

  function toggleCollapsed() {
    onCollapsedChange(!collapsed);
  }

  function toggleCategory(category: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      try { localStorage.setItem(CATEGORY_COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  const enrichedData = useMemo(() => {
    if (!data) return null;

    const enrich = (projects: SidebarProject[]) =>
      projects.map((p) => ({ ...p, phaseCount: phaseCounts[p.id] || 0 }));

    return {
      ...data,
      categories: data.categories.map((cat) => ({ ...cat, projects: enrich(cat.projects) })),
      uncategorized: enrich(data.uncategorized),
    };
  }, [data, phaseCounts]);

  const filteredCategories = useMemo(() => {
    if (!enrichedData) return { categories: [], uncategorized: [] };

    const query = search.toLowerCase().trim();
    const hasStatusFilter = statusFilter.size > 0;
    const filterProjects = (projects: SidebarProject[]) => {
      let filtered = projects;
      if (query) {
        filtered = filtered.filter((p) => p.name.toLowerCase().includes(query));
      }
      if (hasStatusFilter) {
        filtered = filtered.filter((p) => statusFilter.has(p.status as ProjectStatusValue));
      }
      return filtered;
    };

    return {
      categories: enrichedData.categories
        .map((cat) => ({ ...cat, projects: filterProjects(cat.projects) }))
        .filter((cat) => cat.projects.length > 0),
      uncategorized: filterProjects(enrichedData.uncategorized),
    };
  }, [enrichedData, search, statusFilter]);

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────

  const allProjectIds = useMemo(() => {
    const ids: string[] = [];
    for (const cat of filteredCategories.categories) {
      for (const p of cat.projects) ids.push(p.id);
    }
    for (const p of filteredCategories.uncategorized) ids.push(p.id);
    return ids;
  }, [filteredCategories]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // '/' focuses search (when not in an input)
      const tag = (e.target as HTMLElement).tagName;
      const isEditable = ['INPUT', 'TEXTAREA'].includes(tag) || (e.target as HTMLElement).isContentEditable;
      if (e.key === '/' && !isEditable) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      // Arrow keys navigate projects (only when sidebar is not collapsed)
      if (collapsed || !activeProjectId || allProjectIds.length === 0) return;
      if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      if (isEditable) return;

      e.preventDefault();
      const currentIdx = allProjectIds.indexOf(activeProjectId);
      if (currentIdx === -1) return;

      const nextIdx = e.key === 'ArrowDown'
        ? Math.min(currentIdx + 1, allProjectIds.length - 1)
        : Math.max(currentIdx - 1, 0);

      if (nextIdx !== currentIdx) {
        router.push(`/projects/${allProjectIds[nextIdx]}`);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [collapsed, activeProjectId, allProjectIds, router]);

  // ─── Collapsed state ────────────────────────────────────────────────────────

  function expandAndFocusSearch() {
    onCollapsedChange(false);
    // Focus the search input after the sidebar expands
    setTimeout(() => searchRef.current?.focus(), 50);
  }

  if (collapsed) {
    return (
      <aside className="w-full h-full flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface-1)] flex flex-col items-center py-3 gap-2" aria-label="Projects navigation">
        <button
          onClick={toggleCollapsed}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
          aria-label="Expand sidebar"
        >
          <ChevronRight size={14} />
        </button>
        <Tooltip content="Search projects">
          <button
            onClick={expandAndFocusSearch}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Search projects"
          >
            <Search size={14} />
          </button>
        </Tooltip>
      </aside>
    );
  }

  // ─── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <aside className="w-full h-full flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface-1)] flex flex-col" aria-label="Projects navigation">
        <div className="p-4">
          <div className="h-4 w-20 animate-pulse rounded bg-[var(--surface-2)]" />
        </div>
        <div className="px-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-[var(--surface-2)]" />
          ))}
        </div>
      </aside>
    );
  }

  // ─── Full sidebar ───────────────────────────────────────────────────────────

  return (
    <>
      <aside className="w-full h-full flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface-1)] flex flex-col overflow-hidden max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-40 max-sm:shadow-xl" aria-label="Projects navigation">
        {/* Header */}
        <div className="p-3 pb-2 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
              Projects
            </h3>
            <div className="flex items-center gap-0.5">
              <Tooltip content="New Project">
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--accent-400)] transition-colors"
                >
                  <Plus size={12} />
                </button>
              </Tooltip>
              <Tooltip content="Collapse sidebar">
                <button
                  onClick={toggleCollapsed}
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
                  aria-label="Collapse sidebar"
                >
                  <ChevronLeft size={12} />
                </button>
              </Tooltip>
            </div>
          </div>
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter projects... (press /)"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] py-1.5 pl-7 pr-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
          <StatusFilterPills selected={statusFilter} onChange={setStatusFilter} />
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {/* All Projects overview link */}
          <Link
            href="/projects"
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-150',
              !activeProjectId
                ? 'bg-[var(--accent-500)]/10 border border-[var(--accent-500)]/20'
                : 'hover:bg-[var(--surface-2)] border border-transparent',
            )}
          >
            <span className="flex h-2.5 w-2.5 items-center justify-center">
              <span className="h-2 w-2 rounded-sm bg-[var(--text-muted)]" />
            </span>
            <span className={cn(
              'text-sm font-medium',
              !activeProjectId ? 'text-[var(--accent-400)]' : 'text-[var(--text-primary)]',
            )}>
              All Projects
            </span>
          </Link>

          {filteredCategories.categories.map((cat) => (
            <div key={cat.category}>
              <button
                onClick={() => toggleCategory(cat.category)}
                className="flex items-center gap-1.5 px-2 py-1 w-full text-left group hover:bg-[var(--surface-2)]/50 rounded transition-colors"
              >
                <ChevronDown
                  size={12}
                  className={cn(
                    'text-[var(--text-muted)] transition-transform duration-150',
                    collapsedCategories.has(cat.category) && '-rotate-90',
                  )}
                />
                <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  {cat.category}
                </span>
                {collapsedCategories.has(cat.category) && !search.trim() && (
                  <span className="ml-auto text-[11px] tabular-nums text-[var(--text-muted)] opacity-60">
                    {cat.projects.length}
                  </span>
                )}
              </button>
                {(!collapsedCategories.has(cat.category) || search.trim()) && (
                <div className="space-y-0.5">
                  {cat.projects.map((project) => (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      isActive={project.id === activeProjectId}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {filteredCategories.uncategorized.length > 0 && (
            <div>
              {filteredCategories.categories.length > 0 && (
                <button
                  onClick={() => toggleCategory('__uncategorized__')}
                  className="flex items-center gap-1.5 px-2 py-1 w-full text-left group hover:bg-[var(--surface-2)]/50 rounded transition-colors"
                >
                  <ChevronDown
                    size={12}
                    className={cn(
                      'text-[var(--text-muted)] transition-transform duration-150',
                      collapsedCategories.has('__uncategorized__') && '-rotate-90',
                    )}
                  />
                  <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                    Uncategorized
                  </span>
                  {collapsedCategories.has('__uncategorized__') && !search.trim() && (
                    <span className="ml-auto text-[11px] tabular-nums text-[var(--text-muted)] opacity-60">
                      {filteredCategories.uncategorized.length}
                    </span>
                  )}
                </button>
              )}
              {(!collapsedCategories.has('__uncategorized__') || search.trim()) && (
                <div className="space-y-0.5">
                  {filteredCategories.uncategorized.map((project) => (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      isActive={project.id === activeProjectId}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer stats */}
        {data?.summary && (
          <div className="border-t border-[var(--border)] bg-[var(--surface-0)]/50 p-3">
            <div className="grid grid-cols-3 gap-1 text-center">
              <div>
                <div className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{data.summary.activeProjects}</div>
                <div className="text-[12px] text-[var(--text-muted)]">Active</div>
              </div>
              <div>
                <div className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{data.summary.totalProjects}</div>
                <div className="text-[12px] text-[var(--text-muted)]">Total</div>
              </div>
              <div>
                <div className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{data.summary.atRiskProjects}</div>
                <div className="text-[12px] text-[var(--text-muted)]">At Risk</div>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* Create Project Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <ProjectModal
            onClose={() => setShowCreateModal(false)}
            onSaved={() => {
              setShowCreateModal(false);
              void fetchData();
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
