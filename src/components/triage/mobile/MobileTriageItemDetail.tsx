'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion, useDragControls, type PanInfo, useReducedMotion } from 'motion/react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { TriageActionType, TriageItem } from '@/types';
import { ACTION_META, SOURCE_META } from '@/components/triage/types';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';

interface MobileTriageItemDetailProps {
  item: TriageItem | null;
  onClose: () => void;
  onAction: (itemId: string, actionType: TriageActionType) => void;
  busyAction: string | null;
}

type SnapPoint = 0.4 | 0.6 | 0.9;

type MetadataEntry = {
  key: string;
  label: string;
  value: string;
};

const SNAP_POINTS: SnapPoint[] = [0.4, 0.6, 0.9];

const SOURCE_BRAND: Record<string, { bg: string; ring: string; text: string }> = {
  reddit: { bg: 'bg-orange-500/15', ring: 'ring-orange-400/30', text: 'text-orange-200' },
  github: { bg: 'bg-violet-500/15', ring: 'ring-violet-400/30', text: 'text-violet-300' },
  youtube: { bg: 'bg-red-500/15', ring: 'ring-red-400/30', text: 'text-red-300' },
  twitter: { bg: 'bg-sky-500/15', ring: 'ring-sky-400/30', text: 'text-sky-300' },
  instagram: { bg: 'bg-pink-500/15', ring: 'ring-pink-400/30', text: 'text-pink-300' },
  facebook: { bg: 'bg-blue-500/15', ring: 'ring-blue-400/30', text: 'text-blue-300' },
  tiktok: { bg: 'bg-cyan-500/15', ring: 'ring-cyan-400/30', text: 'text-cyan-300' },
  pinterest: { bg: 'bg-rose-500/15', ring: 'ring-rose-400/30', text: 'text-rose-300' },
  web: { bg: 'bg-slate-500/15', ring: 'ring-slate-400/30', text: 'text-slate-300' },
};

const METADATA_LABELS: Record<string, string> = {
  subreddit: 'Subreddit',
  subredditNamePrefixed: 'Subreddit',
  org: 'Organization',
  owner: 'Owner',
  repository: 'Repository',
  repo: 'Repository',
  author: 'Author',
  username: 'Author',
  userName: 'Author',
  channel: 'Channel',
  provider: 'Provider',
  publisher: 'Publisher',
  upvotes: 'Upvotes',
  score: 'Score',
  commentCount: 'Comments',
  comments: 'Comments',
  stars: 'Stars',
  stargazersCount: 'Stars',
  forks: 'Forks',
  language: 'Language',
  duration: 'Duration',
  viewCount: 'Views',
  likeCount: 'Likes',
  domain: 'Domain',
};

const PRIORITY_METADATA_KEYS = [
  'subredditNamePrefixed',
  'subreddit',
  'org',
  'owner',
  'repository',
  'repo',
  'author',
  'username',
  'userName',
  'channel',
  'upvotes',
  'score',
  'commentCount',
  'comments',
  'stars',
  'stargazersCount',
  'forks',
  'language',
  'duration',
  'viewCount',
  'likeCount',
  'provider',
  'publisher',
  'domain',
] as const;

const OMIT_METADATA_KEYS = new Set([
  'embed',
  'html',
  'raw',
  'rawHtml',
  'oembed',
  'images',
  'thumbnails',
  'preview',
  'previews',
  'media',
]);

const URGENCY_META: Record<TriageItem['aiUrgency'], { label: string; className: string }> = {
  time_sensitive: {
    label: 'Time sensitive',
    className: 'border-rose-400/30 bg-rose-500/10 text-rose-200',
  },
  trending: {
    label: 'Trending',
    className: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
  },
  evergreen: {
    label: 'Evergreen',
    className: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
  },
};

const ALL_ACTIONS = Object.entries(ACTION_META).map(([type, meta]) => ({
  type: type as TriageActionType,
  ...meta,
}));

function formatDateTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMetadataValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const rendered = value
      .map((entry) => formatMetadataValue(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 4);
    return rendered.length ? rendered.join(', ') : null;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : null;
  }
  return null;
}

function buildMetadataEntries(item: TriageItem): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  const seen = new Set<string>();

  const pushEntry = (key: string, value: unknown, label = METADATA_LABELS[key] || humanizeKey(key)) => {
    if (seen.has(key) || OMIT_METADATA_KEYS.has(key)) return;
    const rendered = formatMetadataValue(value);
    if (!rendered) return;
    seen.add(key);
    entries.push({ key, label, value: rendered });
  };

  pushEntry('sourceId', item.sourceId, 'Source ID');
  pushEntry('contentType', item.contentType, 'Content type');
  pushEntry('status', item.status, 'Status');
  pushEntry('canonicalUrl', item.canonicalUrl, 'Canonical URL');

  for (const key of PRIORITY_METADATA_KEYS) {
    pushEntry(key, item.rawMetadata[key]);
  }

  const remaining = Object.keys(item.rawMetadata)
    .filter((key) => !seen.has(key) && !OMIT_METADATA_KEYS.has(key))
    .sort((left, right) => left.localeCompare(right));

  for (const key of remaining) {
    pushEntry(key, item.rawMetadata[key]);
  }

  return entries.slice(0, 18);
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function ActionsSection({
  item,
  onAction,
  busyAction,
  takenActions,
  safeSourceUrl,
}: {
  item: TriageItem;
  onAction: (itemId: string, actionType: TriageActionType) => void;
  busyAction: string | null;
  takenActions: Set<TriageActionType>;
  safeSourceUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mt-4 rounded-[24px] bg-white/[0.035] p-4 ring-1 ring-white/8 backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between"
      >
        <div>
          <h3 className="text-sm font-semibold text-white">All actions</h3>
          <p className="mt-0.5 text-xs text-slate-400">Route this item anywhere in one tap.</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={safeSourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.08]"
            aria-label="Open source link in new tab"
          >
            <ExternalLink size={14} />
            Link
          </a>
          <ChevronDown
            size={16}
            className={cn('text-slate-400 transition-transform', expanded && 'rotate-180')}
          />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {ALL_ACTIONS.map((action) => {
            const Icon = action.icon;
            const isBusy = busyAction === action.type;
            const isDone = takenActions.has(action.type);

            return (
              <button
                key={action.type}
                type="button"
                onClick={() => onAction(item.id, action.type)}
                disabled={!!busyAction || isDone}
                aria-label={action.label}
                className={cn(
                  'flex min-h-[72px] flex-col items-center justify-center gap-2 rounded-[20px] px-3 py-3 text-center ring-1 transition-all active:scale-[0.98] disabled:cursor-not-allowed',
                  isDone
                    ? 'bg-emerald-500/12 text-emerald-200 ring-emerald-400/20'
                    : 'bg-white/[0.04] text-slate-200 ring-white/8 hover:bg-white/[0.06]',
                  !!busyAction && !isBusy && 'opacity-50',
                )}
              >
                <div
                  className={cn(
                    'rounded-full p-2',
                    isDone ? 'bg-emerald-500/10' : 'bg-white/[0.05]',
                  )}
                >
                  {isBusy ? <Loader2 size={16} className="animate-spin" /> : isDone ? <Check size={16} /> : <Icon size={16} />}
                </div>
                <span className="text-xs font-medium leading-4">{action.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function MobileTriageItemDetail({
  item,
  onClose,
  onAction,
  busyAction,
}: MobileTriageItemDetailProps) {
  const [currentSnap, setCurrentSnap] = useState<SnapPoint>(0.6);
  const [windowHeight, setWindowHeight] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const prefersReducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    if (!item) return;
    const updateWindowHeight = () => setWindowHeight(window.innerHeight);
    updateWindowHeight();
    window.addEventListener('resize', updateWindowHeight);
    return () => window.removeEventListener('resize', updateWindowHeight);
  }, [item]);

  useEffect(() => {
    if (!item) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const node = sheetRef.current;
      if (!node) return;
      const focusable = getFocusableElements(node);
      (focusable[0] || node).focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const node = sheetRef.current;
      if (!node) return;
      const focusable = getFocusableElements(node);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [item?.id, onClose]);

  const metadataEntries = useMemo(() => (item ? buildMetadataEntries(item) : []), [item]);
  const takenActions = useMemo(() => new Set(item?.actionsTaken.map((action) => action.actionType) ?? []), [item]);

  if (!item) {
    return null;
  }

  const source = SOURCE_META[item.sourcePlatform] || SOURCE_META.web;
  const sourceBrand = SOURCE_BRAND[item.sourcePlatform] || SOURCE_BRAND.web;
  const urgency = URGENCY_META[item.aiUrgency];
  const contentPreview = item.aiSummary || item.description || 'No AI summary is available for this item yet.';
  const safeWindowHeight = windowHeight || 800;
  const sheetHeight = Math.round(safeWindowHeight * currentSnap);
  const score = Math.max(0, Math.min(100, item.aiRelevanceScore));
  const safeSourceUrl = /^https?:\/\//i.test(item.sourceUrl) ? item.sourceUrl : '#';

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const offset = info.offset.y;
    const velocity = info.velocity.y;

    if (velocity > 850 || offset > sheetHeight * 0.28) {
      onClose();
      return;
    }

    const target = currentSnap - offset / safeWindowHeight;
    let nearest = SNAP_POINTS[0];
    let distance = Number.POSITIVE_INFINITY;

    for (const snap of SNAP_POINTS) {
      const nextDistance = Math.abs(snap - target);
      if (nextDistance < distance) {
        distance = nextDistance;
        nearest = snap;
      }
    }

    setCurrentSnap(nearest);
  };

  const handleSheetKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 sm:hidden">
      <motion.div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        initial={prefersReducedMotion ? undefined : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={prefersReducedMotion ? undefined : { opacity: 0 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
        onClick={onClose}
        aria-hidden="true"
      />

      <motion.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleSheetKeyDown}
        className="absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-slate-950/95 shadow-[0_-24px_80px_rgba(2,6,23,0.78)] backdrop-blur-2xl"
        initial={prefersReducedMotion ? { y: 0, height: sheetHeight } : { y: '100%' }}
        animate={{ y: 0, height: sheetHeight }}
        exit={prefersReducedMotion ? undefined : { y: '100%' }}
        transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 42, stiffness: 280 }}
        drag="y"
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.08}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-shrink-0 flex-col items-center px-4 pb-2 pt-3">
          <div
            className="flex w-full cursor-grab touch-none justify-center active:cursor-grabbing"
            onPointerDown={(event) => dragControls.start(event)}
          >
            <div className="h-1.5 w-11 rounded-full bg-white/20" aria-hidden="true" />
          </div>
          <div className="mt-3 flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1',
                  sourceBrand.bg,
                  sourceBrand.ring,
                  sourceBrand.text,
                )}
              >
                <TriageSourceIcon source={item.sourcePlatform} size={13} decorative />
                {source.label}
              </span>
              <span className={cn('rounded-full border px-2 py-1 text-xs font-medium', urgency.className)}>
                {urgency.label}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/[0.05] text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-white/[0.08] hover:text-white"
              aria-label="Close triage item details"
            >
              <X size={16} />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            {SNAP_POINTS.map((snap) => (
              <button
                key={snap}
                type="button"
                onClick={() => setCurrentSnap(snap)}
                aria-label={`Resize sheet to ${Math.round(snap * 100)} percent height`}
                aria-pressed={currentSnap === snap}
                className="flex min-h-11 min-w-11 items-center justify-center"
              >
                <span
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-200',
                    currentSnap === snap ? 'w-5 bg-sky-400' : 'w-1.5 bg-white/25',
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="rounded-[24px] bg-white/[0.04] p-4 ring-1 ring-white/8 backdrop-blur-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-[1.375rem] font-semibold leading-7 text-white">
                  {item.title}
                </h2>
              </div>
              <div className="w-20 flex-shrink-0">
                <div className="text-right text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Score
                </div>
                <div className="mt-1 text-right text-xl font-bold tabular-nums text-sky-300">{score}</div>
              </div>
            </div>

            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-400 to-emerald-400"
                style={{ width: `${score}%` }}
                aria-hidden="true"
              />
            </div>

            {item.thumbnailUrl ? (
              <div className="mt-4 overflow-hidden rounded-[20px] ring-1 ring-white/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="max-h-64 w-full bg-slate-900 object-cover"
                />
              </div>
            ) : null}

            <div className="mt-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                <Sparkles size={12} className="text-sky-300" />
                Full preview
              </div>
              <p
                id={descriptionId}
                className="whitespace-pre-wrap text-sm leading-6 text-slate-200 [text-wrap:pretty]"
              >
                {contentPreview}
              </p>
            </div>

            {item.aiCategories.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {item.aiCategories.map((category) => (
                  <span
                    key={category}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-300"
                  >
                    {category}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <section className="mt-4 rounded-[24px] bg-white/[0.035] p-4 ring-1 ring-white/8 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">Source metadata</h3>
              <a
                href={safeSourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-xs font-medium text-sky-200 ring-1 ring-sky-400/20 transition-colors hover:bg-sky-500/10 hover:text-white"
                aria-label="Open original source in a new tab"
              >
                Open source
                <ArrowUpRight size={14} />
              </a>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {metadataEntries.length > 0 ? (
                metadataEntries.map((entry) => (
                  <div key={entry.key} className="rounded-[18px] bg-slate-900/80 p-3 ring-1 ring-white/6">
                    <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">{entry.label}</div>
                    <div className="mt-1 break-words text-sm text-slate-200">{entry.value}</div>
                  </div>
                ))
              ) : (
                <div className="col-span-2 rounded-[18px] bg-slate-900/80 p-3 text-sm text-slate-400 ring-1 ring-white/6">
                  No source metadata is available for this item.
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-[18px] bg-slate-900/80 p-3 ring-1 ring-white/6">
                <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Captured</div>
                <div className="mt-1 text-sm text-slate-200">{formatDateTime(item.capturedAt)}</div>
              </div>
              <div className="rounded-[18px] bg-slate-900/80 p-3 ring-1 ring-white/6">
                <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">Ingested</div>
                <div className="mt-1 text-sm text-slate-200">{formatDateTime(item.ingestedAt)}</div>
              </div>
            </div>
          </section>

          <section className="mt-4 rounded-[24px] bg-white/[0.035] p-4 ring-1 ring-white/8 backdrop-blur-xl">
            <h3 className="text-sm font-semibold text-white">AI suggested actions</h3>
            <div className="mt-3 space-y-2">
              {item.aiSuggestedActions.length > 0 ? (
                item.aiSuggestedActions.map((suggestion) => {
                  const meta = ACTION_META[suggestion.actionType];
                  const Icon = meta.icon;
                  const isBusy = busyAction === suggestion.actionType;
                  const isDone = takenActions.has(suggestion.actionType);

                  return (
                    <button
                      key={`${item.id}-${suggestion.actionType}`}
                      type="button"
                      onClick={() => onAction(item.id, suggestion.actionType)}
                      disabled={!!busyAction || isDone}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 rounded-[18px] px-3 py-3 text-left ring-1 transition-colors',
                        isDone
                          ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/20'
                          : 'bg-slate-900/80 text-slate-200 ring-white/6 hover:bg-slate-900',
                      )}
                      aria-label={`Apply suggested action ${suggestion.label || meta.label}`}
                    >
                      <div className="flex gap-3">
                        <div
                          className={cn(
                            'mt-0.5 rounded-2xl p-2 ring-1',
                            isDone
                              ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/20'
                              : 'bg-white/[0.05] text-sky-300 ring-white/10',
                          )}
                        >
                          {isBusy ? <Loader2 size={15} className="animate-spin" /> : isDone ? <Check size={15} /> : <Icon size={15} />}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-white">{suggestion.label || meta.label}</div>
                          <div className="mt-1 text-xs leading-5 text-slate-400">
                            {isDone ? 'Already applied' : suggestion.reason}
                          </div>
                        </div>
                      </div>
                      <span className="rounded-full border border-white/10 px-2 py-1 text-xs tabular-nums text-slate-300">
                        {formatConfidence(suggestion.confidence)}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-[18px] bg-slate-900/80 p-3 text-sm text-slate-400 ring-1 ring-white/6">
                  No AI suggestions are available yet.
                </div>
              )}
            </div>
          </section>

          {/* All actions — inline in scrollable content, collapsed by default */}
          <ActionsSection
            item={item}
            onAction={onAction}
            busyAction={busyAction}
            takenActions={takenActions}
            safeSourceUrl={safeSourceUrl}
          />
        </div>
      </motion.div>
    </div>
  );
}
