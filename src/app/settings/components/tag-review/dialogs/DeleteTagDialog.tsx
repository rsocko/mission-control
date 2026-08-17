'use client';

import { Loader2, Trash2 } from 'lucide-react';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import { DialogChrome } from './DialogChrome';

interface DeleteTagDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  onSubmit: (
    tag: Extract<TagDialogState, { kind: 'delete' }>['tag'],
    writeBack: boolean,
  ) => void;
  state: Extract<TagDialogState, { kind: 'delete' }> | null;
}

export function DeleteTagDialog({ busy, dispatch, onSubmit, state }: DeleteTagDialogProps) {
  const close = () => dispatch({ type: 'close' });

  return (
    <DialogChrome open={!!state} onClose={close} labelId="delete-tag-dialog-title">
      {state && (
        <>
          <h3 id="delete-tag-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">Remove tag?</h3>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            This removes &ldquo;{state.tag.name}&rdquo; and detaches it from {state.tag.usageCount} task{state.tag.usageCount === 1 ? '' : 's'}.
          </p>
          {state.tag.type === 'source' && state.tag.usageCount > 0 && (
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
                  Remove this label from {state.tag.usageCount} task{state.tag.usageCount === 1 ? '' : 's'} in the source system (e.g., GitHub).
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
              onClick={() => onSubmit(state.tag, state.writeBack)}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Remove
            </button>
          </div>
        </>
      )}
    </DialogChrome>
  );
}
