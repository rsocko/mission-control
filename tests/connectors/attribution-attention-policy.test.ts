import { describe, expect, it } from 'vitest';
import {
  AttributionAttentionPolicyError,
  attributionAttentionAccountRef,
  currencyMinorUnitFactor,
  parseAttributionAttentionPolicy,
  resolveAttributionAttentionThresholds,
} from '@/lib/finance/attribution-attention-policy';

describe('attribution attention policy', () => {
  it('uses currency-aware defaults and inherits nullable account overrides', () => {
    expect(currencyMinorUnitFactor('JPY')).toBe(1);
    expect(currencyMinorUnitFactor('KWD')).toBe(1_000);
    expect(parseAttributionAttentionPolicy({}, 'USD')).toMatchObject({
      pendingCountThreshold: 10,
      highAmountThresholdMinor: 25_000,
      accountOverrides: {},
    });

    const accountRef = attributionAttentionAccountRef('connector-one', 'direct-account-one');
    const policy = parseAttributionAttentionPolicy({
      attributionAttention: {
        pendingCountThreshold: 12,
        highAmountThresholdMinor: 50_000,
        accountOverrides: {
          [accountRef]: {
            pendingCountThreshold: null,
            highAmountThresholdMinor: 75_000,
          },
        },
      },
    }, 'USD');
    expect(resolveAttributionAttentionThresholds(policy, accountRef)).toEqual({
      pendingCountThreshold: 12,
      highAmountThresholdMinor: 75_000,
    });
    expect(accountRef).toMatch(/^account-v1:[a-f0-9]{64}$/);
    expect(accountRef).not.toContain('direct-account-one');
  });

  it.each([
    { pendingCountThreshold: -1, highAmountThresholdMinor: 1 },
    { pendingCountThreshold: 1.5, highAmountThresholdMinor: 1 },
    { pendingCountThreshold: 100_001, highAmountThresholdMinor: 1 },
    { pendingCountThreshold: 1, highAmountThresholdMinor: -1 },
    { pendingCountThreshold: 1, highAmountThresholdMinor: Number.MAX_SAFE_INTEGER },
  ])('rejects unsafe or out-of-bounds thresholds', (attributionAttention) => {
    expect(() => parseAttributionAttentionPolicy({ attributionAttention }, 'USD'))
      .toThrow(AttributionAttentionPolicyError);
  });

  it('rejects malformed account overrides instead of silently inheriting', () => {
    const accountRef = attributionAttentionAccountRef('connector-one', 'account-one');
    expect(() => parseAttributionAttentionPolicy({
      attributionAttention: {
        pendingCountThreshold: 10,
        highAmountThresholdMinor: 25_000,
        accountOverrides: { [accountRef]: 'invalid' },
      },
    }, 'USD')).toThrow(AttributionAttentionPolicyError);
  });
});
