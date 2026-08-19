'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectProposalActions } from './contracts';

type PlanningMode = 'suggest' | 'refine';

interface AIPlanControlProps {
  hasPhases: boolean;
  proposalActions: ProjectProposalActions;
  variant?: 'outline' | 'secondary';
}

export function AIPlanControl({
  hasPhases,
  proposalActions,
  variant = 'outline',
}: AIPlanControlProps) {
  const [planningMode, setPlanningMode] = useState<PlanningMode | null>(null);
  const [guidance, setGuidance] = useState('');
  const isWorking = proposalActions.isGenerating || proposalActions.isRefining;
  const isRefining = planningMode === 'refine';

  function openGuidance(mode: PlanningMode) {
    setGuidance('');
    // Let Radix dismiss the dropdown before mounting another focus-managed layer.
    setTimeout(() => setPlanningMode(mode), 0);
  }

  function submit() {
    const normalizedGuidance = guidance.trim() || undefined;
    if (isRefining) {
      proposalActions.refine(normalizedGuidance);
    } else {
      proposalActions.generate(normalizedGuidance);
    }
    setPlanningMode(null);
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant={variant}
            disabled={isWorking}
            className={variant === 'outline'
              ? 'border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300'
              : undefined}
          >
            {isWorking ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            AI Plan
            <ChevronDown />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-64 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-2xl"
          >
            {hasPhases ? (
              <>
                <DropdownMenu.Item
                  onSelect={() => openGuidance('refine')}
                  className="cursor-default rounded-lg px-3 py-2 outline-none focus:bg-[var(--surface-2)]"
                >
                  <div className="flex items-start gap-2">
                    <RefreshCw className="mt-0.5 size-4 shrink-0 text-purple-400" />
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        Improve current plan
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                        Preserve the current plan as context while improving it.
                      </p>
                    </div>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                <DropdownMenu.Item
                  onSelect={() => openGuidance('suggest')}
                  className="cursor-default rounded-lg px-3 py-2 outline-none focus:bg-[var(--surface-2)]"
                >
                  <div className="flex items-start gap-2">
                    <Sparkles className="mt-0.5 size-4 shrink-0 text-purple-400" />
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        Start over from tasks
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                        Propose a fresh structure without using the current phases.
                      </p>
                    </div>
                  </div>
                </DropdownMenu.Item>
              </>
            ) : (
              <DropdownMenu.Item
                onSelect={() => openGuidance('suggest')}
                className="cursor-default rounded-lg px-3 py-2 outline-none focus:bg-[var(--surface-2)]"
              >
                <div className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-purple-400" />
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      Generate plan
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      Organize the project tasks into a new phase plan.
                    </p>
                  </div>
                </div>
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog.Root
        open={planningMode !== null}
        onOpenChange={(open) => {
          if (!open) setPlanningMode(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,36rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold text-[var(--text-primary)]">
                  {isRefining ? 'Improve current plan' : 'Generate plan from tasks'}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-[var(--text-tertiary)]">
                  {isRefining
                    ? 'The current phases and task assignments will be used as context. Nothing changes until you approve the proposal.'
                    : 'AI will propose a fresh phase structure. Nothing changes until you approve the proposal.'}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" aria-label="Close AI plan guidance" className="min-h-10 min-w-10 px-2">
                  <X />
                </Button>
              </Dialog.Close>
            </div>

            <label htmlFor="ai-plan-guidance" className="mt-5 block text-sm font-medium text-[var(--text-primary)]">
              {isRefining
                ? 'What should change or improve?'
                : 'What should this plan optimize for?'}
              <span className="ml-1 font-normal text-[var(--text-tertiary)]">(optional)</span>
            </label>
            <textarea
              id="ai-plan-guidance"
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              maxLength={4000}
              rows={5}
              autoFocus
              placeholder={isRefining
                ? 'For example: preserve Discovery, reduce handoffs, and target a two-week launch.'
                : 'For example: prioritize the launch path and separate frontend from backend work.'}
              className="mt-2 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-purple-500 focus:shadow-[var(--shadow-focus-glow)]"
            />
            <p className="mt-1 text-right text-xs text-[var(--text-muted)]">
              {guidance.length}/4000
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button onClick={submit}>
                <Sparkles />
                Generate proposal
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
