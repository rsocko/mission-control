'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Brain, ChevronDown, Clock, Loader2, Trash2, XCircle } from 'lucide-react';

interface RetainedMemory {
  id: string;
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  retainUntil: string;
  updatedAt: string;
}

interface MemoryResponse {
  settings: { enabled: boolean; retentionDays: number };
  memories: RetainedMemory[];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

async function fetchMemories(signal?: AbortSignal): Promise<MemoryResponse> {
  const response = await fetch('/api/ai/memories', { signal });
  if (!response.ok) throw new Error('request failed');
  return response.json() as Promise<MemoryResponse>;
}

export function HoustonRecentConversations() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await fetchMemories());
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMemories(controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(true);
      });
    return () => controller.abort();
  }, []);

  const mutate = useCallback(async (id: string, method: 'PATCH' | 'DELETE') => {
    setPendingId(id);
    try {
      const response = await fetch(`/api/ai/memories/${encodeURIComponent(id)}`, {
        method,
        headers: method === 'PATCH' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'PATCH' ? JSON.stringify({ excluded: true }) : undefined,
      });
      if (!response.ok) throw new Error('request failed');
      setData((current) => current
        ? { ...current, memories: current.memories.filter((memory) => memory.id !== id) }
        : current);
    } catch {
      setError(true);
    } finally {
      setPendingId(null);
    }
  }, []);

  if (!data && !error) {
    return (
      <div className="flex min-h-16 items-center justify-center text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin" aria-label="Loading retained memories" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-secondary)]">
        <p>Retained memories could not be loaded.</p>
        <button type="button" onClick={() => void load()} className="mt-2 font-medium text-[var(--accent-400)] hover:underline">
          Try again
        </button>
      </div>
    );
  }

  if (!data?.settings.enabled) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
        <Brain size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
        <div>
          <p className="text-sm font-medium text-[var(--text-secondary)]">Retained memory is off</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
            Enable privacy-minimized Houston summaries in AI settings. Full transcripts are never indexed.
          </p>
        </div>
      </div>
    );
  }

  if (data.memories.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-2"
      aria-labelledby="houston-memory-heading"
    >
      <div className="flex items-end justify-between gap-3 px-1">
        <h3 id="houston-memory-heading" className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          Retained memories
        </h3>
        <span className="text-xs text-[var(--text-muted)]">Summaries, not transcripts</span>
      </div>
      <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
        {data.memories.map((memory) => {
          const expanded = expandedId === memory.id;
          const pending = pendingId === memory.id;
          return (
            <div key={memory.id}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : memory.id)}
                aria-expanded={expanded}
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-start transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-400)]"
              >
                <Brain size={15} className="shrink-0 text-[var(--accent-400)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{memory.title}</span>
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-[var(--text-muted)]">
                    <Clock size={10} aria-hidden="true" />
                    Updated {formatDate(memory.updatedAt)}
                  </span>
                </span>
                <ChevronDown size={15} className={`shrink-0 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-3 border-t border-[var(--border)] px-4 py-3">
                      <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">{memory.summary}</p>
                      {memory.topics.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {memory.topics.map((topic) => (
                            <span key={topic} className="rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-tertiary)]">
                              {topic}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-[var(--text-muted)]">Expires {formatDate(memory.retainUntil)}</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void mutate(memory.id, 'PATCH')}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                        >
                          <XCircle size={13} />
                          Exclude
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => void mutate(memory.id, 'DELETE')}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                        >
                          {pending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          Delete
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </motion.section>
  );
}
