'use client';

import { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ACTION_META } from '@/components/triage/types';
import { Modal } from '@/components/ui/Modal';
import type { TriageActionType, TriageItem } from '@/types';

interface AutoTriagePlan {
  actionType: TriageActionType;
  itemIds: string[];
  items: Array<{ id: string; title: string; confidence: number }>;
}

interface AutoTriageModalProps {
  open: boolean;
  onClose: () => void;
  items: TriageItem[];
  onExecute: (plan: AutoTriagePlan[]) => Promise<void>;
}

const DEFAULT_THRESHOLD = 0.75;

function buildPlan(items: TriageItem[], threshold: number): AutoTriagePlan[] {
  const pendingItems = items.filter((item) => item.status === 'pending');
  const groups = new Map<TriageActionType, AutoTriagePlan['items']>();

  for (const item of pendingItems) {
    const topSuggestion = item.aiSuggestedActions[0];
    if (!topSuggestion || topSuggestion.confidence < threshold) continue;
    const list = groups.get(topSuggestion.actionType) || [];
    list.push({ id: item.id, title: item.title, confidence: topSuggestion.confidence });
    groups.set(topSuggestion.actionType, list);
  }

  return Array.from(groups.entries())
    .map(([actionType, planItems]) => ({
      actionType,
      itemIds: planItems.map((i) => i.id),
      items: planItems,
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

export default function AutoTriageModal({ open, onClose, items, onExecute }: AutoTriageModalProps) {
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [executing, setExecuting] = useState(false);

  const plan = buildPlan(items, threshold);
  const totalItems = plan.reduce((sum, group) => sum + group.items.length, 0);

  async function handleExecute() {
    setExecuting(true);
    try {
      await onExecute(plan);
      onClose();
    } finally {
      setExecuting(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      ariaLabel="Auto-Triage"
      size="md"
      className="w-full max-w-lg rounded-[18px] p-6"
      overlayClassName="items-center px-4 pt-0"
    >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--accent-400)]" />
            <h2 id="auto-triage-title" className="text-base font-semibold text-[var(--text-primary)]">Auto-Triage</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Apply top AI suggestion to all pending items above the confidence threshold.
        </p>

        {/* Threshold slider */}
        <div className="mt-4 rounded-[12px] border border-[var(--border)] bg-[var(--surface-0)] p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Confidence threshold</span>
            <span className="text-sm font-bold tabular-nums text-[var(--accent-400)]">{Math.round(threshold * 100)}%</span>
          </div>
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={threshold * 100}
            onChange={(e) => setThreshold(Number(e.target.value) / 100)}
            className="mt-2 w-full accent-[var(--accent)]"
          />
          <div className="mt-1 flex justify-between text-xs text-[var(--text-tertiary)]">
            <span>50% (more items)</span>
            <span>95% (fewer, safer)</span>
          </div>
        </div>

        {/* Plan preview */}
        <div className="mt-4 max-h-[280px] overflow-y-auto space-y-2">
          {plan.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface-0)] px-4 py-6 text-center text-sm text-[var(--text-tertiary)]">
              No items meet this threshold. Try lowering it.
            </div>
          ) : (
            plan.map((group) => {
              const meta = ACTION_META[group.actionType];
              const Icon = meta.icon;
              return (
                <div key={group.actionType} className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-0)] p-3">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className="text-[var(--accent-300)]" />
                    <span className="text-sm font-medium text-[var(--text-primary)]">{meta.label}</span>
                    <span className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-xs tabular-nums text-[var(--text-secondary)]">
                      {group.items.length} item{group.items.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {group.items.slice(0, 5).map((item) => (
                      <div key={item.id} className="flex items-center justify-between text-xs">
                        <span className="truncate text-[var(--text-secondary)]">{item.title}</span>
                        <span className="ml-2 shrink-0 tabular-nums text-[var(--text-tertiary)]">{Math.round(item.confidence * 100)}%</span>
                      </div>
                    ))}
                    {group.items.length > 5 && (
                      <div className="text-xs text-[var(--text-tertiary)]">+ {group.items.length - 5} more</div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
          <span className="text-xs text-[var(--text-tertiary)]">
            {totalItems} item{totalItems !== 1 ? 's' : ''} will be actioned
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={totalItems === 0 || executing}
              className={cn(
                'inline-flex items-center gap-2 rounded-[10px] px-4 py-2 text-sm font-medium transition-colors',
                'bg-[var(--accent)] text-white hover:bg-[var(--accent-600)] disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {executing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {executing ? 'Processing…' : `Auto-Triage ${totalItems} items`}
            </button>
          </div>
        </div>
    </Modal>
  );
}
