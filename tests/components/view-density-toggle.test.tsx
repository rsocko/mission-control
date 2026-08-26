import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ViewDensityToggle } from '@/components/toolbar/ViewDensityToggle';
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
});
