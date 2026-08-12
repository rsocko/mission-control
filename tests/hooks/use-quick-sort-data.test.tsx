import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuickSortData, type QuickSortQueueTask } from '@/lib/hooks/useQuickSortData';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const task: QuickSortQueueTask = {
  id: 'task-1',
  title: 'Needs a tag',
  hasNotes: false,
  priority: 'medium',
  effort: 2,
  status: 'todo',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: null,
  sourceListName: null,
  dueDate: null,
  createdAt: '2026-07-31T12:00:00.000Z',
  projects: [],
  phases: [],
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('useQuickSortData background revalidation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the current queue mounted when background revalidation fails', async () => {
    let queueRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('counts=true')) {
        return new Response(JSON.stringify({
          counts: { no_priority: 0, no_effort: 0, no_tags: 1, no_due_date: 0 },
        }));
      }
      if (url.includes('/suggestions?')) {
        return new Response(JSON.stringify({ suggestions: {} }));
      }

      queueRequests++;
      if (queueRequests === 1) {
        return new Response(JSON.stringify({ tasks: [task] }));
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useQuickSortData('no_tags'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.tasks).toEqual([task]);
    });

    await act(async () => {
      await expect(result.current.refreshQueue()).rejects.toThrow('offline');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.tasks).toEqual([task]);
  });

  it('preserves dismissals made while a full reload is in flight', async () => {
    let queueRequests = 0;
    let resolveReload: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('counts=true')) {
        return new Response(JSON.stringify({
          counts: { no_priority: 0, no_effort: 0, no_tags: 1, no_due_date: 0 },
        }));
      }
      if (url.includes('/suggestions?')) {
        return new Response(JSON.stringify({ suggestions: {} }));
      }

      queueRequests++;
      if (queueRequests === 1) {
        return new Response(JSON.stringify({ tasks: [task] }));
      }
      return new Promise<Response>((resolve) => {
        resolveReload = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useQuickSortData('no_tags'));
    await waitFor(() => expect(result.current.tasks).toEqual([task]));

    let reloadPromise: Promise<void> | undefined;
    act(() => {
      reloadPromise = result.current.reloadQueue();
    });
    act(() => {
      result.current.dismiss(task.id);
    });

    await act(async () => {
      if (!resolveReload || !reloadPromise) throw new Error('Expected pending queue reload');
      resolveReload(new Response(JSON.stringify({ tasks: [task] })));
      await reloadPromise;
    });

    expect(result.current.tasks).toEqual([]);
  });
});
