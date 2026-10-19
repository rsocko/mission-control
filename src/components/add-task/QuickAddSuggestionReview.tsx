'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Sparkles } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EffortSelect } from '@/components/EffortBadge';
import { PrioritySelect } from '@/components/PriorityBadge';
import { ProjectSelect } from '@/components/projects/ProjectSelect';
import { TagPickerMenu, TagPill } from '@/components/tags/TagPickerMenu';
import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import {
  getQuickAddSuggestionConfidenceBand,
  type QuickAddSuggestionField,
} from '@/lib/quick-add/submission';
import { cn } from '@/lib/utils';

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
  color?: string | null;
}

interface QuickAddSuggestionReviewProps {
  suggestion: QuickSortSuggestion;
  taskTitle: string;
  projects: QuickAddReviewProject[];
  availableTags: Array<{ id: string; name: string; slug: string; color?: string | null }>;
  blockedReasons?: Partial<Record<'priority' | 'effort' | 'tags' | 'projects' | 'phases', string>>;
  applying: boolean;
  onAvailableTagsChange: (tags: Array<{ id: string; name: string; slug: string; color?: string | null }>) => void;
  onApply: (selection: QuickAddSuggestionSelection) => Promise<void>;
  onSkip: () => void;
}

function confidenceLabel(field: QuickAddSuggestionField, confidence: number) {
  const band = getQuickAddSuggestionConfidenceBand(field, confidence);
  if (band === 'high') return `${Math.round(confidence * 100)}% · strong`;
  if (band === 'medium') return `${Math.round(confidence * 100)}% · review`;
  return `${Math.round(confidence * 100)}% · low`;
}

function ConfidenceBadge({
  field,
  confidence,
}: {
  field: QuickAddSuggestionField;
  confidence: number;
}) {
  const band = getQuickAddSuggestionConfidenceBand(field, confidence);
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        band === 'high' && 'border-green-500/25 bg-green-500/10 text-green-300',
        band === 'medium' && 'border-amber-500/25 bg-amber-500/10 text-amber-300',
        band === 'low' && 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)]',
      )}
    >
      {confidenceLabel(field, confidence)}
    </span>
  );
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
  const [tags, setTags] = useState<ReviewTag[]>(() => suggestion.tags.map((tag) => ({
    ...tag,
    color: availableTags.find((candidate) => candidate.id === tag.id)?.color,
  })));
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
  const effectivePrioritySelected = prioritySelected && !blockedReasons.priority;
  const effectiveEffortSelected = effortSelected && !blockedReasons.effort;
  const effectiveProjectSelected = projectSelected && !blockedReasons.projects;
  const effectivePhaseSelected = phaseSelected && !blockedReasons.phases;
  const effectiveSelectedTagIds = blockedReasons.tags ? new Set<string>() : selectedTagIds;
  const selectedTagCount = tags.filter((tag) => effectiveSelectedTagIds.has(tag.id)).length;
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

  const addExistingTag = (tag: { id: string; name: string; slug?: string; color?: string | null }) => {
    setTags((current) => [...current, {
      id: tag.id,
      name: tag.name,
      confidence: 1,
      color: tag.color,
    }]);
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
    const tag = await response.json() as {
      id: string;
      name: string;
      slug: string;
      color?: string | null;
    };
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
          Checked items will be applied
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
            <PrioritySelect
              priority={priority}
              includeNone={false}
              ariaLabel="Suggested priority"
              disabled={Boolean(blockedReasons.priority)}
              triggerClassName="h-8 min-h-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2.5 py-1 text-xs"
              onChange={(value) => {
                setPriority(value);
                setPrioritySelected(true);
              }}
            />
            <span className="ml-auto hidden truncate text-[11px] text-[var(--text-muted)] lg:block">
              {prioritySuggestion.reason}
            </span>
            <ConfidenceBadge field="priority" confidence={prioritySuggestion.confidence} />
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
            <EffortSelect
              effort={effort}
              includeNone={false}
              ariaLabel="Suggested effort"
              disabled={Boolean(blockedReasons.effort)}
              triggerClassName="h-8 min-h-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2.5 py-1 text-xs"
              onChange={(value) => {
                if (value == null) return;
                setEffort(value);
                setEffortSelected(true);
              }}
            />
            <span className="ml-auto hidden truncate text-[11px] text-[var(--text-muted)] lg:block">
              {effortSuggestion.reason}
            </span>
            <ConfidenceBadge field="effort" confidence={effortSuggestion.confidence} />
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
            <ProjectSelect
              value={projectId}
              projects={projects}
              suggestedProjectIds={suggestion.projects.map((project) => project.id)}
              includeEmptyOption
              emptyLabel="No project"
              ariaLabel="Project"
              disabled={Boolean(blockedReasons.projects)}
              triggerClassName="max-w-52"
              onValueChange={(value) => {
                setProjectId(value);
                setProjectSelected(Boolean(value));
                const nextProject = projects.find((project) => project.id === value);
                const nextPhase = suggestPhase(taskTitle, nextProject?.phases ?? []);
                setPhaseId(nextPhase?.id ?? '');
                setPhaseSelected(Boolean(
                  nextPhase && defaultSelected('phase', nextPhase.confidence),
                ));
              }}
            />
            {projectSuggestion && projectId === projectSuggestion.id && (
              <>
                <span className="hidden truncate text-[11px] text-[var(--text-muted)] lg:block">
                  {projectSuggestion.reason}
                </span>
                <ConfidenceBadge field="project" confidence={projectSuggestion.confidence} />
              </>
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
                  <ConfidenceBadge field="phase" confidence={phaseSuggestion.confidence} />
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
                <TagPill
                  key={tag.id}
                  tag={tag}
                  selected={selected}
                  disabled={Boolean(blockedReasons.tags)}
                  onToggle={() => setSelectedTagIds((current) => {
                      const next = new Set(current);
                      if (next.has(tag.id)) next.delete(tag.id);
                      else next.add(tag.id);
                      return next;
                    })}
                  onRemove={() => {
                      setTags((current) => current.filter((candidate) => candidate.id !== tag.id));
                      setSelectedTagIds((current) => {
                        const next = new Set(current);
                        next.delete(tag.id);
                        return next;
                      });
                    }}
                />
              );
            })}
            {hiddenTagCount > 0 && (
              <button
                data-suggestion-control
                type="button"
                onClick={() => setShowLowConfidenceTags(true)}
                className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
              >
                Show {hiddenTagCount} low-confidence {hiddenTagCount === 1 ? 'tag' : 'tags'}
              </button>
            )}
            <TagPickerMenu
              open={showTagPicker}
              onOpenChange={setShowTagPicker}
              tags={availableTags}
              selectedTagIds={tags.map((tag) => tag.id)}
              query={tagQuery}
              onQueryChange={setTagQuery}
              onSelect={addExistingTag}
              allowCreate
              onCreate={() => void createTag().catch((error) => {
                setTagError(error instanceof Error ? error.message : 'Failed to create tag');
              })}
              disabled={Boolean(blockedReasons.tags)}
              error={tagError}
              triggerLabel="Add tag"
              triggerClassName="rounded-md bg-transparent text-[11px]"
            />
            {tags.length > 0 && (
              <span className="basis-full pl-[5.25rem] text-[10px] text-[var(--text-muted)]">
                {selectedTagCount} of {tags.length} selected. Only selected tags will be applied.
              </span>
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
