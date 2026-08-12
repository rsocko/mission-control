'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, Check, ChevronDown, ChevronUp, ClipboardPlus, Link2, Loader2, RefreshCw, Tag, Trash2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { ACTION_META } from '@/components/triage/types';
import RichPreviewEmbed from '@/components/triage/RichPreviewEmbed';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import type { TriageActionType, TriageItem } from '@/types';

interface DecisionPanelProps {
  selectedItem: TriageItem | null;
  onAction: (itemId: string, actionType: TriageActionType) => void;
  onCreateTask?: (item: TriageItem, preferredAction?: TriageActionType) => void;
  onDelete?: (itemId: string) => void;
  onItemUpdated?: () => void;
  busyAction: string | null;
  embedsEnabled: boolean;
}

export default function DecisionPanel({
  selectedItem,
  onAction,
  onCreateTask,
  onDelete,
  onItemUpdated,
  busyAction,
  embedsEnabled,
}: DecisionPanelProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [contentTypes, setContentTypes] = useState<Array<{ id: string; name: string; color: string }>>([]);
  const typePickerRef = useRef<HTMLDivElement>(null);
  const toggleText = useCallback(() => setTextExpanded((prev) => !prev), []);

  // Reset text expansion when switching items
  useEffect(() => { setTextExpanded(false); setShowTypePicker(false); }, [selectedItem?.id]);

  // Load content types for the picker
  useEffect(() => {
    fetch('/api/triage/content-types')
      .then((r) => r.json())
      .then((data) => {
        if (data.contentTypes) setContentTypes(data.contentTypes.filter((ct: { suppressed: boolean }) => !ct.suppressed));
      })
      .catch(() => {});
  }, []);

  // Close type picker on outside click
  useEffect(() => {
    if (!showTypePicker) return;
    const handler = (e: MouseEvent) => {
      if (typePickerRef.current && !typePickerRef.current.contains(e.target as Node)) {
        setShowTypePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTypePicker]);

  const handleAutoReclassify = useCallback(async () => {
    if (!selectedItem) return;
    setReclassifying(true);
    try {
      const res = await fetch('/api/triage/reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto', id: selectedItem.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Reclassify failed');
      } else if (data.changed) {
        toast.success(`Reclassified to "${data.item.contentType}"`);
        onItemUpdated?.();
      } else {
        toast.info('Content type unchanged');
      }
    } catch {
      toast.error('Network error during reclassify');
    }
    setReclassifying(false);
  }, [selectedItem, onItemUpdated]);

  const handleSetType = useCallback(async (contentType: string) => {
    if (!selectedItem) return;
    setShowTypePicker(false);
    setReclassifying(true);
    try {
      const res = await fetch('/api/triage/reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_type', id: selectedItem.id, contentType }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to set type');
      } else {
        toast.success(`Type set to "${contentType}"`);
        onItemUpdated?.();
      }
    } catch {
      toast.error('Network error');
    }
    setReclassifying(false);
  }, [selectedItem, onItemUpdated]);

  if (!selectedItem) {
    return (
      <section className="rounded-[18px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
        <div className="flex h-full min-h-[320px] items-center justify-center text-center text-sm text-[var(--text-tertiary)]">
          Select a triage item to review.
        </div>
      </section>
    );
  }

  const embed = selectedItem.rawMetadata?.embed as {
    type?: string;
    html?: string;
    thumbnail_url?: string;
    provider_name?: string;
    resolved_title?: string;
  } | undefined;

  const isMediaSource = selectedItem.sourcePlatform === 'instagram' || selectedItem.sourcePlatform === 'youtube';
  const descriptionText = selectedItem.description || selectedItem.aiSummary;
  const isLongText = !!descriptionText && descriptionText.length > 200;

  return (
    <section className="rounded-[18px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Decision panel</h3>
          <p className="text-xs text-[var(--text-tertiary)]">Route the item, archive it, or defer it.</p>
        </div>
        <div className="rounded-full border border-[var(--border)] bg-[var(--surface-0)] px-3 py-1 text-xs text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">
          Score {selectedItem.aiRelevanceScore}
        </div>
      </div>

      <div className="mt-4 rounded-[16px] border border-[var(--border)] bg-[var(--surface-0)] p-4">
        <h4 className="text-lg font-semibold text-[var(--text-primary)] [text-wrap:balance]">{selectedItem.title}</h4>

        {/* Media-first layout: show embed before text for Instagram/YouTube */}
        {isMediaSource && (
          <div className="mt-3">
            <RichPreviewEmbed item={selectedItem} embedsEnabled={embedsEnabled} variant="full" maxThumbnailHeight={320} autoExpand />
          </div>
        )}

        {/* Expandable text for media sources, full text for others */}
        {descriptionText && (
          <div className="mt-2">
            <p className={cn(
              'text-sm text-[var(--text-secondary)] [text-wrap:pretty]',
              isMediaSource && isLongText && !textExpanded && 'line-clamp-3',
            )}>
              {descriptionText}
            </p>
            {isMediaSource && isLongText && (
              <button
                type="button"
                onClick={toggleText}
                className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent-300)] transition-colors hover:text-[var(--accent-200)]"
              >
                {textExpanded ? <><ChevronUp size={12} />Show less</> : <><ChevronDown size={12} />Show more</>}
              </button>
            )}
          </div>
        )}

        {/* Non-media sources: embed after text */}
        {!isMediaSource && (
          <div className="mt-3">
            <RichPreviewEmbed item={selectedItem} embedsEnabled={embedsEnabled} variant="full" maxThumbnailHeight={320} autoExpand />
          </div>
        )}

        {/^(https?:\/\/)/i.test(selectedItem.sourceUrl) && (
          <a href={selectedItem.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-sm text-[var(--accent-300)] hover:text-[var(--accent-200)]">
            <Link2 size={14} />
            Open source
          </a>
        )}
        {typeof selectedItem.rawMetadata?.parsedDueDate === 'string' && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm">
            <Calendar size={14} className="text-[var(--accent-300)]" />
            <span className="text-[var(--text-secondary)]">Detected due date:</span>
            <span className="font-medium text-[var(--text-primary)]">
              {(selectedItem.rawMetadata.parsedDueDateLabel as string) || selectedItem.rawMetadata.parsedDueDate}
            </span>
          </div>
        )}
      </div>

      {/* Content Type with reclassify/override */}
      <div className="mt-4 relative">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-tertiary)]">Content type</div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-0)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <Tag size={12} />
            {selectedItem.contentType}
          </span>
          <Tooltip content="Re-detect content type using current rules">
            <button
              type="button"
              onClick={handleAutoReclassify}
              disabled={reclassifying}
              className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] p-1.5 text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-300)] disabled:opacity-50"
            >
              {reclassifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </Tooltip>
          <div className="relative" ref={typePickerRef}>
            <Tooltip content="Manually set content type">
              <button
                type="button"
                onClick={() => setShowTypePicker((p) => !p)}
                className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1.5 text-xs text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-300)]"
              >
                Set type…
              </button>
            </Tooltip>
            {showTypePicker && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-lg">
                {contentTypes.map((ct) => (
                  <button
                    key={ct.id}
                    type="button"
                    onClick={() => handleSetType(ct.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[8px] px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--surface-2)]',
                      ct.id === selectedItem.contentType ? 'font-medium text-[var(--accent-300)]' : 'text-[var(--text-secondary)]',
                    )}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ct.color }} />
                    {ct.name}
                    {ct.id === selectedItem.contentType && <Check size={12} className="ml-auto" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-tertiary)]">Suggested actions</div>
        <div className="space-y-2">
          {selectedItem.aiSuggestedActions.map((action) => {
            const meta = ACTION_META[action.actionType];
            const Icon = meta.icon;
            const isTaskAction = action.actionType === 'create_task_github' || action.actionType === 'create_task_todo';
            const alreadyDone = selectedItem.actionsTaken.some((a) => a.actionType === action.actionType);
            return (
              <button
                key={`${selectedItem.id}-${action.actionType}`}
                type="button"
                onClick={() => {
                  if (alreadyDone) return;
                  if (isTaskAction && onCreateTask) {
                    onCreateTask(selectedItem, action.actionType);
                  } else {
                    onAction(selectedItem.id, action.actionType);
                  }
                }}
                disabled={busyAction === action.actionType || alreadyDone}
                className={cn(
                  "flex w-full items-start justify-between gap-3 rounded-[14px] border px-3 py-3 text-left transition-[border-color,background-color] disabled:cursor-not-allowed disabled:opacity-60",
                  alreadyDone
                    ? "border-green-800/40 bg-green-900/10"
                    : "border-[var(--border)] bg-[var(--surface-0)] hover:border-[var(--accent)] hover:bg-[var(--surface-1)]",
                )}
              >
                <div className="flex gap-3">
                  <div className={cn(
                    "mt-0.5 rounded-[10px] border p-2",
                    alreadyDone
                      ? "border-green-800/40 bg-green-900/20 text-green-400"
                      : "border-[var(--border)] bg-[var(--surface-1)] text-[var(--accent-300)]",
                  )}>
                    {busyAction === action.actionType ? <Loader2 className="animate-spin" size={14} /> : alreadyDone ? <Check size={14} /> : <Icon size={14} />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-[var(--text-primary)]">{action.label || meta.label}{alreadyDone ? '' : ''}</div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">{alreadyDone ? 'Already applied' : action.reason}</div>
                  </div>
                </div>
                <div className="rounded-full border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">{Math.round(action.confidence * 100)}%</div>
              </button>
            );
          })}
        </div>
      </div>

      {onCreateTask && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => onCreateTask(selectedItem, undefined)}
            className="flex w-full items-center justify-center gap-2 rounded-[12px] border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-3 py-2.5 text-sm font-medium text-[var(--accent-200)] transition-colors hover:bg-[var(--accent)]/20"
          >
            <ClipboardPlus size={14} />
            Create Task…
          </button>
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onAction(selectedItem.id, 'snooze')}
          className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
        >
          Snooze 1 day
        </button>
        <button
          type="button"
          onClick={() => onAction(selectedItem.id, 'dismiss')}
          className="rounded-[12px] border border-red-500/20 bg-red-500/5 px-3 py-2.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/10"
        >
          Dismiss
        </button>
        {onDelete && (
          <Tooltip content="Permanently delete this item and its cached data">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-[12px] border border-red-500/30 bg-red-500/5 p-2.5 text-red-300 transition-colors hover:bg-red-500/15"
            >
              <Trash2 size={16} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && onDelete && (
        <ConfirmDialog
          open={showDeleteConfirm}
          title="Delete permanently?"
          message="This will permanently remove this item and its cached thumbnail. This cannot be undone."
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={() => {
            onDelete(selectedItem.id);
            setShowDeleteConfirm(false);
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-tertiary)]">History</div>
        {selectedItem.actionsTaken.length ? (
          <div className="space-y-2">
            {selectedItem.actionsTaken.slice().reverse().map((entry, index) => (
              <div key={`${entry.actionType}-${entry.appliedAt}-${index}`} className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 text-sm">
                <div className="font-medium text-[var(--text-primary)]">{ACTION_META[entry.actionType].label}</div>
                <div className="mt-1 text-xs text-[var(--text-tertiary)]">{new Date(entry.appliedAt).toLocaleString()}</div>
                {entry.note ? <div className="mt-1 text-xs text-[var(--text-secondary)]">{entry.note}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[12px] border border-dashed border-[var(--border)] bg-[var(--surface-0)] px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">
            Actions will show up here once you triage — you&apos;re starting fresh.
          </div>
        )}
      </div>
    </section>
  );
}
