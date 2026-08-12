import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TagInsightsExplorer from '@/components/tag-insights/TagInsightsExplorer';
import type { TagInsights } from '@/lib/tag-insights/types';

vi.mock('@/components/tag-insights/TagGalaxy', () => ({
  default: ({ data, layoutKey }: { data: TagInsights; layoutKey?: string }) => (
    <div>
      Galaxy renderer: {data.tags.map((tag) => tag.name).join(', ')}
      {' | '}
      Layout: {layoutKey}
    </div>
  ),
}));

const insights: TagInsights = {
  tags: [
    { id: 'api', name: 'API', color: null, taskCount: 2, taskIds: ['1', '2'] },
    { id: 'backend', name: 'Backend', color: null, taskCount: 1, taskIds: ['1'] },
  ],
  pairs: [{
    key: '["api","backend"]',
    sourceTagId: 'api',
    targetTagId: 'backend',
    count: 1,
    taskIds: ['1'],
  }],
  tasks: {
    '1': { id: '1', title: 'Build endpoint', status: 'in_progress' },
    '2': { id: '2', title: 'Write contract', status: 'todo' },
  },
  meta: {
    topN: 15,
    minCooccurrence: 1,
    taskLimit: 2000,
    processedTaskCount: 2,
    truncated: false,
  },
};

describe('TagInsightsExplorer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(insights), { status: 200 }),
    ));
  });

  it('shares one result across Galaxy and Matrix and filters both views', async () => {
    render(<TagInsightsExplorer initialView="matrix" />);

    expect(await screen.findByRole('button', {
      name: 'API and Backend: 1 shared tasks',
    })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Galaxy' }));
    expect(screen.getByText(/Galaxy renderer: API, Backend/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter tags' }), {
      target: { value: 'back' },
    });
    expect(screen.getByText(/Galaxy renderer: Backend/)).toHaveTextContent('Layout: 15:2:back');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('updates the graph layout key only when queried data arrives', async () => {
    let resolveRefresh: (response: Response) => void = () => {};
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(insights), { status: 200 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }));

    render(<TagInsightsExplorer initialView="galaxy" />);
    expect(await screen.findByText(/Galaxy renderer: API, Backend/)).toHaveTextContent(
      'Layout: 15:2:',
    );

    fireEvent.change(screen.getByRole('slider', { name: 'Minimum shared tasks' }), {
      target: { value: '3' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Galaxy renderer: API, Backend/)).toHaveTextContent(
      'Layout: 15:2:',
    );

    await act(async () => {
      resolveRefresh(new Response(JSON.stringify(insights), { status: 200 }));
    });
    expect(await screen.findByText(/Layout: 15:3:/)).toBeInTheDocument();
  });

  it('renders a useful empty search state', async () => {
    render(<TagInsightsExplorer initialView="matrix" />);
    await screen.findByRole('button', { name: 'API and Backend: 1 shared tasks' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter tags' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByRole('heading', { name: 'No matching tags' })).toBeInTheDocument();
  });
});
