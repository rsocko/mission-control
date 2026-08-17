'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CheckCircle2, ChevronRight, Eye, EyeOff, Layers, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { IconRenderer } from '@/components/ui/icon-picker';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { getTaskPriorityVisual, isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { cn } from '@/lib/utils';
import type { ProjectProgress } from '@/types';
import Image from 'next/image';

// ─── TYPES ──────────────────────────────────────────────────────────────────

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

interface ProjectsOverviewData {
  categories: Array<{ category: string; projects: ProjectSummary[] }>;
  uncategorized: ProjectSummary[];
  summary: {
    totalProjects: number;
    activeProjects: number;
    completedProjects: number;
    atRiskProjects: number;
  };
}

interface ProjectTask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

interface HiddenProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  metadata?: Record<string, unknown>;
}

function isSyncManaged(project: { metadata?: Record<string, unknown> }): boolean {
  return !!(project.metadata as Record<string, unknown> | undefined)?.syncManaged;
}

function getHealthLabel(progress: ProjectProgress): string {
  if (progress.totalTasks === 0) return 'no tasks';
  const overdue = progress.health === 'behind' || progress.health === 'at_risk';
  if (overdue) return `${progress.totalTasks - progress.completedTasks} remaining`;
  return 'on track';
}

// ─── PROJECT CARD ───────────────────────────────────────────────────────────

function MobileProjectCard({
  project,
  onTap,
}: {
  project: ProjectSummary;
  onTap: (project: ProjectSummary) => void;
}) {
  const pct = project.progress?.percentComplete ?? 0;
  const totalTasks = project.progress?.totalTasks ?? 0;
  const completedTasks = project.progress?.completedTasks ?? 0;
  const isCompleted = project.status === 'completed';
  const isPaused = project.status === 'paused' || project.status === 'on_hold';

  return (
    <motion.button
      onClick={() => onTap(project)}
      aria-label={`Open project ${project.name}`}
      className={cn(
        'w-full text-left rounded-2xl border border-white/[0.06] bg-white/[0.04] backdrop-blur-xl p-4 transition-colors active:bg-white/[0.08]',
        isPaused && 'opacity-60',
      )}
      whileTap={{ scale: 0.98 }}
      layout
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-[10px] ring-1 ring-inset ring-white/10"
            style={{ backgroundColor: `${project.color}15` }}
          >
            {isSyncManaged(project) ? (
              <Image src="/icons/connectors/github.svg" alt="GitHub" width={14} height={14} className="opacity-80" />
            ) : (
              <IconRenderer value={project.icon} size={14} color={project.color} fallback={<Layers size={14} style={{ color: project.color }} />} />
            )}
          </div>
          <div>
            <p className={cn(
              'text-base font-semibold',
              isCompleted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
            )}>
              {project.name}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {totalTasks} task{totalTasks !== 1 ? 's' : ''} · {getHealthLabel(project.progress)}
            </p>
          </div>
        </div>
        <ChevronRight size={11} className="text-[var(--text-muted)] mt-2 flex-shrink-0" />
      </div>

      {/* Progress bar - shown for active projects with tasks */}
      {totalTasks > 0 && !isPaused && (
        <>
          <div className="mt-3 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
            <div
              className="h-1.5 rounded-full transition-[width] duration-500"
              style={{ width: `${pct}%`, backgroundColor: project.color || 'var(--accent)' }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>{pct}% complete</span>
            {project.targetDate && (
              <span>
                Due {new Date(project.targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
            {!project.targetDate && (
              <span>{completedTasks}/{totalTasks} done</span>
            )}
          </div>
        </>
      )}
    </motion.button>
  );
}

// ─── PROJECT DETAIL SHEET ───────────────────────────────────────────────────

function ProjectDetailSheet({
  project,
  isOpen,
  onClose,
  onHide,
}: {
  project: ProjectSummary | null;
  isOpen: boolean;
  onClose: () => void;
  onHide: (project: ProjectSummary) => void;
}) {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [quickAddValue, setQuickAddValue] = useState('');
  const [addingTask, setAddingTask] = useState(false);

  // Fetch project tasks when sheet opens
  useEffect(() => {
    if (!isOpen || !project) {
      setTasks([]);
      return;
    }
    const controller = new AbortController();
    setLoadingTasks(true);
    fetch(`/api/tasks?projectId=${project.id}&limit=20&openOnly=true`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => setTasks(data.tasks || []))
      .catch((err) => { if (err.name !== 'AbortError') setTasks([]); })
      .finally(() => setLoadingTasks(false));
    return () => controller.abort();
  }, [isOpen, project]);

  const handleQuickAdd = useCallback(async () => {
    if (!quickAddValue.trim() || !project || addingTask) return;
    setAddingTask(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: quickAddValue.trim(),
          priority: 'medium',
          connectorType: 'local',
          projectIds: [project.id],
        }),
      });
      if (res.ok) {
        const newTask = await res.json();
        setTasks(prev => [{ id: newTask.id, title: quickAddValue.trim(), status: 'todo', priority: 'medium' }, ...prev]);
        setQuickAddValue('');
      }
    } catch { /* ignore */ }
    setAddingTask(false);
  }, [quickAddValue, project, addingTask]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleQuickAdd();
    }
  }, [handleQuickAdd]);

  if (!project) return null;

  const pct = project.progress?.percentComplete ?? 0;

  return (
    <MobileSheet isOpen={isOpen} onClose={onClose} title={project.name} height="75%">
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* Project summary */}
        <div className="py-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ring-white/10"
              style={{ backgroundColor: `${project.color}15` }}
            >
              {isSyncManaged(project) ? (
                <Image src="/icons/connectors/github.svg" alt="GitHub" width={16} height={16} className="opacity-80" />
              ) : (
                <IconRenderer value={project.icon} size={16} color={project.color} fallback={<Layers size={16} style={{ color: project.color }} />} />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--text-primary)]">{project.name}</span>
                {project.status === 'completed' && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 size={10} /> Complete
                  </span>
                )}
              </div>
              {project.category && (
                <span className="text-xs text-[var(--text-muted)]">{project.category}</span>
              )}
            </div>
          </div>

          {/* Progress */}
          {project.progress.totalTasks > 0 && (
            <div className="mt-3">
              <div className="h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
                <div
                  className="h-2 rounded-full transition-[width] duration-500"
                  style={{ width: `${pct}%`, backgroundColor: project.color || 'var(--accent)' }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-[var(--text-muted)]">
                <span>{project.progress.completedTasks} of {project.progress.totalTasks} tasks complete</span>
                <span className="font-medium">{pct}%</span>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => onHide(project)}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-2)]"
        >
          <EyeOff size={15} aria-hidden="true" />
          Hide project
        </button>

        {/* Quick-add task input [F-88] */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={quickAddValue}
              onChange={e => setQuickAddValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a task..."
              className="w-full rounded-xl bg-[var(--surface-2)] border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
            />
          </div>
          <button
            onClick={handleQuickAdd}
            disabled={!quickAddValue.trim() || addingTask}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-500)] text-white disabled:opacity-40 transition-opacity active:scale-95"
            aria-label="Add task"
          >
            {addingTask ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </button>
        </div>

        {/* Task list */}
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            Tasks
          </h3>
          {loadingTasks ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin text-[var(--text-muted)]" />
            </div>
          ) : tasks.length === 0 ? (
            <p className="text-center py-6 text-sm text-[var(--text-muted)]">No open tasks</p>
          ) : (
            <div className="space-y-1">
              {tasks.map(task => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </div>
    </MobileSheet>
  );
}

function TaskRow({ task }: { task: ProjectTask }) {
  const isDone = task.status === 'done';
  const isInactive = isInactiveTaskStatus(task.status);

  return (
    <div className={cn('flex items-center gap-2.5 rounded-lg px-2 py-3 min-h-[44px] hover:bg-[var(--surface-2)]', isInactive && 'opacity-50')}>
      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', getTaskPriorityVisual(task.priority).dotClass)} />
      <span className={cn('text-sm text-[var(--text-primary)] truncate flex-1', isDone && 'line-through')}>{task.title}</span>
    </div>
  );
}

// ─── MAIN MOBILE PROJECTS VIEW ──────────────────────────────────────────────

export function MobileProjectsView() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ProjectsOverviewData | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [hiddenProjects, setHiddenProjects] = useState<HiddenProject[]>([]);
  const [projectToHide, setProjectToHide] = useState<ProjectSummary | null>(null);
  const prefersReducedMotion = useReducedMotion() ?? false;

  const loadData = useCallback(async () => {
    try {
      const overviewResponse = await fetch('/api/projects-overview');
      if (!overviewResponse.ok) throw new Error();
      const overview: ProjectsOverviewData = await overviewResponse.json();
      setData(overview);
    } catch { /* ignore */ }
    setLoading(false);

    try {
      const projectsResponse = await fetch('/api/hub-projects?includeHidden=true');
      if (projectsResponse.ok) {
        const body = await projectsResponse.json() as {
          projects?: Array<HiddenProject & { hidden: boolean }>;
        };
        setHiddenProjects((body.projects ?? []).filter(project => project.hidden));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  // Re-fetch on sync completion
  const { progress: syncProgress } = useSyncStream();
  const prevRefetchKeyRef = useRef(syncProgress.refetchKey);
  useEffect(() => {
    if (syncProgress.refetchKey > prevRefetchKeyRef.current) {
      prevRefetchKeyRef.current = syncProgress.refetchKey;
      const t = window.setTimeout(() => void loadData(), 500);
      return () => window.clearTimeout(t);
    }
  }, [syncProgress.refetchKey, loadData]);

  // Pull-to-refresh
  const onRefresh = useCallback(async () => { await loadData(); }, [loadData]);
  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({
    onRefresh,
    enabled: !sheetOpen,
  });

  const allProjects = useMemo(() => {
    if (!data) return [];
    const projects: ProjectSummary[] = [];
    for (const cat of data.categories) {
      projects.push(...cat.projects);
    }
    projects.push(...data.uncategorized);
    return projects;
  }, [data]);

  const handleTapProject = useCallback((project: ProjectSummary) => {
    setSelectedProject(project);
    setSheetOpen(true);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setSheetOpen(false);
    // Refresh data in case tasks were added
    void loadData();
  }, [loadData]);

  const handleHideProject = useCallback(async () => {
    if (!projectToHide) return;

    try {
      const response = await fetch(`/api/hub-projects/${projectToHide.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      if (!response.ok) throw new Error('Failed to hide project');

      toast.success('Project hidden');
      setSheetOpen(false);
      setSelectedProject(null);
      window.dispatchEvent(new Event('projects-updated'));
      await loadData();
    } catch {
      toast.error('Failed to hide project');
    } finally {
      setProjectToHide(null);
    }
  }, [loadData, projectToHide]);

  const handleUnhideProject = useCallback(async (projectId: string) => {
    try {
      const response = await fetch(`/api/hub-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
      });
      if (!response.ok) throw new Error('Failed to unhide project');

      toast.success('Project unhidden');
      window.dispatchEvent(new Event('projects-updated'));
      await loadData();
    } catch {
      toast.error('Failed to unhide project');
    }
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center min-h-[60vh]">
        <Loader2 size={24} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!data || (allProjects.length === 0 && hiddenProjects.length === 0)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 min-h-[60vh]">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-2)]">
          <Layers size={24} className="text-[var(--text-muted)]" />
        </div>
        <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">No projects yet</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)] text-center">
          Create your first project to start tracking progress.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overscroll-y-contain"
      {...containerProps}
    >
      {/* Pull-to-refresh indicator */}
      {pullDistance > 0 && (
        <div className="flex items-center justify-center py-2" style={{ height: Math.min(pullDistance, 60) }}>
          <Loader2 size={16} className={cn('text-[var(--text-muted)]', isRefreshing && 'animate-spin')} />
        </div>
      )}

      <div style={contentStyle}>
        {/* Header */}
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-400)]">
            {allProjects.length > 0 ? 'Active' : 'Hidden'}
          </p>
          <h1 className="mt-1 text-[1.75rem] font-semibold text-[var(--text-primary)]">
            Projects
          </h1>
        </div>

        {/* Project cards */}
        <div className="px-5 pb-28 space-y-3">
          {allProjects.map((project) => (
            <MobileProjectCard
              key={project.id}
              project={project}
              onTap={handleTapProject}
            />
          ))}
          {hiddenProjects.length > 0 && (
            <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.04]">
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 text-xs font-medium text-[var(--text-muted)]">
                <EyeOff size={14} aria-hidden="true" />
                {hiddenProjects.length} hidden project{hiddenProjects.length === 1 ? '' : 's'}
              </div>
              {hiddenProjects.map(project => (
                <div key={project.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
                  {isSyncManaged(project) ? (
                    <Image src="/icons/connectors/github.svg" alt="GitHub" width={14} height={14} className="opacity-80" />
                  ) : (
                    <IconRenderer
                      value={project.icon}
                      size={14}
                      color={project.color}
                      fallback={<Layers size={14} style={{ color: project.color }} />}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]">{project.name}</span>
                  <button
                    type="button"
                    onClick={() => void handleUnhideProject(project.id)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--text-secondary)] active:bg-[var(--surface-2)]"
                    aria-label={`Unhide ${project.name}`}
                  >
                    <Eye size={14} aria-hidden="true" />
                    Unhide
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>

      {/* Project detail bottom sheet [F-87] */}
      <AnimatePresence initial={!prefersReducedMotion}>
        <ProjectDetailSheet
          project={selectedProject}
          isOpen={sheetOpen}
          onClose={handleCloseSheet}
          onHide={setProjectToHide}
        />
      </AnimatePresence>
      <ConfirmDialog
        open={projectToHide !== null}
        title="Hide project?"
        message={`Hide "${projectToHide?.name ?? 'this project'}"? It will be removed from project navigation and portfolio views. You can unhide it from Projects.`}
        confirmLabel="Hide project"
        confirmVariant="warning"
        onConfirm={() => void handleHideProject()}
        onCancel={() => setProjectToHide(null)}
      />
    </div>
  );
}
