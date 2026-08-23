"use client";

import React, {
  Activity,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Columns3 } from 'lucide-react';
import { toast } from 'sonner';
import PhaseProposalReview, { type PhaseProposal } from '@/components/projects/PhaseProposalReview';
import { TaskPickerDialog } from '@/components/projects/TaskPickerDialog';
import { AddTaskModal } from '@/components/add-task';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { ViewInGraphLink } from '@/components/graph/ViewInGraphLink';
import { CONNECTOR_COLORS } from '@/lib/constants/colors';
import { projectLogger } from '@/lib/client-logger';
import { taskFilterContextForEntityCollection } from '@/lib/graph/graph-navigation';
import { scaleIn, staggerContainer } from '@/lib/motion';
import { ProjectHierarchyClientError } from '@/lib/projects/hierarchy-client';
import type { ProjectHierarchyCommand } from '@/lib/projects/hierarchy-types';
import { cn } from '@/lib/utils';

import { LoadingSkeleton, StatusBadge } from './components';
import { TABS } from './constants';
import {
  ProjectPageProvider,
  useProjectPageData,
  useProjectPageMutations,
  useProjectPageTaskInteractions,
} from './context';
import {
  ProjectOverviewTab,
  ProjectPhasesTab,
  ProjectSettingsTab,
  ProjectTasksTab,
  type ConfirmationRequest,
  type ProjectTaskOverlayActions,
  type ProjectTaskTarget,
  type RequestConfirmation,
} from './tabs';
import type { ProjectTab } from './types';
import {
  applyProjectTaskFieldUpdate,
  getProjectStatus,
  getProjectTabCount,
} from './utils';

type AddTaskDest = { id: string; label: string; connectorType: string; account: 'personal' | 'work' | null; color: string; listSelectionMode?: 'required' | 'optional' | 'not-applicable' };
const LOCAL_DESTINATION: AddTaskDest = { id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' };

const EMPTY_CONFIRMATION: ConfirmationRequest = {
  title: '',
  message: '',
  confirmLabel: '',
  variant: 'danger',
  onConfirm: () => {},
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = Array.isArray(params.id) ? params.id[0] : params.id;

  return (
    <ProjectPageProvider projectId={projectId}>
      <ProjectDetailContent projectId={projectId} />
    </ProjectPageProvider>
  );
}

function ProjectSettingsActivityBoundary({
  active,
  connectorListModes,
  requestConfirmation,
}: {
  active: boolean;
  connectorListModes: Record<string, string>;
  requestConfirmation: RequestConfirmation;
}) {
  const [lifetimeController] = useState(() => new AbortController());
  const effectOwnersRef = useRef(0);

  useEffect(() => {
    effectOwnersRef.current += 1;
    return () => {
      effectOwnersRef.current -= 1;
      // Strict Mode replays effects synchronously, so let its next setup reclaim this lifetime.
      queueMicrotask(() => {
        if (effectOwnersRef.current === 0) lifetimeController.abort();
      });
    };
  }, [lifetimeController]);

  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <ProjectSettingsTab
        active={active}
        connectorListModes={connectorListModes}
        lifetimeSignal={lifetimeController.signal}
        requestConfirmation={requestConfirmation}
      />
    </Activity>
  );
}

function ProjectDetailContent({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const initialTab = searchParams.get('tab') as ProjectTab | null;
  const initialAction = searchParams.get('action');
  const {
    error,
    loading,
    phaseItemsByPhase,
    phases,
    progress,
    project,
    tasks,
  } = useProjectPageData();
  const {
    loadProjectDetail,
    runHierarchyCommand,
    setTasks,
  } = useProjectPageMutations();
  const {
    detailMode,
    handleAddToMyDay,
    handleRemoveFromMyDay,
    myDayTaskIds,
    selectedTaskId,
    setDetailMode,
    setSelectedTaskId,
  } = useProjectPageTaskInteractions();

  // Persist last-selected project for quick return
  useEffect(() => {
    if (projectId) {
      try { localStorage.setItem('projects-last-selected', projectId); } catch { /* ignore */ }
    }
  }, [projectId]);

  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab || 'overview');
  const [phasesGraphView, setPhasesGraphView] = useState(false);
  const [revealPhaseId, setRevealPhaseId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ open: boolean; request: ConfirmationRequest }>(
    { open: false, request: EMPTY_CONFIRMATION },
  );

  // Measure sticky header height so the Plan toolbar can offset itself
  const stickyHeaderRef = useRef<HTMLElement>(null);
  const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0);
  useEffect(() => {
    const el = stickyHeaderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setStickyHeaderHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [project]);

  // ── Connector capabilities shared by Settings and the add-task overlay ──
  const [connectorListModes, setConnectorListModes] = useState<Record<string, string>>({});
  const [addTaskDestinations, setAddTaskDestinations] = useState<AddTaskDest[]>([LOCAL_DESTINATION]);

  useEffect(() => {
    fetch('/api/features')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.taskDestinations) return;
        const modes: Record<string, string> = {};
        const dests: AddTaskDest[] = [];
        for (const td of data.taskDestinations) {
          const lsm = (td.listSelectionMode as AddTaskDest['listSelectionMode']) || undefined;
          modes[td.id] = td.listSelectionMode || 'not-applicable';
          dests.push({
            id: td.id,
            label: td.name,
            connectorType: td.type,
            account: (td.account as 'personal' | 'work') || null,
            color: CONNECTOR_COLORS[td.type] || 'var(--text-muted)',
            listSelectionMode: lsm,
          });
        }
        dests.push(LOCAL_DESTINATION);
        setConnectorListModes(modes);
        setAddTaskDestinations(dests);
      })
      .catch((err) => { projectLogger.error('Failed to fetch connector list modes', { err }); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connectorLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const destination of addTaskDestinations) {
      if (labels[destination.connectorType] === undefined) {
        labels[destination.connectorType] = destination.label;
      }
    }
    return labels;
  }, [addTaskDestinations]);

  // ── Shared add-task flows used by both the Plan and Project Tasks tabs ──
  const [createTaskTarget, setCreateTaskTarget] = useState<ProjectTaskTarget | null>(null);
  const [linkTasksTarget, setLinkTasksTarget] = useState<ProjectTaskTarget | null>(null);

  const taskOverlayActions = useMemo<ProjectTaskOverlayActions>(() => ({
    requestCreateTask: (target) => setCreateTaskTarget(target),
    requestLinkTasks: (target) => setLinkTasksTarget(target),
  }), []);

  const closeConfirmation = useCallback(() => {
    setConfirmation((current) => ({ ...current, open: false }));
  }, []);
  const requestConfirmation = useCallback((request: ConfirmationRequest) => {
    setConfirmation({ open: true, request });
  }, []);

  const handleOpenPhase = useCallback((phaseId: string | null) => {
    setActiveTab('phases');
    setRevealPhaseId(phaseId);
  }, []);
  const handleRevealComplete = useCallback(() => setRevealPhaseId(null), []);

  // ── Route-triggered AI phase proposal ───────────────────────────────────
  const [proposal, setProposal] = useState<PhaseProposal | null>(null);
  const [isProposalOpen, setIsProposalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefining, setIsRefining] = useState(false);

  const handleGeneratePhaseProposal = useCallback(async (guidance?: string) => {
    if (!projectId) return;

    setIsGenerating(true);
    try {
      const response = await fetch('/api/project-phases/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          ...(guidance ? { context: guidance } : {}),
        }),
      });

      const payload = (await response.json().catch(() => null)) as { proposal?: PhaseProposal; error?: string } | null;
      if (!response.ok || !payload?.proposal) {
        throw new Error(payload?.error || 'Failed to generate phase proposal');
      }

      setProposal(payload.proposal);
      setIsProposalOpen(true);
      toast.success('AI phase proposal ready');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to generate phase proposal');
    } finally {
      setIsGenerating(false);
    }
  }, [projectId]);

  const handleRefinePhases = useCallback(async (guidance?: string) => {
    if (!projectId || phases.length === 0) return;

    setIsRefining(true);
    try {
      const currentPhases = phases.map((phase) => ({
        name: phase.name,
        taskIds: (phaseItemsByPhase[phase.id] ?? []).map((item) => item.taskId),
      }));

      const response = await fetch('/api/project-phases/ai-refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          currentPhases,
          ...(guidance ? { instruction: guidance } : {}),
        }),
      });

      const payload = (await response.json().catch(() => null)) as { proposal?: PhaseProposal; error?: string } | null;
      if (!response.ok || !payload?.proposal) {
        throw new Error(payload?.error || 'Failed to refine phase plan');
      }

      setProposal(payload.proposal);
      setIsProposalOpen(true);
      toast.success('AI refinement ready for review');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to refine phase plan');
    } finally {
      setIsRefining(false);
    }
  }, [phaseItemsByPhase, phases, projectId]);

  const proposalActions = useMemo(() => ({
    generate: (guidance?: string) => { void handleGeneratePhaseProposal(guidance); },
    refine: (guidance?: string) => { void handleRefinePhases(guidance); },
    isGenerating,
    isRefining,
  }), [handleGeneratePhaseProposal, handleRefinePhases, isGenerating, isRefining]);

  // Auto-trigger AI suggest when navigated with ?action=ai-suggest
  useEffect(() => {
    if (initialAction === 'ai-suggest' && !loading && project && !isGenerating && !isProposalOpen) {
      void handleGeneratePhaseProposal();
    }
    // Only run once after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project]);

  const proposalTaskMap = useMemo(
    () =>
      new Map(
        tasks.map((task) => [
          task.id,
          {
            id: task.id,
            title: task.title,
            priority: task.priority,
            status: task.status,
            connectorType: task.connectorType,
          },
        ] as const),
      ),
    [tasks],
  );

  /** Assign an existing task to this project and optionally to a phase */
  async function handleAddExistingTasksToPhase(taskIds: string[], phaseId: string | null) {
    if (!project) return;
    try {
      const targetName = phaseId
        ? phases.find((phase) => phase.id === phaseId)?.name ?? 'phase'
        : 'the project';
      await runHierarchyCommand({
        type: 'assign_tasks',
        taskIds,
        toPhaseId: phaseId ?? undefined,
        toIndex: phaseId ? (phaseItemsByPhase[phaseId] ?? []).length : undefined,
      }, {
        undoLabel: `Added ${taskIds.length} task${taskIds.length > 1 ? 's' : ''}`,
        announcement: `Added ${taskIds.length} task${taskIds.length > 1 ? 's' : ''} to ${targetName}`,
      });
      toast.success(`Added ${taskIds.length} task${taskIds.length > 1 ? 's' : ''}`);
      void loadProjectDetail({ background: true });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to add tasks');
    }
  }

  /** Handle a newly created task — assign to project and optionally to a phase */
  async function handleNewTaskCreated(taskId: string, phaseId: string | null) {
    if (!project) return;
    try {
      const targetName = phaseId
        ? phases.find((phase) => phase.id === phaseId)?.name ?? 'phase'
        : 'the project';
      const command: ProjectHierarchyCommand = {
        type: 'assign_tasks',
        taskIds: [taskId],
        toPhaseId: phaseId ?? undefined,
        toIndex: phaseId ? (phaseItemsByPhase[phaseId] ?? []).length : undefined,
      };
      const options = {
        undoLabel: 'Added new task',
        announcement: `Added new task to ${targetName}`,
      };
      try {
        await runHierarchyCommand(command, options);
      } catch (error) {
        if (
          error instanceof ProjectHierarchyClientError
          && error.code === 'HIERARCHY_REVISION_CONFLICT'
        ) {
          await runHierarchyCommand(
            phaseId && error.current
              ? {
                  ...command,
                  toIndex: error.current.phaseItemsByPhase[phaseId]?.length ?? 0,
                }
              : command,
            options,
          );
        } else {
          throw error;
        }
      }
      void loadProjectDetail({ background: true });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to assign task to phase');
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Project unavailable</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/projects">Back to Projects</Link>
              </Button>
              <Button onClick={() => void loadProjectDetail()}>Retry</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Project not found</CardTitle>
            <CardDescription>The requested project could not be located.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/projects">Back to Projects</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isGraphView = activeTab === 'phases' && phasesGraphView;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
    <motion.div
      className={cn(
        'min-h-0 min-w-0 flex-1',
        isGraphView ? 'flex flex-col overflow-y-auto' : 'space-y-6 overflow-y-auto',
      )}
      variants={staggerContainer}
      initial="hidden"
      animate="show"
    >
      {/* Compact sticky header */}
      <motion.section ref={stickyHeaderRef} variants={scaleIn} className="sticky top-0 z-20 bg-[var(--surface-0)]">
        <div className="border-b border-[var(--border)] px-4 sm:px-6">
          {/* Top row: title + stats */}
          <div className="flex items-center gap-3 py-3">
            {project.metadata?.syncManaged ? (
              <Image src="/icons/connectors/github.svg" alt="GitHub" width={14} height={14} className="flex-shrink-0 opacity-80" />
            ) : project.icon ? (
              <IconRenderer value={project.icon} size={18} color={project.color} />
            ) : (
              <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} aria-hidden="true" />
            )}
            <h1 className="text-lg font-semibold leading-tight text-[var(--text-primary)] truncate flex-1">
              {project.name}
            </h1>
            <div className="hidden sm:flex items-center gap-4 text-xs text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
              <span><span className="font-semibold text-[var(--text-primary)]">{progress.percentComplete}%</span> done</span>
              <span><span className="font-semibold text-[var(--text-primary)]">{progress.totalTasks}</span> tasks</span>
              <span><span className="font-semibold text-[var(--text-primary)]">{phases.length}</span> phases</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <StatusBadge status={getProjectStatus(project)} />
              {project.category ? <Badge variant="outline">{project.category}</Badge> : null}
              <ViewInGraphLink
                context={taskFilterContextForEntityCollection({ type: 'project', id: projectId })}
                origin={{
                  href: `/projects/${encodeURIComponent(projectId)}?tab=${encodeURIComponent(activeTab)}`,
                  label: project.name,
                }}
                compact
                className="h-7 min-h-7 min-w-7 border border-[var(--border)]"
              />
              <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs text-[var(--text-secondary)]">
                <Link href={`/kanban?projectId=${projectId}`}>
                  <Columns3 className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Kanban</span>
                </Link>
              </Button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 -mb-px">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const count = getProjectTabCount(tab.id, phases.length, tasks.length);
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'px-3 py-2 text-sm font-medium border-b-2 transition-colors duration-150',
                    isActive
                      ? 'border-[var(--accent-400)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border)]',
                  )}
                >
                  {tab.label}{count !== null ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>
        </div>
      </motion.section>

      <div className={cn(
        'px-4 pb-6 sm:px-6',
        isGraphView ? 'flex min-h-[32rem] flex-1 flex-col pt-6' : 'space-y-6',
      )}>
      {/* Activity keeps every visited tab mounted so its local state survives a
          tab switch, while hidden tabs tear down their effects and render no UI. */}
      <Activity mode={activeTab === 'overview' ? 'visible' : 'hidden'}>
        <ProjectOverviewTab
          active={activeTab === 'overview'}
          onOpenPhase={handleOpenPhase}
        />
      </Activity>

      <Activity mode={activeTab === 'phases' ? 'visible' : 'hidden'}>
        <ProjectPhasesTab
          active={activeTab === 'phases'}
          stickyHeaderHeight={stickyHeaderHeight}
          revealPhaseId={revealPhaseId}
          onRevealComplete={handleRevealComplete}
          onGraphLayoutChange={setPhasesGraphView}
          taskOverlayActions={taskOverlayActions}
          requestConfirmation={requestConfirmation}
          proposalActions={proposalActions}
        />
      </Activity>

      <Activity mode={activeTab === 'tasks' ? 'visible' : 'hidden'}>
        <ProjectTasksTab
          active={activeTab === 'tasks'}
          taskOverlayActions={taskOverlayActions}
          connectorLabels={connectorLabels}
        />
      </Activity>

      <ProjectSettingsActivityBoundary
        key={projectId}
        active={activeTab === 'settings'}
        connectorListModes={connectorListModes}
        requestConfirmation={requestConfirmation}
      />

      {proposal ? (
        <PhaseProposalReview
          proposal={proposal}
          projectId={projectId}
          taskMap={proposalTaskMap}
          isOpen={isProposalOpen}
          onAccept={() => {
            setIsProposalOpen(false);
            setProposal(null);
            void loadProjectDetail({ background: true });
          }}
          onReject={() => {
            setIsProposalOpen(false);
            setProposal(null);
            toast('Phase proposal dismissed');
          }}
        />
      ) : null}

      {/* ── Create task modal (scoped to a phase) ─────────────────────────── */}
      <AnimatePresence>
        {createTaskTarget !== null && (
          <AddTaskModal
            initialInput=""
            initialParsed={null}
            initialDestination={addTaskDestinations[0]}
            destinations={addTaskDestinations}
            initialProjectId={projectId}
            deferProjectAssignment
            onTaskCreated={(taskId) => {
              void handleNewTaskCreated(taskId, createTaskTarget.phaseId);
            }}
            onClose={() => setCreateTaskTarget(null)}
            onSubmit={() => setCreateTaskTarget(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Task picker dialog (link existing tasks to a phase) ────────── */}
      <AnimatePresence>
        {linkTasksTarget !== null && (
          <TaskPickerDialog
            excludeTaskIds={tasks.map((t) => t.id)}
            title={linkTasksTarget.phaseId === null
              ? `Add tasks to ${project?.name || 'project'}`
              : `Add tasks to ${phases.find((p) => p.id === linkTasksTarget.phaseId)?.name || 'phase'}`}
            onClose={() => setLinkTasksTarget(null)}
            onConfirm={(taskIds) => {
              void handleAddExistingTasksToPhase(taskIds, linkTasksTarget.phaseId);
              setLinkTasksTarget(null);
            }}
          />
        )}
      </AnimatePresence>
      </div>

      <ConfirmDialog
        open={confirmation.open}
        title={confirmation.request.title}
        message={confirmation.request.message}
        confirmLabel={confirmation.request.confirmLabel}
        confirmVariant={confirmation.request.variant}
        onConfirm={() => { void confirmation.request.onConfirm(closeConfirmation); }}
        onCancel={closeConfirmation}
      />
    </motion.div>

    {/* Task detail panel */}
    <AnimatePresence initial={false}>
      {selectedTaskId ? (
        <motion.div
          className="absolute inset-y-0 right-0 z-30 flex sm:relative sm:inset-auto sm:z-auto sm:h-full sm:min-w-0 sm:shrink"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
          animate={{ opacity: 1, x: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
          transition={{ duration: prefersReducedMotion ? 0.14 : 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <TaskDetailPanel
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
            onUpdate={(fields) => {
              if (fields && selectedTaskId) {
                setTasks((current) =>
                  current.map((t) =>
                    t.id === selectedTaskId
                      ? applyProjectTaskFieldUpdate(t, fields)
                      : t
                  )
                );
              }
              void loadProjectDetail({ background: true });
            }}
            onSubtaskCountChange={(done, total) => {
              setTasks((current) =>
                current.map((task) =>
                  task.id === selectedTaskId ? { ...task, subtaskDone: done, subtaskTotal: total } : task
                )
              );
            }}
            mode={detailMode}
            onModeChange={setDetailMode}
            isInMyDay={myDayTaskIds.has(selectedTaskId)}
            onToggleMyDay={() => myDayTaskIds.has(selectedTaskId)
              ? void handleRemoveFromMyDay(selectedTaskId)
              : void handleAddToMyDay(selectedTaskId)}
            animatePanel={false}
            portalDialog
            focusPanelOnMount
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
    </div>
  );
}
