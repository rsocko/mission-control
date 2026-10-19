import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  getAsyncAIModel: vi.fn(),
  prepareDescriptorInference: vi.fn(),
}));

vi.mock('ai', () => ({ generateObject: mocks.generateObject }));
vi.mock('@/lib/ai/provider-runtime', () => ({
  getAsyncAIModel: mocks.getAsyncAIModel,
}));
vi.mock('@/lib/connectors/monarch-money/quick-review-client', () => ({
  resolveTyrionQuickReviewToken: () => 'test-token',
  TyrionFinanceReviewClient: class {
    prepareDescriptorInference = mocks.prepareDescriptorInference;
  },
}));

import {
  enrichTransactionsWithLocationEvidence,
  inferTransactionLocation,
} from '@/lib/finance/location-inference';
import { AI_FEATURE_DEFAULTS } from '@/lib/ai/sensitivity-policy';
import type { FinanceSnapshotPersistence } from '@/db/persistence/finance-snapshot';
import type { MonarchTransaction } from '@/lib/connectors/monarch-money/client';
import type { ConnectorConfig } from '@/types';
import { descriptorEvidenceFingerprint } from '@/lib/finance/transaction-evidence';

const config = { id: 'finance-test' } as ConnectorConfig;
const transaction = {
  id: 'tx-1',
  date: '2026-10-18',
  amount: -42,
  merchant: { name: 'Invented Market', logoUrl: null },
  businessEntityName: null,
  statementDescriptors: [{
    kind: 'statement',
    text: ' INVENTED MARKET PRINCETON NJ ',
    source: { system: 'monarch', field: 'plaidName' },
  }],
  category: null,
  account: { id: 'account-1', displayName: 'Invented card', mask: null },
  isPending: false,
  isRecurring: false,
  notes: null,
  tags: [],
  tagReferences: [],
  reviewStatus: 'reviewed',
} satisfies MonarchTransaction;

describe('finance location inference', () => {
  it('is restricted to private provider routes', () => {
    expect(AI_FEATURE_DEFAULTS['finance-location-inference']).toBe('restricted');
  });

  it('reuses fresh evidence for the same exact descriptor fingerprint', async () => {
    const infer = vi.fn();
    const persistence = {
      readLocationEvidence: vi.fn(async () => new Map([['tx-1', {
        inputFingerprint: descriptorEvidenceFingerprint(transaction.statementDescriptors),
        evidence: {
          countryCode: 'US',
          region: 'NJ',
          locality: 'Princeton',
          confidence: 0.9,
          sourceKind: 'private-ai-inference',
          model: 'private-model',
          modelVersion: 'provider:azure',
          evaluatedAt: '2026-10-17T12:00:00.000Z',
          staleAfter: '2027-01-15T12:00:00.000Z',
        },
        inferenceEvidence: 'Descriptor contains Princeton NJ.',
        errorCode: null,
      }]])),
    } as unknown as FinanceSnapshotPersistence;

    const result = await enrichTransactionsWithLocationEvidence({
      connectorId: config.id,
      config,
      transactions: [transaction],
      persistence,
      now: new Date('2026-10-18T12:00:00.000Z'),
      infer,
    });

    expect(infer).not.toHaveBeenCalled();
    expect(result[0]?.locationEvidence).toMatchObject({ region: 'NJ', locality: 'Princeton' });
  });

  it('routes exact descriptors through private structured inference with provenance', async () => {
    mocks.prepareDescriptorInference.mockResolvedValueOnce({
      contractVersion: '1.0',
      statementDescriptors: [{
        kind: 'statement',
        text: ' INVENTED MARKET PRINCETON NJ ',
        source: 'monarch',
      }],
    });
    mocks.getAsyncAIModel.mockResolvedValueOnce({
      model: { modelId: 'private-model' },
      configured: { provider: 'azure', model: 'private-model' },
    });
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        countryCode: 'us',
        region: 'nj',
        locality: 'Princeton',
        confidence: 0.88,
        evidence: 'Descriptor contains Princeton NJ.',
      },
    });

    const result = await inferTransactionLocation(
      config,
      transaction,
      new Date('2026-10-18T12:00:00.000Z'),
    );

    expect(mocks.getAsyncAIModel).toHaveBeenCalledWith(
      'finance-location-inference',
      {
        sources: ['monarch-money'],
        sensitivityOverride: 'restricted',
      },
    );
    expect(mocks.prepareDescriptorInference).toHaveBeenCalledWith({
      contractVersion: '1.0',
      statementDescriptors: [{
        kind: 'statement',
        text: ' INVENTED MARKET PRINCETON NJ ',
        source: 'monarch',
      }],
    }, undefined);
    expect(mocks.generateObject).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(' INVENTED MARKET PRINCETON NJ '),
      maxRetries: 1,
    }));
    expect(result).toEqual({
      evidence: {
        countryCode: 'US',
        region: 'NJ',
        locality: 'Princeton',
        confidence: 0.88,
        sourceKind: 'private-ai-inference',
        model: 'private-model',
        modelVersion: 'provider:azure',
        evaluatedAt: '2026-10-18T12:00:00.000Z',
        staleAfter: '2027-01-16T12:00:00.000Z',
      },
      inferenceEvidence: 'Descriptor contains Princeton NJ.',
      errorCode: null,
    });
  });

  it('does not invent a location from uncertain structured output', async () => {
    mocks.prepareDescriptorInference.mockResolvedValueOnce({
      contractVersion: '1.0',
      statementDescriptors: [],
    });
    mocks.getAsyncAIModel.mockResolvedValueOnce({
      model: { modelId: 'private-model' },
      configured: { provider: 'ollama', model: 'private-model' },
    });
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        countryCode: null,
        region: null,
        locality: null,
        confidence: 0.2,
        evidence: 'Descriptor is ambiguous.',
      },
    });

    await expect(inferTransactionLocation(
      config,
      transaction,
      new Date('2026-10-18T12:00:00.000Z'),
    )).resolves.toEqual({
      evidence: null,
      inferenceEvidence: 'Descriptor is ambiguous.',
      errorCode: 'location_inference_uncertain',
    });
  });

  it('paces historical inference and advances deferred evidence on the next sync', async () => {
    const transactions = Array.from({ length: 20 }, (_, index): MonarchTransaction => ({
      ...transaction,
      id: `tx-${index}`,
      statementDescriptors: [{
        ...transaction.statementDescriptors[0],
        text: ` INVENTED MARKET ${index} NJ `,
      }],
    }));
    const infer = vi.fn(async () => ({
      evidence: {
        countryCode: 'US',
        region: 'NJ',
        locality: null,
        confidence: 0.8,
        sourceKind: 'private-ai-inference' as const,
        model: 'private-model',
        modelVersion: 'provider:azure',
        evaluatedAt: '2026-10-18T12:00:00.000Z',
        staleAfter: '2027-01-16T12:00:00.000Z',
      },
      inferenceEvidence: 'Descriptor contains NJ.',
      errorCode: null,
    }));
    const first = await enrichTransactionsWithLocationEvidence({
      connectorId: config.id,
      config,
      transactions,
      persistence: {
        readLocationEvidence: vi.fn(async () => new Map()),
      } as unknown as FinanceSnapshotPersistence,
      now: new Date('2026-10-18T12:00:00.000Z'),
      infer,
    });

    expect(infer).toHaveBeenCalledTimes(16);
    expect(first.slice(16)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        locationEvidenceInputFingerprint: null,
        locationInferenceErrorCode: 'location_inference_unavailable',
      }),
    ]));

    infer.mockClear();
    const prior = new Map(first.map((result) => [result.id, {
      inputFingerprint: result.locationEvidenceInputFingerprint ?? null,
      evidence: result.locationEvidence ?? null,
      inferenceEvidence: result.locationInferenceEvidence ?? null,
      errorCode: result.locationInferenceErrorCode ?? null,
    }]));
    await enrichTransactionsWithLocationEvidence({
      connectorId: config.id,
      config,
      transactions,
      persistence: {
        readLocationEvidence: vi.fn(async () => prior),
      } as unknown as FinanceSnapshotPersistence,
      now: new Date('2026-10-19T12:00:00.000Z'),
      infer,
    });

    expect(infer).toHaveBeenCalledTimes(4);
    expect(infer.mock.calls.map(([called]) => called.id)).toEqual([
      'tx-16',
      'tx-17',
      'tx-18',
      'tx-19',
    ]);
  });

  it('fails safely without blocking synchronization when inference is unavailable', async () => {
    const persistence = {
      readLocationEvidence: vi.fn(async () => new Map()),
    } as unknown as FinanceSnapshotPersistence;
    const result = await enrichTransactionsWithLocationEvidence({
      connectorId: config.id,
      config,
      transactions: [transaction],
      persistence,
      infer: vi.fn(async () => ({
        evidence: null,
        inferenceEvidence: null,
        errorCode: 'location_inference_unavailable',
      })),
    });

    expect(result[0]).toMatchObject({
      id: 'tx-1',
      locationEvidence: null,
      locationInferenceErrorCode: 'location_inference_unavailable',
    });
  });
});
