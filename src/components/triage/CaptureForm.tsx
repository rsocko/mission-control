'use client';

import type { FormEventHandler } from 'react';
import { BookmarkPlus, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TriageSourcePlatform } from '@/types';
import { SOURCE_OPTIONS } from '@/components/triage/types';

interface CaptureFormProps {
  captureUrl: string;
  setCaptureUrl: (value: string) => void;
  captureSource: TriageSourcePlatform;
  setCaptureSource: (value: TriageSourcePlatform) => void;
  busyAction: string | null;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export default function CaptureForm({
  captureUrl,
  setCaptureUrl,
  captureSource,
  setCaptureSource,
  busyAction,
  onSubmit,
}: CaptureFormProps) {
  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2 rounded-[12px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
      <input
        value={captureUrl}
        onChange={(event) => setCaptureUrl(event.target.value)}
        placeholder="Paste a URL to capture into triage…"
        className="h-8 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)]"
      />
      <Select value={captureSource} onValueChange={(value) => setCaptureSource(value as TriageSourcePlatform)}>
        <SelectTrigger className="h-8 w-[140px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs text-[var(--text-primary)]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SOURCE_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="submit"
        disabled={busyAction === 'capture'}
        className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--accent)] px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[var(--accent-500)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busyAction === 'capture' ? <Loader2 size={13} className="animate-spin" /> : <BookmarkPlus size={13} />}
        Capture
      </button>
    </form>
  );
}
