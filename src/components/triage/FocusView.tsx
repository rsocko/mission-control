'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { CheckCircle2, ChevronDown, Clock3, Inbox, Loader2, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { TriageActionType, TriageItem } from '@/types';
import { ACTION_META, SOURCE_META } from '@/components/triage/types';
import RichPreviewEmbed from '@/components/triage/RichPreviewEmbed';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';

// Primary actions shown as large buttons on mobile
const PRIMARY_ACTIONS: Array<{ type: TriageActionType; label: string; icon: typeof CheckCircle2; classes: string }> = [
  { type: 'complete_action', label: 'Done', icon: CheckCircle2, classes: 'border-green-600/40 bg-green-950/40 text-green-400 active:bg-green-900/60' },
  { type: 'snooze', label: 'Snooze', icon: Clock3, classes: 'border-sky-600/40 bg-sky-950/40 text-sky-400 active:bg-sky-900/60' },
  { type: 'dismiss', label: 'Dismiss', icon: MoreHorizontal, classes: 'border-slate-600/40 bg-slate-950/40 text-slate-400 active:bg-slate-900/60' },
];

// Secondary actions hidden behind "More" on mobile
const SECONDARY_ACTION_TYPES: TriageActionType[] = [
  'save_karakeep',
  'save_knowledge_base',
  'create_task_github',
  'create_task_todo',
  'save_model_catalog',
  'trigger_workflow',
  'open_document',
  'defer_action',
  'resurface',
];

interface FocusViewProps {
  items: TriageItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (id: string, actionType: TriageActionType) => void;
  busyAction: string | null;
  loading: boolean;
  embedsEnabled?: boolean;
}

export default function FocusView({
  items,
  selectedId,
  onSelect,
  onAction,
  busyAction,
  loading,
  embedsEnabled = true,
}: FocusViewProps) {
  const [showMore, setShowMore] = useState(false);
  const currentIndex = items.findIndex((item) => item.id === selectedId);
  const item = currentIndex >= 0 ? items[currentIndex] : items[0] || null;
  const index = currentIndex >= 0 ? currentIndex : 0;

  useEffect(() => {
    if (items.length > 0 && currentIndex < 0) onSelect(items[0].id);
  }, [currentIndex, items, onSelect]);

  // Reset "more" menu and swipe position when switching items
  useEffect(() => { setShowMore(false); }, [selectedId]);

  const isMobile = useIsMobile();
  const swipeX = useMotionValue(0);
  // Reset swipe position when item changes to prevent next card inheriting offset
  useEffect(() => { swipeX.set(0); }, [selectedId, swipeX]);
  const swipeRotate = useTransform(swipeX, [-200, 0, 200], [-8, 0, 8]);
  const swipeOpacity = useTransform(swipeX, [-200, -100, 0, 100, 200], [0.5, 0.8, 1, 0.8, 0.5]);

  function handleCardSwipeEnd(_: unknown, info: PanInfo) {
    const { offset } = info;
    if (offset.x > 120) {
      // Swipe right → "Done" action
      onAction(item.id, 'complete_action');
      if (navigator.vibrate) navigator.vibrate(10);
    } else if (offset.x < -120) {
      // Swipe left → "Dismiss"
      onAction(item.id, 'dismiss');
      if (navigator.vibrate) navigator.vibrate(10);
    } else if (offset.y < -120) {
      // Swipe up → "Snooze"
      onAction(item.id, 'snooze');
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }

  const goNext = useCallback(() => {
    if (index < items.length - 1) onSelect(items[index + 1].id);
  }, [index, items, onSelect]);

  const goPrev = useCallback(() => {
    if (index > 0) onSelect(items[index - 1].id);
  }, [index, items, onSelect]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(event)) return;
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        goNext();
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goNext, goPrev]);

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center text-[var(--text-tertiary)]">
        <Loader2 className="animate-spin" size={18} />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-2 text-center">
        <Inbox size={24} className="text-[var(--text-tertiary)]" />
        <div className="text-sm font-medium text-[var(--text-primary)]">No triage items match these filters.</div>
        <div className="text-xs text-[var(--text-tertiary)]">Clear filters or capture a new URL above.</div>
      </div>
    );
  }

  const source = SOURCE_META[item.sourcePlatform] || SOURCE_META.web;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          disabled={index <= 0}
          className="flex items-center gap-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-30"
        >
          ← Prev
        </button>
        <span className="text-xs text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
          {index + 1} of {items.length}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={index >= items.length - 1}
          className="flex items-center gap-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-30"
        >
          Next →
        </button>
      </div>

      {/* Swipe hint on mobile */}
      {isMobile && (
        <div className="flex items-center justify-center gap-4 text-[10px] text-[var(--text-tertiary)]">
          <span>← Dismiss</span>
          <span>↑ Snooze</span>
          <span>Done →</span>
        </div>
      )}

      {/* Card with optional swipe gesture */}
      {isMobile ? (
        <motion.div
          key={item.id}
          drag
          dragSnapToOrigin
          onDragEnd={handleCardSwipeEnd}
          style={{ x: swipeX, rotate: swipeRotate, opacity: swipeOpacity }}
          className="touch-none cursor-grab active:cursor-grabbing"
        >
          <RichPreviewEmbed item={item} embedsEnabled={embedsEnabled} variant="full" maxThumbnailHeight={420} autoExpand />
        </motion.div>
      ) : (
        <RichPreviewEmbed item={item} embedsEnabled={embedsEnabled} variant="full" maxThumbnailHeight={420} autoExpand />
      )}

      <div className="rounded-[16px] border border-[var(--border)] bg-[var(--surface-0)] p-4">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em]', source.badge)}>
            <TriageSourceIcon source={item.sourcePlatform} size={12} decorative />
            {source.label}
          </span>
          <span className="text-xs font-bold text-[var(--accent-300)] [font-variant-numeric:tabular-nums]">{item.aiRelevanceScore}</span>
          {item.aiUrgency === 'time_sensitive' && (
            <span className="rounded-[4px] border border-red-500/30 bg-red-500/20 px-1.5 py-0.5 text-[12px] font-semibold text-red-300">Time sensitive</span>
          )}
        </div>
        <h3 className="mt-2 text-base font-semibold text-[var(--text-primary)] [text-wrap:balance]">{item.title}</h3>
        <p className="mt-1 text-sm text-[var(--text-secondary)] [text-wrap:pretty]">{item.aiSummary || item.description}</p>
        {item.aiCategories.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.aiCategories.slice(0, 5).map((category) => (
              <span key={category} className="rounded-full border border-[var(--border)] bg-[var(--surface-0)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                {category}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Primary action buttons — large touch targets for mobile */}
      <div className="grid grid-cols-3 gap-2">
        {PRIMARY_ACTIONS.map(({ type, label, icon: Icon, classes }) => {
          const isBusy = busyAction === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => onAction(item.id, type)}
              disabled={!!busyAction}
              className={cn(
                'flex flex-col items-center justify-center gap-1.5 rounded-[14px] border py-4 text-sm font-semibold transition-all disabled:opacity-40',
                classes,
              )}
            >
              {isBusy ? <Loader2 size={20} className="animate-spin" /> : <Icon size={20} />}
              {label}
            </button>
          );
        })}
      </div>

      {/* More actions toggle */}
      <button
        type="button"
        onClick={() => setShowMore(!showMore)}
        className="flex items-center justify-center gap-1.5 text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <ChevronDown size={12} className={cn('transition-transform', showMore && 'rotate-180')} />
        {showMore ? 'Less actions' : 'More actions'}
      </button>

      {/* Secondary actions — collapsible on mobile */}
      {showMore && (
        <div className="flex flex-wrap items-center gap-2">
          {SECONDARY_ACTION_TYPES.map((type) => {
            const meta = ACTION_META[type];
            if (!meta) return null;
            const ActionIcon = meta.icon;
            const isBusy = busyAction === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => onAction(item.id, type)}
                disabled={!!busyAction}
                className="flex items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-900)] hover:text-[var(--accent-400)] active:bg-[var(--surface-2)] disabled:opacity-40"
              >
                {isBusy ? <Loader2 size={12} className="animate-spin" /> : <ActionIcon size={12} />}
                {meta.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3 text-[12px] text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold">←</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold">→</kbd>
          Navigate
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold">G</kbd>
          Switch view
        </span>
      </div>
    </div>
  );
}
