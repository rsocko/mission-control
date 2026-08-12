import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backSpy, pushSpy, replaceSpy, getSearchParams, setSearchParams } = vi.hoisted(() => {
  let searchParams = '';
  return {
    backSpy: vi.fn(),
    pushSpy: vi.fn(),
    replaceSpy: vi.fn(),
    getSearchParams: () => searchParams,
    setSearchParams: (value: string) => { searchParams = value; },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: replaceSpy,
    back: backSpy,
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(getSearchParams()),
}));

describe('Insights drill-down navigation', () => {
  beforeEach(() => {
    backSpy.mockReset();
    pushSpy.mockReset();
    replaceSpy.mockReset();
    setSearchParams('');
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('adds Insights return context to source drill-downs', async () => {
    const { SourceBreakdownChart } = await import('@/components/insights/SourceBreakdownChart');

    render(
      <SourceBreakdownChart
        data={[{ source: 'github', count: 3, percentage: 100 }]}
        period={30}
      />,
    );
    fireEvent.click(screen.getByTitle(/GitHub: 3/));

    expect(pushSpy).toHaveBeenCalledWith(
      '/?source=github&origin=insights&insightsPeriod=30',
    );
  });

  it('adds Insights return context to task-age drill-downs', async () => {
    const { TaskAgeChart } = await import('@/components/insights/TaskAgeChart');

    render(
      <TaskAgeChart
        data={[{ label: '31–60 days', count: 2, minDays: 31, maxDays: 60 }]}
        period={90}
      />,
    );
    fireEvent.click(screen.getByTitle(/31–60 days: 2/));

    expect(pushSpy).toHaveBeenCalledWith(
      '/?ageMin=31&ageMax=60&origin=insights&insightsPeriod=90',
    );
  });

  it('uses browser history to return from an in-session drill-down', async () => {
    const { SourceBreakdownChart } = await import('@/components/insights/SourceBreakdownChart');
    const { InsightsBackLink } = await import('@/components/insights/InsightsBackLink');

    render(
      <SourceBreakdownChart
        data={[{ source: 'github', count: 3, percentage: 100 }]}
        period={30}
      />,
    );
    fireEvent.click(screen.getByTitle(/GitHub: 3/));

    const destination = '/?source=github&origin=insights&insightsPeriod=30';
    window.history.pushState({}, '', destination);
    setSearchParams(destination.slice(destination.indexOf('?') + 1));
    cleanup();
    render(<InsightsBackLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Insights' }));

    expect(backSpy).toHaveBeenCalledOnce();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('uses browser history when the drill-down replaces forward entries', async () => {
    window.history.pushState({}, '', '/forward-entry');
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));

    const { TaskAgeChart } = await import('@/components/insights/TaskAgeChart');
    const { InsightsBackLink } = await import('@/components/insights/InsightsBackLink');

    render(
      <TaskAgeChart
        data={[{ label: '31–60 days', count: 2, minDays: 31, maxDays: 60 }]}
        period={90}
      />,
    );
    fireEvent.click(screen.getByTitle(/31–60 days: 2/));

    const destination = '/?ageMin=31&ageMax=60&origin=insights&insightsPeriod=90';
    window.history.pushState({}, '', destination);
    setSearchParams(destination.slice(destination.indexOf('?') + 1));
    cleanup();
    render(<InsightsBackLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Insights' }));

    expect(backSpy).toHaveBeenCalledOnce();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('uses a period-aware fallback when the drill-down URL was opened directly', async () => {
    setSearchParams('origin=insights&insightsPeriod=30');
    const { InsightsBackLink } = await import('@/components/insights/InsightsBackLink');

    render(<InsightsBackLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Insights' }));

    expect(replaceSpy).toHaveBeenCalledWith('/insights?period=30');
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default Insights period for invalid return context', async () => {
    setSearchParams('origin=insights&insightsPeriod=365');
    const { InsightsBackLink } = await import('@/components/insights/InsightsBackLink');

    render(<InsightsBackLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Insights' }));

    expect(replaceSpy).toHaveBeenCalledWith('/insights');
  });

  it('does not show a return link without a valid Insights origin', async () => {
    setSearchParams('origin=search&insightsPeriod=30');
    const { InsightsBackLink } = await import('@/components/insights/InsightsBackLink');

    render(<InsightsBackLink />);

    expect(screen.queryByRole('button', { name: 'Back to Insights' })).toBeNull();
  });
});
