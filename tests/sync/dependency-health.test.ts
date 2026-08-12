import { describe, expect, it } from 'vitest';
import { getDependencyRelationshipDegradation } from '@/lib/sync/dependency-health';
import type { DependencyReconciliationProgress } from '@/lib/sync/task-dependency-manager';

function progress(
  overrides: Partial<DependencyReconciliationProgress> = {},
): DependencyReconciliationProgress {
  return {
    generationId: 'generation-1',
    status: 'completed',
    phase: 'completed',
    readMode: 'graphql-bulk',
    processed: 10,
    total: 10,
    batchSize: 25,
    imported: 1,
    removed: 0,
    startedAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:01:00.000Z',
    completedAt: '2026-08-09T00:01:00.000Z',
    collectionCompletedAt: '2026-08-09T00:00:30.000Z',
    collectionPageCount: 2,
    overflowFetchCount: 1,
    edgeCount: 3,
    durationMs: 60_000,
    failureReason: null,
    nextAttemptAt: null,
    lastCompletedAt: '2026-08-09T00:01:00.000Z',
    lastResumeAttemptAt: null,
    lastResumeOutcome: null,
    lastResumeReason: null,
    collectionPhase: 'complete',
    reconciliationPhase: 'complete',
    latestTerminalOutcome: 'completed',
    consecutiveFailedGenerationCount: 0,
    lastCompletedGeneration: null,
    ...overrides,
  };
}

describe('GitHub dependency relationship health', () => {
  const now = Date.parse('2026-08-09T01:00:00.000Z');
  const staleAfterMs = 2 * 60 * 60_000;

  it('keeps a recent complete generation healthy', () => {
    expect(getDependencyRelationshipDegradation(progress(), staleAfterMs, now)).toBeNull();
  });

  it('degrades missing and stale relationship verification', () => {
    expect(getDependencyRelationshipDegradation(undefined, staleAfterMs, now))
      .toBe('GitHub relationship verification is stale');
    expect(getDependencyRelationshipDegradation(progress({
      lastCompletedAt: '2026-08-08T00:00:00.000Z',
    }), staleAfterMs, now)).toBe('GitHub relationship verification is stale');
  });

  it('reports partial and repeated failures ahead of age', () => {
    expect(getDependencyRelationshipDegradation(progress({
      latestTerminalOutcome: 'partial',
      consecutiveFailedGenerationCount: 3,
    }), staleAfterMs, now)).toBe('Latest GitHub relationship poll was partial');
    expect(getDependencyRelationshipDegradation(progress({
      latestTerminalOutcome: 'failed',
      consecutiveFailedGenerationCount: 2,
    }), staleAfterMs, now)).toBe('GitHub relationship polling is repeatedly failing');
  });
});
