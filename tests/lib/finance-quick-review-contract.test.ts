import { describe, expect, it } from 'vitest';
import {
  financeReviewActionRequestSchema,
  financeMerchantRuleCreateRequestSchema,
  financeVendorResearchRequestSchema,
  tyrionMerchantRuleCreateRequestSchema,
  tyrionQuickReviewRuleResponseSchema,
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

  it('requires explicit global confirmation without accepting account references from the browser', () => {
    const request = {
      contractVersion: '2.1',
      sessionRef: 'session_ref_123456789',
      resumeToken: 'resume_token_123456789',
      reviewRef: 'review_ref_1234567890',
      stateToken: 'state_token_123456789',
      idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
      confirmation: {
        confirmed: true,
        confirmedAt: '2026-10-09T20:00:00.000-04:00',
        globalScopeConfirmed: false,
      },
      rule: {
        outcome: 'review',
        kidId: null,
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        statementDescriptorPattern: null,
        locationPredicate: null,
        scope: 'global',
        confidence: 'likely',
      },
      locationOnlyConfirmation: null,
    };
    expect(financeMerchantRuleCreateRequestSchema.safeParse(request).success).toBe(false);
    expect(financeMerchantRuleCreateRequestSchema.safeParse({
      ...request,
      confirmation: { ...request.confirmation, globalScopeConfirmed: true },
      rule: { ...request.rule, accountRefs: ['browser-controlled-account'] },
    }).success).toBe(false);
  });

  it('enforces Tyrion merchant rule outcome and scope invariants', () => {
    const base = {
      contractVersion: '2.1',
      expectedPolicyVersion: 7,
      idempotencyKey: 'merchant-rule-safe-key',
      confirmation: { confirmed: true, confirmedAt: '2026-10-09T20:00:00.000-04:00' },
      locationOnlyConfirmation: null,
      rule: {
        outcome: 'kid',
        kidId: 'kid-alex',
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        statementDescriptorPattern: null,
        locationPredicate: null,
        scope: 'accounts',
        accountRefs: ['account-current'],
        confidence: 'likely',
      },
    };
    expect(tyrionMerchantRuleCreateRequestSchema.safeParse(base).success).toBe(true);
    expect(tyrionMerchantRuleCreateRequestSchema.safeParse({
      ...base,
      rule: { ...base.rule, scope: 'global', accountRefs: ['account-current'] },
    }).success).toBe(false);
    expect(tyrionMerchantRuleCreateRequestSchema.safeParse({
      ...base,
      rule: { ...base.rule, outcome: 'review', kidId: 'kid-alex' },
    }).success).toBe(false);
  });

  it('requires the server-owned policy version on rule suggestions', () => {
    const response = {
      contractVersion: '1.0',
      policyVersion: 7,
      suggestion: {
        kind: 'merchant',
        merchantPattern: 'INVENTED MARKET',
        businessEntityPattern: 'INVENTED MARKET HOLDINGS',
        statementDescriptorPattern: null,
        locationPredicate: null,
        outcome: 'kid',
        scope: 'accounts',
        accountRefs: ['account-current'],
        kidId: 'kid-alex',
        confidence: 'likely',
        requiresConfirmation: true,
        requiresLocationOnlyConfirmation: false,
      },
    };
    expect(tyrionQuickReviewRuleResponseSchema.safeParse(response).success).toBe(true);
    const missingPolicyVersion = Object.fromEntries(
      Object.entries(response).filter(([key]) => key !== 'policyVersion'),
    );
    expect(tyrionQuickReviewRuleResponseSchema.safeParse(missingPolicyVersion).success).toBe(false);
  });

  it('requires a separate fresh confirmation for location-only rules', () => {
    const request = {
      contractVersion: '2.1',
      expectedPolicyVersion: 7,
      idempotencyKey: 'location-rule-safe-key',
      confirmation: { confirmed: true, confirmedAt: '2026-10-18T20:00:00.000-04:00' },
      locationOnlyConfirmation: null,
      rule: {
        outcome: 'kid',
        kidId: 'kid-alex',
        pattern: null,
        businessEntityPattern: null,
        statementDescriptorPattern: null,
        locationPredicate: {
          countryCode: 'US',
          region: 'NJ',
          locality: null,
          minimumConfidence: 0.7,
        },
        scope: 'accounts',
        accountRefs: ['account-current'],
        confidence: 'likely',
      },
    };
    expect(tyrionMerchantRuleCreateRequestSchema.safeParse(request).success).toBe(false);
    expect(tyrionMerchantRuleCreateRequestSchema.safeParse({
      ...request,
      locationOnlyConfirmation: {
        confirmed: true,
        confirmedAt: '2026-10-18T20:00:01.000-04:00',
      },
    }).success).toBe(true);
  });
});
