import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkMoveToSourceButton } from '@/components/bulk-actions/BulkMoveToSourceButton';

describe('BulkMoveToSourceButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a single scroll region for connectors and destination lists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          connectors: [{
            id: 'inst-2',
            type: 'microsoft-todo',
            name: 'Microsoft To Do',
            capabilities: { taskCreate: true },
          }],
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          sourceLists: Array.from({ length: 8 }, (_, index) => ({
            id: `list-row-${index}`,
            name: `List ${index}`,
            sourceId: `list-${index}`,
          })),
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <BulkMoveToSourceButton
        selectedTaskIds={['task-1']}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Move to source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Microsoft To Do/i }));
    await screen.findByRole('button', { name: 'List 7' });

    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
    expect(container.querySelector('.overflow-y-auto .overflow-y-auto')).not.toBeInTheDocument();
  });
});
