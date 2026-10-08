import { formatInTimeZone } from 'date-fns-tz';
import {
  canonicalizeLegacyRecurrence,
  createCanonicalRecurrenceRule,
  parseCanonicalRecurrenceRule,
  type CanonicalRecurrenceRuleV1,
} from '@/lib/recurrence/canonical';
import type {
  RecurrenceControlState,
  RecurrenceEditorOptions,
  RecurrencePreviewRequest,
  RecurrencePreviewResponse,
} from '@/lib/recurrence/editor-contract';
import { projectRecurrence } from '@/lib/recurrence/projection';

const PREVIEW_OCCURRENCE_LIMIT = 5;
const PREVIEW_RANGE_DAYS = 3_660;

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function applyRecurrenceEditorOptions(
  rule: CanonicalRecurrenceRuleV1,
  options: RecurrenceEditorOptions,
): CanonicalRecurrenceRuleV1 {
  return createCanonicalRecurrenceRule({
    seriesIdentity: rule.series.identity,
    source: rule.source,
    compatibility: rule.compatibility,
    semantics: {
      ...rule.semantics,
      exceptions: { skipDates: options.skipDates },
      materialization: {
        strategy: rule.semantics.mode === 'completion' ? 'on-completion' : 'on-schedule',
        catchUp: rule.semantics.mode === 'completion' ? 'none' : options.catchUp,
      },
    },
  });
}

export function getRecurrenceControlState(
  rule: CanonicalRecurrenceRuleV1 | null,
  fallbackTimezone: string,
): RecurrenceControlState {
  if (!rule) {
    return {
      rule: null,
      owner: 'mission-control',
      support: 'supported',
      reasons: [],
      timezone: fallbackTimezone,
      localTime: null,
    };
  }
  return {
    rule,
    owner: rule.source.owner === 'connector' ? 'provider' : 'mission-control',
    support: rule.source.support.status,
    reasons: [...rule.source.support.reasons],
    timezone: rule.semantics.timezone.id,
    localTime: rule.semantics.start.localTime,
  };
}

export function buildRecurrencePreview(
  input: RecurrencePreviewRequest,
  now = new Date(),
): RecurrencePreviewResponse {
  let rule: CanonicalRecurrenceRuleV1;
  try {
    if (input.rule) {
      const parsed = parseCanonicalRecurrenceRule(input.rule);
      if (!parsed.success) return { status: 'invalid', issues: [...parsed.issues] };
      rule = parsed.rule;
    } else {
      rule = applyRecurrenceEditorOptions(canonicalizeLegacyRecurrence({
        recurrence: input.recurrence,
        mode: input.mode,
        startDate: input.startDate,
        localTime: input.localTime ?? null,
        timezone: input.timezone,
        seriesIdentity: {
          kind: 'mission-control',
          stableId: 'recurrence-preview',
        },
      }), input.options);
    }
  } catch (error) {
    return {
      status: 'invalid',
      issues: [error instanceof Error ? error.message : 'Invalid recurrence'],
    };
  }

  let today: string;
  try {
    today = formatInTimeZone(now, rule.semantics.timezone.id, 'yyyy-MM-dd');
  } catch {
    return {
      status: 'unsupported',
      reasons: rule.source.owner === 'connector'
        ? [...new Set([...rule.source.support.reasons, 'provider_timezone_not_projectable'])]
        : ['timezone_not_projectable'],
    };
  }
  const startInclusive = today < rule.semantics.start.date
    ? rule.semantics.start.date
    : today;
  const result = projectRecurrence({
    rule,
    range: {
      kind: 'local-date',
      startInclusive,
      endExclusive: addUtcDays(startInclusive, PREVIEW_RANGE_DAYS),
    },
    completionAnchors: rule.semantics.mode === 'completion'
      ? [{ completedAt: now.toISOString() }]
      : undefined,
  });

  if (result.status === 'success') {
    return {
      status: 'success',
      occurrences: result.occurrences.slice(0, PREVIEW_OCCURRENCE_LIMIT).map((occurrence) => ({
        localDate: occurrence.localDate,
        localTime: occurrence.localTime,
        instant: occurrence.instant,
      })),
      conditional: rule.semantics.mode === 'completion',
    };
  }
  if (result.status === 'unsupported') {
    return { status: 'unsupported', reasons: [...result.reasons] };
  }
  if (result.status === 'invalid') {
    return { status: 'invalid', issues: [...result.issues] };
  }
  return {
    status: 'invalid',
    issues: [`Preview exceeded the ${result.bound} safety limit`],
  };
}
