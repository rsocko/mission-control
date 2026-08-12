import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TagInsightsMatrix from '@/components/tag-insights/TagInsightsMatrix';
import type { TagInsights } from '@/lib/tag-insights/types';

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

describe('TagInsightsMatrix', () => {
  it('reveals the exact shared tasks when a matrix cell is selected', async () => {
    render(<TagInsightsMatrix data={insights} />);

    fireEvent.click(await screen.findByRole('button', {
      name: 'API and Backend: 1 shared tasks',
    }));

    expect(screen.getByRole('heading', { name: 'Shared tasks' })).toBeInTheDocument();
    expect(screen.getByText('API + Backend')).toBeInTheDocument();
    expect(screen.getByText('Build endpoint')).toBeInTheDocument();
    expect(screen.queryByText('Write contract')).not.toBeInTheDocument();
  });

  it('explains how to recover when the threshold hides every relationship', async () => {
    render(<TagInsightsMatrix data={{ ...insights, pairs: [] }} />);

    expect(await screen.findByText('No visible relationships')).toBeInTheDocument();
    expect(screen.getByText(
      'Lower the minimum shared tasks threshold to reveal weaker relationships.',
    )).toBeInTheDocument();
  });
});
