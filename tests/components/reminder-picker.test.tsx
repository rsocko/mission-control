import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReminderPicker } from '@/components/ui/ReminderPicker';

describe('ReminderPicker', () => {
  it('defaults date-only tasks to 9:00 AM and allows relative selection', () => {
    const onChange = vi.fn(() => true);
    render(
      <ReminderPicker
        value={null}
        dueDate="2099-08-21"
        dueTime={null}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set reminder' }));

    const relativeOption = screen.getByRole('button', { name: /1 hour before/i });
    expect(relativeOption).toBeEnabled();
    expect(screen.getByLabelText('Task due time for relative reminder')).toHaveValue('09:00');

    fireEvent.click(relativeOption);

    expect(onChange).toHaveBeenCalledWith({
      reminderRelative: '1_hour_before',
      reminderDueTime: '09:00',
    });
  });

  it('keeps relative reminders disabled when their computed time is in the past', () => {
    render(
      <ReminderPicker
        value={null}
        dueDate="2020-08-21"
        dueTime="09:00"
        onChange={() => true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set reminder' }));

    expect(screen.getByRole('button', { name: /1 hour before/i })).toBeDisabled();
  });
});
