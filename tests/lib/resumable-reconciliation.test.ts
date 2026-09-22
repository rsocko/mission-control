import { describe, expect, it, vi } from 'vitest';
import {
  exponentialRetryDelay,
  runResumableReconciliation,
  type ReconciliationFailure,
  type ResumableReconciliationSnapshot,
} from '@/lib/reconciliation';

interface TestSnapshot extends ResumableReconciliationSnapshot {
  id: string;
}

function snapshot(overrides: Partial<TestSnapshot> = {}): TestSnapshot {
  return {
    id: 'generation-1',
    status: 'running',
    cursor: 0,
    total: 5,
    batchSize: 2,
    failureCount: 0,
    nextAttemptAt: null,
    ...overrides,
  };
}

function adapter(options: {
  initial?: TestSnapshot;
  failAt?: number;
  continue?: boolean;
  partialOnAdvance?: boolean;
  partialOnComplete?: boolean;
  advanceTo?: number;
} = {}) {
  const progress: Array<{ phase: string; cursor: number }> = [];
  const failures: ReconciliationFailure[] = [];
  return {
    progress,
    failures,
    implementation: {
      createSnapshot: vi.fn(async () => options.initial ?? snapshot()),
      loadBatch: vi.fn(async (_current: TestSnapshot, window: { start: number; end: number }) =>
        Array.from({ length: window.end - window.start }, (_, index) => window.start + index)),
      executeBatch: vi.fn(async (
        _current: TestSnapshot,
        batch: number[],
        window: { start: number },
      ) => {
        if (options.failAt === window.start) throw new Error('synthetic failure');
        return batch;
      }),
      advanceCursor: vi.fn(async (
        current: TestSnapshot,
        _result: number[],
        window: { end: number },
      ) => ({
        ...current,
        status: options.partialOnAdvance ? 'partial' as const : 'running' as const,
        cursor: options.partialOnAdvance
          ? current.cursor
          : options.advanceTo ?? window.end,
        failureCount: 0,
        nextAttemptAt: null,
      })),
      classifyRetry: vi.fn(() => ({ retryable: true })),
      recordFailure: vi.fn(async (
        current: TestSnapshot,
        failure: ReconciliationFailure,
      ) => {
        failures.push(failure);
        return {
          ...current,
          status: 'failed' as const,
          failureCount: failure.failureCount,
          nextAttemptAt: failure.nextAttemptAt,
        };
      }),
      reportProgress: (current: TestSnapshot) => ({
        generationId: current.id,
        processed: current.cursor,
        total: current.total,
        status: current.status,
      }),
      complete: vi.fn(async (current: TestSnapshot) => ({
        snapshot: {
          ...current,
          status: options.partialOnComplete ? 'partial' as const : 'completed' as const,
        },
        result: { processed: current.cursor },
      })),
      shouldContinue: () => options.continue === true,
      onProgress: ({ phase, progress: current }: {
        phase: string;
        progress: { processed: number };
      }) => {
        progress.push({ phase, cursor: current.processed });
      },
    },
  };
}

describe('resumable reconciliation engine', () => {
  it('owns deterministic cursor windows, progress, and completion', async () => {
    const test = adapter({ continue: true });
    const result = await runResumableReconciliation(test.implementation, {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      snapshot: { cursor: 5, status: 'completed' },
      completion: { processed: 5 },
    });
    expect(test.implementation.loadBatch.mock.calls.map((call) => call[1])).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
    expect(test.progress).toEqual([
      { phase: 'ready', cursor: 0 },
      { phase: 'advanced', cursor: 2 },
      { phase: 'advanced', cursor: 4 },
      { phase: 'advanced', cursor: 5 },
      { phase: 'completed', cursor: 5 },
    ]);
  });

  it('resumes from a persisted cursor after restart', async () => {
    const test = adapter();
    const result = await runResumableReconciliation(test.implementation, {
      snapshot: snapshot({ cursor: 2 }),
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: 'running',
      snapshot: { id: 'generation-1', cursor: 4 },
    });
    expect(test.implementation.createSnapshot).not.toHaveBeenCalled();
    expect(test.implementation.loadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 2 }),
      { start: 2, end: 4 },
    );
  });

  it('accepts a persisted cursor advanced by a concurrent worker', async () => {
    const test = adapter({ advanceTo: 4 });
    const result = await runResumableReconciliation(test.implementation, {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: 'running',
      snapshot: { cursor: 4 },
    });
    expect(test.failures).toHaveLength(0);
  });

  it('records retryable partial failures without advancing the cursor', async () => {
    const test = adapter({ failAt: 2 });
    const now = new Date('2026-08-05T12:00:00.000Z');

    await expect(runResumableReconciliation(test.implementation, {
      snapshot: snapshot({ cursor: 2, failureCount: 1 }),
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      now: () => now,
    })).rejects.toThrow('synthetic failure');

    expect(test.failures).toEqual([
      expect.objectContaining({
        failureCount: 2,
        failedAt: now.toISOString(),
        nextAttemptAt: '2026-08-05T12:00:00.200Z',
      }),
    ]);
    expect(test.implementation.advanceCursor).not.toHaveBeenCalled();
    expect(test.progress.at(-1)).toEqual({ phase: 'failed', cursor: 2 });
  });

  it('defers retries until the persisted backoff expires', async () => {
    const test = adapter();
    const result = await runResumableReconciliation(test.implementation, {
      snapshot: snapshot({
        status: 'failed',
        cursor: 2,
        nextAttemptAt: '2026-08-05T12:00:01.000Z',
      }),
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    });

    expect(result.outcome).toBe('deferred');
    expect(test.implementation.loadBatch).not.toHaveBeenCalled();
    expect(test.progress).toEqual([
      { phase: 'ready', cursor: 2 },
      { phase: 'deferred', cursor: 2 },
    ]);
  });

  it('preserves a domain-specific partial completion result', async () => {
    const test = adapter({
      initial: snapshot({ total: 0 }),
      partialOnComplete: true,
    });

    const result = await runResumableReconciliation(test.implementation, {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      snapshot: { status: 'partial', cursor: 0, total: 0 },
      completion: { processed: 0 },
    });
    expect(test.progress.at(-1)).toEqual({ phase: 'completed', cursor: 0 });
  });

  it('stops when a domain atomically fences a batch as partial', async () => {
    const test = adapter({ partialOnAdvance: true });

    const result = await runResumableReconciliation(test.implementation, {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: 'terminal',
      snapshot: { status: 'partial', cursor: 0 },
    });
    expect(test.implementation.complete).not.toHaveBeenCalled();
    expect(test.progress.at(-1)).toEqual({ phase: 'terminal', cursor: 0 });
  });

  it('caps exponential backoff deterministically', () => {
    expect(exponentialRetryDelay(1, 100, 350)).toBe(100);
    expect(exponentialRetryDelay(2, 100, 350)).toBe(200);
    expect(exponentialRetryDelay(3, 100, 350)).toBe(350);
    expect(exponentialRetryDelay(8, 100, 350)).toBe(350);
  });
});
