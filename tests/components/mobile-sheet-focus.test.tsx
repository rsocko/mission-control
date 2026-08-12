import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobileSheet } from '@/components/ui/MobileSheet';

function SheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open details</button>
      <MobileSheet isOpen={open} onClose={() => setOpen(false)} ariaLabel="Task details">
        <button>First action</button>
        <button>Last action</button>
        <button onClick={() => setOpen(false)}>Close details</button>
      </MobileSheet>
    </>
  );
}

describe('MobileSheet focus management', () => {
  it('contains focus and restores it to the opener', async () => {
    render(<SheetHarness />);
    const opener = screen.getByRole('button', { name: 'Open details' });

    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Close details' });
    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.click(last);
    expect(opener).toHaveFocus();
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
});
