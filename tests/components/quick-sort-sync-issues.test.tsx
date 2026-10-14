import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuickSortSyncIssues, {
  extractQuickSortSyncIssues,
} from '@/components/quick-sort/QuickSortSyncIssues';

describe('Quick Sort sync issues', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('extracts recent task-level write-through failures and deduplicates by task', () => {
    const issues = extractQuickSortSyncIssues([
      {
        id: 'run-new',
        syncedAt: '2026-10-14T20:45:25.000Z',
        details: [{
          action: 'push_failed',
          taskId: 'task-1',
          taskTitle: 'Picture in Toilet room',
          reason: 'Write-through failed: Graph request timed out',
        }],
      },
      {
        id: 'run-old',
        syncedAt: '2026-10-14T20:40:00.000Z',
        details: [{
          action: 'push_failed',
          taskId: 'task-1',
          taskTitle: 'Picture in Toilet room',
          reason: 'Write-through failed: Earlier failure',
        }],
      },
      {
        id: 'regular-sync',
        syncedAt: '2026-10-14T20:46:00.000Z',
        details: [{
          action: 'updated',
          taskId: 'task-2',
          taskTitle: 'Unrelated task',
        }],
      },
    ], Date.parse('2026-10-14T21:00:00.000Z'));

    expect(issues).toEqual([{
      id: 'run-new:0',
      taskId: 'task-1',
      taskTitle: 'Picture in Toilet room',
      reason: 'Graph request timed out',
      occurredAt: '2026-10-14T20:45:25.000Z',
    }]);
  });

  it('shows task context for recent failed source updates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        history: [{
          id: 'run-1',
          syncedAt: new Date().toISOString(),
          details: [{
            action: 'push_failed',
            taskId: 'task-1',
            taskTitle: 'Picture in Toilet room',
            reason: 'Write-through failed: Microsoft Graph returned 503',
          }],
        }],
      }),
    }));

    render(<QuickSortSyncIssues />);

    expect(await screen.findByText('1 recent update did not reach its source')).toBeInTheDocument();
    expect(screen.getByText('Picture in Toilet room')).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Graph returned 503/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute(
      'href',
      '/tasks/task-1',
    );
  });

  it('stays hidden when there are no write-through failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ history: [] }),
    }));

    const { container } = render(<QuickSortSyncIssues />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
