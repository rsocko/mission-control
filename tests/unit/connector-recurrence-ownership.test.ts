import { describe, expect, it } from 'vitest';
import { canonicalizeLegacyRecurrence } from '@/lib/recurrence/canonical';
import {
  assertConnectorRecurrenceWriteAllowed,
  assertTaskRecurrenceWriteAllowed,
  getCanonicalRecurrenceOwnership,
  type ConnectorRecurrenceContract,
} from '@/lib/connectors/recurrence-ownership';

const defaultDenyContract = {
  imported: { series: 'provider', occurrences: 'provider' },
  writes: {
    'create-series': ['mission-control'],
  },
} as const satisfies ConnectorRecurrenceContract;

describe('connector recurrence ownership', () => {
  it('distinguishes locally owned series from provider-owned occurrences', () => {
    const rule = canonicalizeLegacyRecurrence({
      recurrence: 'daily',
      mode: 'schedule',
      startDate: '2026-09-01',
      timezone: 'UTC',
      seriesIdentity: {
        kind: 'mission-control',
        stableId: 'local-series',
        connectorInstanceId: 'todo-1',
      },
      source: {
        owner: 'connector',
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        support: { status: 'supported', reasons: [] },
        raw: {},
      },
    });

    expect(getCanonicalRecurrenceOwnership(rule)).toEqual({
      series: 'mission-control',
      occurrences: 'provider',
    });
  });

  it('default-denies undeclared and provider-owned writes', () => {
    expect(() => assertConnectorRecurrenceWriteAllowed({
      contract: defaultDenyContract,
      operation: 'update-series',
      ownership: { series: 'mission-control', occurrences: 'provider' },
    })).toThrow('Recurrence update-series denied');
    expect(() => assertConnectorRecurrenceWriteAllowed({
      contract: defaultDenyContract,
      operation: 'create-series',
      ownership: { series: 'provider', occurrences: 'provider' },
    })).toThrow('denied for provider-owned series');
    expect(() => assertConnectorRecurrenceWriteAllowed({
      contract: defaultDenyContract,
      operation: 'delete-occurrence',
      ownership: { series: 'mission-control', occurrences: 'provider' },
    })).toThrow('denied for provider-owned occurrences');
    expect(() => assertTaskRecurrenceWriteAllowed({
      contract: defaultDenyContract,
      operation: 'create-series',
      metadata: { recurrence: 'daily' },
    })).toThrow('denied without declared ownership');
  });
});
