import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceConnectionWarning } from '@/components/finance/FinanceConnectionWarning';
import type { FinanceConnectionRecoveryView } from '@/lib/connectors/monarch-money/recovery-contract';

const recovery: FinanceConnectionRecoveryView = {
  active: true,
  status: 'authentication_expired',
  authState: 'expired',
  startedAt: '2026-08-22T12:00:00.000Z',
  lastObservedAt: '2026-08-22T12:15:00.000Z',
  notificationCreatedAt: '2026-08-22T12:00:00.000Z',
  taskCreatedAt: null,
  staleData: true,
  message: 'Monarch authentication expired. Finance data is stale until recovery is verified.',
  reconnectUrl: 'https://tyrion.socko.us/?source=mission-control',
  canVerifyRecovery: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FinanceConnectionWarning', () => {
  it('renders persistent stale-data wording and the fixed reconnect destination', () => {
    render(
      <FinanceConnectionWarning
        connectorId="finance-1"
        recovery={recovery}
        onVerified={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert', { name: 'Monarch connection warning' })).toBeTruthy();
    expect(screen.getByText('Finance data may be stale')).toBeTruthy();
    expect(screen.getByText(/Finance data is stale until recovery is verified/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Reconnect Monarch/ })).toHaveAttribute(
      'href',
      'https://tyrion.socko.us/?source=mission-control',
    );
  });

  it('sends an empty verification contract and refreshes only after recovery settles', async () => {
    const onVerified = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ recovered: true, reason: 'recovered' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <FinanceConnectionWarning
        connectorId="finance/1"
        recovery={recovery}
        onVerified={onVerified}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Verify recovery' }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/connectors/finance%2F1/finance/recovery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
  });

  it('keeps the warning visible when bounded recovery verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ recovered: false, reason: 'bounded_sync_failed' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));
    render(
      <FinanceConnectionWarning
        connectorId="finance-1"
        recovery={recovery}
        onVerified={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Verify recovery' }));

    expect(await screen.findByText(
      'The bounded Finance refresh failed. Stale data remains visible.',
    )).toBeTruthy();
    expect(screen.getByRole('alert', { name: 'Monarch connection warning' })).toBeTruthy();
  });
});
