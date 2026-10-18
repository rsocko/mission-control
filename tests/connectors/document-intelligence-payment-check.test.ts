import { describe, expect, it } from 'vitest';
import { mapActionToTask, type DocAction } from '@/lib/connectors/document-intelligence/document-parser';

function paymentAction(): DocAction {
  return {
    id: 'action-1',
    document_id: 42,
    document_title: 'Synthetic electric bill',
    action_type: 'pay',
    urgency: 'high',
    summary: 'Pay the synthetic electric bill',
    status: 'pending',
    created_at: '2026-10-15T12:00:00.000Z',
    source_actions: [
      {
        id: 'check_payment',
        label: 'Check for payment',
        method: 'POST',
        url: '/api/action-queue/actions/action-1/check-payment',
        revision: 'rev-7',
        idempotency_key: 'payment-check-action-1-rev-7',
      },
      {
        id: 'confirm_payment_and_complete',
        label: 'Confirm payment',
        method: 'POST',
        url: '/api/action-queue/actions/action-1/confirm-payment-and-complete',
        revision: 'rev-7',
      },
    ],
    payment_check: {
      state: 'posted_match',
      checked_at: '2026-10-17T18:00:00.000Z',
      fresh_until: '2026-10-17T19:00:00.000Z',
      source: 'Tyrion Bill Matching',
      revision: 'rev-7',
      candidates: [{
        id: 'candidate-1',
        payee: 'Synthetic Electric',
        amount: 128.45,
        currency: 'usd',
        transaction_date: '2026-10-16',
        status: 'posted',
        account_display_name: 'Household checking',
        account_last_four: '001234',
        confidence: 94,
        score: 0.91,
        match_reasons: ['Payee match', 'Amount match'],
        rank: 1,
        score_gap_basis_points: 420,
        receipt_association: {
          status: 'associated',
          label: 'Email receipt',
          receipt_date: '2026-10-16',
          amount: 128.45,
          currency: 'usd',
        },
      }],
      search_context: {
        anchor_date: '2026-10-15',
        window_start: '2026-10-08',
        window_end: '2026-10-22',
        source_as_of: '2026-10-17T17:55:00.000Z',
        searched_at: '2026-10-17T18:00:00.000Z',
        eligible_account_count: 3,
        candidate_pool_size: 8,
      },
    },
  };
}

describe('OWL payment-check projection', () => {
  it('maps decision-grade payment evidence and opaque action controls into task metadata', () => {
    const task = mapActionToTask(
      paymentAction(),
      'document-intelligence',
      'owl-1',
      'https://owl.example',
    );

    expect(task.metadata).toMatchObject({
      paymentCheck: {
        state: 'posted_match',
        checkedAt: '2026-10-17T18:00:00.000Z',
        freshUntil: '2026-10-17T19:00:00.000Z',
        source: 'Tyrion Bill Matching',
        revision: 'rev-7',
        candidates: [{
          id: 'candidate-1',
          payee: 'Synthetic Electric',
          amount: 128.45,
          currency: 'USD',
          status: 'posted',
          accountDisplayName: 'Household checking',
          accountLastFour: '1234',
          confidence: 0.94,
          score: 0.91,
          matchReasons: ['Payee match', 'Amount match'],
          rank: 1,
          scoreGapBasisPoints: 420,
          receiptAssociation: {
            status: 'associated',
            label: 'Email receipt',
            receiptDate: '2026-10-16',
            amount: 128.45,
            currency: 'USD',
          },
        }],
        searchContext: {
          anchorDate: '2026-10-15',
          windowStart: '2026-10-08',
          windowEnd: '2026-10-22',
          sourceAsOf: '2026-10-17T17:55:00.000Z',
          searchedAt: '2026-10-17T18:00:00.000Z',
          eligibleAccountCount: 3,
          candidatePoolSize: 8,
        },
      },
      sourceActions: [
        expect.objectContaining({
          id: 'check_payment',
          revision: 'rev-7',
          idempotency_key: 'payment-check-action-1-rev-7',
        }),
        expect.objectContaining({
          id: 'confirm_payment_and_complete',
          revision: 'rev-7',
        }),
      ],
    });
  });

  it('drops malformed payment evidence instead of presenting a success-shaped fallback', () => {
    const action = paymentAction();
    action.payment_check = {
      state: 'posted_match',
      candidates: [{
        id: 'candidate-1',
        payee: 'Synthetic Electric',
        amount: Number.NaN,
        currency: 'USD',
        transaction_date: '2026-10-16',
        status: 'posted',
        account_display_name: 'Household checking',
        account_last_four: '1234',
        confidence: 0.94,
        score: 0.91,
        match_reasons: [],
      }],
    };

    const task = mapActionToTask(action, 'document-intelligence', 'owl-1');

    expect(task.metadata.paymentCheck).toMatchObject({
      state: 'posted_match',
      candidates: [],
    });
  });
});
