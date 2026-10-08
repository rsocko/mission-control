import { describe, expect, it } from 'vitest';
import {
  normalizeRecurrenceBackfillInstant,
  planRecurrenceBackfill,
  validateRecurrenceBackfillAsOf,
  type RecurrenceBackfillExistingOccurrence,
} from '@/lib/tasks/core/contracts';
import {
  createRecurrenceOccurrenceId,
  type ProjectedRecurrenceOccurrence,
  type RecurrenceOccurrenceIdentityInput,
} from '@/lib/recurrence/projection';

function occurrence(
  value: string,
  existing: RecurrenceBackfillExistingOccurrence | null = null,
) {
  const identity: RecurrenceOccurrenceIdentityInput = {
    seriesId: 'series:v1:test',
    revisionId: 'revision:v1:test',
    effective: value.includes('T')
      ? { kind: 'instant', value: new Date(value).toISOString() }
      : { kind: 'local-date', value },
  };
  const projected: ProjectedRecurrenceOccurrence = {
    occurrenceNumber: 1,
    localDate: value.slice(0, 10),
    localTime: value.includes('T') ? '09:00:00' : null,
    instant: value.includes('T') ? identity.effective.value : null,
    identity,
    anchor: { kind: 'schedule', startDate: '2026-08-10' },
  };
  return {
    occurrenceId: createRecurrenceOccurrenceId(identity),
    occurrence: projected,
    sourceOwner: 'mission-control' as const,
    existing,
  };
}

describe('recurrence backfill policy', () => {
  it('compares instant cutoffs by epoch across equivalent offsets and fractional precision', () => {
    const decisions = planRecurrenceBackfill({
      range: {
        kind: 'instant',
        startInclusive: '2026-08-10T08:59:59.999-04:00',
        endExclusive: '2026-08-10T13:00:00.000000Z',
      },
      asOf: { kind: 'instant', value: '2026-08-10T09:00:00.000-04:00' },
      occurrences: [
        occurrence('2026-08-10T12:59:59.999Z'),
        occurrence('2026-08-10T13:00:00.000Z'),
      ],
    });

    expect(decisions.map(({ decision }) => decision)).toEqual([
      'collapsed',
      'materialized',
    ]);
    expect(decisions[0].reason).toBe('untouched-missed-pileup');
    expect(decisions[1].reason).toBe('current-actionable');
  });

  it('preserves every conservative touch signal and all non-todo statuses', () => {
    const touchReasons = [
      'attachment',
      'description',
      'field-edit',
      'history',
      'planning-membership',
      'time-activity',
    ] as const;
    const decisions = planRecurrenceBackfill({
      range: {
        kind: 'local-date',
        startInclusive: '2026-08-10',
        endExclusive: '2026-08-18',
      },
      asOf: { kind: 'local-date', value: '2026-08-18' },
      occurrences: [
        ...touchReasons.map((reason, index) => occurrence(
          `2026-08-${String(10 + index).padStart(2, '0')}`,
          { taskId: `task-${reason}`, status: 'todo', deletedAt: null, touchReasons: [reason] },
        )),
        occurrence('2026-08-16', {
          taskId: 'task-done',
          status: 'done',
          deletedAt: null,
          touchReasons: [],
        }),
        occurrence('2026-08-17', {
          taskId: 'task-progress',
          status: 'in_progress',
          deletedAt: null,
          touchReasons: [],
        }),
      ],
    });

    expect(decisions.every(({ decision }) => decision === 'preserved')).toBe(true);
  });

  it('rejects mismatched or non-normalized range cutoff kinds', () => {
    expect(normalizeRecurrenceBackfillInstant('2026-08-10T09:00:00-04:00'))
      .toBe('2026-08-10T13:00:00.000Z');
    expect(normalizeRecurrenceBackfillInstant('2026-08-10T09:00:00')).toBeNull();
    expect(validateRecurrenceBackfillAsOf({
      kind: 'instant',
      startInclusive: '2026-08-10T00:00:00.000Z',
      endExclusive: '2026-08-11T00:00:00.000Z',
    }, {
      kind: 'local-date',
      value: '2026-08-10',
    })).toEqual(['asOf.kind must match range.kind']);
    expect(validateRecurrenceBackfillAsOf({
      kind: 'instant',
      startInclusive: '2026-08-10T00:00:00.000Z',
      endExclusive: '2026-08-11T00:00:00.000Z',
    }, {
      kind: 'instant',
      value: '2026-08-10T00:00:00',
    })).toEqual(['asOf.value must include a UTC offset or Z suffix']);
  });
});
