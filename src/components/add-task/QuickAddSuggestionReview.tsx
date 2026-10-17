'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import {
  getQuickAddSuggestionConfidenceBand,
  type QuickAddSuggestionField,
} from '@/lib/quick-add/submission';
import { cn } from '@/lib/utils';

const PRIORITIES = [
  { value: 'critical', label: 'P0 · Critical' },
  { value: 'high', label: 'P1 · High' },
  { value: 'medium', label: 'P2 · Medium' },
  { value: 'low', label: 'P3 · Low' },
] as const;

const EFFORTS = [
  { value: 1, label: 'XS' },
  { value: 2, label: 'S' },
  { value: 3, label: 'M' },
  { value: 4, label: 'L' },
  { value: 5, label: 'XL' },
] as const;

const EMPTY_SELECT_VALUE = '__none__';

export interface QuickAddReviewProject {
  id: string;
  name: string;
  color?: string;
  phases?: Array<{ id: string; name: string }>;
}

export interface QuickAddSuggestionSelection {
  priority?: string;
  effort?: number;
  tagNames: string[];
  projectId?: string;
  phaseId?: string | null;
}

interface ReviewTag {
  id: string;
  name: string;
  confidence: number;
}

interface QuickAddSuggestionReviewProps {
  suggestion: QuickSortSuggestion;
  taskTitle: string;
  projects: QuickAddReviewProject[];
  availableTags: Array<{ id: string; name: string; slug: string }>;
  blockedReasons?: Partial<Record<'priority' | 'effort' | 'tags' | 'projects' | 'phases', string>>;
  applying: boolean;
  onAvailableTagsChange: (tags: Array<{ id: string; name: string; slug: string }>) => void;
  onApply: (selection: QuickAddSuggestionSelection) => Promise<void>;
  onSkip: () => void;
}

function confidenceLabel(field: QuickAddSuggestionField, confidence: number) {
  const band = getQuickAddSuggestionConfidenceBand(field, confidence);
  if (band === 'high') return `${Math.round(confidence * 100)}% · strong`;
  if (band === 'medium') return `${Math.round(confidence * 100)}% · review`;
  return `${Math.round(confidence * 100)}% · low`;
}

function defaultSelected(field: QuickAddSuggestionField, confidence: number) {
  return getQuickAddSuggestionConfidenceBand(field, confidence) === 'high';
}

function normalizeWords(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2) ?? [];
}

export function suggestPhase(
  taskTitle: string,
  phases: Array<{ id: string; name: string }>,
): { id: string; name: string; confidence: number; reason: string } | null {
  const title = taskTitle.toLowerCase();
  const titleWords = new Set(normalizeWords(taskTitle));
  const candidates = phases.map((phase) => {
    const phaseName = phase.name.toLowerCase();
    if (title.includes(phaseName)) {
      return { ...phase, confidence: 0.9, reason: 'Phase name appears in the task' };
    }
    const phaseWords = normalizeWords(phase.name);
    const matches = phaseWords.filter((word) => titleWords.has(word)).length;
    const confidence = phaseWords.length > 0 ? matches / phaseWords.length : 0;
    return {
      ...phase,
      confidence: confidence >= 0.5 ? Math.min(0.8, 0.45 + confidence * 0.3) : confidence,
      reason: matches > 0 ? 'Task and phase names overlap' : 'No clear name match',
    };
  }).sort((a, b) => b.confidence - a.confidence);
  return candidates[0]?.confidence >= 0.5 ? candidates[0] : null;
}

function SelectionToggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-suggestion-control
      onClick={onChange}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
          : 'border-[var(--border)] bg-[var(--surface-0)] text-transparent hover:border-[var(--text-muted)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );
}

function SelectControl({
  value,
  label,
  disabled,
  onChange,
  children,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <Select
      value={value || EMPTY_SELECT_VALUE}
      disabled={disabled}
      onValueChange={(nextValue) => onChange(nextValue === EMPTY_SELECT_VALUE ? '' : nextValue)}
    >
      <SelectTrigger
        data-suggestion-control
        data-enter-native
        aria-label={label}
        className="h-8 min-h-0 max-w-full rounded-md px-2.5 py-1 text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

export function QuickAddSuggestionReview({
  suggestion,
  taskTitle,
  projects,
  availableTags,
  blockedReasons = {},
  applying,
  onAvailableTagsChange,
  onApply,
  onSkip,
}: QuickAddSuggestionReviewProps) {
  const prioritySuggestion = suggestion.priority;
  const effortSuggestion = suggestion.effort;
  const projectSuggestion = suggestion.projects[0] ?? null;
  const initialProjectSelected = Boolean(
    projectSuggestion && defaultSelected('project', projectSuggestion.confidence),
  );
  const initialProject = projects.find((project) => project.id === projectSuggestion?.id) ?? null;
  const initialPhaseSuggestion = suggestPhase(taskTitle, initialProject?.phases ?? []);
  const [priority, setPriority] = useState(prioritySuggestion?.value ?? 'medium');
  const [effort, setEffort] = useState(effortSuggestion?.value ?? 3);
  const [prioritySelected, setPrioritySelected] = useState(
    Boolean(prioritySuggestion && defaultSelected('priority', prioritySuggestion.confidence)),
  );
  const [effortSelected, setEffortSelected] = useState(
    Boolean(effortSuggestion && defaultSelected('effort', effortSuggestion.confidence)),
  );
  const [projectId, setProjectId] = useState(projectSuggestion?.id ?? '');
  const [projectSelected, setProjectSelected] = useState(initialProjectSelected);
  const [phaseId, setPhaseId] = useState(initialPhaseSuggestion?.id ?? '');
  const [phaseSelected, setPhaseSelected] = useState(Boolean(
    initialProjectSelected
    && initialPhaseSuggestion
    && defaultSelected('phase', initialPhaseSuggestion.confidence),
  ));
  const [tags, setTags] = useState<ReviewTag[]>(suggestion.tags);
  const [selectedTagIds, setSelectedTagIds] = useState(() => new Set(
    suggestion.tags
      .filter((tag) => defaultSelected('tag', tag.confidence))
      .map((tag) => tag.id),
  ));
  const [showLowConfidenceTags, setShowLowConfidenceTags] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reviewRef.current?.focus();
  }, []);

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const phaseSuggestion = useMemo(
    () => suggestPhase(taskTitle, selectedProject?.phases ?? []),
    [selectedProject?.phases, taskTitle],
  );

  const visibleTags = tags.filter((tag) => (
    showLowConfidenceTags
    || getQuickAddSuggestionConfidenceBand('tag', tag.confidence) !== 'low'
  ));
  const hiddenTagCount = tags.length - visibleTags.length;
  const matchingTags = availableTags
    .filter((tag) => !tags.some((candidate) => candidate.id === tag.id))
    .filter((tag) => (
      !tagQuery.trim()
      || tag.name.toLowerCase().includes(tagQuery.trim().toLowerCase())
    ))
    .slice(0, 6);
  const canCreateTag = tagQuery.trim().length > 0
    && !availableTags.some((tag) => tag.name.toLowerCase() === tagQuery.trim().toLowerCase());

  const effectivePrioritySelected = prioritySelected && !blockedReasons.priority;
  const effectiveEffortSelected = effortSelected && !blockedReasons.effort;
  const effectiveProjectSelected = projectSelected && !blockedReasons.projects;
  const effectivePhaseSelected = phaseSelected && !blockedReasons.phases;
  const effectiveSelectedTagIds = blockedReasons.tags ? new Set<string>() : selectedTagIds;
  const hasSelection = effectivePrioritySelected
    || effectiveEffortSelected
    || effectiveProjectSelected
    || effectiveSelectedTagIds.size > 0;

  const applySelection = async (allVisible = false) => {
    const selectedTags = allVisible
      ? visibleTags
      : tags.filter((tag) => effectiveSelectedTagIds.has(tag.id));
    await onApply({
      ...(prioritySuggestion && !blockedReasons.priority && (allVisible || effectivePrioritySelected)
        ? { priority }
        : {}),
      ...(effortSuggestion && !blockedReasons.effort && (allVisible || effectiveEffortSelected)
        ? { effort }
        : {}),
      tagNames: blockedReasons.tags ? [] : selectedTags.map((tag) => tag.name),
      ...(projectId && !blockedReasons.projects && (allVisible || effectiveProjectSelected)
        ? {
            projectId,
            phaseId: !blockedReasons.phases && effectivePhaseSelected && phaseId ? phaseId : null,
          }
        : {}),
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onSkip();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void applySelection(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const controls = [...(reviewRef.current?.querySelectorAll<HTMLElement>(
        '[data-suggestion-control]:not(:disabled)',
      ) ?? [])];
      if (controls.length === 0) return;
      const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? 0
        : (currentIndex + delta + controls.length) % controls.length;
      controls[nextIndex]?.focus();
      return;
    }
    const target = event.target as HTMLElement;
    if (
      event.key === 'Enter'
      && target.tagName !== 'SELECT'
      && target.tagName !== 'INPUT'
      && !target.closest('[data-enter-native]')
    ) {
      event.preventDefault();
      void applySelection();
    }
  };

  const addExistingTag = (tag: { id: string; name: string; slug: string }) => {
    setTags((current) => [...current, { id: tag.id, name: tag.name, confidence: 1 }]);
    setSelectedTagIds((current) => new Set(current).add(tag.id));
    setTagQuery('');
    setShowTagPicker(false);
  };

  const createTag = async () => {
    const name = tagQuery.trim();
    if (!name) return;
    setTagError(null);
    const response = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? 'Failed to create tag');
    }
    const tag = await response.json() as { id: string; name: string; slug: string };
    onAvailableTagsChange([...availableTags.filter((candidate) => candidate.id !== tag.id), tag]);
    addExistingTag(tag);
  };

  return (
    <div
      ref={reviewRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="border-t border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 pb-3 pt-2.5 text-[var(--text-primary)]"
    >
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={13} className="text-amber-300" />
        <span className="text-xs font-semibold">Review suggestions</span>
        <span className="text-[11px] text-[var(--text-muted)]">
          Choose only what looks right
        </span>
        <button
          type="button"
          onClick={onSkip}
          className="ml-auto text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Skip
        </button>
      </div>

      <div className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
        {prioritySuggestion && (
          <div className="flex min-h-11 items-center gap-2 px-2.5 py-1.5">
            <SelectionToggle
              checked={effectivePrioritySelected}
              label="Apply priority suggestion"
              disabled={Boolean(blockedReasons.priority)}
              onChange={() => setPrioritySelected((selected) => !selected)}
            />
            <span className="w-14 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">Priority</span>
            <SelectControl
              value={priority}
              label="Suggested priority"
              disabled={Boolean(blockedReasons.priority)}
              onChange={(value) => {
                setPriority(value);
                setPrioritySelected(true);
              }}
            >
              {PRIORITIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectControl>
            <span className="ml-auto hidden truncate text-[11px] text-[var(--text-muted)] md:block">
              {prioritySuggestion.reason} · {confidenceLabel('priority', prioritySuggestion.confidence)}
            </span>
          </div>
        )}

        {effortSuggestion && (
          <div className="flex min-h-11 items-center gap-2 px-2.5 py-1.5">
            <SelectionToggle
              checked={effectiveEffortSelected}
              label="Apply effort suggestion"
              disabled={Boolean(blockedReasons.effort)}
              onChange={() => setEffortSelected((selected) => !selected)}
            />
            <span className="w-14 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">Effort</span>
            <SelectControl
              value={String(effort)}
              label="Suggested effort"
              disabled={Boolean(blockedReasons.effort)}
              onChange={(value) => {
                setEffort(Number(value));
                setEffortSelected(true);
              }}
            >
              {EFFORTS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
              ))}
            </SelectControl>
            <span className="ml-auto hidden truncate text-[11px] text-[var(--text-muted)] md:block">
              {effortSuggestion.reason} · {confidenceLabel('effort', effortSuggestion.confidence)}
            </span>
          </div>
        )}

        {projects.length > 0 && (
          <div className="flex min-h-11 flex-wrap items-center gap-2 px-2.5 py-1.5">
            <SelectionToggle
              checked={effectiveProjectSelected}
              label="Apply project suggestion"
              disabled={Boolean(blockedReasons.projects)}
              onChange={() => setProjectSelected((selected) => !selected)}
            />
            <span className="w-14 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">Project</span>
            <SelectControl
              value={projectId}
              label="Project"
              disabled={Boolean(blockedReasons.projects)}
              onChange={(value) => {
                setProjectId(value);
                setProjectSelected(Boolean(value));
                const nextProject = projects.find((project) => project.id === value);
                const nextPhase = suggestPhase(taskTitle, nextProject?.phases ?? []);
                setPhaseId(nextPhase?.id ?? '');
                setPhaseSelected(Boolean(
                  nextPhase && defaultSelected('phase', nextPhase.confidence),
                ));
              }}
            >
              <SelectItem value={EMPTY_SELECT_VALUE}>No project</SelectItem>
              {suggestion.projects.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Suggested</SelectLabel>
                  {suggestion.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel>All projects</SelectLabel>
                {projects
                  .filter((project) => !suggestion.projects.some((candidate) => candidate.id === project.id))
                  .map((project) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
              </SelectGroup>
            </SelectControl>
            {projectSuggestion && projectId === projectSuggestion.id && (
              <span className="hidden truncate text-[11px] text-[var(--text-muted)] md:block">
                {projectSuggestion.reason} · {confidenceLabel('project', projectSuggestion.confidence)}
              </span>
            )}
            {selectedProject && (selectedProject.phases?.length ?? 0) > 0 && (
              <>
                <span className="ml-7 w-14 shrink-0 text-[11px] font-medium text-[var(--text-muted)] sm:ml-auto">Phase</span>
                <SelectionToggle
                  checked={effectivePhaseSelected}
                  disabled={!projectSelected || !phaseId || Boolean(blockedReasons.phases)}
                  label="Apply phase suggestion"
                  onChange={() => setPhaseSelected((selected) => !selected)}
                />
                <SelectControl
                  value={phaseId}
                  label="Phase"
                  disabled={Boolean(blockedReasons.phases) || !projectSelected}
                  onChange={(value) => {
                    setPhaseId(value);
                    setPhaseSelected(Boolean(value));
                  }}
                >
                  <SelectItem value={EMPTY_SELECT_VALUE}>No phase</SelectItem>
                  {selectedProject.phases?.map((phase) => (
                    <SelectItem key={phase.id} value={phase.id}>{phase.name}</SelectItem>
                  ))}
                </SelectControl>
                {phaseSuggestion && phaseId === phaseSuggestion.id && (
                  <span className="hidden text-[11px] text-[var(--text-muted)] xl:block">
                    {confidenceLabel('phase', phaseSuggestion.confidence)}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {(tags.length > 0 || availableTags.length > 0) && (
          <div className="relative flex min-h-11 flex-wrap items-center gap-1.5 px-2.5 py-1.5">
            <span className="ml-7 w-14 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">Tags</span>
            {visibleTags.map((tag) => {
              const selected = selectedTagIds.has(tag.id);
              return (
                <span
                  key={tag.id}
                  className={cn(
                    'inline-flex h-7 items-center rounded-md border text-[11px] font-medium transition-colors',
                    selected
                      ? 'border-purple-500/50 bg-purple-500/15 text-purple-200'
                      : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)]',
                  )}
                >
                  <button
                    data-suggestion-control
                    type="button"
                    disabled={Boolean(blockedReasons.tags)}
                    aria-pressed={selected}
                    onClick={() => setSelectedTagIds((current) => {
                      const next = new Set(current);
                      if (next.has(tag.id)) next.delete(tag.id);
                      else next.add(tag.id);
                      return next;
                    })}
                    className="inline-flex h-full items-center gap-1 rounded-l-md pl-2 pr-1 hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {selected && <Check size={11} />}
                    {tag.name}
                  </button>
                  <button
                    data-suggestion-control
                    type="button"
                    aria-label={`Remove ${tag.name}`}
                    onClick={() => {
                      setTags((current) => current.filter((candidate) => candidate.id !== tag.id));
                      setSelectedTagIds((current) => {
                        const next = new Set(current);
                        next.delete(tag.id);
                        return next;
                      });
                    }}
                    className="flex h-full items-center rounded-r-md px-1.5 hover:bg-purple-500/10 hover:text-[var(--text-primary)]"
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            {hiddenTagCount > 0 && (
              <button
                data-suggestion-control
                type="button"
                onClick={() => setShowLowConfidenceTags(true)}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                +{hiddenTagCount} more
              </button>
            )}
            <button
              data-suggestion-control
              data-enter-native
              type="button"
              disabled={Boolean(blockedReasons.tags)}
              onClick={() => setShowTagPicker((open) => !open)}
              className="h-7 rounded-md border border-dashed border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Add tag
            </button>
            {showTagPicker && (
              <div className="absolute left-20 top-10 z-20 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2 shadow-[var(--shadow-lg)]">
                <input
                  autoFocus
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  placeholder="Search or create tag…"
                  className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
                />
                {tagError && (
                  <p className="px-2 pt-1.5 text-[11px] text-red-300">{tagError}</p>
                )}
                <div className="mt-1 max-h-36 overflow-y-auto">
                  {matchingTags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => addExistingTag(tag)}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    >
                      {tag.name}
                    </button>
                  ))}
                  {canCreateTag && (
                    <button
                      type="button"
                      onClick={() => void createTag().catch((error) => {
                        setTagError(error instanceof Error ? error.message : 'Failed to create tag');
                      })}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs font-medium text-[var(--accent-400)] hover:bg-[var(--surface-2)]"
                    >
                      Create “{tagQuery.trim()}”
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-muted)]">
          Enter apply · Ctrl/⌘+Enter apply visible · Esc skip
        </span>
        <button
          type="button"
          data-suggestion-control
          data-enter-native
          disabled={applying || !hasSelection}
          onClick={() => void applySelection()}
          className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? 'Applying…' : 'Apply selected'}
        </button>
      </div>
    </div>
  );
}
