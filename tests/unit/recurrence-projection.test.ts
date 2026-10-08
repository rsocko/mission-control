import { afterEach, describe, expect, it } from 'vitest';
import {
  createCanonicalRecurrenceRule,
  type CanonicalRecurrenceDraftV1,
} from '@/lib/recurrence/canonical';
import {
  projectRecurrence,
  type RecurrenceCompletionAnchor,
  type RecurrenceProjectionRange,
} from '@/lib/recurrence/projection';

const ORIGINAL_TIMEZONE = process.env.TZ;
const ORIGINAL_LANGUAGE = process.env.LANG;

function draft(
  semantics: Partial<CanonicalRecurrenceDraftV1['semantics']> = {},
): CanonicalRecurrenceDraftV1 {
  return {
    seriesIdentity: {
      kind: 'mission-control',
      stableId: 'projection-test-series',
    },
    semantics: {
      mode: 'schedule',
      timezone: {
        id: 'America/New_York',
        kind: 'iana',
        dstPolicy: 'preserve-wall-clock',
        gapPolicy: 'shift-forward',
        overlapPolicy: 'earlier-offset',
      },
      start: { date: '2026-01-01', localTime: null },
      pattern: { type: 'daily', interval: 1 },
      end: { type: 'never' },
      exceptions: { skipDates: [] },
      materialization: { strategy: 'on-schedule', catchUp: 'latest' },
      ...semantics,
    },
    source: {
      owner: 'mission-control',
      support: { status: 'supported', reasons: [] },
    },
  };
}

const januaryRange: RecurrenceProjectionRange = {
  kind: 'local-date',
  startInclusive: '2026-01-01',
  endExclusive: '2026-02-01',
};

function successOccurrences(
  input: Parameters<typeof projectRecurrence>[0],
) {
  const result = projectRecurrence(input);
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error(`Expected success, received ${result.status}`);
  return result.occurrences;
}

describe('schedule recurrence projection', () => {
  it('replays deterministically without mutating the rule or range', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      pattern: {
        type: 'weekly',
        interval: 2,
        daysOfWeek: ['monday', 'wednesday'],
      },
      start: { date: '2026-01-05', localTime: null },
    }));
    const range = {
      kind: 'local-date',
      startInclusive: '2026-01-01',
      endExclusive: '2026-02-01',
    } as const;
    const before = JSON.stringify({ rule, range });

    const first = projectRecurrence({ rule, range });
    const second = projectRecurrence({ rule, range });

    expect(second).toEqual(first);
    expect(JSON.stringify({ rule, range })).toBe(before);
    expect(successOccurrences({ rule, range }).map((item) => item.localDate)).toEqual([
      '2026-01-05',
      '2026-01-07',
      '2026-01-19',
      '2026-01-21',
    ]);
  });

  it('uses explicit inclusive-start and exclusive-end boundaries', () => {
    const rule = createCanonicalRecurrenceRule(draft());
    const occurrences = successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-01-02',
        endExclusive: '2026-01-04',
      },
    });

    expect(occurrences.map((item) => item.localDate)).toEqual([
      '2026-01-02',
      '2026-01-03',
    ]);
    expect(occurrences.map((item) => item.occurrenceNumber)).toEqual([2, 3]);
  });

  it('applies the same half-open boundary semantics to instant ranges', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-01-01', localTime: '09:00:00' },
    }));

    expect(successOccurrences({
      rule,
      range: {
        kind: 'instant',
        startInclusive: '2026-01-01T14:00:00.000Z',
        endExclusive: '2026-01-03T14:00:00.000Z',
      },
    }).map((item) => item.instant)).toEqual([
      '2026-01-01T14:00:00.000Z',
      '2026-01-02T14:00:00.000Z',
    ]);
  });

  it('applies inclusive series end dates, count limits, and skip dates', () => {
    const dateEnded = createCanonicalRecurrenceRule(draft({
      end: { type: 'date', date: '2026-01-03' },
      exceptions: { skipDates: ['2026-01-02'] },
    }));
    const countEnded = createCanonicalRecurrenceRule(draft({
      end: { type: 'count', count: 3 },
      exceptions: { skipDates: ['2026-01-02'] },
    }));

    expect(successOccurrences({ rule: dateEnded, range: januaryRange }))
      .toMatchObject([
        { localDate: '2026-01-01', occurrenceNumber: 1 },
        { localDate: '2026-01-03', occurrenceNumber: 3 },
      ]);
    expect(successOccurrences({ rule: countEnded, range: januaryRange }))
      .toMatchObject([
        { localDate: '2026-01-01', occurrenceNumber: 1 },
        { localDate: '2026-01-03', occurrenceNumber: 3 },
      ]);
  });

  it('skips nonexistent month days without drifting the monthly anchor', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-01-31', localTime: null },
      pattern: { type: 'monthly', interval: 1, dayOfMonth: 31 },
    }));

    expect(successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-01-01',
        endExclusive: '2026-06-01',
      },
    }).map((item) => item.localDate)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
  });

  it('skips non-leap years without drifting a leap-day yearly anchor', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      start: { date: '2024-02-29', localTime: null },
      pattern: { type: 'yearly', interval: 1, month: 2, dayOfMonth: 29 },
    }));

    expect(successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2024-01-01',
        endExclusive: '2030-01-01',
      },
    }).map((item) => item.localDate)).toEqual([
      '2024-02-29',
      '2028-02-29',
    ]);
  });

  it('preserves wall clock across DST and shifts a gap forward', () => {
    const ordinary = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-03-07', localTime: '10:00:00' },
    }));
    const gap = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-03-08', localTime: '02:30:00' },
      end: { type: 'count', count: 1 },
    }));

    expect(successOccurrences({
      rule: ordinary,
      range: {
        kind: 'instant',
        startInclusive: '2026-03-07T00:00:00.000Z',
        endExclusive: '2026-03-10T00:00:00.000Z',
      },
    }).map((item) => item.instant)).toEqual([
      '2026-03-07T15:00:00.000Z',
      '2026-03-08T14:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
    ]);
    expect(successOccurrences({ rule: gap, range: januaryToDecember2026() }))
      .toMatchObject([{
        localDate: '2026-03-08',
        localTime: '03:30:00',
        instant: '2026-03-08T07:30:00.000Z',
      }]);
  });

  it('selects the earlier offset for a DST fold', () => {
    const newYorkRule = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-11-01', localTime: '01:30:00' },
      end: { type: 'count', count: 1 },
    }));
    const sydneyRule = createCanonicalRecurrenceRule(draft({
      timezone: {
        id: 'Australia/Sydney',
        kind: 'iana',
        dstPolicy: 'preserve-wall-clock',
        gapPolicy: 'shift-forward',
        overlapPolicy: 'earlier-offset',
      },
      start: { date: '2024-04-07', localTime: '02:30:00' },
      end: { type: 'count', count: 1 },
    }));

    expect(successOccurrences({ rule: newYorkRule, range: januaryToDecember2026() }))
      .toMatchObject([{
        localDate: '2026-11-01',
        localTime: '01:30:00',
        instant: '2026-11-01T05:30:00.000Z',
      }]);
    expect(successOccurrences({
      rule: sydneyRule,
      range: {
        kind: 'local-date',
        startInclusive: '2024-01-01',
        endExclusive: '2025-01-01',
      },
    })).toMatchObject([{
      localDate: '2024-04-07',
      localTime: '02:30:00',
      instant: '2024-04-06T15:30:00.000Z',
    }]);
  });

  it('deduplicates effective identities when a timezone skips a civil day', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      timezone: {
        id: 'Pacific/Apia',
        kind: 'iana',
        dstPolicy: 'preserve-wall-clock',
        gapPolicy: 'shift-forward',
        overlapPolicy: 'earlier-offset',
      },
      start: { date: '2011-12-28', localTime: '23:30:00' },
      end: { type: 'count', count: 5 },
    }));
    const occurrences = successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2011-12-27',
        endExclusive: '2012-01-03',
      },
    });

    expect(occurrences.map((item) => item.localDate)).toEqual([
      '2011-12-28',
      '2011-12-29',
      '2011-12-31',
      '2012-01-01',
    ]);
    expect(new Set(
      occurrences.map((item) => item.identity.effective.value),
    ).size).toBe(occurrences.length);
  });

  it('uses effective instants as stable identity inputs for timed occurrences', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-01-01', localTime: '09:00:00' },
      end: { type: 'count', count: 1 },
    }));
    const [occurrence] = successOccurrences({ rule, range: januaryRange });

    expect(occurrence.identity).toEqual({
      seriesId: rule.series.id,
      revisionId: rule.revision.id,
      effective: { kind: 'instant', value: '2026-01-01T14:00:00.000Z' },
    });
  });
});

describe('completion-anchored recurrence projection', () => {
  const completionRange: RecurrenceProjectionRange = {
    kind: 'local-date',
    startInclusive: '2026-03-01',
    endExclusive: '2026-04-01',
  };

  function completionRule(
    semantics: Partial<CanonicalRecurrenceDraftV1['semantics']> = {},
  ) {
    return createCanonicalRecurrenceRule(draft({
      mode: 'completion',
      start: { date: '2026-03-01', localTime: null },
      materialization: { strategy: 'on-completion', catchUp: 'none' },
      ...semantics,
    }));
  }

  it('normalizes, sorts, and deduplicates explicit completion anchors', () => {
    const rule = completionRule();
    const anchors: RecurrenceCompletionAnchor[] = [
      { completedAt: '2026-03-03T15:00:00-05:00' },
      { completedAt: '2026-03-01T15:00:00.000Z' },
      { completedAt: '2026-03-03T20:00:00.000Z' },
    ];

    expect(successOccurrences({
      rule,
      range: completionRange,
      completionAnchors: anchors,
    }).map((item) => ({
      date: item.localDate,
      anchor: item.anchor,
    }))).toEqual([
      {
        date: '2026-03-02',
        anchor: { kind: 'completion', completedAt: '2026-03-01T15:00:00.000Z' },
      },
      {
        date: '2026-03-04',
        anchor: { kind: 'completion', completedAt: '2026-03-03T20:00:00.000Z' },
      },
    ]);
  });

  it('preserves completion wall-clock time through DST transitions', () => {
    const rule = completionRule({
      start: { date: '2026-03-01', localTime: '09:00:00' },
    });

    expect(successOccurrences({
      rule,
      range: {
        kind: 'instant',
        startInclusive: '2026-03-08T00:00:00.000Z',
        endExclusive: '2026-03-09T00:00:00.000Z',
      },
      completionAnchors: [{ completedAt: '2026-03-07T15:00:00.000Z' }],
    })).toMatchObject([{
      localDate: '2026-03-08',
      localTime: '10:00:00',
      instant: '2026-03-08T14:00:00.000Z',
    }]);
  });

  it('applies gap and fold policy to completion wall-clock anchors', () => {
    const gapRule = completionRule({
      start: { date: '2026-03-01', localTime: '09:00:00' },
    });
    const foldRule = completionRule({
      start: { date: '2026-10-01', localTime: '09:00:00' },
    });

    expect(successOccurrences({
      rule: gapRule,
      range: januaryToDecember2026(),
      completionAnchors: [{ completedAt: '2026-03-07T07:30:00.000Z' }],
    })).toMatchObject([{
      localDate: '2026-03-08',
      localTime: '03:30:00',
      instant: '2026-03-08T07:30:00.000Z',
    }]);
    expect(successOccurrences({
      rule: foldRule,
      range: januaryToDecember2026(),
      completionAnchors: [{ completedAt: '2026-10-31T05:30:00.000Z' }],
    })).toMatchObject([{
      localDate: '2026-11-01',
      localTime: '01:30:00',
      instant: '2026-11-01T05:30:00.000Z',
    }]);
  });

  it('advances past exceptions and missing month days without anchor drift', () => {
    const rule = completionRule({
      start: { date: '2026-01-01', localTime: null },
      pattern: { type: 'monthly', interval: 1, dayOfMonth: 31 },
      exceptions: { skipDates: ['2026-03-31'] },
    });

    expect(successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-01-01',
        endExclusive: '2026-07-01',
      },
      completionAnchors: [{ completedAt: '2026-01-31T17:00:00.000Z' }],
    }).map((item) => item.localDate)).toEqual(['2026-05-31']);
  });

  it('uses every selected weekday before advancing a multi-week cadence', () => {
    const rule = completionRule({
      start: { date: '2026-01-05', localTime: null },
      pattern: {
        type: 'weekly',
        interval: 2,
        daysOfWeek: ['monday', 'wednesday'],
      },
    });

    expect(successOccurrences({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-01-01',
        endExclusive: '2026-02-01',
      },
      completionAnchors: [
        { completedAt: '2026-01-05T15:00:00.000Z' },
        { completedAt: '2026-01-07T15:00:00.000Z' },
      ],
    }).map((item) => item.localDate)).toEqual([
      '2026-01-07',
      '2026-01-19',
    ]);
  });

  it('enforces completion count boundaries when occurrence numbers are supplied', () => {
    const rule = completionRule({ end: { type: 'count', count: 3 } });

    expect(successOccurrences({
      rule,
      range: completionRange,
      completionAnchors: [
        { completedAt: '2026-03-01T15:00:00.000Z', occurrenceNumber: 2 },
        { completedAt: '2026-03-02T15:00:00.000Z', occurrenceNumber: 3 },
      ],
    })).toMatchObject([
      { localDate: '2026-03-02', occurrenceNumber: 3 },
    ]);
    expect(projectRecurrence({
      rule,
      range: completionRange,
      completionAnchors: [{ completedAt: '2026-03-01T15:00:00.000Z' }],
    })).toEqual({
      status: 'unsupported',
      reasons: ['completion_count_requires_occurrence_number'],
    });
  });

  it('applies inclusive completion-series end dates', () => {
    const rule = completionRule({ end: { type: 'date', date: '2026-03-02' } });

    expect(successOccurrences({
      rule,
      range: completionRange,
      completionAnchors: [
        { completedAt: '2026-03-01T15:00:00.000Z' },
        { completedAt: '2026-03-02T15:00:00.000Z' },
      ],
    }).map((item) => item.localDate)).toEqual(['2026-03-02']);
  });
});

describe('projection safety and compatibility', () => {
  it('returns typed invalid and unsupported results without approximating', () => {
    const valid = createCanonicalRecurrenceRule(draft());
    const invalid = {
      ...valid,
      revision: { id: `revision:v1:${'0'.repeat(64)}` },
    };
    const unsupported = createCanonicalRecurrenceRule({
      ...draft(),
      seriesIdentity: {
        kind: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        externalSeriesId: 'opaque-1',
        stability: 'provider',
      },
      semantics: {
        ...draft().semantics,
        pattern: { type: 'unsupported' },
      },
      source: {
        owner: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        support: { status: 'unsupported', reasons: ['provider_pattern_not_supported'] },
        raw: { cadence: 'opaque' },
      },
    });

    expect(projectRecurrence({ rule: invalid, range: januaryRange })).toMatchObject({
      status: 'invalid',
      issues: ['revision.id does not match canonical recurrence semantics'],
    });
    expect(projectRecurrence({ rule: unsupported, range: januaryRange })).toEqual({
      status: 'unsupported',
      reasons: ['provider_pattern_not_supported', 'unsupported_pattern'],
    });
  });

  it('rejects invalid ranges and date-only projection into instant ranges', () => {
    const rule = createCanonicalRecurrenceRule(draft());

    expect(projectRecurrence({
      rule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-02-30',
        endExclusive: '2026-03-01',
      },
    })).toMatchObject({ status: 'invalid' });
    expect(projectRecurrence({
      rule,
      range: {
        kind: 'instant',
        startInclusive: '2026-01-01T00:00:00.000Z',
        endExclusive: '2026-01-02T00:00:00.000Z',
      },
    })).toEqual({
      status: 'invalid',
      issues: ['instant ranges require a timed recurrence'],
    });
  });

  it('requires completion anchors and an executable timezone', () => {
    const completion = createCanonicalRecurrenceRule(draft({
      mode: 'completion',
      materialization: { strategy: 'on-completion', catchUp: 'none' },
    }));
    const providerTimezone = createCanonicalRecurrenceRule({
      ...draft({
        mode: 'completion',
        timezone: {
          id: 'Eastern Standard Time',
          kind: 'provider',
          dstPolicy: 'preserve-wall-clock',
          gapPolicy: 'shift-forward',
          overlapPolicy: 'earlier-offset',
        },
        materialization: { strategy: 'on-completion', catchUp: 'none' },
      }),
      seriesIdentity: {
        kind: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        externalSeriesId: 'series-1',
        stability: 'provider',
      },
      source: {
        owner: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        support: { status: 'lossy', reasons: ['provider_timezone_not_iana'] },
        raw: { timezone: 'Eastern Standard Time' },
      },
    });

    expect(projectRecurrence({ rule: completion, range: januaryRange })).toEqual({
      status: 'invalid',
      issues: ['completion mode requires completionAnchors'],
    });
    expect(projectRecurrence({
      rule: providerTimezone,
      range: januaryRange,
      completionAnchors: [],
    })).toEqual({
      status: 'unsupported',
      reasons: ['provider_timezone_not_iana', 'provider_timezone_not_projectable'],
    });
  });

  it('enforces range, iteration, output, and completion-anchor bounds', () => {
    const scheduleRule = createCanonicalRecurrenceRule(draft());
    const completionRule = createCanonicalRecurrenceRule(draft({
      mode: 'completion',
      materialization: { strategy: 'on-completion', catchUp: 'none' },
    }));

    expect(projectRecurrence({
      rule: scheduleRule,
      range: {
        kind: 'local-date',
        startInclusive: '2026-01-01',
        endExclusive: '2026-01-12',
      },
      limits: { maxRangeDays: 10 },
    })).toEqual({ status: 'bounds-exceeded', bound: 'range', maximum: 10 });
    expect(projectRecurrence({
      rule: scheduleRule,
      range: januaryRange,
      limits: { maxIterations: 2 },
    })).toEqual({ status: 'bounds-exceeded', bound: 'iterations', maximum: 2 });
    expect(projectRecurrence({
      rule: scheduleRule,
      range: januaryRange,
      limits: { maxOccurrences: 2 },
    })).toEqual({ status: 'bounds-exceeded', bound: 'occurrences', maximum: 2 });
    expect(projectRecurrence({
      rule: completionRule,
      range: januaryRange,
      completionAnchors: [
        { completedAt: '2026-01-01T00:00:00.000Z' },
        { completedAt: '2026-01-02T00:00:00.000Z' },
      ],
      limits: { maxCompletionAnchors: 1 },
    })).toEqual({
      status: 'bounds-exceeded',
      bound: 'completion-anchors',
      maximum: 1,
    });
  });

  it('does not depend on the process timezone or locale', () => {
    const rule = createCanonicalRecurrenceRule(draft({
      start: { date: '2026-03-07', localTime: '10:00:00' },
      end: { type: 'count', count: 3 },
    }));

    process.env.TZ = 'UTC';
    process.env.LANG = 'en_US';
    const first = projectRecurrence({ rule, range: januaryToDecember2026() });
    process.env.TZ = 'Pacific/Honolulu';
    process.env.LANG = 'de_DE';
    const second = projectRecurrence({ rule, range: januaryToDecember2026() });

    expect(second).toEqual(first);
  });
});

function januaryToDecember2026(): RecurrenceProjectionRange {
  return {
    kind: 'local-date',
    startInclusive: '2026-01-01',
    endExclusive: '2027-01-01',
  };
}

afterEach(() => {
  if (ORIGINAL_TIMEZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TIMEZONE;
  if (ORIGINAL_LANGUAGE === undefined) delete process.env.LANG;
  else process.env.LANG = ORIGINAL_LANGUAGE;
});
