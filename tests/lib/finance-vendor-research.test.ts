import { describe, expect, it, vi } from 'vitest';
import {
  enforceVendorResearchPolicy,
  researchVendor,
  VendorResearchError,
  type VendorResearchProvider,
} from '@/lib/finance/vendor-research';

const prepared = {
  contractVersion: '1.0',
  query: {
    vendorName: 'Invented Market',
    coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
    amount: null,
    occurredOn: null,
  },
  outputPolicy: {
    factsRequireSources: true,
    inferencesMustBeLabeled: true,
    fraudAssertionAllowed: false,
  },
} as const;

const providerResult = {
  output: {
    facts: [{
      statement: 'Invented Market publishes a Seattle location.',
      confidence: 0.95,
      sourceUrls: ['https://example.test/invented-market'],
    }],
    inferences: [{
      statement: 'The merchant may sell household goods.',
      confidence: 0.55,
      sourceUrls: ['https://example.test/invented-market'],
    }],
    suggestions: {
      businessIdentity: 'Invented Market LLC',
      location: 'Seattle, WA',
      businessType: 'Retail',
      plausiblePurchase: 'Household goods',
      category: 'Shopping',
      kidsClues: [],
    },
    riskIndicators: [{
      detail: 'The location differs from the expected region.',
      confidence: 0.4,
    }],
  },
  sources: [{
    url: 'https://example.test/invented-market',
    title: 'Invented Market locations',
  }],
};

describe('finance vendor research', () => {
  it('uses only Tyrion-prepared query data and returns bounded citations', async () => {
    const provider: VendorResearchProvider = {
      research: vi.fn().mockResolvedValue(providerResult),
    };
    const result = await researchVendor({
      reviewRef: 'review_ref_1234567890',
      prepared,
      provider,
      clock: () => new Date('2026-10-08T21:00:00.000Z'),
    });

    expect(provider.research).toHaveBeenCalledWith(prepared, undefined);
    expect(result.facts[0]).toMatchObject({
      sourceIds: ['source-1'],
      statement: 'Invented Market publishes a Seattle location.',
    });
    expect(result.inferences[0].statement).toContain('may');
    expect(result.riskIndicators[0].label).toBe('Needs investigation');
    expect(result.sources[0]).toMatchObject({
      url: 'https://example.test/invented-market',
      publisher: 'example.test',
    });
  });

  it('rejects facts whose citations were not returned by web search', () => {
    expect(() => enforceVendorResearchPolicy({
      reviewRef: 'review_ref_1234567890',
      researchedAt: '2026-10-08T21:00:00.000Z',
      prepared,
      providerResult: {
        ...providerResult,
        sources: [],
      },
    })).toThrowError(expect.objectContaining({
      code: 'vendor_research_policy_violation',
    }) as VendorResearchError);
  });

  it('rejects any provider output that asserts fraud', () => {
    expect(() => enforceVendorResearchPolicy({
      reviewRef: 'review_ref_1234567890',
      researchedAt: '2026-10-08T21:00:00.000Z',
      prepared,
      providerResult: {
        ...providerResult,
        output: {
          ...providerResult.output,
          riskIndicators: [{
            detail: 'This is a fraudulent merchant.',
            confidence: 0.8,
          }],
        },
      },
    })).toThrowError(expect.objectContaining({
      code: 'vendor_research_policy_violation',
    }) as VendorResearchError);
  });

  it.each([
    'This appears to be theft.',
    'The transaction was unauthorized.',
    'Possible card compromise.',
    'This merchant runs scams.',
  ])('rejects prohibited assertion wording: %s', (detail) => {
    expect(() => enforceVendorResearchPolicy({
      reviewRef: 'review_ref_1234567890',
      researchedAt: '2026-10-08T21:00:00.000Z',
      prepared,
      providerResult: {
        ...providerResult,
        output: {
          ...providerResult.output,
          riskIndicators: [{ detail, confidence: 0.5 }],
        },
      },
    })).toThrowError(expect.objectContaining({
      code: 'vendor_research_policy_violation',
    }) as VendorResearchError);
  });
});
