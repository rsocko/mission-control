import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UniverseSeedSearch } from '@/components/graph/universe/UniverseSeedSearch';

const mocks = vi.hoisted(() => ({
  useProgressiveSearch: vi.fn(),
}));

vi.mock('@/lib/hooks/useProgressiveSearch', () => ({
  useProgressiveSearch: mocks.useProgressiveSearch,
}));

const searchState = {
    results: [
      {
        type: 'task',
        id: 'task-1',
        title: 'Build semantic neighborhoods',
        snippet: '',
        score: 1,
        source: 'hybrid',
        href: '/tasks/task-1',
        metadata: {},
      },
      {
        type: 'task',
        id: 'task-2',
        title: 'Validate vector retrieval',
        snippet: '',
        score: 0.8,
        source: 'semantic',
        href: '/tasks/task-2',
        metadata: {},
      },
    ],
    note: null,
    keywordLoading: false,
    semanticLoading: false,
    semanticEnabled: true,
    semanticAvailable: true,
};

describe('UniverseSeedSearch', () => {
  it('selects multiple hybrid task results and starts a bounded seed projection', async () => {
    mocks.useProgressiveSearch.mockReturnValue(searchState);
    const onExplore = vi.fn();
    render(<UniverseSeedSearch onExplore={onExplore} onExploreAll={vi.fn()} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks to seed the Universe' }), {
      target: { value: 'semantic' },
    });
    await waitFor(() => expect(screen.getByText('Build semantic neighborhoods')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: /Build semantic neighborhoods/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Validate vector retrieval/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Explore 2 selected tasks' }));

    expect(onExplore).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(mocks.useProgressiveSearch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tasks',
      limit: 20,
      universeEligible: true,
    }));
  });
});
