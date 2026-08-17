'use client';

import { Loader2, Palette } from 'lucide-react';
import { getTagPillStyle } from '@/lib/constants/colors';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import { DialogChrome } from './DialogChrome';

const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6',
  '#8b5cf6', '#ec4899', '#6b7280', '#14b8a6', '#f43f5e',
];

interface RecolorTagDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  onSubmit: (tag: Extract<TagDialogState, { kind: 'recolor' }>['tag'], value: string) => void;
  state: Extract<TagDialogState, { kind: 'recolor' }> | null;
}

export function RecolorTagDialog({ busy, dispatch, onSubmit, state }: RecolorTagDialogProps) {
  const close = () => dispatch({ type: 'close' });

  return (
    <DialogChrome open={!!state} onClose={close} labelId="recolor-tag-dialog-title" maxWidth="max-w-xs">
      {state && (
        <>
          <h3 id="recolor-tag-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-3">Change Color</h3>
          <div className="flex items-center gap-3 mb-4">
            <span
              className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full border border-[var(--border)]"
              style={getTagPillStyle(state.value)}
            >
              {state.tag.name}
            </span>
            <span className="text-xs text-[var(--text-muted)]">Preview</span>
          </div>
          <div className="grid grid-cols-5 gap-2 mb-4">
            {COLOR_PRESETS.map(color => (
              <button
                key={color}
                type="button"
                onClick={() => dispatch({ type: 'set-value', value: color })}
                className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                  state.value === color ? 'border-white scale-110' : 'border-transparent'
                }`}
                style={{ background: color }}
                aria-label={`Use color ${color}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs text-[var(--text-muted)]">Custom:</label>
            <input
              type="color"
              value={state.value}
              onChange={event => dispatch({ type: 'set-value', value: event.target.value })}
              className="w-8 h-8 rounded border-0 cursor-pointer bg-transparent"
            />
            <span className="text-xs text-[var(--text-muted)] font-mono">{state.value}</span>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSubmit(state.tag, state.value)}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Palette size={12} />}
              Apply
            </button>
          </div>
        </>
      )}
    </DialogChrome>
  );
}
