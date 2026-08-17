import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import {
  currentAppHistoryDetail,
  installAppHistory,
} from '@/lib/navigation/app-history';

let uninstall: (() => void) | null = null;

describe('useHistoryParamSelection', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/today?keep=1');
    uninstall = installAppHistory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstall?.();
    uninstall = null;
    window.history.replaceState({}, '', '/');
  });

  it('pushes when opening and replaces when switching detail items', () => {
    const { result } = renderHook(() => useHistoryParamSelection('taskId'));

    act(() => result.current[1]('task-1'));
    expect(window.location.search).toBe('?keep=1&taskId=task-1');
    expect(currentAppHistoryDetail()).toMatchObject({
      param: 'taskId',
      parentHref: '/today?keep=1',
    });

    act(() => result.current[1]('task-2'));
    expect(window.location.search).toBe('?keep=1&taskId=task-2');
    expect(window.history.state.__missionControlHistory.position).toBe(1);
  });

  it('uses Back to close a detail opened in the app', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const { result } = renderHook(() => useHistoryParamSelection('taskId'));

    act(() => result.current[1]('task-1'));
    act(() => result.current[1](null));

    expect(back).toHaveBeenCalledOnce();
  });

  it('removes only its parameter for a direct-linked detail', async () => {
    uninstall?.();
    window.history.replaceState({}, '', '/today?keep=1&taskId=task-1');
    uninstall = installAppHistory();
    const { result } = renderHook(() => useHistoryParamSelection('taskId'));

    expect(result.current[0]).toBe('task-1');
    act(() => result.current[1](null));

    await waitFor(() => expect(result.current[0]).toBeNull());
    expect(window.location.search).toBe('?keep=1');
  });

  it('restores trigger focus without scrolling when Back closes detail', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const focus = vi.spyOn(trigger, 'focus');
    const { result } = renderHook(() => useHistoryParamSelection('taskId'));

    act(() => result.current[1]('task-1'));
    act(() => window.history.back());

    await waitFor(() => expect(result.current[0]).toBeNull());
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
    trigger.remove();
  });
});
