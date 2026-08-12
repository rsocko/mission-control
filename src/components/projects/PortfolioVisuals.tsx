'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarClock, ChartPie } from 'lucide-react';
import {
  buildCategoryPortfolioRows,
  buildDeadlineRunway,
  type PortfolioVisualCategory,
  type PortfolioVisualProject,
} from '@/lib/projects-overview/visuals';
import type { ProjectHealth } from '@/types';

const HEALTH_STYLES: Record<ProjectHealth, { label: string; color: string }> = {
  on_track: { label: 'On track', color: 'var(--success)' },
  at_risk: { label: 'At risk', color: 'var(--warning)' },
  behind: { label: 'Behind', color: 'var(--danger)' },
};

const CATEGORY_COLORS = [
  '#8b5cf6',
  '#06b6d4',
  '#22c55e',
  '#f59e0b',
  '#f43f5e',
  '#3b82f6',
  '#a855f7',
  '#14b8a6',
];

type CategoryView = 'completion' | 'workload' | 'health';

function Donut({
  background,
  label,
  children,
  size = 'h-24 w-24',
  inset = 'inset-[8px]',
}: {
  background: string;
  label: string;
  children: React.ReactNode;
  size?: string;
  inset?: string;
}) {
  return (
    <div role="img" aria-label={label} className={`relative shrink-0 rounded-full ${size}`} style={{ background }}>
      <div className={`absolute ${inset} flex flex-col items-center justify-center rounded-full bg-[var(--surface-1)]`}>
        {children}
      </div>
    </div>
  );
}

function CompletionDonuts({ rows }: { rows: ReturnType<typeof buildCategoryPortfolioRows> }) {
  return (
    <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(112px,1fr))] items-start gap-x-3 gap-y-5 px-4 pb-4">
      {rows.map((row, index) => (
        <div key={row.category} className="flex min-w-0 flex-col items-center text-center">
          <Donut
            background={`conic-gradient(${CATEGORY_COLORS[index % CATEGORY_COLORS.length]} 0 ${row.percentComplete}%, var(--surface-2) ${row.percentComplete}% 100%)`}
            label={`${row.category}: ${row.percentComplete}% of tasks complete`}
          >
            <span className="text-lg font-bold tabular-nums text-[var(--text-primary)]">{row.percentComplete}%</span>
            <span className="text-[8px] uppercase tracking-wider text-[var(--text-muted)]">complete</span>
          </Donut>
          <p className="mt-2 w-full truncate text-[11px] font-semibold text-[var(--text-secondary)]">{row.category}</p>
          <p className="text-[9px] tabular-nums text-[var(--text-muted)]">
            {row.projectCount} project{row.projectCount === 1 ? '' : 's'} · {row.totalTasks} tasks
          </p>
        </div>
      ))}
    </div>
  );
}

function WorkloadPie({ rows }: { rows: ReturnType<typeof buildCategoryPortfolioRows> }) {
  const totalTasks = rows.reduce((sum, row) => sum + row.totalTasks, 0);
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    cursor += totalTasks > 0 ? (row.totalTasks / totalTasks) * 100 : 0;
    return `${CATEGORY_COLORS[index % CATEGORY_COLORS.length]} ${start}% ${cursor}%`;
  });

  return (
    <div className="grid flex-1 grid-cols-[minmax(140px,0.8fr)_minmax(180px,1.2fr)] items-center gap-5 px-5 pb-5 max-sm:grid-cols-1">
      <div className="flex justify-center">
        <Donut
          background={totalTasks > 0 ? `conic-gradient(${segments.join(', ')})` : 'var(--surface-2)'}
          label={`Task workload across ${rows.length} categories`}
          size="h-40 w-40"
          inset="inset-[14px]"
        >
          <span className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">{totalTasks}</span>
          <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">total tasks</span>
          <span className="mt-1 text-[9px] text-[var(--text-secondary)]">{rows.length} categories</span>
        </Donut>
      </div>
      <div className="space-y-2.5">
        {rows.map((row, index) => {
          const share = totalTasks > 0 ? Math.round((row.totalTasks / totalTasks) * 100) : 0;
          return (
            <div key={row.category} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }} />
              <span className="truncate font-medium text-[var(--text-secondary)]">{row.category}</span>
              <span className="tabular-nums text-[var(--text-muted)]">
                {row.totalTasks} <span className="inline-block w-7 text-right">{share}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HealthDonuts({ rows }: { rows: ReturnType<typeof buildCategoryPortfolioRows> }) {
  return (
    <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(112px,1fr))] items-start gap-x-3 gap-y-5 px-4 pb-4">
      {rows.map((row) => {
        let cursor = 0;
        const segments = (Object.keys(HEALTH_STYLES) as ProjectHealth[]).map((health) => {
          const start = cursor;
          cursor += (row.health[health] / row.projectCount) * 100;
          return `${HEALTH_STYLES[health].color} ${start}% ${cursor}%`;
        });
        const needsAttention = row.health.at_risk + row.health.behind;

        return (
          <div key={row.category} className="flex min-w-0 flex-col items-center text-center">
            <Donut
              background={`conic-gradient(${segments.join(', ')})`}
              label={`${row.category}: ${row.health.on_track} on track, ${row.health.at_risk} at risk, ${row.health.behind} behind`}
            >
              <span className={`text-lg font-bold tabular-nums ${needsAttention > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {needsAttention}
              </span>
              <span className="text-[8px] uppercase tracking-wider text-[var(--text-muted)]">need attention</span>
            </Donut>
            <p className="mt-2 w-full truncate text-[11px] font-semibold text-[var(--text-secondary)]">{row.category}</p>
            <p className="text-[9px] tabular-nums text-[var(--text-muted)]">{row.projectCount} projects</p>
          </div>
        );
      })}
    </div>
  );
}

function deadlineLabel(daysRemaining: number): string {
  if (daysRemaining < 0) return `${Math.abs(daysRemaining)}d overdue`;
  if (daysRemaining === 0) return 'Due today';
  if (daysRemaining === 1) return 'Due tomorrow';
  return `Due in ${daysRemaining}d`;
}

function CategoryBalance({
  categories,
  uncategorized,
}: {
  categories: PortfolioVisualCategory[];
  uncategorized: PortfolioVisualProject[];
}) {
  const rows = buildCategoryPortfolioRows(categories, uncategorized);
  const [view, setView] = useState<CategoryView>('completion');
  if (rows.length === 0) return null;

  return (
    <section className="flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-4 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">By category</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            {view === 'completion' && 'Task completion with the key number at the center.'}
            {view === 'workload' && 'How your portfolio workload is distributed.'}
            {view === 'health' && 'Project health with attention items called out.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Category chart option" className="flex rounded-lg bg-[var(--surface-2)] p-0.5">
            {([
              ['completion', 'Completion'],
              ['workload', 'Workload'],
              ['health', 'Health'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
                className={`rounded-md px-2.5 py-1 text-[9px] font-medium transition-colors ${
                  view === value
                    ? 'bg-[var(--surface-1)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <ChartPie size={16} className="hidden flex-shrink-0 text-[var(--accent-400)] sm:block" />
        </div>
      </div>

      {view === 'completion' && <CompletionDonuts rows={rows} />}
      {view === 'workload' && <WorkloadPie rows={rows} />}
      {view === 'health' && <HealthDonuts rows={rows} />}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-2.5">
        {view === 'health' ? (
          (Object.keys(HEALTH_STYLES) as ProjectHealth[]).map(health => (
            <span key={health} className="inline-flex items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: HEALTH_STYLES[health].color }} />
              {HEALTH_STYLES[health].label}
            </span>
          ))
        ) : (
          <span className="text-[9px] text-[var(--text-muted)]">
            {view === 'completion' ? 'Ring = percent of tasks complete' : 'Slice = share of all portfolio tasks'}
          </span>
        )}
        <span className="ml-auto text-[9px] text-[var(--text-muted)]">Choose a view to compare concepts</span>
      </div>
    </section>
  );
}

function TargetRunway({
  categories,
  uncategorized,
}: {
  categories: PortfolioVisualCategory[];
  uncategorized: PortfolioVisualProject[];
}) {
  const projects = buildDeadlineRunway(categories, uncategorized);
  if (projects.length === 0) return null;

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex items-start justify-between gap-4 px-4 pb-2 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Target runway</h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Nearest project deadlines, ordered by urgency.</p>
        </div>
        <CalendarClock size={16} className="mt-0.5 flex-shrink-0 text-[var(--accent-400)]" />
      </div>

      <div className="divide-y divide-[var(--border)] px-3 pb-2">
        {projects.map((project) => {
          const urgent = project.daysRemaining <= 14 || project.progress.health !== 'on_track';
          const overdue = project.daysRemaining < 0;
          const progress = Math.min(100, Math.max(0, project.progress.percentComplete));

          return (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              aria-label={`${project.name}, ${progress}% complete, ${deadlineLabel(project.daysRemaining)}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-lg px-1 py-2.5 transition-colors hover:bg-[var(--surface-2)]/30"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
                <span className="truncate text-[11px] font-medium text-[var(--text-secondary)]">{project.name}</span>
              </span>
              <span className={`text-[10px] font-medium tabular-nums ${overdue ? 'text-red-400' : urgent ? 'text-amber-400' : 'text-[var(--text-muted)]'}`}>
                {deadlineLabel(project.daysRemaining)}
              </span>
              <span className="col-span-2 flex items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <span className="block h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: project.color }} />
                </span>
                <span className="w-8 text-right text-[9px] tabular-nums text-[var(--text-muted)]">{progress}%</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function PortfolioVisuals({
  categories,
  uncategorized,
}: {
  categories: PortfolioVisualCategory[];
  uncategorized: PortfolioVisualProject[];
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4" aria-label="Portfolio views">
      <CategoryBalance categories={categories} uncategorized={uncategorized} />
      <TargetRunway categories={categories} uncategorized={uncategorized} />
    </div>
  );
}
