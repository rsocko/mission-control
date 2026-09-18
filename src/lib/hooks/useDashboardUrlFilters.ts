'use client';

import { useEffect } from 'react';
import { TASK_FILTER_CONTEXT_PARAM } from '@/lib/task-filter-context';

interface DashboardUrlFilterActions {
  setSourceFilter: (value: string | null) => void;
  setListFilter: (value: string | null) => void;
  setTagFilter: (value: string[]) => void;
}

type DashboardSearchParams = Pick<URLSearchParams, 'get' | 'has'>;

export function useDashboardUrlFilters(
  searchParams: DashboardSearchParams,
  actions: DashboardUrlFilterActions,
): void {
  const { setSourceFilter, setListFilter, setTagFilter } = actions;

  useEffect(() => {
    if (searchParams.has(TASK_FILTER_CONTEXT_PARAM)) return;

    const source = searchParams.get('source');
    const listId = searchParams.get('listId');
    const tag = searchParams.get('tag');
    if (!source && !listId && !tag) return;

    setSourceFilter(source);
    setListFilter(listId);
    setTagFilter(tag ? [tag] : []);
  }, [searchParams, setListFilter, setSourceFilter, setTagFilter]);
}
