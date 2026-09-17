'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ChartNetwork,
  ChevronDown,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  GitBranch,
  Layers,
  Lightbulb,
  Plus,
} from 'lucide-react';
import Image from 'next/image';
import { DocumentIntakeWizard } from '@/components/projects/DocumentIntakeWizard';
import { ProjectModal } from '@/components/projects/ProjectModal';
import {
  ProjectsPortfolioDashboard,
  type PortfolioProject,
  type PortfolioSummary,
} from '@/components/projects/ProjectsPortfolioDashboard';
import { useProjectsSidebar } from '@/components/projects/ProjectsSidebarContext';
import { IconRenderer } from '@/components/ui/icon-picker';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { fadeSlideUp } from '@/lib/motion';

interface ProjectsOverviewData {
  categories: Array<{ category: string; projects: PortfolioProject[] }>;
  uncategorized: PortfolioProject[];
  summary: PortfolioSummary;
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
        className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        aria-expanded={expanded}
      >
        <EyeOff size={13} />
        {projects.length} hidden project{projects.length === 1 ? '' : 's'}
      </button>
      {expanded && (
        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {projects.map(project => (
            <div key={project.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
              {isSyncManaged(project) ? (
                <Image src="/icons/connectors/github.svg" alt="GitHub" width={17} height={17} className="opacity-80" />
              ) : (
                <IconRenderer
                  value={project.icon}
                  size={17}
                  color={project.color}
                  fallback={<GitBranch size={16} style={{ color: project.color }} />}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{project.name}</span>
              <button
                type="button"
                onClick={() => onUnhide(project.id)}
                className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
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

function NewProjectMenu({
  onBlankProject,
  onImportPlan,
}: {
  onBlankProject: () => void;
  onImportPlan: () => void;
}) {
  const contentClassName = 'z-50 w-64 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] p-1 shadow-xl';
  const itemClassName = 'flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors focus:bg-[var(--surface-2)]';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-[var(--accent-600)] px-3 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-500)]"
        >
          <Plus size={14} />
          New project
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={contentClassName}>
          <DropdownMenu.Item asChild>
            <Link href="/graph/ideation" className={itemClassName}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
                <Lightbulb size={15} />
              </span>
              <span>
                <strong className="block text-xs text-[var(--text-primary)]">Ideate an outcome</strong>
                <span className="mt-0.5 block text-[9px] text-[var(--text-muted)]">Shape related ideas before creating the project</span>
              </span>
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onImportPlan} className={itemClassName}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
              <FileText size={15} />
            </span>
            <span>
              <strong className="block text-xs text-[var(--text-primary)]">Import a plan</strong>
              <span className="mt-0.5 block text-[9px] text-[var(--text-muted)]">Turn a document into phases and tasks</span>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onBlankProject} className={itemClassName}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
              <Plus size={15} />
            </span>
            <span>
              <strong className="block text-xs text-[var(--text-primary)]">Blank project</strong>
              <span className="mt-0.5 block text-[9px] text-[var(--text-muted)]">Start with a name and organize as you go</span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function ProjectsPage() {
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
        <motion.div className="flex flex-1 items-center justify-center p-6" variants={fadeSlideUp} initial="hidden" animate="show">
          <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
            <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${error ? 'bg-red-900/20' : 'bg-[var(--surface-2)]'}`}>
              {error ? <AlertTriangle size={28} className="text-red-400" /> : <Layers size={28} className="text-[var(--text-muted)]" />}
            </div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{error ? 'Failed to load projects' : 'Start your first project'}</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {error || 'Create a blank project, shape an idea, or turn an existing document into a structured plan.'}
            </p>
            {error ? (
              <button
                type="button"
                onClick={() => { setLoading(true); void loadData(); }}
                className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-medium"
              >
                Retry
              </button>
            ) : (
              <NewProjectMenu onBlankProject={() => setCreateOpen(true)} onImportPlan={() => setIntakeOpen(true)} />
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

  return (
    <>
      <motion.div className="flex-1 overflow-y-auto p-4 sm:p-6" variants={fadeSlideUp} initial="hidden" animate="show">
        <div className="mx-auto max-w-6xl space-y-4">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-[var(--text-primary)]">Projects</h1>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Portfolio health, active phases, and the shortest path back into the work.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              {sidebarCollapsed && (
                <button
                  type="button"
                  onClick={expandSidebar}
                  className="hidden min-h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] sm:inline-flex"
                >
                  <FolderOpen size={14} />
                  Show projects
                </button>
              )}
              <NewProjectMenu onBlankProject={() => setCreateOpen(true)} onImportPlan={() => setIntakeOpen(true)} />
            </div>
          </header>

          {error && (
            <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          <ProjectsPortfolioDashboard
            categories={data.categories}
            uncategorized={data.uncategorized}
            summary={data.summary}
          />

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
