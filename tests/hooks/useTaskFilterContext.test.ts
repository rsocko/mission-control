import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskFilterContext } from '@/lib/hooks/useTaskFilterContext';
import {
  TASK_FILTER_CONTEXT_PARAM,
  normalizeTaskFilterContext,
  serializeTaskFilterContext,
} from '@/lib/task-filter-context';

const navigation = vi.hoisted(() => ({
  pathname: '/graph/universe',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
  }),
}));

describe('useTaskFilterContext', () => {
  beforeEach(() => {
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
  });

  it('hydrates from the current URL and replaces filter updates by default', () => {
    const context = normalizeTaskFilterContext({ tagSlugs: ['api'] });
    navigation.search = new URLSearchParams({
      dimensions: 'tags',
      [TASK_FILTER_CONTEXT_PARAM]: serializeTaskFilterContext(context),
    }).toString();
    const { result } = renderHook(() => useTaskFilterContext());

    expect(result.current.context).toEqual(context);
    expect(result.current.activeFilterCount).toBe(1);

    act(() => result.current.update({ priorities: ['high'] }));

    const href = navigation.replace.mock.calls[0][0] as string;
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe('/graph/universe');
    expect(url.searchParams.get('dimensions')).toBe('tags');
    expect(url.searchParams.has(TASK_FILTER_CONTEXT_PARAM)).toBe(true);
    expect(navigation.replace).toHaveBeenCalledWith(href, { scroll: false });
  });

  it('supports history entries and clearing without removing presentation state', () => {
    navigation.search = 'dimensions=tags&source=github-issues';
    const { result } = renderHook(() => useTaskFilterContext());

    act(() => result.current.update({ statuses: ['todo'] }, 'push'));
    expect(navigation.push).toHaveBeenCalledOnce();

    act(() => result.current.clear());
    expect(navigation.replace).toHaveBeenCalledWith(
      '/graph/universe?dimensions=tags',
      { scroll: false },
    );
  });

  it('preserves contextual origin metadata through filter updates and clearing', () => {
    navigation.search = new URLSearchParams({
      dimensions: 'tags',
      from: '/today',
      fromLabel: 'My Day',
    }).toString();
    const { result } = renderHook(() => useTaskFilterContext());

    act(() => result.current.update({ tagSlugs: ['planning'] }));
    act(() => result.current.clear());

    for (const [href] of navigation.replace.mock.calls) {
      const url = new URL(href as string, 'http://localhost');
      expect(url.searchParams.get('from')).toBe('/today');
      expect(url.searchParams.get('fromLabel')).toBe('My Day');
      expect(url.searchParams.get('dimensions')).toBe('tags');
    }
  });

  it('rebases rapid updates on the latest optimistic context', () => {
    const { result } = renderHook(() => useTaskFilterContext());

    act(() => {
      result.current.update({ query: 'assignee:alice' });
      result.current.update({ priorities: ['high'] });
    });

    const href = navigation.replace.mock.calls.at(-1)?.[0] as string;
    const serialized = new URL(href, 'http://localhost').searchParams.get(TASK_FILTER_CONTEXT_PARAM);
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized ?? '{}')).toMatchObject({
      query: 'assignee:alice',
      priorities: ['high'],
    });
  });
});
