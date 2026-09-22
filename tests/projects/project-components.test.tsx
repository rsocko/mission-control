import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhaseAddTaskMenu } from '@/app/projects/[id]/components';

describe('PhaseAddTaskMenu', () => {
  function MenuHarness({
    onCreateNew = vi.fn(),
    onLinkExisting = vi.fn(),
  }: {
    onCreateNew?: () => void;
    onLinkExisting?: () => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <PhaseAddTaskMenu
        open={open}
        onOpenChange={setOpen}
        trigger={<button type="button">Add task</button>}
        onCreateNew={onCreateNew}
        onLinkExisting={onLinkExisting}
      />
    );
  }

  it('offers both new and existing task flows', async () => {
    const onCreateNew = vi.fn();
    const onLinkExisting = vi.fn();

    render(<MenuHarness onCreateNew={onCreateNew} onLinkExisting={onLinkExisting} />);

    const trigger = screen.getByRole('button', { name: 'Add task' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = screen.getByRole('menu', { name: 'Add task' });
    expect(menu).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Create new task' }));
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link existing task' }));

    expect(onCreateNew).toHaveBeenCalledOnce();
    expect(onLinkExisting).toHaveBeenCalledOnce();
  });

  it('supports keyboard navigation and returns focus after closing on Escape', async () => {
    render(<MenuHarness />);

    const trigger = screen.getByRole('button', { name: 'Add task' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const createItem = screen.getByRole('menuitem', { name: 'Create new task' });
    const linkItem = screen.getByRole('menuitem', { name: 'Link existing task' });
    expect(createItem).toHaveFocus();

    fireEvent.keyDown(createItem, { key: 'ArrowDown' });
    await waitFor(() => expect(linkItem).toHaveFocus());

    fireEvent.keyDown(linkItem, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add task' })).toHaveFocus();
    });
  });
});
