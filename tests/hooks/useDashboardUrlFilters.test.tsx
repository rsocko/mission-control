// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDashboardUrlFilters } from '@/lib/hooks/useDashboardUrlFilters';
import { TASK_FILTER_CONTEXT_PARAM } from '@/lib/task-filter-context';

describe('useDashboardUrlFilters', () => {
  it('applies list filters when search params change after the dashboard mounts', () => {
    const actions = {
      setSourceFilter: vi.fn(),
      setListFilter: vi.fn(),
      setTagFilter: vi.fn(),
    };
    const { rerender } = renderHook(
      ({ searchParams }) => useDashboardUrlFilters(searchParams, actions),
      { initialProps: { searchParams: new URLSearchParams() } },
    );

    expect(actions.setSourceFilter).not.toHaveBeenCalled();

    rerender({
      searchParams: new URLSearchParams(
        'source=microsoft-todo&listId=todo-work%3Acurrent-trip',
      ),
    });

    expect(actions.setSourceFilter).toHaveBeenLastCalledWith('microsoft-todo');
    expect(actions.setListFilter).toHaveBeenLastCalledWith('todo-work:current-trip');
    expect(actions.setTagFilter).toHaveBeenLastCalledWith([]);
  });

  it('leaves restored task-filter context in control', () => {
    const actions = {
      setSourceFilter: vi.fn(),
      setListFilter: vi.fn(),
      setTagFilter: vi.fn(),
    };

    renderHook(() => useDashboardUrlFilters(
      new URLSearchParams(`${TASK_FILTER_CONTEXT_PARAM}=restored&source=local`),
      actions,
    ));

    expect(actions.setSourceFilter).not.toHaveBeenCalled();
    expect(actions.setListFilter).not.toHaveBeenCalled();
    expect(actions.setTagFilter).not.toHaveBeenCalled();
  });
});
