'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock,
  ChartNetwork,
  ExternalLink,
  Focus,
  Search,
  SkipForward,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  canEditTaskField,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { LocalDisposition, PlanningHorizon, TaskField } from '@/types';
import { triggerHaptic, triggerHapticFeedback } from '@/lib/utils/haptics';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { DatePicker } from '@/components/ui/date-picker';
import type { QuickSortQueueMode, QuickSortQueueTask, QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import { TASK_PRIORITY_VISUALS } from '@/lib/constants/task-formatting';
import {
  PLANNING_HORIZON_CODES,
  PLANNING_HORIZON_LABELS,
  PLANNING_HORIZONS,
  PLANNING_HORIZON_VISUALS,
} from '@/lib/tasks/planning-horizon';

const PRIORITY_OPTIONS = [
  ...(['critical', 'high', 'medium', 'low'] as const).map((value) => ({
    value,
    label: TASK_PRIORITY_VISUALS[value].shortLabel,
    sublabel: TASK_PRIORITY_VISUALS[value].label,
    classes: TASK_PRIORITY_VISUALS[value].badgeClass,
  })),
] as const;

// ─── Effort ─────────────────────────────────────────────────────────────────

const EFFORT_OPTIONS = [
  { value: 1, label: 'XS', classes: 'border-green-700/60 bg-green-950/50 text-green-400 active:bg-green-900/70' },
  { value: 2, label: 'S', classes: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-400 active:bg-emerald-900/70' },
  { value: 3, label: 'M', classes: 'border-yellow-700/60 bg-yellow-950/50 text-yellow-400 active:bg-yellow-900/70' },
  { value: 4, label: 'L', classes: 'border-orange-700/60 bg-orange-950/50 text-orange-400 active:bg-orange-900/70' },
  { value: 5, label: 'XL', classes: 'border-red-700/60 bg-red-950/50 text-red-400 active:bg-red-900/70' },
] as const;

export type QuadrantChoice = 'do_first' | 'schedule' | 'delegate' | 'eliminate';

// ─── Tag search ──────────────────────────────────────────────────────────────

export interface TagOption {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  usageCount?: number;
}

export interface ProjectOption {
  id: string;
  name: string;
  color: string;
  status?: string;
  phases: Array<{ id: string; name: string; color: string | null }>;
}

function ProjectPicker({
  projects,
  suggestions,
  loading,
  busy,
  onApply,
}: {
  projects: ProjectOption[];
  suggestions: QuickSortSuggestion['projects'];
  loading: boolean;
  busy: boolean;
  onApply: (projectId: string, projectName: string, phaseId?: string, phaseName?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const filteredProjects = projects.filter((project) => (
    project.name.toLowerCase().includes(query.trim().toLowerCase())
  ));
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const suggestedProjects = suggestions.flatMap((suggestion) => {
    const project = projects.find((candidate) => candidate.id === suggestion.id);
    return project ? [{ project, suggestion }] : [];
  });

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="input-glow flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3">
        <Search size={14} className="flex-shrink-0 text-[var(--text-tertiary)]" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a project…"
          aria-label="Find a project"
          className="min-h-11 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          disabled={busy}
        />
      </div>
      {selectedProject ? (
        <div className="rounded-xl border border-cyan-700/45 bg-cyan-950/25 p-3">
          <button
            type="button"
            onClick={() => setSelectedProjectId(null)}
            className="mb-3 flex min-h-11 w-full items-center gap-2 text-left"
          >
            <span
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: selectedProject.color }}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text-primary)]">
              {selectedProject.name}
            </span>
            <span className="text-xs text-cyan-300">Change</span>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onApply(selectedProject.id, selectedProject.name)}
              disabled={busy}
              className="min-h-11 rounded-lg border border-cyan-600/45 bg-cyan-900/35 px-3 text-sm font-medium text-cyan-200 transition-colors hover:bg-cyan-900/55 disabled:opacity-50"
            >
              Project only
            </button>
            {selectedProject.phases.map((phase) => (
              <button
                key={phase.id}
                type="button"
                onClick={() => onApply(
                  selectedProject.id,
                  selectedProject.name,
                  phase.id,
                  phase.name,
                )}
                disabled={busy}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
              >
                {phase.color && (
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: phase.color }}
                  />
                )}
                <span className="truncate">{phase.name}</span>
              </button>
            ))}
          </div>
          {selectedProject.phases.length === 0 && (
            <p className="mt-2 text-center text-xs text-[var(--text-muted)]">
              This project has no phases yet.
            </p>
          )}
        </div>
      ) : (
        <div className="max-h-52 overflow-y-auto overscroll-contain pr-1">
          {suggestedProjects.length > 0 && (
            <div className="mb-3 rounded-xl border border-cyan-700/45 bg-cyan-950/25 p-2">
              <p className="px-1 pb-2 text-xs font-medium text-cyan-200">
                Suggested from similar items
              </p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {suggestedProjects.map(({ project, suggestion }) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                    disabled={busy}
                    className="flex min-h-11 items-center gap-2 rounded-lg border border-cyan-700/40 bg-cyan-950/35 px-3 text-left transition-colors hover:bg-cyan-900/35 disabled:opacity-50"
                  >
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-cyan-100">
                        {project.name}
                      </span>
                      <span className="block truncate text-xs text-cyan-300/70">
                        {suggestion.reason}
                      </span>
                    </span>
                    <Sparkles size={13} className="flex-shrink-0 text-cyan-300" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {loading && <span className="text-xs text-[var(--text-muted)]">Loading projects…</span>}
          {!loading && filteredProjects.length === 0 && (
            <span className="text-xs text-[var(--text-muted)]">No active projects found</span>
          )}
          {filteredProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => setSelectedProjectId(project.id)}
              disabled={busy}
              className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-left text-sm text-[var(--text-secondary)] transition-colors hover:border-cyan-700/55 hover:bg-cyan-950/20 disabled:opacity-50"
            >
              <span
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: project.color }}
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <ChartNetwork size={14} className="flex-shrink-0 text-[var(--text-muted)]" />
            </button>
          ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TagPicker({
  onApply,
  allTags,
  tagsLoading,
  suggestedTagIds,
  recentTagIds,
  disabled = false,
  disabledReason,
}: {
  onApply: (tagId: string, tagName: string) => void;
  allTags: TagOption[];
  tagsLoading: boolean;
  suggestedTagIds: Set<string>;
  recentTagIds: Set<string>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = query.trim()
    ? allTags.filter((t) => !isSyntheticTag(t.name) && t.name.toLowerCase().includes(query.toLowerCase()))
    : allTags.filter((t) => !isSyntheticTag(t.name)).slice(0, 10);

  // Sort: suggested first, then recently-used, then the rest
  const sorted = [...filtered].sort((a, b) => {
    const aS = suggestedTagIds.has(a.id) ? 0 : recentTagIds.has(a.id) ? 1 : 2;
    const bS = suggestedTagIds.has(b.id) ? 0 : recentTagIds.has(b.id) ? 1 : 2;
    return aS - bS;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="input-glow flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3">
        <Search size={14} className="text-[var(--text-tertiary)] flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags…"
          className="min-h-11 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="flex min-h-11 min-w-11 items-center justify-center text-[var(--text-tertiary)]"
            aria-label="Clear tag search"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tagsLoading && <span className="text-xs text-[var(--text-muted)]">Loading…</span>}
        {!tagsLoading && sorted.length === 0 && (
          <span className="text-xs text-[var(--text-muted)]">No tags found</span>
        )}
        {sorted.map((tag) => {
          const isSuggested = suggestedTagIds.has(tag.id);
          const isRecent = !isSuggested && recentTagIds.has(tag.id);
          return (
            <button
              key={tag.id}
              onClick={() => { triggerHaptic('light'); onApply(tag.id, tag.name); }}
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              className={cn(
                'flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition-colors',
                isSuggested
                  ? 'border-[var(--accent)]/40 bg-indigo-950/40 text-indigo-300 ring-1 ring-[var(--accent)]/30'
                  : isRecent
                    ? 'border-blue-600/40 bg-blue-950/30 text-blue-300'
                    : 'border-[var(--border)] bg-[var(--surface-3)] text-[var(--text-secondary)] active:bg-[var(--surface-2)]'
              )}
            >
              {isSuggested && <Sparkles size={10} className="text-[var(--accent-300)]" />}
              {isRecent && <Clock size={10} className="text-blue-400" />}
              {tag.color && (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
              )}
              {tag.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Actions Component ──────────────────────────────────────────────────

interface QuickSortActionsProps {
  task: QuickSortQueueTask;
  mode: QuickSortQueueMode;
  suggestion?: QuickSortSuggestion;
  onViewTask: () => void;
  onSkip: () => void;
  onMarkDone: () => void;
  onSetLocalDisposition: (disposition: LocalDisposition) => void;
  onApplyQuadrant: (quadrant: QuadrantChoice, dueDate?: string) => void;
  onApplyPriority: (priority: string) => void;
  onApplyEffort: (effort: number) => void;
  onApplyTag: (tagId: string, tagName: string) => void;
  onApplyPlanningHorizon: (planningHorizon: PlanningHorizon) => void;
  onApplyProject?: (projectId: string, projectName: string, phaseId?: string, phaseName?: string) => void;
  allTags: TagOption[];
  projects?: ProjectOption[];
  projectsLoading?: boolean;
  tagsLoading: boolean;
  recentTagIds: string[];
  busy: boolean;
}

export default function QuickSortActions({
  task,
  mode,
  suggestion,
  onViewTask,
  onSkip,
  onMarkDone,
  onSetLocalDisposition,
  onApplyQuadrant,
  onApplyPriority,
  onApplyEffort,
  onApplyTag,
  onApplyPlanningHorizon,
  onApplyProject = () => {},
  allTags,
  projects = [],
  projectsLoading = false,
  tagsLoading,
  recentTagIds,
  busy,
}: QuickSortActionsProps) {
  const [confirmingEliminate, setConfirmingEliminate] = useState(false);
  const suggestedPriority = suggestion?.priority?.value;
  const suggestedEffort = suggestion?.effort?.value;
  const suggestedTagIds = new Set(suggestion?.tags?.map((t) => t.id) ?? []);
  const recentTagSet = new Set(recentTagIds);
  const fieldByMode: Partial<Record<QuickSortQueueMode, TaskField>> = {
    no_priority: 'priority',
    quadrant: 'priority',
    no_effort: 'effort',
    no_tags: 'tags',
    no_planning_horizon: 'planningHorizon',
  };
  const modeField = fieldByMode[mode];
  const canApplyMode = modeField ? canEditTaskField(task.editPolicy, modeField) : true;
  const modeBlockedReason = modeField
    ? taskFieldBlockedReason(task.editPolicy, modeField)
    : undefined;
  const quadrantPermission = (fields: TaskField[]) => {
    const blockedField = fields.find((field) => !canEditTaskField(task.editPolicy, field));
    return {
      allowed: !blockedField,
      reason: blockedField ? taskFieldBlockedReason(task.editPolicy, blockedField) : undefined,
    };
  };
  const doFirstPermission = quadrantPermission(['priority', 'planningHorizon']);
  const schedulePermission = quadrantPermission(['priority', 'dueDate']);
  const delegatePermission = quadrantPermission(['planningHorizon', 'microStatus']);
  const eliminatePermission = quadrantPermission(['status', 'statusReason']);
  const canMarkDone = canEditTaskField(task.editPolicy, 'status');
  const dispositionOptions = TASK_DISPOSITION_OPTIONS.filter((option) => (
    option.value !== 'active'
    && option.value !== task.localDisposition
    && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
  ));

  return (
    <div className="quick-sort-actions-inner flex max-h-full min-h-0 flex-col gap-2 px-4">
      <div
        className="quick-sort-primary-actions flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain"
        data-testid="quick-sort-primary-actions"
      >
        {/* Mode-specific action buttons */}
        {mode === 'no_priority' && (
          <div className="grid grid-cols-4 gap-2">
            {PRIORITY_OPTIONS.map((option) => {
              const isSuggested = option.value === suggestedPriority;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    triggerHapticFeedback('priority');
                    onApplyPriority(option.value);
                  }}
                  disabled={busy || !canApplyMode}
                  title={!canApplyMode ? modeBlockedReason : undefined}
                  className={cn(
                    'quick-sort-primary-button flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl border py-2 font-semibold transition-all active:scale-95 disabled:opacity-50',
                    option.classes,
                    isSuggested && 'ring-2 ring-[var(--accent)]/50 shadow-[0_0_8px_rgba(99,102,241,0.2)]',
                  )}
                >
                  {isSuggested && <Sparkles size={10} className="mb-0.5 text-[var(--accent-300)]" />}
                  <span className="text-base">{option.label}</span>
                  <span className="text-[10px] opacity-70">{option.sublabel}</span>
                </button>
              );
            })}
          </div>
        )}

        {mode === 'quadrant' && (
          confirmingEliminate ? (
            <div
              role="alertdialog"
              aria-label="Confirm eliminate task"
              className="rounded-xl border border-rose-700/50 bg-rose-950/35 p-3"
            >
              <p className="text-sm font-medium text-rose-200">Eliminate this task?</p>
              <p className="mt-1 text-xs text-rose-200/70">It will be closed as not planned. You can undo this action.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingEliminate(false)}
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] disabled:opacity-50"
                >
                  Keep task
                </button>
                <button
                  type="button"
                  onClick={() => onApplyQuadrant('eliminate')}
                  disabled={busy || !eliminatePermission.allowed}
                  title={eliminatePermission.reason}
                  className="min-h-11 rounded-lg border border-rose-600/60 bg-rose-950/70 px-3 text-sm font-medium text-rose-300 disabled:opacity-50"
                >
                  Eliminate
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  triggerHapticFeedback('priority');
                  onApplyQuadrant('do_first');
                }}
                disabled={busy || !doFirstPermission.allowed}
                title={doFirstPermission.reason}
                className="quick-sort-primary-button flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-rose-700/60 bg-rose-950/45 px-2 py-2 font-semibold text-rose-300 transition-all active:scale-95 disabled:opacity-50"
              >
                <Focus size={16} />
                <span className="text-sm">Do first</span>
                <span className="text-[10px] font-normal opacity-70">Important + urgent</span>
              </button>
              <DatePicker
                value={null}
                onChange={(date) => {
                  if (date) {
                    triggerHaptic('light');
                    onApplyQuadrant('schedule', date);
                  }
                }}
                placeholder="Schedule"
                aria-label="Schedule important task"
                disabled={busy || !schedulePermission.allowed}
                title={schedulePermission.reason}
                className="quick-sort-primary-button min-h-[64px] justify-center rounded-xl border-blue-700/60 bg-blue-950/45 px-2 py-2 text-sm font-semibold text-blue-300"
              />
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onApplyQuadrant('delegate');
                }}
                disabled={busy || !delegatePermission.allowed}
                title={delegatePermission.reason}
                className="quick-sort-primary-button flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border-amber-700/60 bg-amber-950/45 px-2 py-2 font-semibold text-amber-300 transition-all active:scale-95 disabled:opacity-50"
              >
                <Users size={16} />
                <span className="text-sm">Delegate</span>
                <span className="text-[10px] font-normal opacity-70">Urgent, waiting on someone</span>
              </button>
              <button
                type="button"
                onClick={() => setConfirmingEliminate(true)}
                disabled={busy || !eliminatePermission.allowed}
                title={eliminatePermission.reason}
                className="quick-sort-primary-button flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border-slate-700/60 bg-slate-950/45 px-2 py-2 font-semibold text-slate-300 transition-all active:scale-95 disabled:opacity-50"
              >
                <Trash2 size={16} />
                <span className="text-sm">Eliminate</span>
                <span className="text-[10px] font-normal opacity-70">Not important or urgent</span>
              </button>
            </div>
          )
        )}

        {mode === 'no_effort' && (
          <div className="grid grid-cols-5 gap-2">
          {EFFORT_OPTIONS.map((opt) => {
            const isSuggested = opt.value === suggestedEffort;
            return (
              <button
                key={opt.value}
                onClick={() => { triggerHaptic('light'); onApplyEffort(opt.value); }}
                disabled={busy || !canApplyMode}
                title={!canApplyMode ? modeBlockedReason : undefined}
                className={cn(
                  'quick-sort-primary-button flex min-h-11 flex-col items-center justify-center rounded-xl border py-2 font-semibold text-base transition-all active:scale-95 disabled:opacity-50',
                  opt.classes,
                  isSuggested && 'ring-2 ring-[var(--accent)]/50 shadow-[0_0_8px_rgba(99,102,241,0.2)]'
                )}
              >
                {isSuggested && <Sparkles size={10} className="text-[var(--accent-300)] mb-0.5" />}
                {opt.label}
              </button>
            );
          })}
          </div>
        )}

        {mode === 'no_tags' && (
          <TagPicker
            onApply={onApplyTag}
            allTags={allTags}
            tagsLoading={tagsLoading}
            suggestedTagIds={suggestedTagIds}
            recentTagIds={recentTagSet}
            disabled={busy || !canApplyMode}
            disabledReason={!canApplyMode ? modeBlockedReason : undefined}
          />
        )}

        {mode === 'no_planning_horizon' && (
          <div className="grid grid-cols-4 gap-2">
          {PLANNING_HORIZONS.map((planningHorizon) => (
            <button
              key={planningHorizon}
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onApplyPlanningHorizon(planningHorizon);
              }}
              disabled={busy || !canApplyMode}
              title={!canApplyMode ? modeBlockedReason : undefined}
              className={cn(
                'quick-sort-primary-button flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-sm font-medium transition-all active:scale-95 disabled:opacity-50',
                PLANNING_HORIZON_VISUALS[planningHorizon].badgeClass,
              )}
            >
              <span
                aria-hidden="true"
                className="inline-flex min-w-6 items-center justify-center rounded border border-current/30 bg-black/10 px-1 py-0.5 font-mono text-xs font-semibold leading-none"
              >
                {PLANNING_HORIZON_CODES[planningHorizon]}
              </span>
              <span>{PLANNING_HORIZON_LABELS[planningHorizon]}</span>
            </button>
          ))}
          </div>
        )}

        {mode === 'no_project' && (
          <ProjectPicker
            key={task.id}
            projects={projects}
            suggestions={suggestion?.projects ?? []}
            loading={projectsLoading}
            busy={busy}
            onApply={onApplyProject}
          />
        )}

        {dispositionOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
          {dispositionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSetLocalDisposition(option.value)}
              disabled={busy}
              title={option.detail}
              aria-label={`${option.label}. ${option.detail}`}
              className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border border-emerald-700/40 bg-emerald-950/30 px-2 py-3 text-sm font-medium text-emerald-300 transition-colors active:bg-emerald-900/50 disabled:opacity-50"
            >
              <Archive size={14} />
              {option.label}
            </button>
          ))}
          <p className="col-span-2 text-center text-[10px] text-[var(--text-muted)]">
            Mission Control only. The upstream task is unchanged.
          </p>
          </div>
        )}
      </div>

      {/* Lower-frequency task detail action stays far left for right-handed use. */}
      <div className="grid flex-shrink-0 grid-cols-3 gap-2">
        <button
          onClick={onViewTask}
          disabled={busy}
          aria-label="View task"
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-transparent px-2 py-2 text-xs text-[var(--text-tertiary)] transition-colors active:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <ExternalLink size={13} />
          View
        </button>
        <button
          onClick={() => { triggerHapticFeedback('taskComplete'); onMarkDone(); }}
          disabled={busy || !canMarkDone}
          title={!canMarkDone ? taskFieldBlockedReason(task.editPolicy, 'status') : undefined}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-green-700/40 bg-green-950/30 px-2 py-2 text-sm font-medium text-green-400 transition-colors active:bg-green-900/50 disabled:opacity-50"
        >
          <CheckCircle2 size={14} />
          Done
        </button>
        <button
          onClick={() => { triggerHaptic('light'); onSkip(); }}
          disabled={busy}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2 py-2 text-sm text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-3)] disabled:opacity-50"
        >
          <SkipForward size={14} />
          Skip
        </button>
      </div>
    </div>
  );
}
