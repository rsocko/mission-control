import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/db/persistence/value-codecs';

export const CANONICAL_RECURRENCE_VERSION = 1 as const;
export const CANONICAL_RECURRENCE_METADATA_KEY = 'canonicalRecurrence' as const;

export const RECURRENCE_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type RecurrenceWeekday = typeof RECURRENCE_WEEKDAYS[number];
export type RecurrenceMode = 'schedule' | 'completion';
export type RecurrenceSupportStatus = 'supported' | 'lossy' | 'unsupported';

export type RecurrencePattern =
  | { readonly type: 'daily'; readonly interval: number }
  | {
      readonly type: 'weekly';
      readonly interval: number;
      readonly daysOfWeek: readonly RecurrenceWeekday[];
    }
  | {
      readonly type: 'monthly';
      readonly interval: number;
      readonly dayOfMonth: number;
    }
  | {
      readonly type: 'yearly';
      readonly interval: number;
      readonly month: number;
      readonly dayOfMonth: number;
    }
  | { readonly type: 'unsupported' };

export type RecurrenceEnd =
  | { readonly type: 'never' }
  | { readonly type: 'date'; readonly date: string }
  | { readonly type: 'count'; readonly count: number };

export type RecurrenceSeriesIdentity =
  | {
      readonly kind: 'mission-control';
      readonly stableId: string;
      readonly connectorInstanceId?: string;
    }
  | {
      readonly kind: 'connector';
      readonly connectorType: string;
      readonly connectorInstanceId: string;
      readonly externalSeriesId: string;
      /**
       * `provider` means the connector supplied a durable series identifier.
       * `derived` means the connector exposes no such identifier and the
       * adapter documented the deterministic source fields used instead.
       */
      readonly stability: 'provider' | 'derived';
    };

export type RecurrenceSource =
  | {
      readonly owner: 'mission-control';
      readonly support: { readonly status: 'supported'; readonly reasons: readonly [] };
    }
  | {
      readonly owner: 'connector';
      readonly connectorType: string;
      readonly connectorInstanceId: string;
      readonly support: {
        readonly status: RecurrenceSupportStatus;
        readonly reasons: readonly string[];
      };
      /**
       * Original provider data is retained for diagnostics and future
       * migrations. It is provenance, not executable rule state, so it is
       * deliberately excluded from revision hashing.
       */
      readonly raw: unknown;
    };

export interface CanonicalRecurrenceSemanticsV1 {
  readonly mode: RecurrenceMode;
  readonly timezone: {
    readonly id: string;
    readonly kind: 'iana' | 'provider';
    /**
     * Recurrence advances in local calendar time. During DST transitions,
     * the local wall-clock time is preserved rather than a fixed UTC offset.
     */
    readonly dstPolicy: 'preserve-wall-clock';
    /** Nonexistent local times advance by the timezone transition gap. */
    readonly gapPolicy: 'shift-forward';
    /** Ambiguous local times use the earlier of the two matching offsets. */
    readonly overlapPolicy: 'earlier-offset';
  };
  readonly start: {
    readonly date: string;
    readonly localTime: string | null;
  };
  readonly pattern: RecurrencePattern;
  readonly end: RecurrenceEnd;
  readonly exceptions: {
    readonly skipDates: readonly string[];
  };
  readonly materialization: {
    readonly strategy: 'on-schedule' | 'on-completion';
    readonly catchUp: 'latest' | 'none';
  };
}

export interface CanonicalRecurrenceRuleV1 {
  readonly version: typeof CANONICAL_RECURRENCE_VERSION;
  readonly series: {
    readonly id: string;
    readonly identity: RecurrenceSeriesIdentity;
  };
  readonly revision: {
    readonly id: string;
  };
  readonly semantics: CanonicalRecurrenceSemanticsV1;
  readonly source: RecurrenceSource;
  readonly compatibility: {
    readonly legacyLabel: string | null;
    readonly migratedFrom: 'legacy-string' | null;
  };
}

/**
 * Shared JSON contract used by TaskItem and the portable task persistence
 * domain. Additional connector metadata remains allowed, while recurrence
 * fields are typed.
 */
export interface TaskMetadata extends Record<string, unknown> {
  recurrence?: string | null;
  recurrenceIdentity?: string | null;
  canonicalRecurrence?: CanonicalRecurrenceRuleV1 | null;
}

export interface CanonicalRecurrenceDraftV1 {
  readonly seriesIdentity: RecurrenceSeriesIdentity;
  readonly semantics: CanonicalRecurrenceSemanticsV1;
  readonly source: RecurrenceSource;
  readonly compatibility?: {
    readonly legacyLabel?: string | null;
    readonly migratedFrom?: 'legacy-string' | null;
  };
}

export interface LegacyRecurrenceInput {
  readonly recurrence: string;
  readonly mode: RecurrenceMode;
  readonly startDate: string;
  readonly localTime?: string | null;
  readonly timezone: string;
  readonly seriesIdentity: RecurrenceSeriesIdentity;
  readonly source?: RecurrenceSource;
}

export interface ParsedRecurrenceMetadata {
  readonly rule: CanonicalRecurrenceRuleV1 | null;
  readonly status: 'canonical' | 'legacy' | 'absent' | 'invalid';
  readonly issues: readonly string[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const ID_COMPONENT_PATTERN = /^[^\u0000-\u001f\u007f]{1,500}$/;
const HASH_PATTERN = /^(?:series|revision):v1:[a-f0-9]{64}$/;
const SUPPORT_REASON_PATTERN = /^[a-z0-9][a-z0-9_-]{1,99}$/;

const weekdaySchema = z.enum(RECURRENCE_WEEKDAYS);
const positiveIntervalSchema = z.number().int().min(1).max(10_000);
const patternSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('daily'), interval: positiveIntervalSchema }),
  z.strictObject({
    type: z.literal('weekly'),
    interval: positiveIntervalSchema,
    daysOfWeek: z.array(weekdaySchema).min(1).max(7),
  }),
  z.strictObject({
    type: z.literal('monthly'),
    interval: positiveIntervalSchema,
    dayOfMonth: z.number().int().min(1).max(31),
  }),
  z.strictObject({
    type: z.literal('yearly'),
    interval: positiveIntervalSchema,
    month: z.number().int().min(1).max(12),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
  z.strictObject({ type: z.literal('unsupported') }),
]);
const endSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('never') }),
  z.strictObject({ type: z.literal('date'), date: z.string() }),
  z.strictObject({ type: z.literal('count'), count: z.number().int().min(1).max(1_000_000) }),
]);
const seriesIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mission-control'),
    stableId: z.string().regex(ID_COMPONENT_PATTERN),
    connectorInstanceId: z.string().regex(ID_COMPONENT_PATTERN).optional(),
  }),
  z.strictObject({
    kind: z.literal('connector'),
    connectorType: z.string().regex(ID_COMPONENT_PATTERN),
    connectorInstanceId: z.string().regex(ID_COMPONENT_PATTERN),
    externalSeriesId: z.string().regex(ID_COMPONENT_PATTERN),
    stability: z.enum(['provider', 'derived']),
  }),
]);
const supportSchema = z.strictObject({
  status: z.enum(['supported', 'lossy', 'unsupported']),
  reasons: z.array(z.string().regex(SUPPORT_REASON_PATTERN)).max(50),
});
const sourceSchema = z.discriminatedUnion('owner', [
  z.strictObject({
    owner: z.literal('mission-control'),
    support: z.strictObject({
      status: z.literal('supported'),
      reasons: z.tuple([]),
    }),
  }),
  z.strictObject({
    owner: z.literal('connector'),
    connectorType: z.string().regex(ID_COMPONENT_PATTERN),
    connectorInstanceId: z.string().regex(ID_COMPONENT_PATTERN),
    support: supportSchema,
    raw: z.unknown(),
  }),
]);
const semanticsSchema = z.strictObject({
  mode: z.enum(['schedule', 'completion']),
  timezone: z.strictObject({
    id: z.string().regex(ID_COMPONENT_PATTERN),
    kind: z.enum(['iana', 'provider']),
    dstPolicy: z.literal('preserve-wall-clock'),
    gapPolicy: z.literal('shift-forward'),
    overlapPolicy: z.literal('earlier-offset'),
  }),
  start: z.strictObject({
    date: z.string(),
    localTime: z.string().nullable(),
  }),
  pattern: patternSchema,
  end: endSchema,
  exceptions: z.strictObject({
    skipDates: z.array(z.string()).max(10_000),
  }),
  materialization: z.strictObject({
    strategy: z.enum(['on-schedule', 'on-completion']),
    catchUp: z.enum(['latest', 'none']),
  }),
});
const canonicalRuleSchema = z.strictObject({
  version: z.literal(CANONICAL_RECURRENCE_VERSION),
  series: z.strictObject({
    id: z.string().regex(HASH_PATTERN),
    identity: seriesIdentitySchema,
  }),
  revision: z.strictObject({
    id: z.string().regex(HASH_PATTERN),
  }),
  semantics: semanticsSchema,
  source: sourceSchema,
  compatibility: z.strictObject({
    legacyLabel: z.string().nullable(),
    migratedFrom: z.literal('legacy-string').nullable(),
  }),
});

function hashCanonical(prefix: 'series' | 'revision', value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return `${prefix}:v1:${digest}`;
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function extractRecurrenceLocalTime(
  value: unknown,
  timezone: string,
): string | null {
  if (typeof value !== 'string' || !value.includes('T')) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return value.match(/T([0-2]\d:[0-5]\d(?::[0-5]\d)?)/)?.[1] ?? null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}:${values.second}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeSeriesIdentity(identity: RecurrenceSeriesIdentity): RecurrenceSeriesIdentity {
  if (identity.kind === 'mission-control') {
    return {
      kind: identity.kind,
      stableId: identity.stableId.trim(),
      ...(identity.connectorInstanceId
        ? { connectorInstanceId: identity.connectorInstanceId.trim() }
        : {}),
    };
  }
  return {
    kind: identity.kind,
    connectorType: identity.connectorType.trim(),
    connectorInstanceId: identity.connectorInstanceId.trim(),
    externalSeriesId: identity.externalSeriesId.trim(),
    stability: identity.stability,
  };
}

function normalizePattern(pattern: RecurrencePattern): RecurrencePattern {
  if (pattern.type !== 'weekly') return { ...pattern };
  const weekdayOrder = new Map(RECURRENCE_WEEKDAYS.map((day, index) => [day, index]));
  return {
    ...pattern,
    daysOfWeek: [...new Set(pattern.daysOfWeek)]
      .sort((left, right) => weekdayOrder.get(left)! - weekdayOrder.get(right)!),
  };
}

function normalizeSource(source: RecurrenceSource): RecurrenceSource {
  if (source.owner === 'mission-control') {
    return {
      owner: 'mission-control',
      support: { status: 'supported', reasons: [] },
    };
  }
  return {
    owner: 'connector',
    connectorType: source.connectorType.trim(),
    connectorInstanceId: source.connectorInstanceId.trim(),
    support: {
      status: source.support.status,
      reasons: [...new Set(source.support.reasons)].sort(),
    },
    raw: source.raw,
  };
}

function normalizeSemantics(
  semantics: CanonicalRecurrenceSemanticsV1,
): CanonicalRecurrenceSemanticsV1 {
  return {
    mode: semantics.mode,
    timezone: {
      id: semantics.timezone.id.trim(),
      kind: semantics.timezone.kind,
      dstPolicy: 'preserve-wall-clock',
      gapPolicy: 'shift-forward',
      overlapPolicy: 'earlier-offset',
    },
    start: {
      date: semantics.start.date,
      localTime: semantics.start.localTime?.length === 5
        ? `${semantics.start.localTime}:00`
        : semantics.start.localTime,
    },
    pattern: normalizePattern(semantics.pattern),
    end: { ...semantics.end },
    exceptions: {
      skipDates: [...new Set(semantics.exceptions.skipDates)].sort(),
    },
    materialization: {
      strategy: semantics.mode === 'completion' ? 'on-completion' : 'on-schedule',
      catchUp: semantics.mode === 'completion' ? 'none' : semantics.materialization.catchUp,
    },
  };
}

function semanticIssues(
  semantics: CanonicalRecurrenceSemanticsV1,
  source: RecurrenceSource,
  seriesIdentity: RecurrenceSeriesIdentity,
): string[] {
  const issues: string[] = [];
  if (!isCalendarDate(semantics.start.date)) issues.push('start.date must be a calendar date');
  if (semantics.start.localTime !== null && !TIME_PATTERN.test(semantics.start.localTime)) {
    issues.push('start.localTime must be HH:mm or HH:mm:ss');
  }
  if (semantics.timezone.kind === 'iana' && !isIanaTimezone(semantics.timezone.id)) {
    issues.push('timezone.id must be a valid IANA timezone');
  }
  if (
    semantics.timezone.kind === 'provider'
    && (source.owner !== 'connector' || source.support.status === 'supported')
  ) {
    issues.push('provider timezone identifiers require an explicit lossy connector source');
  }
  if (semantics.end.type === 'date') {
    if (!isCalendarDate(semantics.end.date)) {
      issues.push('end.date must be a calendar date');
    } else if (isCalendarDate(semantics.start.date) && semantics.end.date < semantics.start.date) {
      issues.push('end.date must not precede start.date');
    }
  }
  for (const date of semantics.exceptions.skipDates) {
    if (!isCalendarDate(date)) {
      issues.push(`exceptions.skipDates contains an invalid date: ${date}`);
    } else if (isCalendarDate(semantics.start.date) && date < semantics.start.date) {
      issues.push(`exceptions.skipDates contains a date before start.date: ${date}`);
    }
  }
  if (semantics.pattern.type === 'yearly') {
    const maxDay = daysInMonth(2000, semantics.pattern.month);
    if (semantics.pattern.dayOfMonth > maxDay) {
      issues.push('yearly pattern dayOfMonth is invalid for month');
    }
  }
  if (
    semantics.mode === 'completion'
    && (
      semantics.materialization.strategy !== 'on-completion'
      || semantics.materialization.catchUp !== 'none'
    )
  ) {
    issues.push('completion mode must materialize on completion without catch-up');
  }
  if (semantics.mode === 'schedule' && semantics.materialization.strategy !== 'on-schedule') {
    issues.push('schedule mode must materialize on schedule');
  }
  if (
    source.owner === 'connector'
    && source.support.status !== 'supported'
    && source.support.reasons.length === 0
  ) {
    issues.push('lossy and unsupported imports require support reasons');
  }
  if (
    source.owner === 'connector'
    && source.support.status === 'supported'
    && source.support.reasons.length > 0
  ) {
    issues.push('supported imports cannot include support reasons');
  }
  if (semantics.pattern.type === 'unsupported') {
    if (source.owner !== 'connector' || source.support.status === 'supported') {
      issues.push('unsupported patterns require an explicit lossy or unsupported connector source');
    }
  } else if (source.owner === 'connector' && source.support.status === 'unsupported') {
    issues.push('unsupported imports cannot contain executable recurrence semantics');
  }
  if (source.owner === 'connector' && !isJsonValue(source.raw)) {
    issues.push('connector source raw must be JSON-compatible');
  }
  if (source.owner === 'connector') {
    const identityConnectorInstanceId = seriesIdentity.connectorInstanceId;
    if (identityConnectorInstanceId !== source.connectorInstanceId) {
      issues.push('series identity and source must use the same connector instance');
    }
    if (
      seriesIdentity.kind === 'connector'
      && seriesIdentity.connectorType !== source.connectorType
    ) {
      issues.push('series identity and source must use the same connector type');
    }
  }
  return issues;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function normalizeDraft(draft: CanonicalRecurrenceDraftV1): CanonicalRecurrenceDraftV1 {
  return {
    seriesIdentity: normalizeSeriesIdentity(draft.seriesIdentity),
    semantics: normalizeSemantics(draft.semantics),
    source: normalizeSource(draft.source),
    compatibility: {
      legacyLabel: draft.compatibility?.legacyLabel?.trim() || null,
      migratedFrom: draft.compatibility?.migratedFrom ?? null,
    },
  };
}

/**
 * The exact canonical revision bytes. Only executable semantics and the stable
 * series ID participate. Mutable provenance, raw provider payloads, support
 * diagnostics, and display compatibility labels are intentionally excluded.
 */
export function canonicalRecurrenceRevisionBytes(input: {
  readonly seriesId: string;
  readonly semantics: CanonicalRecurrenceSemanticsV1;
}): string {
  return canonicalJson({
    semantics: normalizeSemantics(input.semantics),
    seriesId: input.seriesId,
    version: CANONICAL_RECURRENCE_VERSION,
  });
}

export function createCanonicalRecurrenceRule(
  draftInput: CanonicalRecurrenceDraftV1,
): CanonicalRecurrenceRuleV1 {
  const draft = normalizeDraft(draftInput);
  const structural = z.strictObject({
    seriesIdentity: seriesIdentitySchema,
    semantics: semanticsSchema,
    source: sourceSchema,
    compatibility: z.strictObject({
      legacyLabel: z.string().nullable(),
      migratedFrom: z.literal('legacy-string').nullable(),
    }),
  }).safeParse(draft);
  if (!structural.success) {
    throw new Error(`Invalid canonical recurrence: ${structural.error.issues[0].message}`);
  }
  const issues = semanticIssues(draft.semantics, draft.source, draft.seriesIdentity);
  if (issues.length > 0) throw new Error(`Invalid canonical recurrence: ${issues.join('; ')}`);

  const seriesId = hashCanonical('series', {
    identity: draft.seriesIdentity,
    version: CANONICAL_RECURRENCE_VERSION,
  });
  const revisionId = hashCanonical(
    'revision',
    JSON.parse(canonicalRecurrenceRevisionBytes({ seriesId, semantics: draft.semantics })),
  );
  return {
    version: CANONICAL_RECURRENCE_VERSION,
    series: {
      id: seriesId,
      identity: draft.seriesIdentity,
    },
    revision: { id: revisionId },
    semantics: draft.semantics,
    source: draft.source,
    compatibility: {
      legacyLabel: draft.compatibility?.legacyLabel ?? null,
      migratedFrom: draft.compatibility?.migratedFrom ?? null,
    },
  };
}

export function parseCanonicalRecurrenceRule(
  value: unknown,
): { readonly success: true; readonly rule: CanonicalRecurrenceRuleV1 }
  | { readonly success: false; readonly issues: readonly string[] } {
  let parsedValue = value;
  if (typeof value === 'string') {
    try {
      parsedValue = JSON.parse(value) as unknown;
    } catch {
      return { success: false, issues: ['canonical recurrence is not valid JSON'] };
    }
  }
  const parsed = canonicalRuleSchema.safeParse(parsedValue);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  const issues = semanticIssues(
    parsed.data.semantics,
    parsed.data.source,
    parsed.data.series.identity,
  );
  if (issues.length > 0) return { success: false, issues };
  try {
    const normalized = createCanonicalRecurrenceRule({
      seriesIdentity: parsed.data.series.identity,
      semantics: parsed.data.semantics,
      source: parsed.data.source,
      compatibility: parsed.data.compatibility,
    });
    if (normalized.series.id !== parsed.data.series.id) {
      issues.push('series.id does not match canonical series identity');
    }
    if (normalized.revision.id !== parsed.data.revision.id) {
      issues.push('revision.id does not match canonical recurrence semantics');
    }
    return issues.length > 0
      ? { success: false, issues }
      : { success: true, rule: normalized };
  } catch (error) {
    return {
      success: false,
      issues: [error instanceof Error ? error.message : 'invalid canonical recurrence'],
    };
  }
}

export function serializeCanonicalRecurrenceRule(rule: CanonicalRecurrenceRuleV1): string {
  const parsed = parseCanonicalRecurrenceRule(rule);
  if (!parsed.success) {
    throw new Error(`Invalid canonical recurrence: ${parsed.issues.join('; ')}`);
  }
  return canonicalJson(parsed.rule);
}

function legacyPattern(recurrence: string, startDate: string): RecurrencePattern | null {
  const normalized = recurrence.trim().toLowerCase();
  if (normalized === 'daily') return { type: 'daily', interval: 1 };
  if (normalized === 'weekdays') {
    return {
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    };
  }
  const startDay = new Date(`${startDate}T00:00:00.000Z`).getUTCDay();
  const startWeekday = RECURRENCE_WEEKDAYS[(startDay + 6) % 7];
  if (normalized === 'weekly') {
    return { type: 'weekly', interval: 1, daysOfWeek: [startWeekday] };
  }
  if (normalized === 'biweekly') {
    return { type: 'weekly', interval: 2, daysOfWeek: [startWeekday] };
  }
  const [, month, day] = startDate.split('-').map(Number);
  if (normalized === 'monthly') return { type: 'monthly', interval: 1, dayOfMonth: day };
  if (normalized === 'yearly') {
    return { type: 'yearly', interval: 1, month, dayOfMonth: day };
  }
  const intervalMatch = normalized.match(/^every (\d+) (days?|weeks?|months?|years?)$/);
  if (intervalMatch) {
    const interval = Number(intervalMatch[1]);
    if (interval < 1) return null;
    const unit = intervalMatch[2].replace(/s$/, '');
    if (unit === 'day') return { type: 'daily', interval };
    if (unit === 'week') {
      return { type: 'weekly', interval, daysOfWeek: [startWeekday] };
    }
    if (unit === 'month') return { type: 'monthly', interval, dayOfMonth: day };
    return { type: 'yearly', interval, month, dayOfMonth: day };
  }
  const weeklyMatch = normalized.match(/^(?:weekly|every (\d+) weeks?) \(([^)]+)\)$/);
  if (!weeklyMatch) return null;
  const days = weeklyMatch[2].split(',').map((dayName) => dayName.trim());
  if (days.some((dayName) => !RECURRENCE_WEEKDAYS.includes(dayName as RecurrenceWeekday))) {
    return null;
  }
  return {
    type: 'weekly',
    interval: weeklyMatch[1] ? Number(weeklyMatch[1]) : 1,
    daysOfWeek: days as RecurrenceWeekday[],
  };
}

export function canonicalizeLegacyRecurrence(
  input: LegacyRecurrenceInput,
): CanonicalRecurrenceRuleV1 {
  if (!isCalendarDate(input.startDate)) {
    throw new Error('Invalid canonical recurrence: startDate must be a calendar date');
  }
  const pattern = legacyPattern(input.recurrence, input.startDate);
  const source = input.source ?? {
    owner: 'mission-control',
    support: { status: 'supported', reasons: [] },
  };
  if (!pattern && source.owner === 'mission-control') {
    throw new Error(`Invalid canonical recurrence: unsupported recurrence "${input.recurrence}"`);
  }
  const effectiveSource: RecurrenceSource = pattern || source.owner === 'mission-control'
    ? source
    : {
        ...source,
        support: {
          status: 'unsupported',
          reasons: [...source.support.reasons, 'unsupported_legacy_recurrence'],
        },
      };
  return createCanonicalRecurrenceRule({
    seriesIdentity: input.seriesIdentity,
    semantics: {
      mode: input.mode,
      timezone: {
        id: input.timezone,
        kind: isIanaTimezone(input.timezone) ? 'iana' : 'provider',
        dstPolicy: 'preserve-wall-clock',
        gapPolicy: 'shift-forward',
        overlapPolicy: 'earlier-offset',
      },
      start: {
        date: input.startDate,
        localTime: input.localTime ?? null,
      },
      pattern: pattern ?? { type: 'unsupported' },
      end: { type: 'never' },
      exceptions: { skipDates: [] },
      materialization: {
        strategy: input.mode === 'completion' ? 'on-completion' : 'on-schedule',
        catchUp: input.mode === 'completion' ? 'none' : 'latest',
      },
    },
    source: effectiveSource,
    compatibility: {
      legacyLabel: input.recurrence,
      migratedFrom: 'legacy-string',
    },
  });
}

export function readRecurrenceMetadata(
  metadata: unknown,
  legacy?: Omit<LegacyRecurrenceInput, 'recurrence'>,
): ParsedRecurrenceMetadata {
  let parsedMetadata = metadata;
  for (let depth = 0; depth < 2 && typeof parsedMetadata === 'string'; depth++) {
    try {
      parsedMetadata = JSON.parse(parsedMetadata) as unknown;
    } catch {
      return { rule: null, status: 'invalid', issues: ['task metadata is not valid JSON'] };
    }
  }
  const record = parsedMetadata && typeof parsedMetadata === 'object' && !Array.isArray(parsedMetadata)
    ? parsedMetadata as Record<string, unknown>
    : {};
  if (
    record[CANONICAL_RECURRENCE_METADATA_KEY] !== undefined
    && record[CANONICAL_RECURRENCE_METADATA_KEY] !== null
  ) {
    const parsed = parseCanonicalRecurrenceRule(record[CANONICAL_RECURRENCE_METADATA_KEY]);
    return parsed.success
      ? { rule: parsed.rule, status: 'canonical', issues: [] }
      : { rule: null, status: 'invalid', issues: parsed.issues };
  }
  if (typeof record.recurrence !== 'string') {
    return { rule: null, status: 'absent', issues: [] };
  }
  if (!legacy) {
    return {
      rule: null,
      status: 'legacy',
      issues: ['legacy recurrence requires explicit identity, start date, mode, and timezone'],
    };
  }
  try {
    return {
      rule: canonicalizeLegacyRecurrence({ ...legacy, recurrence: record.recurrence }),
      status: 'legacy',
      issues: [],
    };
  } catch (error) {
    return {
      rule: null,
      status: 'invalid',
      issues: [error instanceof Error ? error.message : 'invalid legacy recurrence'],
    };
  }
}

export function writeRecurrenceMetadata(
  metadata: Record<string, unknown>,
  rule: CanonicalRecurrenceRuleV1 | null,
): Record<string, unknown> {
  const next = { ...metadata };
  if (rule) {
    const parsed = parseCanonicalRecurrenceRule(rule);
    if (!parsed.success) {
      throw new Error(
        `Cannot write invalid canonical recurrence metadata: ${parsed.issues.join('; ')}`,
      );
    }
    next[CANONICAL_RECURRENCE_METADATA_KEY] = parsed.rule;
  } else {
    delete next[CANONICAL_RECURRENCE_METADATA_KEY];
  }
  return next;
}
