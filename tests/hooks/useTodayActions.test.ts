import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pushUndoWithToast: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/stores/undoStore', () => ({
  pushUndoWithToast: mocks.pushUndoWithToast,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useTodayActions } from '@/lib/hooks/useTodayActions';
import type { MyDayItem } from '@/components/today/types';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const disabledMirrorPolicy = makeTaskEditPolicy({
  sourceModel: 'remote-mirror',
  connectorEnabled: false,
});

function mirrorTodayItem(): MyDayItem {
  return {
    id: 'today-mirror',
    taskId: 'mirror-1',
    order: 1,
    isAutoIncluded: false,
    addedAt: '2026-07-31T12:00:00.000Z',
    title: 'Mirrored task',
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    connectorType: 'custom-rest',
    connectorInstanceId: 'disabled-mirror',
    sourceListName: 'External',
    createdAt: '2026-07-31T12:00:00.000Z',
    tags: [],
    hasDescription: false,
    localDisposition: 'active',
    taskSourceModel: 'remote-mirror',
    editPolicy: disabledMirrorPolicy,
  };
}

describe('useTodayActions completion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reports failure without emitting success effects for a rejected completion', async () => {
    const fetchData = vi.fn(async () => {});
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
    const { result } = renderHook(() => useTodayActions({
      items: [{
        id: 'today-item',
        taskId: 'task-1',
        order: 1,
        isAutoIncluded: false,
        addedAt: '2026-07-31T12:00:00.000Z',
        title: 'Today task',
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListName: 'Inbox',
        createdAt: '2026-07-31T12:00:00.000Z',
        tags: [],
        hasDescription: false,
        localDisposition: 'active',
        taskSourceModel: 'mc-owned',
        editPolicy: editableTaskPolicy,
      }],
      setItems: vi.fn(),
      scheduled: [],
      calendarEvents: [],
      sourceLists: [],
      energyLevel: null,
      setEnergyLevel: vi.fn(),
      todayISO: '2026-07-31',
      fetchData,
    }));

    let succeeded = true;
    await act(async () => {
      const completion = result.current.completeTask('task-1');
      await vi.advanceTimersByTimeAsync(600);
      succeeded = await completion;
    });

    expect(succeeded).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to complete task');
    expect(mocks.pushUndoWithToast).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('deduplicates completion requests while a task is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const fetchData = vi.fn(async () => {});
    const { result } = renderHook(() => useTodayActions({
      items: [{
        id: 'today-item',
        taskId: 'task-1',
        order: 1,
        isAutoIncluded: false,
        addedAt: '2026-07-31T12:00:00.000Z',
        title: 'Today task',
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListName: 'Inbox',
        createdAt: '2026-07-31T12:00:00.000Z',
        tags: [],
        hasDescription: false,
        localDisposition: 'active',
        taskSourceModel: 'mc-owned',
        editPolicy: editableTaskPolicy,
      }],
      setItems: vi.fn(),
      scheduled: [],
      calendarEvents: [],
      sourceLists: [],
      energyLevel: null,
      setEnergyLevel: vi.fn(),
      todayISO: '2026-07-31',
      fetchData,
    }));

    let firstSucceeded = false;
    let duplicateSucceeded = true;
    await act(async () => {
      const firstCompletion = result.current.completeTask('task-1');
      duplicateSucceeded = await result.current.completeTask('task-1');
      await vi.advanceTimersByTimeAsync(600);
      firstSucceeded = await firstCompletion;
    });

    expect(firstSucceeded).toBe(true);
    expect(duplicateSucceeded).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.pushUndoWithToast).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(fetchData).toHaveBeenCalledTimes(1);
  });

  it('completes suggestions outside My Day and restores their prior status on undo', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const fetchData = vi.fn(async () => {});
    const { result } = renderHook(() => useTodayActions({
      items: [],
      setItems: vi.fn(),
      scheduled: [],
      calendarEvents: [],
      sourceLists: [],
      energyLevel: null,
      setEnergyLevel: vi.fn(),
      todayISO: '2026-07-31',
      fetchData,
    }));

    await act(async () => {
      const completion = result.current.completeTask('suggestion-1', {
        title: 'Suggested task',
        status: 'in_progress',
        editPolicy: editableTaskPolicy,
      });
      await vi.advanceTimersByTimeAsync(600);
      expect(await completion).toBe(true);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/tasks/suggestion-1', expect.objectContaining({
      body: JSON.stringify({ status: 'done' }),
    }));

    const undo = mocks.pushUndoWithToast.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
    expect(undo).toBeDefined();
    await act(async () => {
      await undo?.();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks/suggestion-1', expect.objectContaining({
      body: JSON.stringify({ status: 'in_progress' }),
    }));
  });

  it('hides a disabled-connector mirror after its local disposition is persisted', async () => {
    vi.useRealTimers();
    const fetchData = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        fields: { localDisposition: { mode: 'local', persisted: true } },
      }),
    })));
    const { result } = renderHook(() => {
      const [items, setItems] = useState([mirrorTodayItem()]);
      const actions = useTodayActions({
        items,
        setItems,
        scheduled: [],
        calendarEvents: [],
        sourceLists: [],
        energyLevel: null,
        setEnergyLevel: vi.fn(),
        todayISO: '2026-07-31',
        fetchData,
      });
      return { items, actions };
    });

    await act(async () => {
      expect(await result.current.actions.setTaskLocalDisposition('mirror-1', 'handled')).toBe(true);
    });

    expect(result.current.items).toEqual([]);
    expect(global.fetch).toHaveBeenCalledWith('/api/tasks/mirror-1', expect.objectContaining({
      body: JSON.stringify({ localDisposition: 'handled' }),
    }));
    expect(fetchData).toHaveBeenCalledWith({ skipSync: true });
  });

  it('restores Today state when local disposition persistence is rejected', async () => {
    vi.useRealTimers();
    const fetchData = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Disposition was rejected' }),
    })));
    const { result } = renderHook(() => {
      const [items, setItems] = useState([mirrorTodayItem()]);
      const actions = useTodayActions({
        items,
        setItems,
        scheduled: [],
        calendarEvents: [],
        sourceLists: [],
        energyLevel: null,
        setEnergyLevel: vi.fn(),
        todayISO: '2026-07-31',
        fetchData,
      });
      return { items, actions };
    });

    await act(async () => {
      expect(await result.current.actions.setTaskLocalDisposition('mirror-1', 'dismissed')).toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Disposition was rejected');
    expect(fetchData).not.toHaveBeenCalled();
  });
});
