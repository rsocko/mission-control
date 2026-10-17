'use client';

import { Sparkles, Tag } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { TagPickerMenu, TagPill } from '@/components/tags/TagPickerMenu';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { cn } from '@/lib/utils';
import type { TagConnectorCaps, TaskDetailMode, TaskTag } from './task-detail-types';

export interface TaskTagsSectionProps {
  mode: TaskDetailMode;
  /** Tags currently applied to the task, already filtered of synthetic tags. */
  tags: TaskTag[];
  /** Every applied tag id, used to hide already-applied picker options. */
  appliedTagIds: string[];
  canEditTags: boolean;
  /** Explains why tags cannot be edited, when they cannot. */
  tagsBlockedReason?: string;
  showPicker: boolean;
  pickerTags: TaskTag[];
  pickerLoading: boolean;
  tagInput: string;
  /** Null while capabilities are unknown, which implies freeform creation. */
  connectorCaps: TagConnectorCaps | null;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onTagInputChange: (value: string) => void;
  onAddTag: (tagName: string) => void;
  onRemoveTag: (tagId: string) => void;
}

/** Applied tags plus the add-tag picker popover. */
export function TaskTagsSection({
  mode,
  tags,
  appliedTagIds,
  canEditTags,
  tagsBlockedReason,
  showPicker,
  pickerTags,
  pickerLoading,
  tagInput,
  connectorCaps,
  onOpenPicker,
  onClosePicker,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
}: TaskTagsSectionProps) {
  const allowsFreeform = !connectorCaps || connectorCaps.tagCreationMode === 'freeform';
  const selectableTags = pickerTags.filter((tag) => !isSyntheticTag(tag.name));

  return (
    <section className={cn(
      'overflow-visible rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
      (mode === 'panel' || mode === 'mobile') && 'order-2',
      mode === 'dialog' && 'col-start-1 row-start-4',
      mode === 'workspace' && 'col-start-1 row-start-4',
    )}>
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-heading)]"><Tag size={14} className="text-[var(--text-tertiary)]" />Tags</h3>
        <Tooltip content="Suggested tags are not available yet">
          <button type="button" disabled className="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-violet-300 opacity-60">
            <Sparkles size={12} />Suggest
          </button>
        </Tooltip>
      </div>
      <div className="p-3">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <TagPill
                key={tag.id}
                tag={tag}
                disabled={!canEditTags}
                onRemove={() => onRemoveTag(tag.id)}
              />
            ))}
            <Tooltip content={canEditTags ? 'Add tag' : tagsBlockedReason}>
              <TagPickerMenu
                open={showPicker}
                onOpenChange={(open) => open ? onOpenPicker() : onClosePicker()}
                tags={selectableTags}
                selectedTagIds={appliedTagIds}
                query={tagInput}
                onQueryChange={onTagInputChange}
                onSelect={(tag) => onAddTag(tag.name)}
                allowCreate={allowsFreeform}
                onCreate={onAddTag}
                loading={pickerLoading}
                disabled={!canEditTags}
                searchPlaceholder={allowsFreeform ? 'Search or create tag…' : 'Search labels…'}
                noMatchesLabel="No matching labels"
                emptyLabel={connectorCaps?.tagCreationMode === 'predefined'
                  ? 'No labels available'
                  : 'No tags available'}
              />
            </Tooltip>
          </div>
        </div>
      </div>
    </section>
  );
}
