import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileTriageStream from '@/components/triage/mobile/MobileTriageStream';
import type { TriageItem } from '@/types';

vi.mock('@/lib/hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    containerRef: { current: null },
    isRefreshing: false,
    pullDistance: 0,
    containerProps: {},
  }),
}));

function makeItem(overrides: Partial<TriageItem>): TriageItem {
  return {
    id: 'item-1',
    sourcePlatform: 'github',
    sourceId: 'src-1',
    sourceUrl: 'https://example.com/item-1',
    title: 'Ship mobile triage stream',
    description: 'Create a mobile-first triage feed.',
    contentType: 'repo',
    capturedAt: '2026-07-29T14:00:00.000Z',
    ingestedAt: '2026-07-29T14:05:00.000Z',
    status: 'pending',
    aiSummary: 'AI summary for the triage item.',
    aiCategories: ['productivity'],
    aiSuggestedActions: [],
    aiRelevanceScore: 92,
    aiUrgency: 'time_sensitive',
    rawMetadata: {},
    actionsTaken: [],
    ...overrides,
  };
}

describe('MobileTriageStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T16:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders branded cards and handles taps', () => {
    const onItemTap = vi.fn();

    render(
      <MobileTriageStream
        items={[makeItem({ title: 'GitHub issue triage', sourcePlatform: 'github', aiRelevanceScore: 88 })]}
        loading={false}
        onItemTap={onItemTap}
        activeSourceFilter="github"
        onSourceFilterChange={vi.fn()}
        activeTypeFilter={null}
        onTypeFilterChange={vi.fn()}
      />,
    );

    const filterToggle = screen.getByRole('button', { name: 'Toggle filters' });
    expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'GitHub' })).not.toBeInTheDocument();
    expect(screen.getByText('GitHub issue triage')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText('Time sensitive')).toBeInTheDocument();
    expect(screen.getByText('2 hours ago')).toBeInTheDocument();

    fireEvent.click(filterToggle);
    expect(filterToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'GitHub' })).toHaveClass('bg-violet-500/15');
    expect(screen.getAllByText('Time sensitive')).toHaveLength(2);

    fireEvent.click(screen.getByText('GitHub issue triage').closest('button') as HTMLButtonElement);
    expect(onItemTap).toHaveBeenCalledWith('item-1');
  });

  it('supports source, type, and focus controls', () => {
    const onSourceFilterChange = vi.fn();
    const onTypeFilterChange = vi.fn();
    const onSwitchToFocus = vi.fn();

    render(
      <MobileTriageStream
        items={[
          makeItem({ sourcePlatform: 'reddit', contentType: 'video', title: 'Reddit video' }),
          makeItem({ id: 'item-2', sourcePlatform: 'github', contentType: 'repo', title: 'GitHub repo' }),
        ]}
        loading={false}
        onItemTap={vi.fn()}
        onSwitchToFocus={onSwitchToFocus}
        activeSourceFilter="all"
        onSourceFilterChange={onSourceFilterChange}
        activeTypeFilter={null}
        onTypeFilterChange={onTypeFilterChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reddit' }));
    expect(onSourceFilterChange).toHaveBeenCalledWith('reddit');

    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(onTypeFilterChange).toHaveBeenCalledWith('video');

    fireEvent.click(screen.getByRole('button', { name: /focus mode/i }));
    expect(onSwitchToFocus).toHaveBeenCalledTimes(1);
  });

  it('filters by priority chips', () => {
    render(
      <MobileTriageStream
        items={[
          makeItem({ id: 'item-1', title: 'Urgent item', aiUrgency: 'time_sensitive' }),
          makeItem({ id: 'item-2', title: 'Evergreen item', aiUrgency: 'evergreen', sourcePlatform: 'reddit' }),
        ]}
        loading={false}
        onItemTap={vi.fn()}
        activeSourceFilter="all"
        onSourceFilterChange={vi.fn()}
        activeTypeFilter={null}
        onTypeFilterChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Urgent item')).toBeInTheDocument();
    expect(screen.getByText('Evergreen item')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Time sensitive' }));

    expect(screen.getByText('Urgent item')).toBeInTheDocument();
    expect(screen.queryByText('Evergreen item')).toBeNull();
  });
});
