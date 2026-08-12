import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BulkDispositionButtons } from '@/components/bulk-actions/BulkDispositionButtons';
import { makeTaskEditPolicy } from '../fixtures/task-edit-policy';

describe('BulkDispositionButtons', () => {
  it('keeps local mirror actions available when every selected connector is disabled', () => {
    const onSetDisposition = vi.fn(async () => {});
    render(
      <BulkDispositionButtons
        tasks={[
          {
            localDisposition: 'active',
            editPolicy: makeTaskEditPolicy({
              sourceModel: 'remote-mirror',
              connectorEnabled: false,
            }),
          },
        ]}
        onSetDisposition={onSetDisposition}
      />,
    );

    const handled = screen.getByRole('button', {
      name: /Handled here.*without completing them upstream.*Mission Control only/i,
    });
    expect(handled).toBeEnabled();
    fireEvent.click(handled);
    expect(onSetDisposition).toHaveBeenCalledWith('handled');
  });

  it('disables a mixed selection with the field-specific reason', () => {
    render(
      <BulkDispositionButtons
        tasks={[
          {
            localDisposition: 'active',
            editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }),
          },
          {
            localDisposition: 'active',
            editPolicy: makeTaskEditPolicy({
              sourceModel: 'remote-managed',
              reasons: {
                localDisposition: 'Local disposition is only available for read-only remote mirrors',
              },
            }),
          },
        ]}
        onSetDisposition={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole('button', {
      name: /Dismiss here.*Local disposition is only available for read-only remote mirrors/i,
    })).toBeDisabled();
  });
});
