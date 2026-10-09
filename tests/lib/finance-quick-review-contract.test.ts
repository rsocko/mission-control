import { describe, expect, it } from 'vitest';
import {
  financeReviewActionRequestSchema,
  financeVendorResearchRequestSchema,
} from '@/lib/finance/quick-review-contract';

const baseAction = {
  contractVersion: '1.0',
  sessionRef: 'session_ref_123456789',
  resumeToken: 'resume_token_123456789',
  reviewRef: 'review_ref_1234567890',
  stateToken: 'state_token_123456789',
  idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
  correction: null,
};

describe('finance quick review contract', () => {
  it('keeps skipped items unchanged in Monarch and marks confirmed items reviewed', () => {
    expect(financeReviewActionRequestSchema.safeParse({
      ...baseAction,
      action: 'skip',
      monarchReviewOutcome: 'unchanged',
    }).success).toBe(true);
    expect(financeReviewActionRequestSchema.safeParse({
      ...baseAction,
      action: 'skip',
      monarchReviewOutcome: 'reviewed',
    }).success).toBe(false);
    expect(financeReviewActionRequestSchema.safeParse({
      ...baseAction,
      action: 'confirm',
      monarchReviewOutcome: 'reviewed',
    }).success).toBe(true);
  });

  it('rejects amount or date research context without explicit approval', () => {
    const result = financeVendorResearchRequestSchema.safeParse({
      contractVersion: '1.0',
      sessionRef: 'session_ref_123456789',
      resumeToken: 'resume_token_123456789',
      reviewRef: 'review_ref_1234567890',
      stateToken: 'state_token_123456789',
      request: null,
      publicContext: {
        normalizedVendorName: 'Invented Market',
        coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
        amount: 184.62,
        date: '2026-10-08',
        sensitiveContextApproved: false,
      },
    });
    expect(result.success).toBe(false);
  });
});
