import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundedIdentifier,
  buildDurableAiCompareAndSetConditions,
  buildDurableAiRunHistoryConditions,
  computeDurableAiRetryAvailableAt,
  deserializeInternalDurableAiRun,
  durableAiRequestFingerprint,
  durableAiRetentionDays,
  normalizeDurableAiExecutionState,
  positiveInteger,
  resolveDurableAiTraceparent,
  toPublicDurableAiRun,
} from '@/lib/ai/durable-runs/postgres-adapter';

const ADAPTER_PATH = path.resolve(
  __dirname,
  '../../src/lib/ai/durable-runs/postgres-adapter.ts',
);

function internalRun() {
  return deserializeInternalDurableAiRun({
    id: 'run-1',
    idempotencyKey: 'feature:run-1',
    requestFingerprint: 'fingerprint',
    featureId: 'durable-test',
    sensitivity: 'standard',
    status: 'running',
    executionRoute: 'test-route',
    requestedProvider: 'bifrost',
    requestedModel: 'azure/gpt-4o-mini',
    provider: null,
    model: null,
    fallbackState: 'not_requested',
    correlationId: 'correlation-1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    tracestate: null,
    attempt: 1,
    maxAttempts: 3,
    availableAt: '2026-01-01T00:00:00.000Z',
    timeoutAt: '2026-01-01T00:15:00.000Z',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-01-01T00:02:00.000Z',
    cancelRequestedAt: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    notifyOnCompletion: true,
    cleanupStatus: 'none',
    executionState: { state: 'active', ownerId: 'worker-a' },
    revision: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-31T00:00:00.000Z',
  });
}

describe('PostgreSQL durable AI run repository — pure helpers', () => {
  describe('buildDurableAiRunHistoryConditions', () => {
    it('returns an empty clause with no filters', () => {
      expect(buildDurableAiRunHistoryConditions({}, 1)).toEqual({
        clause: '',
        params: [],
      });
    });

    it('numbers placeholders from the requested start index', () => {
      expect(buildDurableAiRunHistoryConditions(
        { status: 'queued', featureId: 'durable-test' },
        3,
      )).toEqual({
        clause: 'WHERE status = $3 AND feature_id = $4',
        params: ['queued', 'durable-test'],
      });
    });

    it('expands compound history cursors into a stable tie-breaking predicate', () => {
      const result = buildDurableAiRunHistoryConditions(
        { before: '2026-01-01T00:00:00.000Z|run-9' },
        1,
      );
      expect(result.clause).toBe(
        'WHERE (created_at < $1 OR (created_at = $2 AND id < $3))',
      );
      expect(result.params).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        'run-9',
      ]);
    });

    it('treats a cursor without a separator as a plain timestamp bound', () => {
      expect(buildDurableAiRunHistoryConditions(
        { before: '2026-01-01T00:00:00.000Z' },
        1,
      )).toEqual({
        clause: 'WHERE created_at < $1',
        params: ['2026-01-01T00:00:00.000Z'],
      });
    });
  });

  describe('buildDurableAiCompareAndSetConditions', () => {
    it('always fences on run id and expected revision', () => {
      expect(buildDurableAiCompareAndSetConditions(
        'run-1',
        7,
        {},
        '2026-01-01T00:00:00.000Z',
        13,
      )).toEqual({
        clause: 'id = $13 AND revision = $14',
        params: ['run-1', 7],
      });
    });

    it('adds status, cancellation, owner, and lease guards in placeholder order', () => {
      const result = buildDurableAiCompareAndSetConditions(
        'run-1',
        7,
        {
          allowedCurrentStatuses: ['running', 'cancelling'],
          cancellation: 'absent',
          requiredLeaseOwner: 'worker-a',
          leaseState: 'active',
        },
        '2026-01-01T00:00:00.000Z',
        13,
      );
      expect(result.clause).toBe(
        'id = $13 AND revision = $14 AND status = ANY($15::text[]) '
        + 'AND cancel_requested_at IS NULL AND lease_owner = $16 '
        + 'AND lease_expires_at > $17',
      );
      expect(result.params).toEqual([
        'run-1',
        7,
        ['running', 'cancelling'],
        'worker-a',
        '2026-01-01T00:00:00.000Z',
      ]);
    });

    it('supports the expired-lease and requested-cancellation fences', () => {
      const result = buildDurableAiCompareAndSetConditions(
        'run-1',
        1,
        { cancellation: 'requested', leaseState: 'expired' },
        '2026-01-01T00:00:00.000Z',
        13,
      );
      expect(result.clause).toBe(
        'id = $13 AND revision = $14 AND cancel_requested_at IS NOT NULL '
        + 'AND lease_expires_at <= $15',
      );
      expect(result.params).toEqual([
        'run-1',
        1,
        '2026-01-01T00:00:00.000Z',
      ]);
    });
  });

  describe('computeDurableAiRetryAvailableAt', () => {
    it('applies exponential backoff from the attempt that failed', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(computeDurableAiRetryAvailableAt(now, 1, 1_000))
        .toBe('2026-01-01T00:00:01.000Z');
      expect(computeDurableAiRetryAvailableAt(now, 2, 1_000))
        .toBe('2026-01-01T00:00:02.000Z');
      expect(computeDurableAiRetryAvailableAt(now, 3, 1_000))
        .toBe('2026-01-01T00:00:04.000Z');
    });

    it('never applies a negative exponent and caps the delay at five minutes', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(computeDurableAiRetryAvailableAt(now, 0, 1_000))
        .toBe('2026-01-01T00:00:01.000Z');
      expect(
        Date.parse(computeDurableAiRetryAvailableAt(now, 30, 60_000)) - now.getTime(),
      ).toBe(5 * 60_000);
    });
  });

  describe('normalizeDurableAiExecutionState', () => {
    it('passes through jsonb objects and rejects non-object shapes', () => {
      expect(normalizeDurableAiExecutionState({ state: 'active' }))
        .toEqual({ state: 'active' });
      expect(normalizeDurableAiExecutionState(null)).toBeNull();
      expect(normalizeDurableAiExecutionState(undefined)).toBeNull();
      expect(normalizeDurableAiExecutionState([1, 2])).toBeNull();
      expect(normalizeDurableAiExecutionState(7)).toBeNull();
    });

    it('parses JSON text left behind by a SQLite import', () => {
      expect(normalizeDurableAiExecutionState('{"state":"active"}'))
        .toEqual({ state: 'active' });
      expect(normalizeDurableAiExecutionState('')).toBeNull();
      expect(normalizeDurableAiExecutionState('[1]')).toBeNull();
    });
  });

  describe('run projection', () => {
    it('coerces the boolean notification column and keeps internal fields private', () => {
      const run = internalRun();
      expect(run.notifyOnCompletion).toBe(true);
      expect(run.executionState).toEqual({ state: 'active', ownerId: 'worker-a' });

      const publicRun = toPublicDurableAiRun(run);
      expect(publicRun).not.toHaveProperty('executionState');
      expect(publicRun).not.toHaveProperty('leaseOwner');
      expect(publicRun).not.toHaveProperty('leaseExpiresAt');
      expect(publicRun).not.toHaveProperty('idempotencyKey');
      expect(publicRun).not.toHaveProperty('requestFingerprint');
      expect(publicRun).not.toHaveProperty('traceparent');
      expect(publicRun).toMatchObject({ id: 'run-1', attempt: 1, revision: 4 });
    });
  });

  describe('request identity', () => {
    it('binds an idempotency key to the routed request shape', () => {
      const request = {
        idempotencyKey: 'feature:run-1',
        featureId: 'durable-test',
        sensitivity: 'standard',
        executionRoute: 'test-route',
        requestedProvider: 'bifrost',
        requestedModel: 'azure/gpt-4o-mini',
      } as const;
      expect(durableAiRequestFingerprint(request))
        .toBe(durableAiRequestFingerprint({ ...request, correlationId: 'other' }));
      expect(durableAiRequestFingerprint(request))
        .not.toBe(durableAiRequestFingerprint({
          ...request,
          requestedModel: 'different-model',
        }));
    });

    it('rejects identifiers outside the persisted column bounds', () => {
      expect(boundedIdentifier('  run-1  ', 'run id')).toBe('run-1');
      expect(() => boundedIdentifier('   ', 'run id')).toThrow(/1-200 characters/);
      expect(() => boundedIdentifier('x'.repeat(301), 'idempotencyKey', 300))
        .toThrow(/1-300 characters/);
    });

    it('generates or validates W3C traceparents', () => {
      expect(resolveDurableAiTraceparent(undefined))
        .toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(resolveDurableAiTraceparent(
        '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01',
      )).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      expect(() => resolveDurableAiTraceparent('not-a-traceparent'))
        .toThrow(/W3C version 00/);
    });
  });

  describe('bounded configuration', () => {
    it('falls back for non-positive or unsafe values', () => {
      expect(positiveInteger(5, 10)).toBe(5);
      expect(positiveInteger(0, 10)).toBe(10);
      expect(positiveInteger(-1, 10)).toBe(10);
      expect(positiveInteger(Number.NaN, 10)).toBe(10);
      expect(positiveInteger(undefined, 10)).toBe(10);
    });

    it('applies the sensitivity retention policy with an environment override', () => {
      expect(durableAiRetentionDays('standard')).toBe(30);
      expect(durableAiRetentionDays('restricted')).toBe(7);
      expect(durableAiRetentionDays('local-only')).toBe(1);

      process.env.MC_AI_RUN_RETENTION_DAYS_LOCAL_ONLY = '3';
      try {
        expect(durableAiRetentionDays('local-only')).toBe(3);
      } finally {
        delete process.env.MC_AI_RUN_RETENTION_DAYS_LOCAL_ONLY;
      }
    });
  });

  describe('backend isolation', () => {
    it('never reaches into the SQLite persistence backend', () => {
      const source = readFileSync(ADAPTER_PATH, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(([, target]) => target);

      expect(imports).toEqual(expect.arrayContaining(['pg', './types', './repository']));
      expect(imports).not.toContain('@/db');
      expect(imports.some((target) => /sqlite|drizzle|@\/db\//i.test(target))).toBe(false);
      expect(source).not.toMatch(/\bsqlite\.(prepare|transaction|exec)\b/);
    });
  });
});
