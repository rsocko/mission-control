import { describe, expect, it, vi } from 'vitest';
import {
  assertQuickReviewCategoryCorrectionSupported,
  merchantNameForRank,
  runExclusiveQuickReviewAction,
  runQuickReviewWriteSequence,
} from '@/lib/finance/quick-review-service';

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

  it('joins duplicate in-flight actions and rejects a competing action', async () => {
    const completed = new Map<string, string>();
    const pending = new Map<string, Promise<string>>();
    let active = false;
    let resolveOperation!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => {
      resolveOperation = resolve;
    }));
    const run = (idempotencyKey: string) => runExclusiveQuickReviewAction({
      idempotencyKey,
      completed,
      pending,
      isActive: () => active,
      setActive: (value) => { active = value; },
      operation,
    });

    const first = run('same-key');
    const duplicate = run('same-key');
    await expect(run('different-key')).rejects.toMatchObject({
      code: 'review_action_in_progress',
      status: 409,
    });
    resolveOperation('done');

    await expect(first).resolves.toBe('done');
    await expect(duplicate).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('uses a neutral contract-safe merchant name for blank merchants', () => {
    expect(merchantNameForRank('   ')).toBe('Unknown merchant');
    expect(merchantNameForRank(' Invented Market ')).toBe('Invented Market');
  });

  it('rejects unsupported removal of an existing Monarch category', () => {
    expect(() => assertQuickReviewCategoryCorrectionSupported(
      null,
      'category-groceries',
    )).toThrowError(expect.objectContaining({
      code: 'category_removal_unavailable',
      status: 422,
    }));
    expect(() => assertQuickReviewCategoryCorrectionSupported(
      null,
      null,
    )).not.toThrow();
  });
});
