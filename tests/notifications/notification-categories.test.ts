import { describe, expect, it } from 'vitest';
import {
  formatNotificationCategoryLabel,
  formatNotificationSourceLabel,
} from '@/lib/notifications/categories';

describe('notification display labels', () => {
  it('uses canonical category labels and safely formats extension categories', () => {
    expect(formatNotificationCategoryLabel('development')).toBe('Development');
    expect(formatNotificationCategoryLabel('ai_insights')).toBe('AI Insights');
    expect(formatNotificationCategoryLabel('custom_signal')).toBe('Custom Signal');
    expect(formatNotificationCategoryLabel('toString')).toBe('ToString');
  });

  it('uses the same source identity as notification cards', () => {
    expect(formatNotificationSourceLabel('github-issues')).toBe('GitHub');
    expect(formatNotificationSourceLabel('finance-manager')).toBe('Tyrion');
    expect(formatNotificationSourceLabel('invented-source')).toBe('Invented Source');
  });
});
