'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@/lib/search/fts';
import { fuseHybridResults } from '@/lib/search/hybrid-ranking';

type SearchScope = 'tasks' | 'notifications' | 'all';

interface SearchResponse {
  note?: string | null;
  semanticAvailable?: boolean;
  semanticEnabled?: boolean;
  durationMs?: number;
  results: SearchResult[];
}

interface UseProgressiveSearchOptions {
  query: string;
  enabled: boolean;
  type?: SearchScope;
  limit?: number;
  source?: string | null;
  status?: string | null;
  excludeDone?: boolean;
}

export function mergeProgressiveSearchResults(
  keywordResults: SearchResult[],
  semanticResults: SearchResult[],
  query = '',
  limit = Math.max(keywordResults.length, semanticResults.length, 20),
): SearchResult[] {
  return fuseHybridResults(query, keywordResults, semanticResults, {
    limit,
    perKindLimit: Math.max(1, Math.ceil(limit * 0.75)),
  });
}

async function readSearchResponse(response: Response): Promise<SearchResponse> {
  if (!response.ok) {
    throw new Error(await response.text() || `Search failed (${response.status})`);
  }
  return response.json() as Promise<SearchResponse>;
}

export function useProgressiveSearch({
  query,
  enabled,
  type = 'all',
  limit = 20,
  source = null,
  status = null,
  excludeDone = false,
}: UseProgressiveSearchOptions) {
  const normalizedQuery = query.trim();
  const requestRevisionRef = useRef(0);
  const [keywordResults, setKeywordResults] = useState<SearchResult[]>([]);
  const [semanticResults, setSemanticResults] = useState<SearchResult[]>([]);
  const [keywordLoading, setKeywordLoading] = useState(false);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [keywordDurationMs, setKeywordDurationMs] = useState<number | null>(null);
  const [semanticDurationMs, setSemanticDurationMs] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [semanticEnabled, setSemanticEnabled] = useState(false);
  const [semanticAvailable, setSemanticAvailable] = useState(false);
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [keywordRevision, setKeywordRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setCapabilityReady(false);
    fetch('/api/ai/search?q=__status_check__&mode=hybrid&limit=1', {
      signal: controller.signal,
    })
      .then(readSearchResponse)
      .then((payload) => {
        setSemanticEnabled(payload.semanticEnabled ?? false);
        setSemanticAvailable(payload.semanticAvailable ?? false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSemanticEnabled(false);
          setSemanticAvailable(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCapabilityReady(true);
      });
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !normalizedQuery) {
      requestRevisionRef.current += 1;
      setKeywordResults([]);
      setSemanticResults([]);
      setKeywordLoading(false);
      setSemanticLoading(false);
      setKeywordDurationMs(null);
      setSemanticDurationMs(null);
      setNote(null);
      return;
    }

    const revision = ++requestRevisionRef.current;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: normalizedQuery,
      mode: 'keyword',
      type,
      limit: String(limit),
    });
    if (source) params.set('source', source);
    if (status) params.set('status', status);
    if (excludeDone) params.set('excludeDone', 'true');

    setKeywordLoading(true);
    setSemanticLoading(false);
    setSemanticResults([]);
    setSemanticDurationMs(null);
    setNote(null);

    fetch(`/api/ai/search?${params.toString()}`, { signal: controller.signal })
      .then(readSearchResponse)
      .then((payload) => {
        if (requestRevisionRef.current !== revision) return;
        setKeywordResults(payload.results);
        setKeywordDurationMs(payload.durationMs ?? null);
        setNote(payload.note ?? null);
        setKeywordRevision(revision);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestRevisionRef.current !== revision) return;
        setKeywordResults([]);
        setKeywordDurationMs(null);
        setNote(error instanceof Error ? error.message : 'Search failed.');
      })
      .finally(() => {
        if (!controller.signal.aborted && requestRevisionRef.current === revision) {
          setKeywordLoading(false);
        }
      });

    return () => controller.abort();
  }, [enabled, excludeDone, limit, normalizedQuery, source, status, type]);

  useEffect(() => {
    if (
      !enabled
      || !normalizedQuery
      || !capabilityReady
      || !semanticEnabled
      || !semanticAvailable
      || keywordRevision !== requestRevisionRef.current
    ) {
      return;
    }

    const revision = requestRevisionRef.current;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: normalizedQuery,
      mode: 'semantic',
      type,
      limit: String(limit),
    });
    if (source) params.set('source', source);
    if (status) params.set('status', status);
    if (excludeDone) params.set('excludeDone', 'true');

    setSemanticLoading(true);
    fetch(`/api/ai/search?${params.toString()}`, { signal: controller.signal })
      .then(readSearchResponse)
      .then((payload) => {
        if (requestRevisionRef.current !== revision) return;
        setSemanticResults(payload.results);
        setSemanticDurationMs(payload.durationMs ?? null);
        setNote(payload.note ?? null);
      })
      .catch(() => {
        // Keyword results remain authoritative when optional enrichment fails.
      })
      .finally(() => {
        if (!controller.signal.aborted && requestRevisionRef.current === revision) {
          setSemanticLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    capabilityReady,
    enabled,
    excludeDone,
    keywordRevision,
    limit,
    normalizedQuery,
    semanticAvailable,
    semanticEnabled,
    source,
    status,
    type,
  ]);

  const results = useMemo(
    () => mergeProgressiveSearchResults(
      keywordResults,
      semanticResults,
      normalizedQuery,
      limit,
    ),
    [keywordResults, limit, normalizedQuery, semanticResults],
  );

  return {
    results,
    note,
    keywordLoading,
    semanticLoading,
    keywordDurationMs,
    semanticDurationMs,
    semanticEnabled,
    semanticAvailable,
  };
}
