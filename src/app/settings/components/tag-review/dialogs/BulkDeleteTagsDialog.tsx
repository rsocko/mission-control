'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { getTagPillStyle } from '@/lib/constants/colors';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import { isSystemTag } from '../heuristics';
import type { ReviewTag } from '../types';
import { DialogChrome } from './DialogChrome';

interface BulkDeleteTagsDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  onSubmit: (tags: ReviewTag[], writeBack: boolean) => void;
  selectedTags: ReviewTag[];
  state: Extract<TagDialogState, { kind: 'bulk-delete' }> | null;
}

export function BulkDeleteTagsDialog({
  busy,
  dispatch,
  onSubmit,
  selectedTags,
  state,
}: BulkDeleteTagsDialogProps) {
  const close = () => dispatch({ type: 'close' });
  const removableTags = selectedTags.filter(tag => !isSystemTag(tag.name));

  return (
    <DialogChrome open={!!state} onClose={close} labelId="bulk-delete-tags-dialog-title">
      {state && (
        <>
          <h3 id="bulk-delete-tags-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
            Remove {selectedTags.length} tags?
          </h3>
          <p className="text-xs text-[var(--text-muted)] mb-3">
            This will remove the following tags and detach them from all linked tasks:
          </p>
          <div className="bg-[var(--surface-0)] rounded-lg p-3 mb-4 max-h-32 overflow-y-auto">
            <div className="flex flex-wrap gap-1.5">
              {removableTags.map(tag => (
                <span
                  key={tag.id}
                  className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)]"
                  style={getTagPillStyle(tag.color)}
                >
                  {tag.name} <span className="text-[var(--text-muted)] ml-1">({tag.usageCount})</span>
                </span>
              ))}
            </div>
          </div>
          {selectedTags.some(tag => tag.type === 'source' && tag.usageCount > 0) && (
            <label className="flex items-start gap-2 bg-amber-900/20 border border-amber-800/30 rounded-md px-3 py-2.5 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={state.writeBack}
                onChange={event => dispatch({ type: 'set-write-back', value: event.target.checked })}
                className="mt-0.5 rounded border-[var(--border)] w-3.5 h-3.5 accent-amber-500"
              />
              <div>
                <span className="text-xs text-amber-300 font-medium">Also remove from source</span>
                <p className="text-[10px] text-amber-300/70 mt-0.5">
                  Remove labels from tasks in the source system (e.g., GitHub) before deleting.
                </p>
              </div>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSubmit(selectedTags, state.writeBack)}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Remove {removableTags.length} Tags
            </button>
          </div>
        </>
      )}
    </DialogChrome>
  );
}
