'use client';

import { ExternalLink, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import type { SourceListInfo } from '../types';
import { DialogChrome } from './DialogChrome';

interface PushTagDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  onSubmit: (tag: Extract<TagDialogState, { kind: 'push' }>['tag'], targetListId: string) => void;
  sourceLists: SourceListInfo[];
  state: Extract<TagDialogState, { kind: 'push' }> | null;
}

export function PushTagDialog({
  busy,
  dispatch,
  onSubmit,
  sourceLists,
  state,
}: PushTagDialogProps) {
  const close = () => dispatch({ type: 'close' });

  return (
    <DialogChrome open={!!state} onClose={close} labelId="push-tag-dialog-title">
      {state && (
        <>
          <h3 id="push-tag-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
            Push &ldquo;{state.tag.name}&rdquo; to source
          </h3>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            Create this tag/label in a source system so it can be applied to tasks there.
          </p>
          <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1 block">Target</label>
          <Select
            value={state.targetListId}
            onValueChange={targetListId => dispatch({ type: 'set-push-target', targetListId })}
          >
            <SelectTrigger className="h-9 w-full mb-4">
              <SelectValue placeholder="Select a source list..." />
            </SelectTrigger>
            <SelectContent>
              {sourceLists.map(sourceList => (
                <SelectItem key={sourceList.id} value={sourceList.id}>{sourceList.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button
              type="button"
              disabled={!state.targetListId || busy}
              onClick={() => onSubmit(state.tag, state.targetListId)}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
              Push
            </button>
          </div>
        </>
      )}
    </DialogChrome>
  );
}
