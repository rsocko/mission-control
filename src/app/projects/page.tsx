'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  ChartNetwork,
  Check,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  GitBranch,
  Layers,
  Plus,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import Image from 'next/image';
import type { ProjectProgress } from '@/types';
import { DocumentIntakeWizard } from '@/components/projects/DocumentIntakeWizard';
import { PortfolioVisuals } from '@/components/projects/PortfolioVisuals';
import { ProjectModal } from '@/components/projects/ProjectModal';
import { useProjectsSidebar } from '@/components/projects/ProjectsSidebarContext';
import { IconRenderer } from '@/components/ui/icon-picker';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { fadeSlideUp } from '@/lib/motion';

const MobileProjectsView = dynamic(
  () => import('@/components/projects/MobileProjectsView').then(mod => mod.MobileProjectsView),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4 animate-pulse px-4 pt-4">
        <div className="h-8 w-36 rounded-lg bg-[var(--surface-2)]" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-16 rounded-xl bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
      </div>
    ),
  },
);

interface ProjectSummary {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  category: string | null;
  status: string;
  progress: ProjectProgress;
  targetDate: string | null;
  metadata?: Record<string, unknown>;
}

interface RecentProject extends ProjectSummary {
  nextTask: { id: string; title: string } | null;
}

interface RecentCompletedItem {
  taskId: string;
  title: string;
  completedAt: string;
  projectId: string;
  projectName: string;
  projectColor: string;
}

interface ProjectsOverviewData {
  categories: Array<{ category: string; projects: ProjectSummary[] }>;
  uncategorized: ProjectSummary[];
  recentProjects: RecentProject[];
  recentCompletedItems: RecentCompletedItem[];
  summary: {
    totalProjects: number;
    activeProjects: number;
    completedProjects: number;
    atRiskProjects: number;
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    portfolioPercent: number;
    completedThisWeek: number;
  };
}

interface HiddenProject {
  id: string;
  name: string;
  icon: string | null;
  color: string;
  metadata?: Record<string, unknown>;
}

function isSyncManaged(project: { metadata?: Record<string, unknown> }): boolean {
  return Boolean(project.metadata?.syncManaged);
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'No activity yet';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Recently';

  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MetricCard({
  label,
  value,
  detail,
  valueClassName = 'text-[var(--text-primary)]',
}: {
  label: string;
  value: string | number;
  detail: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <article className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums tracking-tight ${valueClassName}`}>{value}</p>
      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{detail}</div>
    </article>
  );
}

function ProjectCard({ project }: { project: RecentProject }) {
  const progress = Math.min(100, Math.max(0, project.progress.percentComplete));

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3.5 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]/30"
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
          style={{ color: project.color, backgroundColor: `color-mix(in srgb, ${project.color} 14%, transparent)` }}
        >
          <IconRenderer
            value={project.icon}
            size={16}
            color={project.color}
            fallback={<GitBranch size={16} />}
          />
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          {formatRelativeTime(project.progress.lastActivity)}
        </span>
      </div>
      <h3 className="mt-3 truncate text-sm font-semibold text-[var(--text-primary)]">{project.name}</h3>
      <p className="mt-1 line-clamp-2 min-h-8 text-[11px] leading-4 text-[var(--text-muted)]">
        {project.nextTask ? `Next: ${project.nextTask.title}` : 'No open task selected as the next step'}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: project.color }} />
        </div>
        <span className="w-8 text-right text-[10px] tabular-nums text-[var(--text-secondary)]">{progress}%</span>
      </div>
    </Link>
  );
}

function LaunchAction({
  href,
  icon,
  title,
  description,
  onClick,
}: {
  href?: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick?: () => void;
}) {
  const className = 'flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 text-left transition-colors hover:border-[var(--accent-500)]/30 hover:bg-[var(--surface-2)]/40';
  const content = (
    <>
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-500)]/10 text-[var(--accent-400)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-[var(--text-primary)]">{title}</span>
        <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">{description}</span>
      </span>
    </>
  );

  if (href) return <Link href={href} className={className}>{content}</Link>;
  return <button type="button" onClick={onClick} className={className}>{content}</button>;
}

export function HiddenProjectsSection({
  projects,
  expanded,
  onExpandedChange,
  onUnhide,
}: {
  projects: HiddenProject[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onUnhide: (projectId: string) => void;
}) {
  if (projects.length === 0) return null;

  return (
    <section className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] text-left">
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        aria-expanded={expanded}
      >
        <EyeOff size={13} />
        {projects.length} hidden project{projects.length === 1 ? '' : 's'}
      </button>
      {expanded && (
        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {projects.map(project => (
            <div key={project.id} className="flex items-center gap-3 px-4 py-2.5">
              {isSyncManaged(project) ? (
                <Image src="/icons/connectors/github.svg" alt="GitHub" width={17} height={17} className="opacity-80" />
              ) : (
                <IconRenderer value={project.icon} size={17} color={project.color} fallback={<GitBranch size={16} style={{ color: project.color }} />} />
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{project.name}</span>
              <button
                type="button"
                onClick={() => onUnhide(project.id)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                aria-label={`Unhide ${project.name}`}
              >
                <Eye size={12} />
                Unhide
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ProjectsPage() {
  const isMobile = useIsMobile();
  const { collapsed: sidebarCollapsed, expandSidebar } = useProjectsSidebar();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ProjectsOverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenProjects, setHiddenProjects] = useState<HiddenProject[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const response = await fetch('/api/projects-overview');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setData(await response.json() as ProjectsOverviewData);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHiddenProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/hub-projects?includeHidden=true');
      if (!response.ok) return;
      const body = await response.json();
      setHiddenProjects(
        (body.projects as Array<HiddenProject & { hidden: boolean }>).filter(project => project.hidden),
      );
    } catch {
      // Hidden projects are secondary; the portfolio remains usable if this request fails.
    }
  }, []);

  const reloadProjects = useCallback(async () => {
    await Promise.all([loadData(), loadHiddenProjects()]);
    window.dispatchEvent(new CustomEvent('projects-updated'));
  }, [loadData, loadHiddenProjects]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadData();
      void loadHiddenProjects();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadData, loadHiddenProjects]);

  const { progress: syncProgress } = useSyncStream();
  const previousRefetchKey = useRef(syncProgress.refetchKey);
  useEffect(() => {
    if (syncProgress.refetchKey <= previousRefetchKey.current) return;
    previousRefetchKey.current = syncProgress.refetchKey;
    const timeoutId = window.setTimeout(() => {
      void loadData();
      void loadHiddenProjects();
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [loadData, loadHiddenProjects, syncProgress.refetchKey]);

  async function handleUnhide(projectId: string) {
    try {
      const response = await fetch(`/api/hub-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await reloadProjects();
      setError(null);
    } catch {
      setError('Failed to unhide project');
    }
  }

  if (isMobile) return <MobileProjectsView />;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <ChartNetwork size={32} className="animate-pulse text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-muted)]">Loading projects...</p>
        </div>
      </div>
    );
  }

  if (!data || data.summary.totalProjects === 0) {
    return (
      <>
        <motion.div className="flex flex-1 items-center justify-center p-8" variants={fadeSlideUp} initial="hidden" animate="show">
          <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
            <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${error ? 'bg-red-900/20' : 'bg-[var(--surface-2)]'}`}>
              {error ? <AlertTriangle size={28} className="text-red-400" /> : <Layers size={28} className="text-[var(--text-muted)]" />}
            </div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{error ? 'Failed to load projects' : 'Start your first project'}</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {error || 'Create a blank project, shape an idea in Graph, or turn an existing document into a structured plan.'}
            </p>
            {error ? (
              <button type="button" onClick={() => { setLoading(true); void loadData(); }} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-sm font-medium">
                Retry
              </button>
            ) : (
              <div className="mt-2 grid w-full grid-cols-3 gap-2">
                <LaunchAction icon={<Plus size={17} />} title="Blank project" description="Start from scratch" onClick={() => setCreateOpen(true)} />
                <LaunchAction href="/graph/ideation" icon={<Sparkles size={17} />} title="Ideate" description="Connect related work" />
                <LaunchAction icon={<FileText size={17} />} title="Import plan" description="Document to phases" onClick={() => setIntakeOpen(true)} />
              </div>
            )}
            <HiddenProjectsSection
              projects={hiddenProjects}
              expanded={showHidden}
              onExpandedChange={setShowHidden}
              onUnhide={(projectId) => void handleUnhide(projectId)}
            />
          </div>
        </motion.div>
        <DocumentIntakeWizard isOpen={intakeOpen} onClose={() => setIntakeOpen(false)} />
        <AnimatePresence>
          {createOpen && <ProjectModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); void reloadProjects(); }} />}
        </AnimatePresence>
      </>
    );
  }

  const summary = data.summary;
  const inProgressEnd = Math.min(
    100,
    summary.portfolioPercent + (summary.totalTasks > 0 ? Math.round((summary.inProgressTasks / summary.totalTasks) * 100) : 0),
  );

  return (
    <>
      <motion.div className="flex-1 overflow-y-auto p-6" variants={fadeSlideUp} initial="hidden" animate="show">
        <div className="mx-auto max-w-6xl space-y-4">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-[var(--text-primary)]">Projects</h1>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">See what is moving, what needs attention, and where to pick up next.</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {sidebarCollapsed && (
                <button
                  type="button"
                  onClick={expandSidebar}
                  className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-300 transition-colors hover:bg-violet-500/15"
                >
                  <FolderOpen size={14} />
                  Show all projects
                </button>
              )}
              <button
                type="button"
                onClick={() => setIntakeOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <FileText size={14} />
                Import plan
              </button>
              <Link
                href="/graph/ideation"
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <Sparkles size={14} />
                Ideate
              </Link>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-600)] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-500)]"
              >
                <Plus size={14} />
                New project
              </button>
            </div>
          </header>

          {error && (
            <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          <section className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3" aria-label="Portfolio summary">
            <MetricCard label="Active projects" value={summary.activeProjects} detail={`${summary.totalProjects} total projects`} />
            <MetricCard
              label="Completed this week"
              value={summary.completedThisWeek}
              detail={<span className="text-emerald-400">Recent portfolio wins</span>}
            />
            <MetricCard
              label="Portfolio progress"
              value={`${summary.portfolioPercent}%`}
              detail={`${summary.completedTasks} of ${summary.totalTasks} tasks complete`}
            />
            <MetricCard
              label="Needs attention"
              value={summary.atRiskProjects}
              valueClassName={summary.atRiskProjects > 0 ? 'text-amber-400' : 'text-emerald-400'}
              detail={summary.atRiskProjects > 0 ? 'At risk or behind' : 'Everything is on track'}
            />
          </section>

          <PortfolioVisuals categories={data.categories} uncategorized={data.uncategorized} />

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-4">
            <div className="space-y-4">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Pick up where you left off</h2>
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Recently active projects and their next useful step.</p>
                  </div>
                  {sidebarCollapsed && (
                    <button type="button" onClick={expandSidebar} className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent-400)] hover:underline">
                      View all <ArrowRight size={11} />
                    </button>
                  )}
                </div>
                {data.recentProjects.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] gap-2 px-3 pb-3">
                    {data.recentProjects.map(project => <ProjectCard key={project.id} project={project} />)}
                  </div>
                ) : (
                  <p className="px-4 pb-5 text-xs text-[var(--text-muted)]">No active project activity yet.</p>
                )}
              </section>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] items-center gap-3">
                  <div className="px-2 py-1">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Start with an outcome</h2>
                    <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">Turn an idea, document, or cluster of related tasks into a project.</p>
                  </div>
                  <LaunchAction icon={<Plus size={17} />} title="Blank project" description="Start from scratch" onClick={() => setCreateOpen(true)} />
                  <LaunchAction href="/graph/ideation" icon={<Sparkles size={17} />} title="Ideate" description="Connect related work" />
                  <LaunchAction icon={<FileText size={17} />} title="Import plan" description="Document to phases" onClick={() => setIntakeOpen(true)} />
                </div>
              </section>

              <HiddenProjectsSection
                projects={hiddenProjects}
                expanded={showHidden}
                onExpandedChange={setShowHidden}
                onUnhide={(projectId) => void handleUnhide(projectId)}
              />
            </div>

            <div className="space-y-4">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <div className="px-4 pb-2 pt-4">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">Portfolio pulse</h2>
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">How project work is moving right now.</p>
                </div>
                <div className="grid grid-cols-[116px_1fr] items-center gap-3 px-4 pb-4">
                  <div
                    role="img"
                    aria-label={`${summary.portfolioPercent}% of portfolio tasks complete`}
                    className="relative h-28 w-28 rounded-full"
                    style={{
                      background: `conic-gradient(var(--success) 0 ${summary.portfolioPercent}%, var(--accent-500) ${summary.portfolioPercent}% ${inProgressEnd}%, var(--surface-2) ${inProgressEnd}% 100%)`,
                    }}
                  >
                    <div className="absolute inset-[10px] flex flex-col items-center justify-center rounded-full bg-[var(--surface-1)]">
                      <span className="text-xl font-bold tabular-nums text-[var(--text-primary)]">{summary.portfolioPercent}%</span>
                      <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">complete</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {[
                      { label: 'Completed', value: summary.completedTasks, color: 'var(--success)' },
                      { label: 'In progress', value: summary.inProgressTasks, color: 'var(--accent-500)' },
                      { label: 'Remaining', value: Math.max(0, summary.totalTasks - summary.completedTasks - summary.inProgressTasks), color: 'var(--surface-3)' },
                    ].map(item => (
                      <div key={item.label} className="grid grid-cols-[8px_1fr_auto] items-center gap-2 text-[11px]">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="text-[var(--text-secondary)]">{item.label}</span>
                        <span className="font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <div className="flex items-center justify-between gap-4 px-4 pb-2 pt-4">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">Recent wins</h2>
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Completed work with its project context.</p>
                  </div>
                  <TrendingUp size={16} className="text-emerald-400" />
                </div>
                {data.recentCompletedItems.length > 0 ? (
                  <div className="divide-y divide-[var(--border)] px-3 pb-2">
                    {data.recentCompletedItems.map(item => (
                      <Link
                        key={`${item.projectId}:${item.taskId}`}
                        href={`/projects/${item.projectId}`}
                        className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 px-1 py-2.5 transition-colors hover:bg-[var(--surface-2)]/30"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                          <Check size={11} strokeWidth={2.5} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium text-[var(--text-secondary)]">{item.title}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: item.projectColor }} />
                            {item.projectName}
                          </span>
                        </span>
                        <span className="text-[9px] text-[var(--text-muted)]">{formatRelativeTime(item.completedAt)}</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="px-4 pb-5 pt-2 text-xs text-[var(--text-muted)]">Completed project work will appear here.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      </motion.div>

      <DocumentIntakeWizard isOpen={intakeOpen} onClose={() => setIntakeOpen(false)} />
      <AnimatePresence>
        {createOpen && (
          <ProjectModal
            onClose={() => setCreateOpen(false)}
            onSaved={() => {
              setCreateOpen(false);
              void reloadProjects();
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
