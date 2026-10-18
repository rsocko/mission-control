import { describe, expect, it } from 'vitest';
import { projectPaymentCheckContext } from '@/lib/ai/payment-check-context';

describe('AI payment-check context', () => {
  it('projects bounded decision evidence without exposing source actions or revisions', () => {
    const result = projectPaymentCheckContext(JSON.stringify({
      sourceActions: [{ id: 'confirm_payment_and_complete', revision: 'secret-control' }],
      paymentCheck: {
        state: 'posted_match',
        checkedAt: '2026-10-17T18:00:00.000Z',
        source: 'Tyrion Bill Matching',
        revision: 'rev-7',
        searchContext: {
          windowStart: '2026-10-08',
          windowEnd: '2026-10-22',
          sourceAsOf: '2026-10-17T17:55:00.000Z',
        },
        candidates: Array.from({ length: 5 }, (_, index) => ({
          id: `candidate-${index}`,
          payee: `Synthetic payee ${index}`,
          amount: 100 + index,
          currency: 'USD',
          transactionDate: '2026-10-16',
          status: 'posted',
          accountDisplayName: 'Household checking',
          accountLastFour: '1234',
          confidence: 0.94,
          score: 0.91,
          matchReasons: ['Payee match', 'Amount match', 'Date match', 'Reason 4', 'Reason 5', 'Reason 6'],
        })),
      },
    }));

    expect(result).toMatchObject({
      state: 'posted_match',
      source: 'Tyrion Bill Matching',
      searchContext: {
        windowStart: '2026-10-08',
        windowEnd: '2026-10-22',
        sourceAsOf: '2026-10-17T17:55:00.000Z',
      },
    });
    expect(result?.candidates).toHaveLength(3);
    expect(result?.candidates[0].matchReasons).toHaveLength(5);
    expect(result).not.toHaveProperty('revision');
    expect(result).not.toHaveProperty('sourceActions');
  });

  it('omits malformed or unrelated metadata', () => {
    expect(projectPaymentCheckContext('{bad json')).toBeUndefined();
    expect(projectPaymentCheckContext({ actionType: 'pay' })).toBeUndefined();
  });
});
