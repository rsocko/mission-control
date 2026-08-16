'use client';

import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, ChevronDown, Check } from 'lucide-react';
import Image from 'next/image';
import { modalOverlay, modalContent } from '@/lib/motion';
import { CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';
import type { TaskTemplate } from '@/types';
import { taskLogger } from '@/lib/client-logger';
import { applyQuickAddWorkflowTemplate } from '@/lib/quick-add/submission';
import type { QuickAddDestination } from './quick-add-types';

interface WorkflowApplyModalProps {
  template: TaskTemplate;
  destinations: QuickAddDestination[];
  initialDestination: QuickAddDestination;
  onClose: () => void;
  onApplied: () => void;
}

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) {
    return <Image src={src} alt={type} width={size} height={size} className="flex-shrink-0" />;
  }
  return null;
}

export function WorkflowApplyModal({
  template,
  destinations,
  initialDestination,
  onClose,
  onApplied,
}: WorkflowApplyModalProps) {
  const workflowTasks = template.workflowTasks || [];
  const [checked, setChecked] = useState<boolean[]>(() => workflowTasks.map(() => true));
  const [destination, setDestination] = useState<QuickAddDestination>(initialDestination);
  const [showDestPicker, setShowDestPicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const checkedCount = checked.filter(Boolean).length;
  const totalSubtasks = workflowTasks.reduce((sum, wt, i) =>
    checked[i] ? sum + (wt.subtasks?.length || 0) : sum, 0
  );

  const toggleTask = useCallback((idx: number) => {
    setChecked(prev => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  }, []);

  // Close on Escape — but not if destination picker is open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showDestPicker) {
          setShowDestPicker(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, showDestPicker]);

  const [error, setError] = useState<string | null>(null);

  const handleApply = useCallback(async () => {
    if (isSubmitting || checkedCount === 0) return;
    setIsSubmitting(true);
    setError(null);

    try {
      await applyQuickAddWorkflowTemplate({}, {
        templateId: template.id,
        destination,
        selectedIndices: checked.flatMap((isChecked, index) => isChecked ? [index] : []),
      });
      onApplied();
      onClose();
      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
    } catch (err) {
      taskLogger.error('Failed to apply workflow template', { err });
      setError(err instanceof Error ? err.message : 'Network error — please try again');
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, checkedCount, template.id, destination, checked, onApplied, onClose]);

  const PRIORITY_STYLES: Record<string, string> = {
    high: 'bg-orange-900/30 text-orange-400',
    critical: 'bg-rose-900/40 text-rose-400',
    medium: 'bg-amber-900/25 text-amber-300',
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center"
        variants={modalOverlay}
        initial="hidden"
        animate="show"
        exit="exit"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <motion.div
          className="relative z-10 w-[480px] max-h-[80vh] flex flex-col bg-[var(--surface-1)] border border-[var(--border-strong)] rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden"
          variants={modalContent}
          initial="hidden"
          animate="show"
          exit="exit"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                {template.icon || '📋'} {template.name}
              </h2>
              <span className="text-xs text-[var(--text-muted)]">
                Workflow template · {checkedCount} task{checkedCount !== 1 ? 's' : ''} will be created
              </span>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1 rounded-md hover:bg-[var(--surface-2)]"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {/* Destination picker */}
            <div className="relative flex items-center gap-2.5 px-3 py-2.5 bg-[var(--surface-0)] rounded-lg border border-[var(--border)]">
              <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Destination</span>
              <button
                onClick={() => setShowDestPicker(!showDestPicker)}
                className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border-strong)] hover:bg-[var(--surface-3)] transition-colors"
              >
                <ConnectorIcon type={destination.connectorType} size={14} />
                <span className="max-w-[160px] truncate">{destination.listName || destination.shortLabel || destination.label}</span>
                <ChevronDown size={10} className={`transition-transform ${showDestPicker ? 'rotate-180' : ''}`} />
              </button>

              <AnimatePresence>
                {showDestPicker && (
                  <motion.div
                    className="absolute right-0 top-full mt-1 z-10 w-64 max-h-52 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-xl"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                  >
                    {destinations.map(dest => (
                      <button
                        key={`${dest.id}-${dest.listId || 'default'}`}
                        onClick={() => { setDestination(dest); setShowDestPicker(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                          destination.id === dest.id && destination.listId === dest.listId
                            ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                        }`}
                      >
                        <ConnectorIcon type={dest.connectorType} size={12} />
                        <span className="truncate">{dest.listName || dest.shortLabel || dest.label}</span>
                        {destination.id === dest.id && destination.listId === dest.listId && (
                          <span className="ml-auto text-blue-400"><Check size={12} /></span>
                        )}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Summary */}
            <div className="flex gap-4 px-3 py-2.5 bg-[var(--surface-2)] rounded-lg">
              <span className="text-xs text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">{checkedCount}</strong> tasks</span>
              <span className="text-xs text-[var(--text-secondary)]"><strong className="text-[var(--text-primary)]">{totalSubtasks}</strong> subtasks total</span>
            </div>

            {/* Task list */}
            {workflowTasks.map((wt, i) => (
              <button
                key={i}
                onClick={() => toggleTask(i)}
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                  checked[i]
                    ? 'border-[var(--border)] bg-[var(--surface-0)]'
                    : 'border-[var(--border-subtle)] bg-transparent opacity-50'
                }`}
              >
                <div className={`mt-0.5 w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                  checked[i]
                    ? 'bg-[var(--accent-500)] border-[var(--accent-500)]'
                    : 'bg-transparent border-[var(--border-strong)]'
                }`}>
                  {checked[i] && <Check size={10} className="text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-[var(--text-primary)]">{wt.title}</span>
                  {wt.subtasks && wt.subtasks.length > 0 && (
                    <span className="block text-xs text-[var(--text-muted)] mt-0.5 truncate">
                      {wt.subtasks.length} subtask{wt.subtasks.length !== 1 ? 's' : ''} · {wt.subtasks.slice(0, 3).join(', ')}{wt.subtasks.length > 3 ? '…' : ''}
                    </span>
                  )}
                </div>
                {wt.priority && wt.priority !== 'none' && (
                  <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${PRIORITY_STYLES[wt.priority] || ''}`}>
                    {wt.priority}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-2 px-5 py-3 border-t border-[var(--border)]">
            {error && (
              <div className="text-xs text-red-400 bg-red-900/20 px-3 py-2 rounded-lg">{error}</div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border-strong)] hover:bg-[var(--surface-3)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={isSubmitting || checkedCount === 0}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--accent-600)] text-white hover:bg-[var(--accent-500)] transition-colors disabled:opacity-50"
              >
                {isSubmitting ? 'Creating…' : `Create ${checkedCount} task${checkedCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
