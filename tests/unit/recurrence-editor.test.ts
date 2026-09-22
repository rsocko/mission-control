import { describe, expect, it } from 'vitest';
import {
  canonicalizeLegacyRecurrence,
  createCanonicalRecurrenceRule,
} from '@/lib/recurrence/canonical';
import {
  applyRecurrenceEditorOptions,
  buildRecurrencePreview,
  getRecurrenceControlState,
} from '@/lib/recurrence/editor';

describe('recurrence editor domain', () => {
  it('updates exceptions and catch-up policy without changing series ownership', () => {
    const original = canonicalizeLegacyRecurrence({
      recurrence: 'weekly',
      mode: 'schedule',
      startDate: '2026-09-21',
      timezone: 'UTC',
      seriesIdentity: { kind: 'mission-control', stableId: 'task-1' },
    });
    const updated = applyRecurrenceEditorOptions(original, {
      skipDates: ['2026-09-28'],
      catchUp: 'none',
    });

    expect(updated.series).toEqual(original.series);
    expect(updated.source).toEqual(original.source);
    expect(updated.revision.id).not.toBe(original.revision.id);
    expect(updated.semantics.exceptions.skipDates).toEqual(['2026-09-28']);
    expect(updated.semantics.materialization).toEqual({
      strategy: 'on-schedule',
      catchUp: 'none',
    });
  });

  it('does not invent catch-up behavior for completion-anchored rules', () => {
    const original = canonicalizeLegacyRecurrence({
      recurrence: 'daily',
      mode: 'completion',
      startDate: '2026-09-21',
      timezone: 'UTC',
      seriesIdentity: { kind: 'mission-control', stableId: 'task-1' },
    });
    const updated = applyRecurrenceEditorOptions(original, {
      skipDates: [],
      catchUp: 'latest',
    });

    expect(updated.semantics.materialization).toEqual({
      strategy: 'on-completion',
      catchUp: 'none',
    });
  });

  it('surfaces unsupported provider rules without attempting projection', () => {
    const rule = createCanonicalRecurrenceRule({
      seriesIdentity: {
        kind: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        externalSeriesId: 'series-1',
        stability: 'provider',
      },
      semantics: {
        mode: 'schedule',
        timezone: {
          id: 'provider-zone',
          kind: 'provider',
          dstPolicy: 'preserve-wall-clock',
          gapPolicy: 'shift-forward',
          overlapPolicy: 'earlier-offset',
        },
        start: { date: '2026-09-21', localTime: null },
        pattern: { type: 'unsupported' },
        end: { type: 'never' },
        exceptions: { skipDates: [] },
        materialization: { strategy: 'on-schedule', catchUp: 'latest' },
      },
      source: {
        owner: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        support: { status: 'unsupported', reasons: ['provider_pattern_unknown'] },
        raw: {},
      },
    });

    expect(getRecurrenceControlState(rule, 'UTC')).toMatchObject({
      owner: 'provider',
      support: 'unsupported',
      reasons: ['provider_pattern_unknown'],
    });
    expect(buildRecurrencePreview({
      recurrence: 'provider-specific',
      mode: 'schedule',
      startDate: '2026-09-21',
      timezone: 'UTC',
      options: { skipDates: [], catchUp: 'latest' },
      rule,
    }, new Date('2026-09-21T12:00:00.000Z'))).toEqual({
      status: 'unsupported',
      reasons: ['provider_pattern_unknown', 'provider_timezone_not_projectable'],
    });
  });
});

