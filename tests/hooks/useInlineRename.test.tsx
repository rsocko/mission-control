import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInlineRename } from '@/lib/hooks/useInlineRename';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useInlineRename', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deterministically delays blur saves and closes after the save completes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useInlineRename({ name: 'Inbox', onSave }));

    act(() => {
      result.current.startEditing();
      result.current.setName('Renamed');
      result.current.scheduleBlur();
      vi.advanceTimersByTime(199);
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('Renamed', undefined, undefined);
    expect(result.current.editing).toBe(false);
  });

  it('does not commit a blur while the icon picker is open', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useInlineRename({ name: 'Inbox', onSave }));

    act(() => {
      result.current.startEditing();
      result.current.setName('Renamed');
      result.current.setPickerOpen(true);
      result.current.scheduleBlur();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));

    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(true);
  });

  it('autosaves the latest draft on unmount and cancels a scheduled blur', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useInlineRename({
      name: 'Inbox',
      icon: '📥',
      onSave,
    }));

    act(() => {
      result.current.startEditing();
      result.current.setName('Later');
      result.current.scheduleBlur();
    });
    unmount();
    act(() => vi.runAllTimers());

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('Later', '📥', undefined);
  });

  it('does not restore a stale draft when another row updates the source name', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ name }) => useInlineRename({ name, onSave }),
      { initialProps: { name: 'rsocko/tyrion' } },
    );

    rerender({ name: 'Tyrion' });
    unmount();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not restore a stale draft after an unchanged edit closes', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender, unmount } = renderHook(
      ({ name }) => useInlineRename({ name, onSave }),
      { initialProps: { name: 'rsocko/tyrion' } },
    );

    act(() => {
      result.current.startEditing();
      result.current.scheduleBlur();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));

    expect(result.current.editing).toBe(false);
    rerender({ name: 'Tyrion' });
    unmount();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('cancel resets the draft and prevents blur and unmount saves', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useInlineRename({
      name: 'Inbox',
      icon: '📥',
      iconColor: '#123456',
      onSave,
    }));

    act(() => {
      result.current.startEditing();
      result.current.setName('Discard me');
      result.current.setIcon('🗑️');
      result.current.scheduleBlur();
      result.current.cancel();
      vi.runAllTimers();
    });
    unmount();

    expect(result.current.name).toBe('Inbox');
    expect(result.current.icon).toBe('📥');
    expect(result.current.iconColor).toBe('#123456');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('serializes overlapping saves so the newest snapshot is persisted last', async () => {
    const first = deferred();
    const persistenceOrder: string[] = [];
    let persistedName = 'Inbox';
    const onSave = vi.fn(async (name: string) => {
      persistenceOrder.push(`start:${name}`);
      if (name === 'First') await first.promise;
      persistedName = name;
      persistenceOrder.push(`finish:${name}`);
    });
    const { result } = renderHook(() => useInlineRename({ name: 'Inbox', onSave }));

    act(() => {
      result.current.startEditing();
      result.current.setName('First');
      void result.current.save();
    });
    act(() => {
      result.current.setName('Second');
      void result.current.save();
      result.current.setName('Newest');
      void result.current.save();
    });

    expect(onSave).toHaveBeenCalledOnce();
    expect(persistenceOrder).toEqual(['start:First']);

    await act(async () => {
      first.resolve();
      await first.promise;
    });

    expect(onSave).toHaveBeenNthCalledWith(1, 'First', undefined, undefined);
    expect(onSave).toHaveBeenNthCalledWith(2, 'Newest', undefined, undefined);
    expect(persistenceOrder).toEqual([
      'start:First',
      'finish:First',
      'start:Newest',
      'finish:Newest',
    ]);
    expect(onSave).not.toHaveBeenCalledWith('Second', undefined, undefined);
    expect(persistedName).toBe('Newest');
    expect(result.current.editing).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it('keeps the editor open when the latest overlapping save fails', async () => {
    const first = deferred();
    const second = deferred();
    const onError = vi.fn();
    const onSave = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useInlineRename({ name: 'Inbox', onSave, onError }));

    act(() => {
      result.current.startEditing();
      result.current.setName('First');
      void result.current.save();
      result.current.setName('Second');
      void result.current.save();
    });

    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => first.resolve());
    expect(onSave).toHaveBeenCalledTimes(2);
    await act(async () => second.reject(new Error('failed')));

    expect(result.current.editing).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });
});
