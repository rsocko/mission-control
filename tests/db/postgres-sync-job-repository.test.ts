import { describe, expect, it } from 'vitest';
import {
  buildExclusionClause,
  computeRetryAvailableAt,
  deserializeJob,
  failedResult,
} from '@/db/postgres/sync/job-repository';
import {
  connectorSyncLeaseOwner,
  escapeLikePattern,
  getConnectorOperationLeaseMs,
} from '@/db/postgres/sync/lease-helpers';

describe('PostgreSQL sync job repository — pure helpers', () => {
  describe('buildExclusionClause', () => {
    it('returns an empty clause for no exclusions', () => {
      expect(buildExclusionClause(new Set(), 2)).toEqual({ clause: '', params: [] });
    });

    it('builds a parameterized NOT IN clause starting at the given index', () => {
      const result = buildExclusionClause(new Set(['a', 'b', 'c']), 3);
      expect(result.clause).toBe('AND connector_id NOT IN ($3, $4, $5)');
      expect(result.params).toEqual(['a', 'b', 'c']);
    });

    it('matches claimNext\'s query, which only binds $1 before the exclusion clause', () => {
      // claimNext's candidate SELECT has exactly one preceding placeholder
      // ($1 = nowIso), so the exclusion clause must start at $2. A prior
      // regression called this with startIndex 3, which either threw a
      // parameter-count mismatch or silently mis-bound values.
      const result = buildExclusionClause(new Set(['connector-1']), 2);
      expect(result.clause).toBe('AND connector_id NOT IN ($2)');
      expect(result.params).toEqual(['connector-1']);
    });
  });

  describe('computeRetryAvailableAt', () => {
    it('applies exponential backoff based on attempt count', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(computeRetryAvailableAt(now, 1, 1000)).toBe('2026-01-01T00:00:01.000Z');
      expect(computeRetryAvailableAt(now, 2, 1000)).toBe('2026-01-01T00:00:02.000Z');
      expect(computeRetryAvailableAt(now, 3, 1000)).toBe('2026-01-01T00:00:04.000Z');
    });

    it('caps the delay at 15 minutes', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const result = computeRetryAvailableAt(now, 20, 60_000);
      expect(new Date(result).getTime() - now.getTime()).toBe(15 * 60_000);
    });

    it('never applies a negative attempt exponent', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(computeRetryAvailableAt(now, 0, 1000)).toBe('2026-01-01T00:00:01.000Z');
    });
  });

  describe('deserializeJob', () => {
    it('passes rows through unchanged (jsonb result is already deserialized)', () => {
      const row = {
        id: 'job-1',
        connectorId: 'connector-1',
        full: true,
        source: 'api' as const,
        status: 'succeeded' as const,
        attempt: 1,
        maxAttempts: 3,
        availableAt: '2026-01-01T00:00:00.000Z',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        leaseOwner: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:05.000Z',
        result: { connectorId: 'connector-1', success: true, tasksAdded: 1, tasksUpdated: 0, tasksRemoved: 0, notificationsAdded: 0, errors: [], syncedAt: '2026-01-01T00:00:05.000Z' },
        error: null,
        durationBudgetMs: 300_000,
        identityMode: null,
        identityModeRevision: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
      };
      expect(deserializeJob(row)).toEqual(row);
    });
  });

  describe('failedResult', () => {
    it('builds a failed SyncResult with the given error message', () => {
      const result = failedResult('connector-1', 'boom');
      expect(result).toMatchObject({
        connectorId: 'connector-1',
        success: false,
        errors: ['boom'],
      });
      expect(typeof result.syncedAt).toBe('string');
    });
  });
});

describe('PostgreSQL connector-operation lease helpers', () => {
  it('scopes sync lease owners by job id and worker owner', () => {
    expect(connectorSyncLeaseOwner('job-1', 'worker-a')).toBe('sync:job-1:worker-a');
  });

  it('escapes LIKE metacharacters so a job id cannot widen the match', () => {
    expect(escapeLikePattern('job_1%weird\\value')).toBe('job\\_1\\%weird\\\\value');
  });

  it('falls back to a sane default lease duration', () => {
    const original = process.env.MC_CONNECTOR_OPERATION_LEASE_MS;
    delete process.env.MC_CONNECTOR_OPERATION_LEASE_MS;
    try {
      expect(getConnectorOperationLeaseMs()).toBe(120_000);
    } finally {
      if (original === undefined) delete process.env.MC_CONNECTOR_OPERATION_LEASE_MS;
      else process.env.MC_CONNECTOR_OPERATION_LEASE_MS = original;
    }
  });

  it('rejects a non-positive configured lease duration', () => {
    const original = process.env.MC_CONNECTOR_OPERATION_LEASE_MS;
    process.env.MC_CONNECTOR_OPERATION_LEASE_MS = '-5';
    try {
      expect(getConnectorOperationLeaseMs()).toBe(120_000);
    } finally {
      if (original === undefined) delete process.env.MC_CONNECTOR_OPERATION_LEASE_MS;
      else process.env.MC_CONNECTOR_OPERATION_LEASE_MS = original;
    }
  });
});
