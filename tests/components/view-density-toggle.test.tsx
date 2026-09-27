import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RowLayoutDropdown, ViewDensityToggle } from '@/components/toolbar/ViewDensityToggle';
import { TooltipProvider } from '@/components/ui/Tooltip';

describe('ViewDensityToggle', () => {
  it('supports a controlled density without mutating global view state', () => {
    const onChange = vi.fn();
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');

    render(
      <TooltipProvider>
        <ViewDensityToggle value="comfortable" onChange={onChange} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch to compact view' }));

    expect(onChange).toHaveBeenCalledWith('compact');
    expect(dispatchEvent).not.toHaveBeenCalled();
    dispatchEvent.mockRestore();
  });

  describe('RowLayoutDropdown', () => {
    it('offers normal, compact, and wrapped title layouts', () => {
      const onChange = vi.fn();

      render(
        <TooltipProvider>
          <RowLayoutDropdown value="normal" onChange={onChange} />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Row layout: Normal' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Wrap/ }));

      expect(onChange).toHaveBeenCalledWith('wrapped');
      expect(screen.queryByRole('menu', { name: 'Row layout options' })).not.toBeInTheDocument();
    });

    it('supports arrow-key navigation between layout choices', () => {
      render(
        <TooltipProvider>
          <RowLayoutDropdown value="normal" onChange={vi.fn()} />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Row layout: Normal' }));
      const normal = screen.getByRole('menuitemradio', { name: /Normal/ });
      const compact = screen.getByRole('menuitemradio', { name: /Compact/ });
      normal.focus();
      fireEvent.keyDown(normal, { key: 'ArrowDown' });

      expect(compact).toHaveFocus();
    });
  });
});
