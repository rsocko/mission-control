import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '@/components/ui/Modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

describe('Modal accessibility', () => {
  it('uses an explicit accessible label when the heading is rendered by its children', () => {
    render(
      <Modal isOpen onClose={vi.fn()} ariaLabel="Priority setup" showClose={false}>
        <h2>Priority setup</h2>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'Priority setup' })).toBeDefined();
  });

  it('does not close when a nested select consumes Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Nested control">
        <Select>
          <SelectTrigger aria-label="Choose project">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mission-control">Mission Control</SelectItem>
          </SelectContent>
        </Select>
      </Modal>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Choose project' }));
    expect(await screen.findByRole('option', { name: 'Mission Control' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Mission Control' })).not.toBeInTheDocument();
  });

  it('names the dialog, traps focus, and restores focus when closed', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open preview</button>
        <Modal isOpen={false} onClose={onClose} title="Attachment preview">
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </Modal>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Open preview' });
    trigger.focus();

    rerender(
      <>
        <button type="button">Open preview</button>
        <Modal isOpen onClose={onClose} title="Attachment preview">
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </Modal>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(dialog).toHaveFocus();

    const last = screen.getByRole('button', { name: 'Last action' });
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    rerender(
      <>
        <button type="button">Open preview</button>
        <Modal isOpen={false} onClose={onClose} title="Attachment preview">
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </Modal>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Open preview' })).toHaveFocus();
  });
});
