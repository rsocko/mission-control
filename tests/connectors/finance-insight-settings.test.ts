import { describe, expect, it } from 'vitest';
import { resolveFinanceInsightCurrency } from '@/lib/finance-insights/settings';

describe('finance insight settings', () => {
  it('uses only an exact persisted household currency', () => {
    expect(resolveFinanceInsightCurrency({
      settings: { householdCurrency: 'EUR' },
    })).toBe('EUR');
  });

  it('fails closed for missing, malformed, environment, or legacy inferred values', () => {
    process.env.FINANCE_INSIGHTS_CURRENCY = 'CAD';
    expect(resolveFinanceInsightCurrency({ settings: {} })).toBeNull();
    expect(resolveFinanceInsightCurrency({
      settings: { householdCurrency: 'US' },
    })).toBeNull();
    expect(resolveFinanceInsightCurrency({
      settings: { householdCurrency: ' eur ' },
    })).toBeNull();
    expect(resolveFinanceInsightCurrency({
      settings: { insightCurrency: 'USD' },
    })).toBeNull();
    delete process.env.FINANCE_INSIGHTS_CURRENCY;
  });
});
