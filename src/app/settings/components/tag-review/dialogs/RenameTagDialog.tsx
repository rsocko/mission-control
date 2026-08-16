'use client';

import { Loader2, Pencil } from 'lucide-react';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import { DialogChrome } from './DialogChrome';

interface RenameTagDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  onSubmit: (tag: Extract<TagDialogState, { kind: 'rename' }>['tag'], value: string) => void;
  state: Extract<TagDialogState, { kind: 'rename' }> | null;
}

export function RenameTagDialog({ busy, dispatch, onSubmit, state }: RenameTagDialogProps) {
  const close = () => dispatch({ type: 'close' });

  return (
    <DialogChrome open={!!state} onClose={close} labelId="rename-tag-dialog-title">
      {state && (
        <>
          <h3 id="rename-tag-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">Rename Tag</h3>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            Rename &ldquo;{state.tag.name}&rdquo; across {state.tag.usageCount} task{state.tag.usageCount === 1 ? '' : 's'}.
          </p>
          <input
            type="text"
            value={state.value}
            onChange={event => dispatch({ type: 'set-value', value: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter') onSubmit(state.tag, state.value);
            }}
            placeholder="New name..."
            autoFocus
            className="w-full px-3 py-2 text-sm bg-[var(--surface-0)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40 focus:border-blue-500/40 mb-4"
          />
          {state.tag.type === 'source' && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/30 rounded-md px-2.5 py-1.5 mb-4">
              ⚠️ Source tags can only be renamed in Mission Control. The original label on the source system will not change.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button
              type="button"
              disabled={!state.value.trim() || state.value.trim() === state.tag.name || busy}
              onClick={() => onSubmit(state.tag, state.value)}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
              Rename
            </button>
          </div>
        </>
      )}
    </DialogChrome>
  );
}
