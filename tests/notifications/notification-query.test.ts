import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_QUERY,
  NOTIFICATION_MERCHANT_QUERY_ERROR,
  hasActiveNotificationFilters,
  notificationQueryValidationError,
  parseNotificationQuery,
  serializeNotificationQuery,
} from '@/lib/notifications/query';
import {
  DEFAULT_GITHUB_NOTIFICATION_VIEWS,
  notificationViewHref,
} from '@/lib/notifications/views';
import { normalizeFinanceProviderFacets } from '@/lib/finance-insights/provider';

describe('notification URL query', () => {
  const merchant = `merchant-v1_${'A'.repeat(43)}`;

  it('round-trips every supported filter and sort value', () => {
    const query = parseNotificationQuery(new URLSearchParams({
      q: 'review me',
      level: 'urgent',
      category: 'security',
      merchant,
      source: 'github-issues',
      sourceAccount: 'github-work',
      state: 'unread',
      actionableOnly: 'true',
      dateRange: 'week',
      repository: 'octo/app',
      owner: 'octo',
      reason: 'review_requested',
      subjectType: 'PullRequest',
      participating: 'true',
      sort: 'oldest',
    }));

    expect(parseNotificationQuery(serializeNotificationQuery(query))).toEqual(query);
  });

  it('drops invalid enumerations and bounds free-text values', () => {
    const query = parseNotificationQuery({
      level: 'admin',
      state: 'deleted',
      dateRange: 'forever',
      sort: 'random',
      q: 'x'.repeat(500),
    });

    expect({ ...query, q: null }).toEqual(DEFAULT_NOTIFICATION_QUERY);
    expect(query.q).toHaveLength(300);
  });

  it('ships shareable GitHub defaults without setup', () => {
    expect(DEFAULT_GITHUB_NOTIFICATION_VIEWS.map(view => view.name)).toEqual([
      'Review requests',
      'Mentions',
      'Assignments',
      'CI activity',
      'Security',
      'Participating',
      'All GitHub',
    ]);
    expect(notificationViewHref(DEFAULT_GITHUB_NOTIFICATION_VIEWS[0])).toContain(
      'reason=review_requested',
    );
  });

  it('does not treat sort direction as an active filter', () => {
    expect(hasActiveNotificationFilters({
      ...DEFAULT_NOTIFICATION_QUERY,
      sort: 'oldest',
    })).toBe(false);
  });

  it('normalizes every Finance source alias to one source family', () => {
    for (const source of ['finance', 'finance-manager', 'monarch-money']) {
      const query = parseNotificationQuery({ source });
      expect(query.source).toBe('finance-manager');
      expect(serializeNotificationQuery(query).get('source')).toBe('finance-manager');
    }
    expect(normalizeFinanceProviderFacets([
      { value: 'finance', count: 2 },
      { value: 'finance-manager', count: 3 },
      { value: 'monarch-money', count: 5 },
      { value: 'github-issues', count: 7 },
    ])).toEqual({
      'finance-manager': 10,
      'github-issues': 7,
    });
  });

  it('round-trips one bounded normalized merchant key without accepting free text', () => {
    expect(notificationQueryValidationError({ ...DEFAULT_NOTIFICATION_QUERY })).toBeNull();
    const query = parseNotificationQuery({ category: 'finance', merchant });
    expect(query.merchant).toBe(merchant);
    expect(parseNotificationQuery(serializeNotificationQuery(query))).toEqual(query);

    for (const invalid of ['', 'Invented market', `${merchant}' OR 1=1`, 'merchant-v1_short']) {
      expect(notificationQueryValidationError({ merchant: invalid })).toBe(
        NOTIFICATION_MERCHANT_QUERY_ERROR,
      );
      expect(parseNotificationQuery({ merchant: invalid }).merchant).toBeNull();
    }
  });

  it('rejects duplicate merchant parameters instead of broadening the query', () => {
    const params = new URLSearchParams();
    params.append('merchant', merchant);
    params.append('merchant', merchant);

    expect(notificationQueryValidationError(params)).toBe(NOTIFICATION_MERCHANT_QUERY_ERROR);
    expect(parseNotificationQuery(params).merchant).toBeNull();
  });
});
