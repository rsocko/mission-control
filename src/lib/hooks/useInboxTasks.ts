'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getInboxTaskStatus,
  toInboxTaskItem,
  type InboxTaskDto,
} from '@/lib/inbox/items';
import type { TriageItem, TriageStatus } from '@/types';

const PAGE_SIZE = 200;

interface UseInboxTasksParams {
  query: string;
  status: TriageStatus | 'all';
}

export function useInboxTasks({ query, status }: UseInboxTasksParams) {
  const [items, setItems] = useState<TriageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadItems = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (status === 'actioned' || status === 'dismissed') {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const tasks: InboxTaskDto[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const params = new URLSearchParams({
          quickFilter: 'inbox',
          openOnly: 'true',
          parentOnly: 'true',
          includeTags: 'true',
          limit: String(PAGE_SIZE),
          offset: String(offset),
          sortBy: 'createdAt',
          sortDirection: 'desc',
        });
        if (query.trim()) params.set('search', query.trim());

        const response = await fetch(`/api/tasks?${params.toString()}`);
        if (!response.ok) throw new Error(`Inbox task fetch failed: ${response.status}`);
        const data = await response.json() as { tasks?: InboxTaskDto[]; hasMore?: boolean };
        const page = data.tasks ?? [];
        tasks.push(...page);
        hasMore = data.hasMore === true;
        if (hasMore && page.length === 0) {
          throw new Error('Inbox task pagination returned an empty page');
        }
        offset += page.length;
      }

      const nextItems = tasks
        .filter((task) => status === 'all' || getInboxTaskStatus(task) === status)
        .map(toInboxTaskItem);
      if (requestId === requestIdRef.current) setItems(nextItems);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : 'Inbox tasks could not be loaded');
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [query, status]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  return { items, loading, error, loadItems };
}
