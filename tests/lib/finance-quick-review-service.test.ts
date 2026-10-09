import { describe, expect, it, vi } from 'vitest';
import { runQuickReviewWriteSequence } from '@/lib/finance/quick-review-service';

describe('finance quick review write sequence', () => {
  it('verifies every correction before marking Monarch reviewed', async () => {
    const order: string[] = [];
    await runQuickReviewWriteSequence({
      updateCategory: vi.fn(async () => { order.push('category'); }),
      updateMerchant: vi.fn(async () => { order.push('merchant'); }),
      updateKidAttribution: vi.fn(async () => { order.push('kid'); }),
      markReviewed: vi.fn(async () => { order.push('reviewed'); }),
    });

    expect(order).toEqual(['category', 'merchant', 'kid', 'reviewed']);
  });

  it('does not mark reviewed when a required correction fails', async () => {
    const markReviewed = vi.fn();
    await expect(runQuickReviewWriteSequence({
      updateCategory: vi.fn(async () => undefined),
      updateMerchant: vi.fn(async () => {
        throw new Error('merchant write failed');
      }),
      updateKidAttribution: vi.fn(async () => undefined),
      markReviewed,
    })).rejects.toThrow('merchant write failed');

    expect(markReviewed).not.toHaveBeenCalled();
  });
});
