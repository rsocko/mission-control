import { beforeEach, describe, expect, it, vi } from 'vitest';

const add = vi.fn();
const record = vi.fn();

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add }),
      createHistogram: () => ({ record }),
    }),
  },
}));

describe('ingestion telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records low-cardinality accepted byte and duration attributes', async () => {
    const { recordIngestionOutcome } = await import('@/lib/ingestion/telemetry');

    recordIngestionOutcome({
      source: 'remote-document',
      outcome: 'accepted',
      bytes: 42,
      durationMs: 12,
    });

    const attributes = {
      'mc.ingestion.source': 'remote-document',
      'mc.ingestion.outcome': 'accepted',
      'mc.ingestion.reason': 'none',
    };
    expect(add).toHaveBeenNthCalledWith(1, 1, attributes);
    expect(add).toHaveBeenNthCalledWith(2, 42, attributes);
    expect(record).toHaveBeenCalledWith(12, attributes);
  });

  it('classifies fixed rejection reasons without including error messages', async () => {
    const {
      ingestionRejectionReason,
      recordIngestionOutcome,
    } = await import('@/lib/ingestion/telemetry');
    const { IngestionLimitError } = await import('@/lib/ingestion/bounded-reader');
    const reason = ingestionRejectionReason(new IngestionLimitError('sensitive path', 1, 2));

    recordIngestionOutcome({
      source: 'local-file',
      outcome: 'rejected',
      bytes: 2,
      durationMs: 3,
      reason,
    });

    expect(reason).toBe('limit');
    expect(add).toHaveBeenCalledWith(1, expect.objectContaining({
      'mc.ingestion.reason': 'limit',
    }));
    expect(JSON.stringify(add.mock.calls)).not.toContain('sensitive path');
  });
});
