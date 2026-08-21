import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobileSheet, shouldDismissMobileSheet } from '@/components/ui/MobileSheet';

function SheetHarness() {
  const [open, setOpen] = useState(false);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={fallbackRef}>Fallback target</button>
      <button onClick={() => setOpen(true)}>Open details</button>
      <MobileSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        ariaLabel="Task details"
        returnFocusRef={fallbackRef}
      >
        <button>First action</button>
        <button>Last action</button>
        <button onClick={() => setOpen(false)}>Close details</button>
      </MobileSheet>
    </>
  );
}

function RemovedOpenerHarness() {
  const [open, setOpen] = useState(false);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={fallbackRef}>Fallback target</button>
      {!open && <button onClick={() => setOpen(true)}>Open temporary details</button>}
      <MobileSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        ariaLabel="Temporary details"
        returnFocusRef={fallbackRef}
      >
        <button onClick={() => setOpen(false)}>Close temporary details</button>
      </MobileSheet>
    </>
  );
}

describe('MobileSheet focus management', () => {
  it('focuses the first action and restores focus to the opener', async () => {
    render(<SheetHarness />);
    const opener = screen.getByRole('button', { name: 'Open details' });

    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole('button', { name: 'First action' });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('uses the fallback focus target when the opener was removed', async () => {
    render(<RemovedOpenerHarness />);
    const fallback = screen.getByRole('button', { name: 'Fallback target' });

    fireEvent.click(screen.getByRole('button', { name: 'Open temporary details' }));
    const close = screen.getByRole('button', { name: 'Close temporary details' });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.click(close);
    await waitFor(() => expect(fallback).toHaveFocus());
  });

  it('preserves child focus across parent rerenders', () => {
    const { rerender } = render(
      <MobileSheet isOpen onClose={() => {}} ariaLabel="Task details">
        <input aria-label="Task title" />
      </MobileSheet>,
    );
    const input = screen.getByRole('textbox', { name: 'Task title' });
    input.focus();

    rerender(
      <MobileSheet isOpen onClose={() => {}} ariaLabel="Task details">
        <input aria-label="Task title" />
      </MobileSheet>,
    );

    expect(input).toHaveFocus();
  });

  it('uses deliberate distance and velocity thresholds for drag dismissal', () => {
    expect(shouldDismissMobileSheet(119, 699)).toBe(false);
    expect(shouldDismissMobileSheet(120, 0)).toBe(true);
    expect(shouldDismissMobileSheet(0, 700)).toBe(true);
    expect(shouldDismissMobileSheet(-200, -1200)).toBe(false);
  });

  it('exposes one drag handle without size controls', () => {
    render(
      <MobileSheet isOpen onClose={() => {}} ariaLabel="Task details">
        <div>Content</div>
      </MobileSheet>,
    );

    expect(screen.getByRole('separator', { name: 'Drag down to close sheet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resize sheet/i })).not.toBeInTheDocument();
  });
});
