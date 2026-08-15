import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhaseAddTaskMenu } from '@/app/projects/[id]/components';

describe('PhaseAddTaskMenu', () => {
  it('offers both new and existing task flows', () => {
    const onCreateNew = vi.fn();
    const onLinkExisting = vi.fn();

    render(
      <PhaseAddTaskMenu
        onCreateNew={onCreateNew}
        onLinkExisting={onLinkExisting}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole('menu', { name: 'Add task' });
    expect(menu).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Create new task' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link existing task' }));

    expect(onCreateNew).toHaveBeenCalledOnce();
    expect(onLinkExisting).toHaveBeenCalledOnce();
  });

  it('supports keyboard navigation and returns focus after closing on Escape', async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(true);
      return (
        <div data-phase-add-menu>
          <button type="button" aria-haspopup="menu">Add task</button>
          {open ? (
            <PhaseAddTaskMenu
              onCreateNew={vi.fn()}
              onLinkExisting={vi.fn()}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </div>
      );
    }

    render(<MenuHarness />);

    const createItem = screen.getByRole('menuitem', { name: 'Create new task' });
    const linkItem = screen.getByRole('menuitem', { name: 'Link existing task' });
    expect(createItem).toHaveFocus();

    fireEvent.keyDown(createItem, { key: 'ArrowDown' });
    expect(linkItem).toHaveFocus();

    fireEvent.keyDown(linkItem, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add task' })).toHaveFocus();
    });
  });
});
