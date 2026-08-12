'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  clearTaskFilterContextFromSearchParams,
  countTaskFilters,
  hydrateTaskFilterContext,
  setTaskFilterContextInSearchParams,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { parseGraphOrigin } from '@/lib/graph/graph-navigation';

export function useTaskFilterContext() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydration = useMemo(
    () => hydrateTaskFilterContext(searchParams),
    [searchParams],
  );
  const currentContextRef = useRef(hydration.context);
  useEffect(() => {
    currentContextRef.current = hydration.context;
  }, [hydration.context]);

  const commit = useCallback((
    context: TaskFilterContext,
    mode: 'push' | 'replace' = 'replace',
  ) => {
    currentContextRef.current = context;
    const next = setTaskFilterContextInSearchParams(searchParams, context);
    const href = next.size ? `${pathname}?${next.toString()}` : pathname;
    router[mode](href, { scroll: false });
  }, [pathname, router, searchParams]);

  const update = useCallback((
    patch: Partial<Omit<TaskFilterContext, 'version'>>,
    mode: 'push' | 'replace' = 'replace',
  ) => {
    commit(updateTaskFilterContext(currentContextRef.current, patch), mode);
  }, [commit]);

  const clear = useCallback((mode: 'push' | 'replace' = 'replace') => {
    currentContextRef.current = EMPTY_TASK_FILTER_CONTEXT;
    const next = clearTaskFilterContextFromSearchParams(searchParams);
    const href = next.size ? `${pathname}?${next.toString()}` : pathname;
    router[mode](href, { scroll: false });
  }, [pathname, router, searchParams]);

  return {
    ...hydration,
    origin: parseGraphOrigin(searchParams),
    activeFilterCount: countTaskFilters(hydration.context),
    setContext: commit,
    update,
    clear,
  };
}
