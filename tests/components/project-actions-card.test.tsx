import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectActionsCard } from '@/app/projects/[id]/ProjectActionsCard';

describe('ProjectActionsCard', () => {
  it('offers both reversible hiding and deletion for a local project', () => {
    const onHide = vi.fn();
    const onDelete = vi.fn();

    render(
      <ProjectActionsCard
        syncManaged={false}
        onHide={onHide}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText(/you can unhide it from all projects/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

    expect(onHide).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('offers hiding without deletion for a sync-managed project', () => {
    const onHide = vi.fn();

    render(
      <ProjectActionsCard
        syncManaged
        onHide={onHide}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide project' }));

    expect(onHide).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });
});
