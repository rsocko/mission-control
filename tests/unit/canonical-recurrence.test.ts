import { describe, expect, it } from 'vitest';
import { tasks as postgresTasks } from '@/db/postgres/schema/tasks';
import { tasks as sqliteTasks } from '@/db/schema/tasks';
import {
  CANONICAL_RECURRENCE_METADATA_KEY,
  canonicalRecurrenceRevisionBytes,
  canonicalizeLegacyRecurrence,
  createCanonicalRecurrenceRule,
  parseCanonicalRecurrenceRule,
  readRecurrenceMetadata,
  serializeCanonicalRecurrenceRule,
  writeRecurrenceMetadata,
  type CanonicalRecurrenceDraftV1,
} from '@/lib/recurrence/canonical';

function draft(
  overrides: Partial<CanonicalRecurrenceDraftV1> = {},
): CanonicalRecurrenceDraftV1 {
  return {
    seriesIdentity: {
      kind: 'connector',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-work',
      externalSeriesId: 'list-a:water plants:2026-03-01',
      stability: 'derived',
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
      start: { date: '2026-03-01', localTime: '09:00' },
      pattern: {
        type: 'weekly',
        interval: 1,
        daysOfWeek: ['friday', 'monday'],
      },
      end: { type: 'never' },
      exceptions: { skipDates: ['2026-05-01', '2026-04-03'] },
      materialization: { strategy: 'on-schedule', catchUp: 'latest' },
    },
    source: {
      owner: 'connector',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-work',
      support: { status: 'lossy', reasons: ['provider_timezone_normalized'] },
      raw: { providerOnly: 'first payload' },
    },
    compatibility: {
      legacyLabel: 'weekly (friday, monday)',
      migratedFrom: null,
    },
    ...overrides,
  };
}

describe('canonical recurrence identity', () => {
  it('uses stable canonical bytes for semantically equivalent inputs', () => {
    const first = createCanonicalRecurrenceRule(draft());
    const second = createCanonicalRecurrenceRule(draft({
      semantics: {
        ...draft().semantics,
        pattern: {
          type: 'weekly',
          interval: 1,
          daysOfWeek: ['monday', 'friday', 'monday'],
        },
        exceptions: {
          skipDates: ['2026-04-03', '2026-05-01', '2026-04-03'],
        },
      },
      source: {
        owner: 'connector',
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-work',
        support: {
          status: 'lossy',
          reasons: ['another_diagnostic', 'provider_timezone_normalized'],
        },
        raw: { providerOnly: 'changed payload' },
      },
      compatibility: {
        legacyLabel: 'Every Monday and Friday',
        migratedFrom: null,
      },
    }));

    expect(second.series.id).toBe(first.series.id);
    expect(second.revision.id).toBe(first.revision.id);
    expect(canonicalRecurrenceRevisionBytes({
      seriesId: second.series.id,
      semantics: second.semantics,
    })).toBe(
      canonicalRecurrenceRevisionBytes({
        seriesId: first.series.id,
        semantics: first.semantics,
      }),
    );
    expect(serializeCanonicalRecurrenceRule(JSON.parse(
      serializeCanonicalRecurrenceRule(first),
    ))).toBe(serializeCanonicalRecurrenceRule(first));
  });

  it('changes the revision but not the series when executable semantics change', () => {
    const first = createCanonicalRecurrenceRule(draft());
    const changed = createCanonicalRecurrenceRule(draft({
      semantics: {
        ...draft().semantics,
        pattern: {
          type: 'weekly',
          interval: 2,
          daysOfWeek: ['monday', 'friday'],
        },
      },
    }));

    expect(changed.series.id).toBe(first.series.id);
    expect(changed.revision.id).not.toBe(first.revision.id);
  });

  it('normalizes equivalent local-time encodings before revision hashing', () => {
    const shortTime = createCanonicalRecurrenceRule(draft());
    const fullTime = createCanonicalRecurrenceRule(draft({
      semantics: {
        ...draft().semantics,
        start: { ...draft().semantics.start, localTime: '09:00:00' },
      },
    }));

    expect(shortTime.semantics.start.localTime).toBe('09:00:00');
    expect(shortTime.revision.id).toBe(fullTime.revision.id);
  });

  it('scopes connector series identity to the connector instance', () => {
    const first = createCanonicalRecurrenceRule(draft());
    const otherConnector = createCanonicalRecurrenceRule(draft({
      seriesIdentity: {
        ...draft().seriesIdentity as Extract<
          CanonicalRecurrenceDraftV1['seriesIdentity'],
          { kind: 'connector' }
        >,
        connectorInstanceId: 'todo-personal',
      },
      source: {
        ...draft().source as Extract<
          CanonicalRecurrenceDraftV1['source'],
          { owner: 'connector' }
        >,
        connectorInstanceId: 'todo-personal',
      },
    }));

    expect(otherConnector.series.id).not.toBe(first.series.id);
  });

  it('rejects invalid calendar, timezone, and identity data', () => {
    expect(() => createCanonicalRecurrenceRule(draft({
      semantics: {
        ...draft().semantics,
        start: { date: '2026-02-30', localTime: '09:00' },
      },
    }))).toThrow('start.date must be a calendar date');
    expect(() => createCanonicalRecurrenceRule(draft({
      semantics: {
        ...draft().semantics,
        timezone: {
          id: 'Not/A_Timezone',
          kind: 'iana',
          dstPolicy: 'preserve-wall-clock',
          gapPolicy: 'shift-forward',
          overlapPolicy: 'earlier-offset',
        },
      },
    }))).toThrow('valid IANA timezone');
  });

  it('detects persisted identity tampering', () => {
    const rule = createCanonicalRecurrenceRule(draft());
    const parsed = parseCanonicalRecurrenceRule({
      ...rule,
      revision: {
        id: `revision:v1:${'0'.repeat(64)}`,
      },
    });

    expect(parsed).toEqual({
      success: false,
      issues: ['revision.id does not match canonical recurrence semantics'],
    });
  });
});

describe('legacy recurrence compatibility', () => {
  const expectedPatterns = [
    ['daily', { type: 'daily', interval: 1 }],
    ['weekdays', {
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    }],
    ['weekly', { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }],
    ['biweekly', { type: 'weekly', interval: 2, daysOfWeek: ['monday'] }],
    ['monthly', { type: 'monthly', interval: 1, dayOfMonth: 3 }],
    ['yearly', { type: 'yearly', interval: 1, month: 8, dayOfMonth: 3 }],
    ['every 3 days', { type: 'daily', interval: 3 }],
    ['every 2 weeks (wednesday, monday)', {
      type: 'weekly',
      interval: 2,
      daysOfWeek: ['monday', 'wednesday'],
    }],
  ] as const;

  it.each(expectedPatterns)('normalizes %s without changing its schedule', (label, pattern) => {
    const rule = canonicalizeLegacyRecurrence({
      recurrence: label,
      mode: 'schedule',
      startDate: '2026-08-03',
      timezone: 'America/New_York',
      seriesIdentity: { kind: 'mission-control', stableId: 'task-1' },
    });

    expect(rule.semantics.pattern).toEqual(pattern);
    expect(rule.compatibility).toEqual({
      legacyLabel: label,
      migratedFrom: 'legacy-string',
    });
  });

  it('keeps unsupported connector imports explicit and rejects unsupported local rules', () => {
    expect(() => canonicalizeLegacyRecurrence({
      recurrence: 'every blue moon',
      mode: 'schedule',
      startDate: '2026-08-03',
      timezone: 'UTC',
      seriesIdentity: { kind: 'mission-control', stableId: 'task-1' },
    })).toThrow('unsupported recurrence');

    const imported = canonicalizeLegacyRecurrence({
      recurrence: 'every blue moon',
      mode: 'schedule',
      startDate: '2026-08-03',
      timezone: 'UTC',
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
        support: { status: 'supported', reasons: [] },
        raw: { cadence: 'blue moon' },
      },
    });

    expect(imported.semantics.pattern).toEqual({ type: 'unsupported' });
    expect(imported.source.support).toEqual({
      status: 'unsupported',
      reasons: ['unsupported_legacy_recurrence'],
    });
  });
});

describe('recurrence persistence contract', () => {
  it('round-trips the same canonical metadata through SQLite text and PostgreSQL jsonb shapes', () => {
    const rule = createCanonicalRecurrenceRule(draft());
    const metadata = writeRecurrenceMetadata({ connectorData: true }, rule);
    const sqliteValue = JSON.stringify(metadata);
    const postgresValue = JSON.parse(sqliteValue) as Record<string, unknown>;

    expect(readRecurrenceMetadata(sqliteValue)).toEqual({
      rule,
      status: 'canonical',
      issues: [],
    });
    expect(readRecurrenceMetadata(postgresValue)).toEqual({
      rule,
      status: 'canonical',
      issues: [],
    });
    expect(metadata[CANONICAL_RECURRENCE_METADATA_KEY]).toEqual(rule);
    expect(sqliteTasks.metadata.dataType).toBe('json');
    expect(postgresTasks.metadata.dataType).toBe('json');
  });

  it('requires migration context before interpreting a legacy metadata string', () => {
    expect(readRecurrenceMetadata({ recurrence: 'daily' })).toEqual({
      rule: null,
      status: 'legacy',
      issues: ['legacy recurrence requires explicit identity, start date, mode, and timezone'],
    });
    expect(readRecurrenceMetadata({ recurrence: 'daily' }, {
      mode: 'completion',
      startDate: '2026-03-07',
      timezone: 'America/New_York',
      seriesIdentity: { kind: 'mission-control', stableId: 'task-legacy' },
    }).rule?.semantics).toMatchObject({
      mode: 'completion',
      timezone: {
        id: 'America/New_York',
        dstPolicy: 'preserve-wall-clock',
      },
      materialization: {
        strategy: 'on-completion',
        catchUp: 'none',
      },
    });
  });
});
