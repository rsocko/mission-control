'use client';

import { Archive, BookOpen, Boxes, Check, Clock3, ListTodo, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { SOURCE_META } from '@/components/triage/types';
import RichPreviewEmbed from '@/components/triage/RichPreviewEmbed';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';
import type { TriageActionType, TriageItem } from '@/types';

const QUICK_ACTIONS: Array<{ type: TriageActionType; label: string; icon: typeof Archive; className: string }> = [
  { type: 'save_karakeep', label: 'Karakeep', icon: Archive, className: 'border-blue-800/40 bg-blue-900/20 text-blue-300 hover:bg-blue-900/40' },
  { type: 'create_task_todo', label: 'Task', icon: ListTodo, className: 'border-emerald-800/40 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/40' },
  { type: 'snooze', label: 'Snooze', icon: Clock3, className: 'border-sky-800/40 bg-sky-900/20 text-sky-300 hover:bg-sky-900/40' },
  { type: 'dismiss', label: 'Dismiss', icon: X, className: 'border-slate-700/40 bg-slate-800/20 text-slate-300 hover:bg-slate-800/40' },
];

interface TriageStreamItemProps {
  item: TriageItem;
  isSelected: boolean;
  isBulkSelected: boolean;
  bulkMode: boolean;
  onSelect: () => void;
  onBulkToggle: () => void;
  onAction?: (itemId: string, actionType: TriageActionType) => void;
  embedsEnabled?: boolean;
}

export default function TriageStreamItem({
  item,
  isSelected,
  isBulkSelected,
  bulkMode,
  onSelect,
  onBulkToggle,
  onAction,
  embedsEnabled = true,
}: TriageStreamItemProps) {
  const meta = SOURCE_META[item.sourcePlatform] || SOURCE_META.web;
  const embed = item.rawMetadata?.embed as { thumbnail_url?: string; type?: string } | undefined;
  const thumbnailUrl = item.thumbnailUrl || embed?.thumbnail_url;

  return (
    <div className="flex items-start gap-2">
      {bulkMode ? (
        <input
          type="checkbox"
          checked={isBulkSelected}
          onChange={onBulkToggle}
          aria-label={`Select ${item.title}`}
          className="mt-5 h-4 w-4 flex-shrink-0 cursor-pointer rounded border-[var(--border-strong)] accent-[var(--accent-500)]"
        />
      ) : null}
      <button
        type="button"
        onClick={bulkMode ? onBulkToggle : onSelect}
        className={cn(
          'w-full rounded-[16px] border px-4 py-4 text-left shadow-[var(--shadow-sm)] transition-[border-color,background-color]',
          isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-900)]/15'
            : isBulkSelected
              ? 'border-blue-500/40 bg-blue-900/20'
              : 'border-[var(--border)] bg-[var(--surface-0)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-1)]',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          {thumbnailUrl ? (
            <div className={cn(
              'relative flex-shrink-0 overflow-hidden rounded-[10px] bg-[var(--surface-2)]',
              item.sourcePlatform === 'tiktok'
                ? 'h-[72px] w-[40px]'
                : item.sourcePlatform === 'instagram' || item.sourcePlatform === 'pinterest'
                  ? 'h-[72px] w-[58px]'
                  : item.sourcePlatform === 'youtube'
                    ? 'h-[72px] w-[128px]'
                    : 'h-[72px] w-[72px]',
            )}>
              <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
              {(item.contentType === 'video' || embed?.type === 'video') && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                  <Play size={18} className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]" fill="white" />
                </div>
              )}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em]', meta.badge)}>
              <TriageSourceIcon source={item.sourcePlatform} size={12} decorative />
              {meta.label}
            </div>
            <h4 className="mt-3 text-sm font-semibold text-[var(--text-primary)] [text-wrap:balance]">{item.title}</h4>
            <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)] [text-wrap:pretty]">{item.aiSummary || item.description}</p>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold text-[var(--accent-300)] [font-variant-numeric:tabular-nums]">{item.aiRelevanceScore}</div>
            <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-tertiary)]">{item.status}</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {item.aiCategories.slice(0, 3).map((category) => (
            <span key={category} className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs text-[var(--text-secondary)]">
              {category}
            </span>
          ))}
        </div>

        {/* AI suggestion pills */}
        {item.aiSuggestedActions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.aiSuggestedActions.slice(0, 2).map((suggestion) => (
              <span
                key={suggestion.actionType}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/20 bg-[var(--accent-900)]/20 px-2 py-0.5 text-xs font-medium text-[var(--accent-300)]"
              >
                {suggestion.label || suggestion.actionType.replace(/_/g, ' ')}
                <span className="tabular-nums opacity-70">{Math.round(suggestion.confidence * 100)}%</span>
              </span>
            ))}
          </div>
        )}

        {/* Inline quick actions */}
        {!bulkMode && onAction && (
          <div className="mt-3 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
            {QUICK_ACTIONS.map(({ type, label, icon: Icon, className: actionClass }) => {
              const alreadyDone = item.actionsTaken.some((a) => a.actionType === type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (!alreadyDone) onAction(item.id, type); }}
                  disabled={alreadyDone}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-[8px] border px-2 py-1 text-xs font-medium transition-colors',
                    alreadyDone ? 'border-green-800/40 bg-green-900/20 text-green-400 opacity-70 cursor-default' : actionClass,
                  )}
                >
                  {alreadyDone ? <Check size={11} /> : <Icon size={11} />}
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {isSelected && (
          <div className="mt-3" onClick={(e) => e.stopPropagation()}>
            <RichPreviewEmbed item={item} embedsEnabled={embedsEnabled} variant="compact" maxThumbnailHeight={200} />
          </div>
        )}
      </button>
    </div>
  );
}
