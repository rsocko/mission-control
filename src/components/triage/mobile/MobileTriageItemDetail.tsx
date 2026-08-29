'use client';

import { useMemo, useState } from 'react';
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
import { MobileSheet } from '@/components/ui/MobileSheet';

interface MobileTriageItemDetailProps {
  item: TriageItem | null;
  onClose: () => void;
  onAction: (itemId: string, actionType: TriageActionType) => void;
  busyAction: string | null;
}

type MetadataEntry = {
  key: string;
  label: string;
  value: string;
};

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
        <h3 className="text-sm font-semibold text-white">All actions</h3>
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
  item: activeItem,
  onClose,
  onAction,
  busyAction,
}: MobileTriageItemDetailProps) {
  const metadataEntries = useMemo(
    () => (activeItem ? buildMetadataEntries(activeItem) : []),
    [activeItem],
  );
  const takenActions = useMemo(
    () => new Set(activeItem?.actionsTaken.map((action) => action.actionType) ?? []),
    [activeItem],
  );

  if (!activeItem) {
    return (
      <MobileSheet
        isOpen={false}
        onClose={onClose}
        ariaLabel="Triage item details"
        height="full"
      >
        {null}
      </MobileSheet>
    );
  }

  const item = activeItem;
  const source = SOURCE_META[item.sourcePlatform] || SOURCE_META.web;
  const sourceBrand = SOURCE_BRAND[item.sourcePlatform] || SOURCE_BRAND.web;
  const urgency = URGENCY_META[item.aiUrgency];
  const contentPreview = item.aiSummary || item.description || 'No AI summary is available for this item yet.';
  const score = Math.max(0, Math.min(100, item.aiRelevanceScore));
  const safeSourceUrl = /^https?:\/\//i.test(item.sourceUrl) ? item.sourceUrl : '#';

  return (
    <MobileSheet
      isOpen={activeItem !== null}
      onClose={onClose}
      ariaLabel="Triage item details"
      height="full"
      className="rounded-t-[28px] border-white/10 bg-slate-950/95 shadow-[0_-24px_80px_rgba(2,6,23,0.78)] backdrop-blur-2xl"
      contentClassName="flex flex-col overflow-hidden"
    >
      <div className="flex shrink-0 items-center justify-between px-4 pb-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        <div className="rounded-[24px] bg-white/[0.04] p-4 ring-1 ring-white/8 backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold leading-7 text-white">
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
            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200 [text-wrap:pretty]">
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
    </MobileSheet>
  );
}
