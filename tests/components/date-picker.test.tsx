import * as Dialog from '@radix-ui/react-dialog';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatePicker } from '@/components/ui/date-picker';

describe('DatePicker', () => {
  function renderNestedDatePicker(onChange: (date: string) => void) {
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content aria-label="Task details">
            <Dialog.Title>Task details</Dialog.Title>
            <DatePicker value="2026-09-22" onChange={onChange} aria-label="Due date" />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Due date' }));
  }

  it('clears the due date when nested in a modal dialog', () => {
    const onChange = vi.fn();

    renderNestedDatePicker(onChange);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('selects a new due date when nested in a modal dialog', () => {
    const onChange = vi.fn();

    renderNestedDatePicker(onChange);
    const nextDay = screen.getByRole('button', { name: /September 23rd, 2026/i });
    fireEvent.pointerDown(nextDay);
    fireEvent.click(nextDay);

    expect(onChange).toHaveBeenCalledWith('2026-09-23');
  });
});
