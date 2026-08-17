import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationViewsBar } from '@/components/notifications/NotificationViewsBar';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';
import { DEFAULT_GITHUB_NOTIFICATION_VIEWS } from '@/lib/notifications/views';

describe('notification saved views sidebar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps saved views in the rail and offers saving only for a new query', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      views: DEFAULT_GITHUB_NOTIFICATION_VIEWS,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onAnnouncement = vi.fn();
    const onApply = vi.fn();
    const view = render(
      <NotificationViewsBar
        query={DEFAULT_GITHUB_NOTIFICATION_VIEWS[0].query}
        activeViewId={DEFAULT_GITHUB_NOTIFICATION_VIEWS[0].id}
        onApply={onApply}
        onAnnouncement={onAnnouncement}
        variant="sidebar"
      />,
    );

    const reviewRequests = await screen.findByRole('button', { name: 'Review requests' });
    expect(reviewRequests).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Save current view' })).not.toBeInTheDocument();
    fireEvent.click(reviewRequests);
    expect(onApply).toHaveBeenCalledWith(DEFAULT_GITHUB_NOTIFICATION_VIEWS[0]);

    view.rerender(
      <NotificationViewsBar
        query={{ ...DEFAULT_NOTIFICATION_QUERY, category: 'finance' }}
        activeViewId={null}
        onApply={onApply}
        onAnnouncement={onAnnouncement}
        variant="sidebar"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save current view' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(screen.getByRole('textbox', { name: 'View name' })).toHaveFocus();
  });
});
