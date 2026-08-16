import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredPanelWidth, useResizablePanel } from '@/lib/hooks/useResizablePanel';

const STORAGE_KEY = 'test:panel-width';

function moveTo(clientX: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
  });
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('readStoredPanelWidth', () => {
  it('clamps a stored width into the allowed range', () => {
    localStorage.setItem(STORAGE_KEY, '900');
    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 280, maxWidth: 600, defaultWidth: 430 })).toBe(600);

    localStorage.setItem(STORAGE_KEY, '120');
    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 280, maxWidth: 600, defaultWidth: 430 })).toBe(280);
  });

  it('falls back to the default when nothing valid is stored', () => {
    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 280, maxWidth: 600, defaultWidth: 430 })).toBe(430);

    localStorage.setItem(STORAGE_KEY, 'not-a-number');
    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 280, maxWidth: 600, defaultWidth: 430 })).toBe(430);
  });

  it('honors a host minimum larger than the default', () => {
    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 520, maxWidth: 600, defaultWidth: 430 })).toBe(520);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });

    expect(readStoredPanelWidth({ storageKey: STORAGE_KEY, minWidth: 280, maxWidth: 600, defaultWidth: 430 })).toBe(430);
  });
});

describe('useResizablePanel', () => {
  it('widens the panel as the handle is dragged left and persists the final width', () => {
    const { result } = renderHook(() => useResizablePanel({ storageKey: STORAGE_KEY, minWidth: 280 }));
    expect(result.current.width).toBe(430);

    act(() => {
      result.current.handleResizeStart({ clientX: 500, preventDefault: () => {} });
    });
    moveTo(400);
    expect(result.current.width).toBe(530);

    act(() => { document.dispatchEvent(new MouseEvent('mouseup')); });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('530');
  });

  it('clamps the drag to the configured bounds', () => {
    const { result } = renderHook(() => useResizablePanel({ storageKey: STORAGE_KEY, minWidth: 300, maxWidth: 500 }));

    act(() => {
      result.current.handleResizeStart({ clientX: 500, preventDefault: () => {} });
    });
    moveTo(0);
    expect(result.current.width).toBe(500);

    moveTo(900);
    expect(result.current.width).toBe(300);

    act(() => { document.dispatchEvent(new MouseEvent('mouseup')); });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('300');
  });

  it('starts from the rendered width when a host constrains the panel', () => {
    const element = document.createElement('div');
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      bottom: 0, height: 0, left: 0, right: 350, top: 0, width: 350, x: 0, y: 0, toJSON: () => ({}),
    });
    const elementRef = { current: element };
    const { result } = renderHook(() => useResizablePanel({ storageKey: STORAGE_KEY, minWidth: 280, elementRef }));

    act(() => {
      result.current.handleResizeStart({ clientX: 500, preventDefault: () => {} });
    });
    moveTo(450);

    expect(result.current.width).toBe(400);
  });

  it('prevents the default handle interaction so text is not selected', () => {
    const preventDefault = vi.fn();
    const { result } = renderHook(() => useResizablePanel({ storageKey: STORAGE_KEY, minWidth: 280 }));

    act(() => {
      result.current.handleResizeStart({ clientX: 500, preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')); });
  });

  it('removes drag listeners when the panel unmounts mid-drag', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { result, unmount } = renderHook(() => useResizablePanel({ storageKey: STORAGE_KEY, minWidth: 280 }));

    act(() => {
      result.current.handleResizeStart({ clientX: 500, preventDefault: () => {} });
    });
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));

    const widthAfterUnmount = result.current.width;
    act(() => {
      document.dispatchEvent(Object.assign(new MouseEvent('mousemove'), { clientX: 100 }));
    });
    expect(result.current.width).toBe(widthAfterUnmount);
  });
});
