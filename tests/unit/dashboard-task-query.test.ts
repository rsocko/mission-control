import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  buildTaskRequestRanges,
  DASHBOARD_TASK_ENTITY_LIMIT,
  DASHBOARD_TASK_PAGE_LIMIT,
  dashboardKeys,
  flattenTaskPages,
  getRetainedTaskRequestCount,
  normalizeTaskParams,
} from '@/lib/hooks/useDashboardQueries';
import {
  EMPTY_TASK_RESPONSE,
  type DashboardTaskResponseViewModel as TaskResponse,
  type DashboardTaskViewModel as Task,
} from '@/types/dashboard';

function task(id: string): Task {
  return { id, title: id } as Task;
}

function page(ids: string[], hasMore = true): TaskResponse {
  return {
    ...EMPTY_TASK_RESPONSE,
    tasks: ids.map(task),
    total: 1_000,
    hasMore,
  };
}

describe('dashboard task query retention', () => {
  it('normalizes equivalent parameter order and excludes offsets from cache keys', () => {
    const first = normalizeTaskParams('offset=50&status=todo&limit=50&source=github');
    const second = normalizeTaskParams('source=github&limit=50&offset=0&status=todo');

    expect(first).toBe(second);
    expect(dashboardKeys.tasks(first)).toEqual(dashboardKeys.tasks(second));
  });

  it('flattens loaded pages without retaining duplicate task entities', () => {
    const data: InfiniteData<TaskResponse, number> = {
      pages: [
        page(['task-1', 'task-2']),
        page(['task-2', 'task-3'], false),
      ],
      pageParams: [0, 2],
    };

    expect(flattenTaskPages(data).tasks.map(({ id }) => id)).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
  });

  it('stops advertising load-more once the documented page bound is reached', () => {
    const data: InfiniteData<TaskResponse, number> = {
      pages: Array.from(
        { length: DASHBOARD_TASK_PAGE_LIMIT },
        (_, index) => page([`task-${index}`]),
      ),
      pageParams: Array.from(
        { length: DASHBOARD_TASK_PAGE_LIMIT },
        (_, index) => index,
      ),
    };

    expect(flattenTaskPages(data).hasMore).toBe(false);
    expect(flattenTaskPages(data).tasks).toHaveLength(DASHBOARD_TASK_PAGE_LIMIT);
  });

  it('keeps the entity bound after optimistic updates collapse pages', () => {
    const data: InfiniteData<TaskResponse, number> = {
      pages: [
        page(Array.from(
          { length: DASHBOARD_TASK_ENTITY_LIMIT },
          (_, index) => `task-${index}`,
        )),
      ],
      pageParams: [0],
    };

    expect(flattenTaskPages(data).hasMore).toBe(false);
    expect(flattenTaskPages(data).tasks).toHaveLength(DASHBOARD_TASK_ENTITY_LIMIT);
  });

  it('retains the visible task count when a background refresh replaces one enriched page', () => {
    const data: InfiniteData<TaskResponse, number> = {
      pages: [page(Array.from({ length: 278 }, (_, index) => `task-${index}`))],
      pageParams: [0],
    };

    expect(getRetainedTaskRequestCount(data, 50)).toBe(278);
  });

  it('uses normal pagination when multiple server pages are already cached', () => {
    const data: InfiniteData<TaskResponse, number> = {
      pages: [
        page(Array.from({ length: 50 }, (_, index) => `task-${index}`)),
        page(Array.from({ length: 50 }, (_, index) => `task-${index + 50}`)),
      ],
      pageParams: [0, 50],
    };

    expect(getRetainedTaskRequestCount(data, 50)).toBe(50);
  });

  it('splits a retained refresh across the API page limit', () => {
    expect(buildTaskRequestRanges(0, 278)).toEqual([
      { offset: 0, limit: 200 },
      { offset: 200, limit: 78 },
    ]);
  });
});
