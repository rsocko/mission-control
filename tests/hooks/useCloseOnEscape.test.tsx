import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCloseOnEscape } from '@/lib/hooks/useCloseOnEscape';

describe('useCloseOnEscape', () => {
  it('closes on Escape when enabled', () => {
    const onClose = vi.fn();
    renderHook(() => useCloseOnEscape(onClose));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores handled Escape events and disabled surfaces', () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useCloseOnEscape(onClose, enabled),
      { initialProps: { enabled: true } },
    );
    const handledEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handledEvent.preventDefault();
    document.dispatchEvent(handledEvent);
    rerender({ enabled: false });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
