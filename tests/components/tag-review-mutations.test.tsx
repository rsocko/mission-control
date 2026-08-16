import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTagMutations } from '@/app/settings/components/tag-review/useTagMutations';
import type { ReviewTag } from '@/app/settings/components/tag-review/types';

const apiMocks = vi.hoisted(() => ({
  patch: vi.fn(),
}));

vi.mock('@/app/settings/components/tag-review/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/app/settings/components/tag-review/api')>();
  return {
    ...actual,
    tagReviewApi: {
      ...actual.tagReviewApi,
      patch: apiMocks.patch,
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const tag: ReviewTag = {
  id: 'tag-1',
  name: 'Bug',
  slug: 'bug',
  type: 'hub',
  source: null,
  sources: [],
  sourceNames: [],
  color: '#6b7280',
  confirmed: true,
  usageCount: 1,
  unifiedInto: null,
  listUsage: [],
  sourceUsage: [],
};

describe('useTagMutations', () => {
  beforeEach(() => {
    apiMocks.patch.mockReset();
  });

  it('blocks a simultaneous different mutation until the active request completes', async () => {
    const renameRequest = deferred<Record<string, unknown>>();
    const recolorRequest = deferred<Record<string, unknown>>();
    apiMocks.patch.mockImplementation(operation =>
      operation === 'rename' ? renameRequest.promise : recolorRequest.promise
    );

    const { result } = renderHook(() => useTagMutations({
      refreshTags: vi.fn(async () => undefined),
      setAllTags: vi.fn(),
      removeSelectedIds: vi.fn(),
    }));

    let renamePromise!: Promise<boolean>;
    act(() => {
      renamePromise = result.current.rename(tag, 'Defect');
    });
    expect(result.current.busyOperation).toBe('rename');
    expect(result.current.isBusy).toBe(true);

    let blockedResult!: boolean;
    await act(async () => {
      blockedResult = await result.current.recolor(
        { ...tag, id: 'tag-2' },
        '#ef4444',
      );
    });
    expect(blockedResult).toBe(false);
    expect(result.current.busyOperation).toBe('rename');
    expect(apiMocks.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      renameRequest.resolve({});
      await renamePromise;
    });
    expect(result.current.busyOperation).toBeNull();

    let recolorPromise!: Promise<boolean>;
    act(() => {
      recolorPromise = result.current.recolor({ ...tag, id: 'tag-2' }, '#ef4444');
    });
    expect(result.current.busyOperation).toBe('recolor');
    await act(async () => {
      recolorRequest.resolve({});
      await recolorPromise;
    });
    expect(result.current.busyOperation).toBeNull();
  });

  it('blocks conflicting actions on the same tag', async () => {
    const renameRequest = deferred<Record<string, unknown>>();
    apiMocks.patch.mockImplementation(() => renameRequest.promise);
    const { result } = renderHook(() => useTagMutations({
      refreshTags: vi.fn(async () => undefined),
      setAllTags: vi.fn(),
      removeSelectedIds: vi.fn(),
    }));

    let renamePromise!: Promise<boolean>;
    act(() => {
      renamePromise = result.current.rename(tag, 'Defect');
    });

    let recolorResult!: boolean;
    await act(async () => {
      recolorResult = await result.current.recolor(tag, '#ef4444');
    });

    expect(recolorResult).toBe(false);
    expect(result.current.busyOperation).toBe('rename');
    expect(result.current.busyTagId).toBe(tag.id);
    expect(apiMocks.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      renameRequest.resolve({});
      await renamePromise;
    });
    expect(result.current.isBusy).toBe(false);
  });
});
