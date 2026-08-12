/**
 * undoStore — Unit Tests
 * Tests for #1044: global undo system with 5-second window
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sonner before importing the store
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { useUndoStore, pushUndoWithToast, executeUndo } from '@/lib/stores/undoStore';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useUndoStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUndoStore', () => {
  it('pushUndo adds an entry to the queue', () => {
    useUndoStore.getState().pushUndo({ label: 'Test', undo: vi.fn() });
    expect(useUndoStore.getState().queue).toHaveLength(1);
    expect(useUndoStore.getState().queue[0].label).toBe('Test');
  });

  it('popUndo returns the most recent entry within the window', () => {
    const undo1 = vi.fn();
    const undo2 = vi.fn();
    useUndoStore.getState().pushUndo({ label: 'First', undo: undo1 });
    useUndoStore.getState().pushUndo({ label: 'Second', undo: undo2 });

    const entry = useUndoStore.getState().popUndo();
    expect(entry?.label).toBe('Second');
    expect(useUndoStore.getState().queue).toHaveLength(1);
  });

  it('popUndo returns null when entries have expired', () => {
    useUndoStore.getState().pushUndo({ label: 'Old', undo: vi.fn() });
    vi.advanceTimersByTime(5001);
    const entry = useUndoStore.getState().popUndo();
    expect(entry).toBeNull();
  });

  it('auto-expires entries after 5 seconds', () => {
    useUndoStore.getState().pushUndo({ label: 'Expires', undo: vi.fn() });
    expect(useUndoStore.getState().queue).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    expect(useUndoStore.getState().queue).toHaveLength(0);
  });

  it('removeEntry removes a specific entry by id', () => {
    const id = useUndoStore.getState().pushUndo({ label: 'Remove me', undo: vi.fn() });
    useUndoStore.getState().pushUndo({ label: 'Keep me', undo: vi.fn() });
    useUndoStore.getState().removeEntry(id);
    expect(useUndoStore.getState().queue).toHaveLength(1);
    expect(useUndoStore.getState().queue[0].label).toBe('Keep me');
  });

  it('caps the queue at MAX_QUEUE_SIZE', () => {
    for (let i = 0; i < 25; i++) {
      useUndoStore.getState().pushUndo({ label: `Entry ${i}`, undo: vi.fn() });
    }
    expect(useUndoStore.getState().queue.length).toBeLessThanOrEqual(20);
  });

  it('takeEntry atomically removes and returns the entry', () => {
    const id = useUndoStore.getState().pushUndo({ label: 'Take me', undo: vi.fn() });
    const taken = useUndoStore.getState().takeEntry(id);
    expect(taken?.label).toBe('Take me');
    expect(useUndoStore.getState().queue).toHaveLength(0);
    // Second take returns null (prevents double-undo)
    const second = useUndoStore.getState().takeEntry(id);
    expect(second).toBeNull();
  });
});

describe('pushUndoWithToast', () => {
  it('adds entry to store and calls toast.success', async () => {
    const { toast } = await import('sonner');
    const undoFn = vi.fn();
    pushUndoWithToast('Task completed', undoFn);

    expect(useUndoStore.getState().queue).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Task completed', expect.objectContaining({
      action: expect.objectContaining({ label: 'Undo' }),
      duration: 5000,
    }));
  });

  it('preserves an entry when undo validation rejects a toast click', async () => {
    const { toast } = await import('sonner');
    const undoFn = vi.fn();
    pushUndoWithToast('Move task', undoFn, {
      validationError: () => 'Undo newer project hierarchy changes first',
    });
    const toastOptions = vi.mocked(toast.success).mock.calls[0][1] as {
      action: { onClick: () => void };
    };

    toastOptions.action.onClick();

    expect(undoFn).not.toHaveBeenCalled();
    expect(useUndoStore.getState().queue).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith('Undo newer project hierarchy changes first');
  });
});

describe('executeUndo', () => {
  it('executes the most recent undo function', () => {
    const undoFn = vi.fn();
    useUndoStore.getState().pushUndo({ label: 'Action', undo: undoFn });
    const result = executeUndo();
    expect(result).toBe(true);
    expect(undoFn).toHaveBeenCalledOnce();
  });

  it('returns false when nothing to undo', () => {
    const result = executeUndo();
    expect(result).toBe(false);
  });

  it('skips expired entries', () => {
    const undoFn = vi.fn();
    useUndoStore.getState().pushUndo({ label: 'Expired', undo: undoFn });
    vi.advanceTimersByTime(5001);
    const result = executeUndo();
    expect(result).toBe(false);
    expect(undoFn).not.toHaveBeenCalled();
  });
});
