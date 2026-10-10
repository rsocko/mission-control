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
            acceptedRuleBasedReviewBacklog: 0,
            blockingReviewRequired: 0,
            counts: {
              status: { attributed: 2 },
              reason: {},
              method: { manual: 1, 'account-default': 1 },
              confidence: { definite: 2 },
              reviewStatus: { 'not-required': 2 },
            },
          })
        : init?.method === 'PATCH'
          ? response({
              connector: {
                enabled: false,
                configurationUrl: 'https://tyrion.example/policy',
              },
              policySelection: {
                mode: 'pinned',
                pinnedPolicyVersion: 3,
              },
              activePolicyVersion: 3,
              policyUpdatedAt: '2026-10-09T11:00:00.000Z',
              policyDiscoveryError: null,
              householdCurrency: 'USD',
              attentionPolicy: {
                pendingCountThreshold: 10,
                highAmountThresholdMinor: 25_000,
                accountOverrides: {},
              },
              accountSummary: {
                total: 1,
                active: 1,
                accounts: [{
                  accountRef: `account-v1:${'b'.repeat(64)}`,
                  displayName: 'Household checking',
                  active: true,
                }],
              },
              historyProjection: null,
            })
        : response({
            connector: {
              enabled: false,
              configurationUrl: 'https://tyrion.example/policy',
            },
            policySelection: {
              mode: 'follow-current',
              pinnedPolicyVersion: null,
            },
            activePolicyVersion: 3,
            policyUpdatedAt: '2026-10-09T11:00:00.000Z',
            policyDiscoveryError: null,
            householdCurrency: 'USD',
            attentionPolicy: {
              pendingCountThreshold: 10,
              highAmountThresholdMinor: 25_000,
              accountOverrides: {},
            },
            accountSummary: {
              total: 1,
              active: 1,
              accounts: [{
                accountRef: `account-v1:${'b'.repeat(64)}`,
                displayName: 'Household checking',
                active: true,
              }],
            },
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
    expect(screen.getByRole('radio', {
      name: /Follow Tyrion's current policy/,
    })).toBeChecked();
    expect(screen.getByText(/without redeploying Mission Control/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Pending count' }))
      .toHaveAttribute('placeholder', 'Inherit');
    expect(screen.getByRole('spinbutton', { name: 'Amount (USD)' }))
      .toHaveAttribute('placeholder', 'Inherit');

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pending transactions' }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'High amount (USD)' }), {
      target: { value: '300' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pending count' }), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save notification thresholds' }));
    expect(await screen.findByText('Attribution notification thresholds saved.'))
      .toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/connectors/finance-connector/finance/attribution-readiness',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attentionPolicy: {
            pendingCountThreshold: 12,
            highAmountThresholdMinor: 30_000,
            accountOverrides: {
              [`account-v1:${'b'.repeat(64)}`]: {
                pendingCountThreshold: 15,
                highAmountThresholdMinor: null,
              },
            },
          },
        }),
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run no-write preview' }));

    expect(await screen.findByText(/1 manual decisions preserved/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/connectors/finance-connector/finance/attribution-readiness',
      { method: 'POST' },
    );

    fireEvent.click(screen.getByRole('radio', {
      name: /Pin a specific policy version/,
    }));
    fireEvent.change(screen.getByRole('spinbutton', { name: /^Policy version/ }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy mode' }));

    expect(await screen.findByText('Pinned to policy 3.')).toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/connectors/finance-connector/finance/attribution-readiness',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinnedPolicyVersion: 3 }),
      },
    );
  });
});
