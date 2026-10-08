'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectProposalActions } from './contracts';

export function PhaseReorganizationTrigger({
  phaseId,
  phaseName,
  proposalActions,
  compact = false,
}: {
  phaseId: string;
  phaseName: string;
  proposalActions: ProjectProposalActions;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState('');

  function submit() {
    proposalActions.reorganize(phaseId, guidance.trim() || undefined);
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={proposalActions.isReorganizing}
          className={compact
            ? 'inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50'
            : 'inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-amber-500/25 bg-amber-500/5 px-2.5 text-xs font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50'}
        >
          {proposalActions.isReorganizing
            ? <LoaderCircle size={13} className="animate-spin" />
            : <Sparkles size={13} />}
          Review structure
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,36rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-semibold text-[var(--text-primary)]">
                Review “{phaseName}”
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-[var(--text-tertiary)]">
                AI will compare this phase with the rest of the project and propose the smallest useful reorganization. Nothing changes until you approve it.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="Close phase review" className="min-h-10 min-w-10 px-2">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <label htmlFor={`phase-review-${phaseId}`} className="mt-5 block text-sm font-medium text-[var(--text-primary)]">
            What should the review preserve or optimize?
            <span className="ml-1 font-normal text-[var(--text-tertiary)]">(optional)</span>
          </label>
          <textarea
            id={`phase-review-${phaseId}`}
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            maxLength={4000}
            rows={4}
            autoFocus
            placeholder="For example: keep completed launch work together and separate ongoing maintenance."
            className="mt-2 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-purple-500 focus:shadow-[var(--shadow-focus-glow)]"
          />
          <p className="mt-1 text-right text-xs tabular-nums text-[var(--text-muted)]">
            {guidance.length}/4000
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
            <Button onClick={submit}>
              <Sparkles />
              Generate review
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
