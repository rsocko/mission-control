import { describe, expect, it } from 'vitest';
import { canonicalizeLegacyRecurrence } from '@/lib/recurrence/canonical';
import {
  assertRecurrenceOccurrenceMatches,
  assertRecurrenceOccurrenceTaskScope,
  assertRecurrenceOccurrenceTiming,
  createPersistedRecurrenceOccurrence,
  deriveRecurrenceOccurrenceProvenance,
} from '@/lib/recurrence/occurrence-persistence';

function rule(input: {
  recurrence?: string;
  timezone?: string;
  connectorInstanceId?: string;
} = {}) {
  const connectorInstanceId = input.connectorInstanceId;
  return canonicalizeLegacyRecurrence({
    recurrence: input.recurrence ?? 'daily',
    mode: 'schedule',
    startDate: '2026-08-10',
    localTime: null,
    timezone: input.timezone ?? 'UTC',
    seriesIdentity: connectorInstanceId
      ? {
          kind: 'connector',
          connectorType: 'planner',
          connectorInstanceId,
          externalSeriesId: 'series-1',
          stability: 'provider',
        }
      : { kind: 'mission-control', stableId: 'series-1' },
    source: connectorInstanceId
      ? {
          owner: 'connector',
          connectorType: 'planner',
          connectorInstanceId,
          support: { status: 'supported', reasons: [] },
          raw: {},
        }
      : undefined,
  });
}

function provenance(
  recurrenceRule = rule(),
  instant: string | null = null,
) {
  return deriveRecurrenceOccurrenceProvenance({
    rule: recurrenceRule,
    occurrence: {
      localDate: '2026-08-17',
      instant,
      occurrenceNumber: 1,
      anchor: { kind: 'schedule', startDate: '2026-08-10' },
    },
  }).provenance;
}

describe('recurrence occurrence persistence identity', () => {
  it('is deterministic and distinguishes local dates from normalized instants', () => {
    const local = provenance();
    expect(provenance()).toEqual(local);
    const instant = provenance(rule({ timezone: 'America/New_York' }), '2026-08-17T13:00:00.000Z');
    expect(instant.occurrenceId).not.toBe(local.occurrenceId);
    expect(instant).toMatchObject({
      effectiveKind: 'instant',
      effectiveValue: '2026-08-17T13:00:00.000Z',
      timezoneId: 'America/New_York',
    });
  });

  it('distinguishes immutable rule revisions and connector instances', () => {
    expect(provenance(rule({ recurrence: 'weekly' })).occurrenceId)
      .not.toBe(provenance().occurrenceId);
    const first = provenance(rule({ connectorInstanceId: 'instance-a' }));
    const second = provenance(rule({ connectorInstanceId: 'instance-b' }));
    expect(first.seriesId).not.toBe(second.seriesId);
    expect(first.occurrenceId).not.toBe(second.occurrenceId);
  });

  it('rejects non-normalized instants, source scope mismatches, and corrupt claims', () => {
    expect(() => provenance(rule(), '2026-08-17T13:00:00Z'))
      .toThrow('normalized ISO instant');
    const connector = provenance(rule({ connectorInstanceId: 'instance-a' }));
    expect(() => assertRecurrenceOccurrenceTaskScope({
      connectorType: 'planner',
      connectorInstanceId: 'instance-b',
    }, connector)).toThrow('scope does not match');
    expect(() => assertRecurrenceOccurrenceMatches(
      createPersistedRecurrenceOccurrence(
        { ...connector, timezoneId: 'Europe/London' },
        'task-1',
        null,
        '2026-08-10T12:00:00.000Z',
      ),
      connector,
    )).toThrow('conflicts on timezoneId');
    expect(() => assertRecurrenceOccurrenceTiming(
      { dueDate: '2026-08-18' },
      {
        taskId: 'task-1',
        scheduledDate: '2026-08-17',
      },
      provenance(),
      'task-1',
    )).toThrow('effective value');
  });
});
