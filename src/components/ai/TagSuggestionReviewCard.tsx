'use client';

import { Plus, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { TagRecommendation } from '@/lib/tags/recommendations';

export interface EditableTagSuggestion {
  taskId: string;
  title: string;
  tags: TagRecommendation[];
  suggestedTagIds: string[];
  selectedTagIds: string[];
  confidence: number;
}

interface TagSuggestionReviewCardProps {
  suggestion: EditableTagSuggestion;
  availableTags: Array<{ id: string; name: string }>;
  applying: boolean;
  blockedReason?: string;
  onChange: (suggestion: EditableTagSuggestion) => void;
  onApply: () => void;
  onDismiss: () => void;
}

export function TagSuggestionReviewCard({
  suggestion,
  availableTags,
  applying,
  blockedReason,
  onChange,
  onApply,
  onDismiss,
}: TagSuggestionReviewCardProps) {
  const selectedIds = new Set(suggestion.selectedTagIds);
  const addableTags = availableTags.filter((tag) => (
    !suggestion.tags.some((candidate) => candidate.id === tag.id)
  ));

  function toggleTag(tagId: string) {
    const next = new Set(selectedIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onChange({ ...suggestion, selectedTagIds: [...next] });
  }

  function removeTag(tagId: string) {
    onChange({
      ...suggestion,
      tags: suggestion.tags.filter((tag) => tag.id !== tagId),
      selectedTagIds: suggestion.selectedTagIds.filter((id) => id !== tagId),
    });
  }

  function addTag(tagId: string) {
    const tag = availableTags.find((candidate) => candidate.id === tagId);
    if (!tag) return;
    onChange({
      ...suggestion,
      tags: [
        ...suggestion.tags,
        { ...tag, confidence: 1, reason: 'Added manually' },
      ],
      selectedTagIds: [...selectedIds, tag.id],
    });
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-[var(--text-primary)]">
            {suggestion.title}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Select only the tags that fit this task.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={applying}
          className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {suggestion.tags.map((tag) => {
          const selected = selectedIds.has(tag.id);
          return (
            <span
              key={tag.id}
              className={cn(
                'inline-flex min-h-8 items-center rounded-full border text-xs transition-colors',
                selected
                  ? 'border-blue-400/40 bg-blue-500/15 text-blue-100'
                  : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]',
              )}
              title={`${tag.reason} · ${Math.round(tag.confidence * 100)}% confidence`}
            >
              <button
                type="button"
                aria-label={tag.name}
                aria-describedby={`tag-recommendation-${suggestion.taskId}-${tag.id}`}
                aria-pressed={selected}
                onClick={() => toggleTag(tag.id)}
                className="min-h-8 px-3 font-medium"
              >
                {tag.name}
                <span
                  id={`tag-recommendation-${suggestion.taskId}-${tag.id}`}
                  className="sr-only"
                >
                  {`, ${tag.reason}, ${Math.round(tag.confidence * 100)}% confidence`}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${tag.name}`}
                onClick={() => removeTag(tag.id)}
                className="mr-1 rounded-full p-1 text-current opacity-60 transition-opacity hover:opacity-100"
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Select
          key={suggestion.tags.map((tag) => tag.id).join(':')}
          onValueChange={addTag}
        >
          <SelectTrigger
            aria-label="Add another tag"
            className="h-9 w-auto min-w-40 bg-[var(--surface-0)] text-xs"
            disabled={applying || addableTags.length === 0}
          >
            <Plus size={13} />
            <SelectValue placeholder="Add another tag" />
          </SelectTrigger>
          <SelectContent>
            {addableTags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={onApply}
          disabled={applying || Boolean(blockedReason) || selectedIds.size === 0}
          title={blockedReason}
          className="min-h-9 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? 'Applying…' : `Apply ${selectedIds.size} tag${selectedIds.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
