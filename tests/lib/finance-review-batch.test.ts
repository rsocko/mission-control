import { describe, expect, it } from 'vitest';
import {
  groupAttributionExceptions,
  runWithBoundedConcurrency,
} from '@/components/finance/finance-review-batch';
import { normalizeAttributionMerchant } from '@/lib/finance/attribution-merchant';
import type { AttributionException } from '@/components/finance/types';

function exception(id: string, merchantName: string | null): AttributionException {
  return {
    id,
    merchantName,
    status: 'open',
    reasonCode: 'low-confidence',
    retryable: true,
    reviewState: 'pending',
    policyVersion: 7,
    occurrenceCount: 1,
    firstObservedAt: '2026-08-08T10:00:00.000Z',
    lastObservedAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:00:00.000Z',
    date: '2026-08-08',
    assignedKidId: null,
    attributionStatus: 'unattributed',
    confidence: 'none',
    method: null,
    explanation: null,
    reasons: [],
    decisionSource: null,
    evaluatedAt: null,
  };
}

describe('finance review grouping', () => {
  it('uses the attribution normalizer as the deterministic exact merchant key', () => {
    expect(normalizeAttributionMerchant('  Invented\u000b  Market  ')).toBe('Invented Market');
    expect(normalizeAttributionMerchant('')).toBe('Unknown merchant');

    const groups = groupAttributionExceptions([
      exception('one', 'Invented Market'),
      exception('two', '  Invented\u000b  Market  '),
      exception('three', 'invented market'),
      exception('four', null),
    ]);

    expect(groups.map((group) => [group.key, group.exceptions.length])).toEqual([
      ['Invented Market', 2],
      ['invented market', 1],
      ['Unknown merchant', 1],
    ]);
  });

  it('never exceeds the requested worker concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await runWithBoundedConcurrency(
      [1, 2, 3, 4, 5, 6],
      4,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return value * 2;
      },
    );

    expect(maximumActive).toBe(4);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });
});
