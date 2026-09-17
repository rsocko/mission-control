'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Layers,
  Search,
} from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker';
import {
  buildCategoryPortfolioRows,
  buildDeadlineRunway,
} from '@/lib/projects-overview/visuals';
import type { ProjectProgress } from '@/types';

export interface ProjectPhaseSummary {
  id: string;
  name: string;
  status: string;
  color: string | null;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  percentComplete: number;
}

export interface PortfolioProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  category: string | null;
  status: string;
  progress: ProjectProgress;
  phases: ProjectPhaseSummary[];
  targetDate: string | null;
}

export interface PortfolioSummary {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  atRiskProjects: number;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  portfolioPercent: number;
  completedThisWeek: number;
}

type DashboardView = 'overview' | 'health' | 'timeline';

interface CategoryGroup {
  category: string;
  projects: PortfolioProject[];
}

const DEFAULT_CATEGORY_LIMIT = 8;

function healthRank(project: PortfolioProject): number {
  if (project.progress.health === 'behind') return 0;
  if (project.progress.health === 'at_risk') return 1;
  return 2;
}

function activityTime(project: PortfolioProject): number {
  return Date.parse(project.progress.lastActivity ?? '') || 0;
}

function healthLabel(project: PortfolioProject): string {
  if (project.progress.pulse?.state === 'off_track') return 'Off track';
  if (project.progress.pulse?.state === 'watch') return 'Watch';
  if (project.progress.pulse?.state === 'unknown') return 'Unknown';
  if (project.progress.health === 'behind') return 'Behind';
  if (project.progress.health === 'at_risk') return 'At risk';
  return 'On track';
}

function healthColor(project: PortfolioProject): string {
  if (project.progress.health === 'behind') return 'var(--danger)';
  if (project.progress.health === 'at_risk') return 'var(--warning)';
  return 'var(--success)';
}

function formatTargetDate(value: string | null): string {
  if (!value) return 'No target';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'No target';
  return new Date(parsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function categoryGroups(
  categories: CategoryGroup[],
  uncategorized: PortfolioProject[],
): CategoryGroup[] {
  return uncategorized.length > 0
    ? [...categories, { category: 'Uncategorized', projects: uncategorized }]
    : categories;
}

function CategoryRings({
  categories,
  selectedCategory,
  showAll,
  onSelect,
  onShowAll,
}: {
  categories: CategoryGroup[];
  selectedCategory: string | null;
  showAll: boolean;
  onSelect: (category: string) => void;
  onShowAll: () => void;
}) {
  const rows = buildCategoryPortfolioRows(categories, []);
  const projectsByCategory = new Map(categories.map(group => [group.category, group.projects]));
  const visibleRows = showAll ? rows : rows.slice(0, DEFAULT_CATEGORY_LIMIT);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">By category</h2>
          <p className="mt-0.5 text-[9px] text-[var(--text-muted)]">
            Outer ring: task completion · Inner ring: project health
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[9px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-3 rounded-full bg-[var(--accent-500)]" />
            Task completion
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full bg-[linear-gradient(90deg,var(--success)_0_50%,var(--warning)_50%_75%,var(--danger)_75%)]" />
            Project health
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
        {visibleRows.map((row) => {
          const projects = projectsByCategory.get(row.category) ?? [];
          const onTrackEnd = row.projectCount > 0 ? (row.health.on_track / row.projectCount) * 100 : 0;
          const atRiskEnd = row.projectCount > 0
            ? ((row.health.on_track + row.health.at_risk) / row.projectCount) * 100
            : 0;
          const selected = selectedCategory === row.category;
          const ringLabel = `${row.category}: ${row.percentComplete}% of tasks complete; ${row.health.on_track} on track, ${row.health.at_risk} at risk, ${row.health.behind} behind`;

          return (
            <button
              key={row.category}
              type="button"
              onClick={() => onSelect(row.category)}
              aria-label={ringLabel}
              aria-pressed={selected}
              className={`group min-w-0 border-b border-r border-[var(--border)] px-3 py-4 text-center transition-colors last:border-r-0 hover:bg-[var(--surface-2)]/40 focus-visible:relative ${
                selected ? 'bg-[var(--surface-2)]/60' : ''
              }`}
            >
              <span
                role="img"
                aria-label={ringLabel}
                className="relative mx-auto block h-24 w-24 rounded-full"
                style={{
                  background: `conic-gradient(${projects[0]?.color ?? 'var(--accent-500)'} 0 ${row.percentComplete}%, var(--surface-2) ${row.percentComplete}% 100%)`,
                }}
              >
                <span className="absolute inset-2 rounded-full bg-[var(--surface-1)] transition-colors group-hover:bg-[var(--surface-1)]" />
                <span
                  className="absolute inset-[14px] rounded-full"
                  style={{
                    background: `conic-gradient(var(--success) 0 ${onTrackEnd}%, var(--warning) ${onTrackEnd}% ${atRiskEnd}%, var(--danger) ${atRiskEnd}% 100%)`,
                  }}
                />
                <span className="absolute inset-5 rounded-full bg-[var(--surface-1)]" />
                <span className="absolute inset-[27px] flex flex-col items-center justify-center rounded-full bg-[var(--surface-0)]">
                  <strong className="text-base font-bold tabular-nums text-[var(--text-primary)]">{row.percentComplete}%</strong>
                  <span className="mt-0.5 text-[9px] uppercase tracking-wider text-[var(--text-muted)]">tasks</span>
                </span>
              </span>
              <span className="mt-2 block truncate text-xs font-semibold text-[var(--text-secondary)]">{row.category}</span>
              <span className="mt-0.5 block text-[9px] tabular-nums text-[var(--text-muted)]">
                {row.projectCount} project{row.projectCount === 1 ? '' : 's'} · {row.totalTasks} tasks
              </span>
              <span className="mt-1 block truncate text-[9px] text-[var(--text-secondary)]">
                {row.health.on_track} on track
                {row.health.at_risk > 0 ? ` · ${row.health.at_risk} at risk` : ''}
                {row.health.behind > 0 ? ` · ${row.health.behind} behind` : ''}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2 text-[9px] text-[var(--text-muted)]">
        <span>Select a category to drill into its projects and phases.</span>
        <span className="flex items-center gap-2">
          {selectedCategory && (
            <>
              <span>Showing {selectedCategory}</span>
              <button
                type="button"
                onClick={onShowAll}
                className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                All categories
              </button>
            </>
          )}
          {hiddenCount > 0 && !selectedCategory && (
            <button
              type="button"
              onClick={onShowAll}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-2 py-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Show {hiddenCount} more
              <ChevronDown size={11} />
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

function PhaseRail({ project }: { project: PortfolioProject }) {
  if (project.phases.length === 0) {
    return (
      <Link
        href={`/projects/${encodeURIComponent(project.id)}?tab=phases`}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-dashed border-[var(--border-strong)] px-2 text-[9px] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
      >
        <CircleDashed size={11} />
        No phases yet
      </Link>
    );
  }

  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto pb-1">
      {project.phases.slice(0, 4).map((phase) => (
        <Link
          key={phase.id}
          href={`/projects/${encodeURIComponent(project.id)}?tab=phases&phase=${encodeURIComponent(phase.id)}`}
          aria-label={`Open ${phase.name} phase in ${project.name}`}
          className={`relative min-w-[76px] flex-1 overflow-hidden rounded-md border px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)] ${
            phase.status === 'in_progress'
              ? 'border-[var(--border-focus)] bg-[var(--accent-500)]/[0.06] text-blue-200'
              : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)]'
          }`}
        >
          <span className="block truncate text-[9px] font-semibold">{phase.name}</span>
          <span className="mt-0.5 block text-[9px] tabular-nums text-[var(--text-muted)]">
            {phase.completedTasks}/{phase.totalTasks}
          </span>
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--surface-3)]">
            <span
              className="block h-full"
              style={{
                width: `${phase.percentComplete}%`,
                backgroundColor: phase.color ?? project.color,
              }}
            />
          </span>
        </Link>
      ))}
      {project.phases.length > 4 && (
        <Link
          href={`/projects/${encodeURIComponent(project.id)}?tab=phases`}
          className="flex min-w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-0)] text-[9px] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
        >
          +{project.phases.length - 4}
        </Link>
      )}
    </div>
  );
}

function ProjectRow({ project }: { project: PortfolioProject }) {
  const pulse = project.progress.pulse;
  const secondary = pulse?.freshness.label ?? `${Math.max(0, project.progress.totalTasks - project.progress.completedTasks)} open tasks`;

  return (
    <div className="grid gap-3 border-b border-[var(--border-subtle)] px-3 py-3 last:border-b-0 lg:grid-cols-[minmax(190px,1.15fr)_minmax(260px,1.6fr)_92px_82px] lg:items-center">
      <Link
        href={`/projects/${encodeURIComponent(project.id)}`}
        className="group flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
          style={{
            color: project.color,
            borderColor: `color-mix(in srgb, ${project.color} 20%, transparent)`,
            backgroundColor: `color-mix(in srgb, ${project.color} 12%, transparent)`,
          }}
        >
          <IconRenderer value={project.icon} size={15} color={project.color} fallback={<Layers size={15} />} />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-[var(--text-primary)] group-hover:text-blue-300">{project.name}</span>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: healthColor(project) }} />
          </span>
          <span className="mt-1 block truncate text-[9px] text-[var(--text-muted)]">
            {project.progress.totalTasks} tasks · {healthLabel(project)} · {secondary}
          </span>
        </span>
      </Link>

      <PhaseRail project={project} />

      <div className="flex items-center gap-2">
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
          <span className="block h-full rounded-full" style={{ width: `${project.progress.percentComplete}%`, backgroundColor: project.color }} />
        </span>
        <span className="w-8 text-right text-[9px] tabular-nums text-[var(--text-secondary)]">{project.progress.percentComplete}%</span>
      </div>

      <span className={`text-[9px] tabular-nums ${
        project.progress.health === 'behind' ? 'text-red-400' : project.progress.health === 'at_risk' ? 'text-amber-400' : 'text-[var(--text-muted)]'
      }`}>
        {formatTargetDate(project.targetDate)}
      </span>
    </div>
  );
}

function ProjectMatrix({
  groups,
  selectedCategory,
  attentionOnly,
  search,
  onSelectCategory,
}: {
  groups: CategoryGroup[];
  selectedCategory: string | null;
  attentionOnly: boolean;
  search: string;
  onSelectCategory: (category: string) => void;
}) {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleGroups = groups
    .filter(group => !selectedCategory || group.category === selectedCategory)
    .map(group => ({
      ...group,
      projects: [...group.projects]
        .filter(project => !attentionOnly || project.progress.health !== 'on_track')
        .filter((project) => {
          if (!normalizedSearch) return true;
          return [group.category, project.name, ...project.phases.map(phase => phase.name)]
            .some(value => value.toLocaleLowerCase().includes(normalizedSearch));
        })
        .sort((a, b) => healthRank(a) - healthRank(b) || activityTime(b) - activityTime(a) || a.name.localeCompare(b.name)),
    }))
    .filter(group => group.projects.length > 0);
  const projectCount = visibleGroups.reduce((sum, group) => sum + group.projects.length, 0);

  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {attentionOnly ? 'Projects requiring attention' : selectedCategory ? `${selectedCategory} projects` : 'Portfolio by category'}
          </h2>
          <p className="mt-0.5 text-[9px] text-[var(--text-muted)]">
            {attentionOnly
              ? 'At-risk and behind projects, grouped for intervention.'
              : 'Open a category, project, or phase directly from the matrix.'}
          </p>
        </div>
        <span className="text-[9px] tabular-nums text-[var(--text-muted)]">{projectCount} projects</span>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-5 py-8 text-center">
          <Search size={20} className="mx-auto text-[var(--text-muted)]" />
          <p className="mt-2 text-xs font-semibold text-[var(--text-primary)]">No matching projects</p>
          <p className="mt-1 text-[9px] text-[var(--text-muted)]">Try another project, phase, or category name.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleGroups.map((group) => {
            const totalTasks = group.projects.reduce((sum, project) => sum + project.progress.totalTasks, 0);
            const completedTasks = group.projects.reduce((sum, project) => sum + project.progress.completedTasks, 0);
            const completion = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            const attention = group.projects.filter(project => project.progress.health !== 'on_track').length;

            return (
              <section key={group.category} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <button
                  type="button"
                  onClick={() => onSelectCategory(group.category)}
                  className="grid min-h-14 w-full grid-cols-[minmax(150px,1fr)_82px_110px_18px] items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-0)] px-3 text-left transition-colors hover:bg-[var(--surface-2)]/30"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: group.projects[0]?.color }} />
                    <span className="min-w-0">
                      <strong className="block truncate text-xs text-[var(--text-primary)]">{group.category}</strong>
                      <span className="mt-0.5 block text-[9px] text-[var(--text-muted)]">
                        {attention > 0 ? `${attention} need attention` : 'All projects on track'}
                      </span>
                    </span>
                  </span>
                  <span className="hidden sm:block">
                    <span className="block text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Projects</span>
                    <strong className="mt-0.5 block text-xs tabular-nums">{group.projects.length} active</strong>
                  </span>
                  <span>
                    <span className="block text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Completion</span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                        <span className="block h-full" style={{ width: `${completion}%`, backgroundColor: group.projects[0]?.color }} />
                      </span>
                      <span className="w-7 text-right text-[9px] tabular-nums text-[var(--text-secondary)]">{completion}%</span>
                    </span>
                  </span>
                  <ArrowRight size={13} className="text-[var(--text-muted)]" />
                </button>
                <div className="hidden h-7 grid-cols-[minmax(190px,1.15fr)_minmax(260px,1.6fr)_92px_82px] items-center gap-3 border-b border-[var(--border-subtle)] px-3 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)] lg:grid">
                  <span>Project</span><span>Active phases</span><span>Progress</span><span>Target</span>
                </div>
                {group.projects.map(project => <ProjectRow key={project.id} project={project} />)}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AttentionPanel({ groups }: { groups: CategoryGroup[] }) {
  const projects = groups
    .flatMap(group => group.projects.map(project => ({ ...project, category: group.category })))
    .filter(project => project.progress.health !== 'on_track')
    .sort((a, b) => healthRank(a) - healthRank(b) || activityTime(a) - activityTime(b));

  if (projects.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3">
        <CheckCircle2 size={17} className="text-emerald-400" />
        <div>
          <p className="text-xs font-semibold text-emerald-300">Everything is on track</p>
          <p className="mt-0.5 text-[9px] text-emerald-200/70">No project currently needs intervention.</p>
        </div>
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/[0.04]">
      <div className="grid md:grid-cols-[180px_repeat(3,minmax(0,1fr))]">
        <div className="border-b border-amber-500/15 px-4 py-3 md:border-b-0 md:border-r">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <AlertTriangle size={14} />
            Needs attention
          </p>
          <p className="mt-1 text-[9px] leading-4 text-amber-200/60">Stale progress, target risk, or blocked work.</p>
        </div>
        {projects.slice(0, 3).map(project => (
          <Link
            key={project.id}
            href={`/projects/${encodeURIComponent(project.id)}`}
            className="min-w-0 border-b border-amber-500/10 px-4 py-3 transition-colors last:border-b-0 hover:bg-amber-500/[0.05] md:border-b-0 md:border-r md:last:border-r-0"
          >
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
              <strong className="truncate text-xs text-[var(--text-primary)]">{project.name}</strong>
              <span className="ml-auto rounded-full border border-amber-500/20 bg-amber-500/[0.07] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
                {healthLabel(project)}
              </span>
            </span>
            <span className="mt-1.5 block truncate pl-3.5 text-[9px] text-[var(--text-muted)]">
              {project.progress.pulse?.reasons[0]?.detail ?? project.category}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function TargetTimeline({ groups }: { groups: CategoryGroup[] }) {
  const categorized = groups.filter(group => group.category !== 'Uncategorized');
  const uncategorized = groups.find(group => group.category === 'Uncategorized')?.projects ?? [];
  const projects = buildDeadlineRunway(categorized, uncategorized, new Date(), 50);

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Target runway</h2>
          <p className="mt-0.5 text-[9px] text-[var(--text-muted)]">Project progress ordered by the nearest target.</p>
        </div>
        <CalendarClock size={16} className="text-[var(--accent-400)]" />
      </div>
      {projects.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">Add project target dates to build the runway.</p>
      ) : (
        <div>
          {projects.map(project => {
            const urgent = project.daysRemaining <= 14 || project.progress.health !== 'on_track';
            const overdue = project.daysRemaining < 0;
            const targetLabel = overdue
              ? `${Math.abs(project.daysRemaining)}d overdue`
              : project.daysRemaining === 0
                ? 'Due today'
                : `Due in ${project.daysRemaining}d`;
            return (
              <Link
                key={project.id}
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="grid gap-2 border-b border-[var(--border-subtle)] px-4 py-3 transition-colors last:border-b-0 hover:bg-[var(--surface-2)]/30 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.2fr)_80px] sm:items-center"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
                  <span className="truncate text-xs font-semibold text-[var(--text-secondary)]">{project.name}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                    <span className="block h-full rounded-full" style={{ width: `${project.progress.percentComplete}%`, backgroundColor: project.color }} />
                  </span>
                  <span className="w-8 text-right text-[9px] tabular-nums text-[var(--text-muted)]">{project.progress.percentComplete}%</span>
                </span>
                <span className={`text-[9px] font-medium tabular-nums sm:text-right ${
                  overdue ? 'text-red-400' : urgent ? 'text-amber-400' : 'text-[var(--text-muted)]'
                }`}>{targetLabel}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ProjectsPortfolioDashboard({
  categories,
  uncategorized,
  summary,
}: {
  categories: CategoryGroup[];
  uncategorized: PortfolioProject[];
  summary: PortfolioSummary;
}) {
  const [view, setView] = useState<DashboardView>('overview');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [search, setSearch] = useState('');
  const groups = useMemo(
    () => categoryGroups(categories, uncategorized)
      .sort((a, b) => {
        const aAttention = a.projects.filter(project => project.progress.health !== 'on_track').length;
        const bAttention = b.projects.filter(project => project.progress.health !== 'on_track').length;
        const aActivity = Math.max(0, ...a.projects.map(activityTime));
        const bActivity = Math.max(0, ...b.projects.map(activityTime));
        return bAttention - aAttention || bActivity - aActivity || a.category.localeCompare(b.category);
      }),
    [categories, uncategorized],
  );

  const chooseView = (nextView: DashboardView) => {
    setView(nextView);
    setSelectedCategory(null);
  };

  return (
    <div className="space-y-4">
      <section className="grid overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-1)] sm:grid-cols-4" aria-label="Portfolio summary">
        {[
          { label: 'Active projects', value: summary.activeProjects, detail: `${summary.totalProjects} total projects`, view: 'overview' as const, color: 'var(--accent-500)' },
          { label: 'Portfolio progress', value: `${summary.portfolioPercent}%`, detail: `${summary.completedTasks} of ${summary.totalTasks} tasks complete`, view: 'overview' as const, color: 'var(--accent-500)' },
          { label: 'Needs attention', value: summary.atRiskProjects, detail: summary.atRiskProjects > 0 ? 'At risk or behind' : 'Everything is on track', view: 'health' as const, color: summary.atRiskProjects > 0 ? 'var(--warning)' : 'var(--success)' },
          { label: 'Completed this week', value: summary.completedThisWeek, detail: 'Recent portfolio wins', view: 'overview' as const, color: 'var(--success)' },
        ].map(metric => (
          <button
            key={metric.label}
            type="button"
            onClick={() => chooseView(metric.view)}
            className="min-w-40 border-b border-[var(--border)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-2)]/40 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: metric.color }} />
              {metric.label}
            </span>
            <strong className="mt-1.5 block text-xl tabular-nums tracking-tight text-[var(--text-primary)]">{metric.value}</strong>
            <span className="mt-1 block text-[9px] text-[var(--text-muted)]">{metric.detail}</span>
          </button>
        ))}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Project portfolio view" className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-0.5">
          {([
            ['overview', 'Overview'],
            ['health', 'Project health'],
            ['timeline', 'Target timeline'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => chooseView(value)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                view === value
                  ? 'bg-[var(--surface-2)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex h-9 min-w-0 basis-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2.5 sm:ml-auto sm:h-8 sm:max-w-72 sm:basis-auto sm:flex-1">
          <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Find a project or phase…"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>
      </div>

      {view === 'overview' && (
        <CategoryRings
          categories={groups}
          selectedCategory={selectedCategory}
          showAll={showAllCategories}
          onSelect={setSelectedCategory}
          onShowAll={() => {
            if (selectedCategory) setSelectedCategory(null);
            else setShowAllCategories(true);
          }}
        />
      )}

      {view === 'health' && <AttentionPanel groups={groups} />}
      {view === 'timeline' ? (
        <TargetTimeline groups={groups} />
      ) : (
        <ProjectMatrix
          groups={groups}
          selectedCategory={selectedCategory}
          attentionOnly={view === 'health'}
          search={search}
          onSelectCategory={setSelectedCategory}
        />
      )}
    </div>
  );
}
