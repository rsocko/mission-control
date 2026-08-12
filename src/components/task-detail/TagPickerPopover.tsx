'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Tag, Search, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'motion/react';
import { getTagPillStyle } from '@/lib/constants/colors';
import { useClickOutside } from '@/lib/hooks/useClickOutside';

export interface TaskTag {
  id: string;
  name: string;
  slug?: string;
  color: string | null;
}

export interface TagConnectorCaps {
  tagWriteBack: boolean;
  tagCreationMode: 'freeform' | 'predefined';
  tagScope: 'global' | 'per-list';
}

export interface TagPickerPopoverProps {
  /** Task ID for API calls. */
  taskId: string;
  /** Currently assigned tag IDs. */
  tagIds: string[];
  /** All known tags (from parent + extras). */
  knownTags: TaskTag[];
  /** Connector tag capabilities (null if unknown). */
  connectorCaps?: TagConnectorCaps | null;
  /** Source list ID for per-list tag scoping. */
  sourceListId?: string | null;
  /** Connector type for source-aware filtering. */
  connectorType?: string | null;
  /** Called after tags are added/removed (pass new tagIds). */
  onTagIdsChange: (tagIds: string[]) => void;
  /** Called when a new tag is fetched that wasn't in knownTags. */
  onNewTagDiscovered?: (tag: TaskTag) => void;
  /** Notify parent that data changed. */
  onUpdate?: () => void;
  /** Whether editing is allowed. */
  canEdit?: boolean;
}

/**
 * Tag picker popover with search, add, create, and remove.
 * Supports freeform vs predefined tag creation modes per connector capabilities.
 */
export function TagPickerPopover({
  taskId,
  tagIds,
  knownTags,
  connectorCaps,
  sourceListId,
  connectorType,
  onTagIdsChange,
  onNewTagDiscovered,
  onUpdate,
  canEdit = true,
}: TagPickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pickerTags, setPickerTags] = useState<TaskTag[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => { setIsOpen(false); setTagInput(''); }, isOpen);

  // Fetch available tags when picker opens
  const fetchPickerTags = useCallback(async () => {
    setPickerLoading(true);
    try {
      const params = new URLSearchParams();
      if (connectorCaps?.tagScope === 'per-list' && sourceListId) {
        params.set('listId', sourceListId);
      }
      // When the source doesn't support tag write-back, only show tags from that source
      if (connectorCaps && !connectorCaps.tagWriteBack && connectorType) {
        params.set('source', connectorType);
      }
      const url = params.toString() ? `/api/tags?${params.toString()}` : '/api/tags';
      const res = await fetch(url);
      const data = await res.json();
      setPickerTags(data.tags || []);
    } catch {
      setPickerTags([]);
    } finally {
      setPickerLoading(false);
    }
  }, [connectorCaps?.tagScope, connectorCaps?.tagWriteBack, sourceListId, connectorType]);

  useEffect(() => {
    if (isOpen) fetchPickerTags();
  }, [isOpen, fetchPickerTags]);

  const handleAddTag = useCallback(async (tagName: string) => {
    if (!tagName.trim()) return;
    const res = await fetch(`/api/tasks/${taskId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [tagName.trim()] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || 'Failed to add tag');
      return;
    }
    const data = await res.json();
    if (data.rejectedTags?.length && !data.addedTagIds?.length) {
      toast.error(`Label "${data.rejectedTags[0]}" doesn't exist in this source. Please create it there first.`);
      return;
    }
    if (data.addedTagIds?.length) {
      onTagIdsChange([...tagIds, ...data.addedTagIds]);
      // Try to find the added tag details
      const allKnown = [...pickerTags, ...knownTags];
      const addedTag = allKnown.find((t) => data.addedTagIds.includes(t.id));
      if (!addedTag) {
        // Newly created — refresh to discover it
        const params = new URLSearchParams();
        if (connectorCaps?.tagScope === 'per-list' && sourceListId) {
          params.set('listId', sourceListId);
        }
        if (connectorCaps && !connectorCaps.tagWriteBack && connectorType) {
          params.set('source', connectorType);
        }
        const url = params.toString() ? `/api/tags?${params.toString()}` : '/api/tags';
        fetch(url)
          .then((r) => r.json())
          .then((d) => {
            const newTag = (d.tags || []).find((t: TaskTag) => data.addedTagIds.includes(t.id));
            if (newTag) onNewTagDiscovered?.(newTag);
          })
          .catch(() => {});
      } else {
        onNewTagDiscovered?.(addedTag);
      }
      onUpdate?.();
    }
    setTagInput('');
  }, [taskId, tagIds, pickerTags, knownTags, connectorCaps?.tagScope, connectorCaps?.tagWriteBack, sourceListId, connectorType, onTagIdsChange, onNewTagDiscovered, onUpdate]);

  const handleRemoveTag = useCallback(async (tagId: string) => {
    // Optimistic remove
    onTagIdsChange(tagIds.filter((id) => id !== tagId));
    const res = await fetch(`/api/tasks/${taskId}/tags`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId }),
    });
    if (!res.ok) {
      onTagIdsChange(tagIds); // revert
      toast.error('Failed to remove tag');
      return;
    }
    onUpdate?.();
  }, [taskId, tagIds, onTagIdsChange, onUpdate]);

  // Compute display tags from tagIds + knownTags
  const displayTags = tagIds
    .map((id) => knownTags.find((t) => t.id === id))
    .filter(Boolean) as TaskTag[];

  // Filter picker tags to exclude already-assigned
  const filteredPickerTags = pickerTags.filter(
    (t) => !tagIds.includes(t.id) && t.name.toLowerCase().includes(tagInput.toLowerCase()),
  );

  const canCreate = !connectorCaps || connectorCaps.tagCreationMode === 'freeform';

  return (
    <div className="relative" ref={ref}>
      {/* Current tags display + add button */}
      <div className="flex flex-wrap items-center gap-1.5">
        {displayTags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border"
            style={getTagPillStyle(tag.color)}
          >
            {tag.name}
            {canEdit && (
              <button
                onClick={() => handleRemoveTag(tag.id)}
                className="ml-0.5 hover:text-red-400 transition-colors"
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
        {canEdit && (
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
          >
            <Tag size={10} />
            <Plus size={10} />
          </button>
        )}
      </div>

      {/* Picker dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="absolute left-0 top-full mt-1 w-56 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-20 overflow-hidden"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
          >
            {/* Search input */}
            <div className="px-2 pt-2 pb-1.5">
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tagInput.trim() && canCreate) {
                      e.preventDefault();
                      handleAddTag(tagInput.trim());
                    }
                    if (e.key === 'Escape') { setIsOpen(false); setTagInput(''); }
                  }}
                  placeholder={canCreate ? 'Search or create tag…' : 'Search tags…'}
                  className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  autoFocus
                />
              </div>
            </div>

            {/* Tag list */}
            <div className="max-h-40 overflow-y-auto px-1 pb-1.5">
              {pickerLoading ? (
                <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">Loading…</div>
              ) : filteredPickerTags.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">
                  {tagInput.trim() && canCreate ? (
                    <button
                      onClick={() => handleAddTag(tagInput.trim())}
                      className="text-[var(--accent)] hover:underline"
                    >
                      Create &quot;{tagInput.trim()}&quot;
                    </button>
                  ) : (
                    'No tags found'
                  )}
                </div>
              ) : (
                filteredPickerTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleAddTag(tag.name)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color || 'var(--text-muted)' }}
                    />
                    {tag.name}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
