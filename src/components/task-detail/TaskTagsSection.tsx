'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Plus, Search, Sparkles, Tag, X } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
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
  const pickerRef = useRef<HTMLDivElement>(null);
  const allowsFreeform = !connectorCaps || connectorCaps.tagCreationMode === 'freeform';

  // Close tag picker on click outside
  useEffect(() => {
    if (!showPicker) return;
    const handler = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClosePicker();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker, onClosePicker]);

  const filteredPickerTags = (tagInput.trim()
    ? pickerTags.filter((tag) => tag.name.toLowerCase().includes(tagInput.toLowerCase()) && !isSyntheticTag(tag.name))
    : pickerTags.filter((tag) => !isSyntheticTag(tag.name))
  ).filter((tag) => !appliedTagIds.includes(tag.id));

  return (
    <section className={cn(
      'overflow-visible rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
      (mode === 'panel' || mode === 'mobile') && 'order-2',
      mode === 'dialog' && 'col-start-1 row-start-4',
      mode === 'workspace' && 'col-start-1 row-start-4',
    )}>
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2.5">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]"><Tag size={13} />Tags</h3>
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
              <span
                key={tag.id}
                className="group/tag inline-flex min-h-7 items-center gap-1 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
                style={tag.color ? {
                  backgroundColor: `${tag.color}30`,
                  color: `color-mix(in oklch, ${tag.color} 60%, white)`,
                } : undefined}
              >
                {tag.name}
                <button
                  onClick={() => onRemoveTag(tag.id)}
                  disabled={!canEditTags}
                  className="ml-0.5 rounded-full opacity-60 transition-all hover:text-red-400 group-hover/tag:opacity-100 focus:opacity-100"
                  title={canEditTags ? `Remove tag "${tag.name}"` : tagsBlockedReason}
                  aria-label={`Remove tag ${tag.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <div className="relative" ref={pickerRef}>
              <Tooltip content={canEditTags ? 'Add tag' : tagsBlockedReason}>
                <button
                  onClick={() => showPicker ? onClosePicker() : onOpenPicker()}
                  disabled={!canEditTags}
                  className="flex min-h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                  aria-label="Add tag"
                >
                  <Plus size={10} />
                  Add
                </button>
              </Tooltip>

              <AnimatePresence>
                {showPicker && (
                  <motion.div
                    className="absolute left-0 top-full mt-1 w-56 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-20 overflow-hidden"
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.12 }}
                  >
                    {/* Search / input */}
                    <div className="px-2 pt-2 pb-1.5">
                      <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                        <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                        <input
                          type="text"
                          value={tagInput}
                          onChange={(e) => onTagInputChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && tagInput.trim() && allowsFreeform) {
                              e.preventDefault();
                              onAddTag(tagInput.trim());
                            }
                            if (e.key === 'Escape') onClosePicker();
                          }}
                          placeholder={allowsFreeform ? 'Search or create tag…' : 'Search labels…'}
                          className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                          autoFocus
                        />
                      </div>
                    </div>

                    {pickerLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
                      </div>
                    ) : (
                      <div className="max-h-52 overflow-y-auto py-1">
                        {/* Freeform: show "create" option when input doesn't match existing */}
                        {allowsFreeform && tagInput.trim() && !pickerTags.some((tag) => tag.name.toLowerCase() === tagInput.trim().toLowerCase()) && (
                          <button
                            onClick={() => onAddTag(tagInput.trim())}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--accent)] text-left hover:bg-[var(--surface-2)] transition-colors duration-75"
                          >
                            <Plus size={11} />
                            Create &ldquo;{tagInput.trim()}&rdquo;
                          </button>
                        )}

                        {filteredPickerTags.length === 0 && !(allowsFreeform && tagInput.trim()) ? (
                          <div className="px-3 py-2 text-xs text-[var(--text-muted)]">{tagInput.trim() ? 'No matching labels' : 'No labels available'}</div>
                        ) : filteredPickerTags.map((tag) => (
                          <button
                            key={tag.id}
                            onClick={() => onAddTag(tag.name)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] text-left hover:bg-[var(--surface-2)] transition-colors duration-75"
                          >
                            {tag.color && (
                              <span
                                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: tag.color }}
                              />
                            )}
                            {tag.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
