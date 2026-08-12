'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Inbox, Search } from 'lucide-react';
import {
  triageSummaryDataSchema,
  type TriageSummaryData,
} from '@/lib/triage/summary-contract';

export function parseTriageSummaryData(value: unknown) {
  return triageSummaryDataSchema.safeParse(value);
}

export function TriageSummaryCard({ data }: { data: TriageSummaryData }) {
  const queueUrl = buildQueueUrl(data.mcBaseUrl);
  const [sortBy, setSortBy] = useState<'score' | 'newest' | 'source'>('score');
  const items = useMemo(() => [...data.items].sort((left, right) => {
    if (sortBy === 'newest') {
      return Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
    }
    if (sortBy === 'source') {
      return left.source.localeCompare(right.source) || right.score - left.score;
    }
    return right.score - left.score;
  }), [data.items, sortBy]);

  return (
    <section
      className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      aria-label="Triage summary"
    >
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <Search size={16} className="mt-0.5 text-violet-300" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">{data.title}</span>
          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
            {data.total} matching item{data.total === 1 ? '' : 's'}
            {data.hasMore ? `; showing ${data.items.length}` : ''}
          </span>
        </span>
        <a
          href={queueUrl}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs font-medium text-[var(--accent-300)] hover:bg-[var(--surface-2)]"
        >
          View queue
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </header>

      {data.items.length > 1 ? (
        <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Sort</span>
          {([
            ['score', 'Relevance'],
            ['newest', 'Newest'],
            ['source', 'Source'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={sortBy === value}
              onClick={() => setSortBy(value)}
              className={`rounded-full border px-2 py-1 text-[10px] font-medium ${
                sortBy === value
                  ? 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-[var(--text-muted)]">
          <Inbox size={22} aria-hidden="true" />
          <p>No triage items match this search.</p>
        </div>
      ) : (
        <div className="max-h-[32rem] divide-y divide-[var(--border-subtle)] overflow-y-auto">
          {items.map(item => (
            <article key={item.id} className="flex gap-3 p-3">
              {item.thumbnailUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- trusted thumbnail origins are dynamic */
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="h-16 w-20 flex-none rounded-md border border-[var(--border-subtle)] object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <span>{formatLabel(item.source)}</span>
                  <span aria-hidden="true">/</span>
                  <span>{formatLabel(item.status)}</span>
                  <span aria-hidden="true">/</span>
                  <span>{formatCapturedAt(item.capturedAt)}</span>
                  <span className="ml-auto rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-300">
                    Score {Math.round(item.score)}
                  </span>
                </div>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent-300)] hover:underline"
                    aria-label={`Open source: ${item.title}`}
                  >
                    {item.title}
                  </a>
                ) : (
                  <h4 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{item.title}</h4>
                )}
                {item.summary ? (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-secondary)]">{item.summary}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                    {formatLabel(item.contentType)}
                  </span>
                  {item.categories.slice(0, 3).map(category => (
                    <span
                      key={category}
                      className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"
                    >
                      {category}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function buildQueueUrl(mcBaseUrl?: string) {
  if (!mcBaseUrl) return '/triage';
  return new URL('triage', `${mcBaseUrl.replace(/\/$/, '')}/`).href;
}

function formatCapturedAt(value: string) {
  return new Date(value).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function formatLabel(value: string) {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}
