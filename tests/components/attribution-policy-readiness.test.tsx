import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttributionPolicyReadiness,
} from '@/app/settings/components/AttributionPolicyReadiness';

function response(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AttributionPolicyReadiness', () => {
  it('links to Tyrion defaults without exposing or copying account references', async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST'
        ? response({
            generatedAt: '2026-10-09T12:00:00.000Z',
            policyVersion: 3,
            engineVersion: '2.0.0',
            totalTransactions: 2,
            evaluated: 2,
            truncated: false,
            complete: true,
            ready: true,
            counts: {
              status: { attributed: 2 },
              reason: {},
              method: { manual: 1, 'account-default': 1 },
              confidence: { definite: 2 },
              reviewStatus: { 'not-required': 2 },
            },
          })
        : response({
            connector: {
              enabled: false,
              configurationUrl: 'https://tyrion.example/policy',
            },
            expectedPolicyVersion: 3,
            accountSummary: { total: 2, active: 2 },
            historyProjection: null,
          })
    ));
    vi.stubGlobal('fetch', fetcher);

    render(<AttributionPolicyReadiness connectorId="finance-connector" />);

    expect(await screen.findByText(/Default attribution is managed directly in Tyrion/))
      .toBeInTheDocument();
    expect(screen.getByText(/Manual assignments and explicit rules override defaults/))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Configure defaults in Tyrion/ }))
      .toHaveAttribute('href', 'https://tyrion.example/policy');
    expect(screen.queryByRole('button', { name: /Copy Tyrion account reference/ }))
      .not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('account-v1:');

    fireEvent.click(screen.getByRole('button', { name: 'Run no-write preview' }));

    expect(await screen.findByText(/1 manual decisions preserved/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/connectors/finance-connector/finance/attribution-readiness',
      { method: 'POST' },
    );
  });
});
