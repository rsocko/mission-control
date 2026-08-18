import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubtaskPill } from '@/components/ui/SubtaskPill';

describe('SubtaskPill', () => {
  it('handles direct navigation without triggering the containing row', () => {
    const onClick = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <SubtaskPill done={1} total={3} onClick={onClick} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'Open subtasks, 1 of 3 subtasks complete',
    }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('remains a status indicator when no navigation handler is provided', () => {
    render(<SubtaskPill done={1} total={3} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTitle('1 of 3 subtasks complete')).toBeInTheDocument();
  });
});
