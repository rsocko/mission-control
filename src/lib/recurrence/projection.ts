import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { canonicalJson } from '@/db/persistence/value-codecs';
import {
  RECURRENCE_WEEKDAYS,
  parseCanonicalRecurrenceRule,
  type CanonicalRecurrenceRuleV1,
  type RecurrencePattern,
} from '@/lib/recurrence/canonical';

const MILLISECONDS_PER_DAY = 86_400_000;

export const RECURRENCE_PROJECTION_LIMITS = {
  maxRangeDays: 3_660,
  maxIterations: 50_000,
  maxOccurrences: 10_000,
  maxCompletionAnchors: 10_000,
} as const;

export type RecurrenceProjectionRange =
  | {
      readonly kind: 'local-date';
      readonly startInclusive: string;
      readonly endExclusive: string;
    }
  | {
      readonly kind: 'instant';
      readonly startInclusive: string;
      readonly endExclusive: string;
    };

export interface RecurrenceCompletionAnchor {
  readonly completedAt: string;
  /**
   * One-based position of the completed occurrence in the recurrence set.
   * It is optional except when the canonical rule has a count boundary.
   */
  readonly occurrenceNumber?: number;
}

export interface RecurrenceProjectionInput {
  readonly rule: unknown;
  readonly range: RecurrenceProjectionRange;
  readonly completionAnchors?: readonly RecurrenceCompletionAnchor[];
  /**
   * Callers may lower limits for a smaller work budget, but cannot raise the
   * engine's hard safety limits.
   */
  readonly limits?: {
    readonly maxRangeDays?: number;
    readonly maxIterations?: number;
    readonly maxOccurrences?: number;
    readonly maxCompletionAnchors?: number;
  };
}

export interface RecurrenceOccurrenceIdentityInput {
  readonly seriesId: string;
  readonly revisionId: string;
  readonly effective:
    | { readonly kind: 'local-date'; readonly value: string }
    | { readonly kind: 'instant'; readonly value: string };
}

export function serializeRecurrenceOccurrenceIdentity(
  identity: RecurrenceOccurrenceIdentityInput,
): string {
  return canonicalJson({
    effective: identity.effective,
    revisionId: identity.revisionId,
    seriesId: identity.seriesId,
    version: 1,
  });
}

export function createRecurrenceOccurrenceId(
  identity: RecurrenceOccurrenceIdentityInput,
): string {
  return `occurrence:v1:${serializeRecurrenceOccurrenceIdentity(identity)}`;
}

export interface ProjectedRecurrenceOccurrence {
  /** One-based canonical occurrence position when it can be known. */
  readonly occurrenceNumber: number | null;
  readonly localDate: string;
  readonly localTime: string | null;
  readonly instant: string | null;
  readonly identity: RecurrenceOccurrenceIdentityInput;
  readonly anchor:
    | { readonly kind: 'schedule'; readonly startDate: string }
    | { readonly kind: 'completion'; readonly completedAt: string };
}

export type RecurrenceProjectionResult =
  | {
      readonly status: 'success';
      readonly occurrences: readonly ProjectedRecurrenceOccurrence[];
      readonly iterations: number;
    }
  | {
      readonly status: 'invalid';
      readonly issues: readonly string[];
    }
  | {
      readonly status: 'unsupported';
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'bounds-exceeded';
      readonly bound: 'range' | 'iterations' | 'occurrences' | 'completion-anchors';
      readonly maximum: number;
    };

interface EffectiveLimits {
  readonly maxRangeDays: number;
  readonly maxIterations: number;
  readonly maxOccurrences: number;
  readonly maxCompletionAnchors: number;
}

interface ParsedRange {
  readonly range: RecurrenceProjectionRange;
  readonly startValue: number | string;
  readonly endValue: number | string;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface Candidate {
  readonly nominalDate: string;
  readonly occurrenceNumber: number | null;
}

interface ResolvedOccurrence {
  readonly localDate: string;
  readonly localTime: string | null;
  readonly instant: string | null;
}

interface WorkBudget {
  iterations: number;
  readonly maximum: number;
}

interface NormalizedCompletionAnchor {
  readonly completedAt: string;
  readonly occurrenceNumber: number | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_INSTANT_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

function parseCalendarDate(value: string): CalendarDate | null {
  if (!DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function toEpochDay(value: string): number {
  const date = parseCalendarDate(value)!;
  return Date.UTC(date.year, date.month - 1, date.day) / MILLISECONDS_PER_DAY;
}

function fromEpochDay(value: number): string {
  return new Date(value * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

function addCalendarDays(value: string, days: number): string {
  return fromEpochDay(toEpochDay(value) + days);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateForMonthIndex(monthIndex: number, dayOfMonth: number): string | null {
  const year = Math.floor(monthIndex / 12);
  const monthIndexWithinYear = monthIndex - year * 12;
  const month = monthIndexWithinYear + 1;
  if (dayOfMonth > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

function consumeIteration(budget: WorkBudget): boolean {
  budget.iterations += 1;
  return budget.iterations <= budget.maximum;
}

function parseExplicitInstant(value: string): string | null {
  if (!EXPLICIT_INSTANT_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function effectiveLimits(
  input: RecurrenceProjectionInput['limits'],
): { readonly success: true; readonly limits: EffectiveLimits }
  | { readonly success: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const readLimit = (
    key: keyof EffectiveLimits,
    hardMaximum: number,
  ): number => {
    const value = input?.[key];
    if (value === undefined) return hardMaximum;
    if (!Number.isInteger(value) || value < 1 || value > hardMaximum) {
      issues.push(`limits.${key} must be an integer from 1 through ${hardMaximum}`);
      return hardMaximum;
    }
    return value;
  };
  const limits = {
    maxRangeDays: readLimit('maxRangeDays', RECURRENCE_PROJECTION_LIMITS.maxRangeDays),
    maxIterations: readLimit('maxIterations', RECURRENCE_PROJECTION_LIMITS.maxIterations),
    maxOccurrences: readLimit('maxOccurrences', RECURRENCE_PROJECTION_LIMITS.maxOccurrences),
    maxCompletionAnchors: readLimit(
      'maxCompletionAnchors',
      RECURRENCE_PROJECTION_LIMITS.maxCompletionAnchors,
    ),
  };
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, limits };
}

function parseRange(
  range: RecurrenceProjectionRange,
  limits: EffectiveLimits,
): { readonly success: true; readonly parsed: ParsedRange }
  | { readonly success: false; readonly result: RecurrenceProjectionResult } {
  if (range.kind === 'local-date') {
    if (!parseCalendarDate(range.startInclusive) || !parseCalendarDate(range.endExclusive)) {
      return {
        success: false,
        result: {
          status: 'invalid',
          issues: ['local-date range boundaries must be calendar dates'],
        },
      };
    }
    const start = toEpochDay(range.startInclusive);
    const end = toEpochDay(range.endExclusive);
    if (end <= start) {
      return {
        success: false,
        result: {
          status: 'invalid',
          issues: ['range.endExclusive must be after range.startInclusive'],
        },
      };
    }
    if (end - start > limits.maxRangeDays) {
      return {
        success: false,
        result: {
          status: 'bounds-exceeded',
          bound: 'range',
          maximum: limits.maxRangeDays,
        },
      };
    }
    return {
      success: true,
      parsed: { range, startValue: range.startInclusive, endValue: range.endExclusive },
    };
  }

  const start = parseExplicitInstant(range.startInclusive);
  const end = parseExplicitInstant(range.endExclusive);
  if (!start || !end) {
    return {
      success: false,
      result: {
        status: 'invalid',
        issues: ['instant range boundaries must include a UTC offset or Z suffix'],
      },
    };
  }
  const startMilliseconds = new Date(start).getTime();
  const endMilliseconds = new Date(end).getTime();
  if (endMilliseconds <= startMilliseconds) {
    return {
      success: false,
      result: {
        status: 'invalid',
        issues: ['range.endExclusive must be after range.startInclusive'],
      },
    };
  }
  if (
    Math.ceil((endMilliseconds - startMilliseconds) / MILLISECONDS_PER_DAY)
    > limits.maxRangeDays
  ) {
    return {
      success: false,
      result: {
        status: 'bounds-exceeded',
        bound: 'range',
        maximum: limits.maxRangeDays,
      },
    };
  }
  return {
    success: true,
    parsed: {
      range,
      startValue: startMilliseconds,
      endValue: endMilliseconds,
    },
  };
}

function unsupportedReasons(rule: CanonicalRecurrenceRuleV1): string[] {
  const reasons = rule.source.owner === 'connector'
    ? [...rule.source.support.reasons]
    : [];
  if (rule.semantics.pattern.type === 'unsupported') {
    reasons.push('unsupported_pattern');
  }
  if (
    rule.semantics.timezone.kind === 'provider'
    && (rule.semantics.start.localTime !== null || rule.semantics.mode === 'completion')
  ) {
    reasons.push('provider_timezone_not_projectable');
  }
  return [...new Set(reasons)].sort();
}

function resolveWallClock(
  nominalDate: string,
  localTime: string | null,
  timezone: string,
): ResolvedOccurrence {
  if (localTime === null) {
    return { localDate: nominalDate, localTime: null, instant: null };
  }

  const requestedWallTime = `${nominalDate}T${localTime}`;
  const initial = fromZonedTime(requestedWallTime, timezone);
  const requestedAsUtc = new Date(`${requestedWallTime}Z`).getTime();
  const offsets = new Set<number>();
  for (const dayOffset of [-3, -1, 0, 1, 3]) {
    const sample = new Date(initial.getTime() + dayOffset * MILLISECONDS_PER_DAY);
    const rendered = formatInTimeZone(sample, timezone, "yyyy-MM-dd'T'HH:mm:ss");
    offsets.add(new Date(`${rendered}Z`).getTime() - sample.getTime());
  }
  const candidates = [...offsets].map((offset) => {
    const instant = new Date(requestedAsUtc - offset);
    return {
      instant,
      rendered: formatInTimeZone(instant, timezone, "yyyy-MM-dd'T'HH:mm:ss"),
    };
  });
  const exactMatches = candidates
    .filter((candidate) => candidate.rendered === requestedWallTime)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime());

  // Folds have two exact matches; v1 selects the chronologically earlier one.
  // Gaps have none; the earliest valid wall time after the request preserves
  // the requested minutes while shifting forward by the transition gap.
  const resolved = exactMatches[0]?.instant
    ?? candidates
      .filter((candidate) => candidate.rendered > requestedWallTime)
      .sort((left, right) => (
        left.rendered.localeCompare(right.rendered)
        || left.instant.getTime() - right.instant.getTime()
      ))[0]?.instant
    ?? initial;

  return {
    localDate: formatInTimeZone(resolved, timezone, 'yyyy-MM-dd'),
    localTime: formatInTimeZone(resolved, timezone, 'HH:mm:ss'),
    instant: resolved.toISOString(),
  };
}

function isInRange(occurrence: ResolvedOccurrence, range: ParsedRange): boolean {
  if (range.range.kind === 'local-date') {
    return occurrence.localDate >= (range.startValue as string)
      && occurrence.localDate < (range.endValue as string);
  }
  const instant = new Date(occurrence.instant!).getTime();
  return instant >= (range.startValue as number) && instant < (range.endValue as number);
}

function isAtOrAfterRangeEnd(occurrence: ResolvedOccurrence, range: ParsedRange): boolean {
  if (range.range.kind === 'local-date') {
    return occurrence.localDate >= (range.endValue as string);
  }
  return new Date(occurrence.instant!).getTime() >= (range.endValue as number);
}

function identityFor(
  rule: CanonicalRecurrenceRuleV1,
  occurrence: ResolvedOccurrence,
): RecurrenceOccurrenceIdentityInput {
  return {
    seriesId: rule.series.id,
    revisionId: rule.revision.id,
    effective: occurrence.instant === null
      ? { kind: 'local-date', value: occurrence.localDate }
      : { kind: 'instant', value: occurrence.instant },
  };
}

function weekdayIndex(date: string): number {
  const dateParts = parseCalendarDate(date)!;
  const sundayBased = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day),
  ).getUTCDay();
  return (sundayBased + 6) % 7;
}

function* scheduleCandidates(
  rule: CanonicalRecurrenceRuleV1,
  budget: WorkBudget,
): Generator<Candidate, 'iterations' | undefined> {
  const { pattern, start } = rule.semantics;
  const end = rule.semantics.end;
  let occurrenceNumber = 0;

  function* daily(): Generator<Candidate, 'iterations' | undefined> {
    let date = start.date;
    while (true) {
      if (!consumeIteration(budget)) return 'iterations';
      occurrenceNumber += 1;
      yield { nominalDate: date, occurrenceNumber };
      date = addCalendarDays(date, pattern.type === 'daily' ? pattern.interval : 1);
    }
  }

  function* weekly(
    weeklyPattern: Extract<RecurrencePattern, { type: 'weekly' }>,
  ): Generator<Candidate, 'iterations' | undefined> {
    const weekStart = addCalendarDays(start.date, -weekdayIndex(start.date));
    const dayIndexes = weeklyPattern.daysOfWeek.map((day) => RECURRENCE_WEEKDAYS.indexOf(day));
    let activeWeek = weekStart;
    while (true) {
      for (const dayIndex of dayIndexes) {
        if (!consumeIteration(budget)) return 'iterations';
        const date = addCalendarDays(activeWeek, dayIndex);
        if (date < start.date) continue;
        occurrenceNumber += 1;
        yield { nominalDate: date, occurrenceNumber };
      }
      activeWeek = addCalendarDays(activeWeek, weeklyPattern.interval * 7);
    }
  }

  function* monthly(
    monthlyPattern: Extract<RecurrencePattern, { type: 'monthly' }>,
  ): Generator<Candidate, 'iterations' | undefined> {
    const startParts = parseCalendarDate(start.date)!;
    let monthIndex = startParts.year * 12 + startParts.month - 1;
    while (true) {
      if (!consumeIteration(budget)) return 'iterations';
      const date = dateForMonthIndex(monthIndex, monthlyPattern.dayOfMonth);
      if (date && date >= start.date) {
        occurrenceNumber += 1;
        yield { nominalDate: date, occurrenceNumber };
      }
      monthIndex += monthlyPattern.interval;
    }
  }

  function* yearly(
    yearlyPattern: Extract<RecurrencePattern, { type: 'yearly' }>,
  ): Generator<Candidate, 'iterations' | undefined> {
    let year = parseCalendarDate(start.date)!.year;
    while (true) {
      if (!consumeIteration(budget)) return 'iterations';
      const date = dateForMonthIndex(
        year * 12 + yearlyPattern.month - 1,
        yearlyPattern.dayOfMonth,
      );
      if (date && date >= start.date) {
        occurrenceNumber += 1;
        yield { nominalDate: date, occurrenceNumber };
      }
      year += yearlyPattern.interval;
    }
  }

  const candidates = pattern.type === 'daily'
    ? daily()
    : pattern.type === 'weekly'
      ? weekly(pattern)
      : pattern.type === 'monthly'
        ? monthly(pattern)
        : pattern.type === 'yearly'
          ? yearly(pattern)
          : daily();

  while (true) {
    const next = candidates.next();
    if (next.done) return next.value;
    const candidate = next.value;
    if (end.type === 'count' && candidate.occurrenceNumber! > end.count) return undefined;
    if (end.type === 'date' && candidate.nominalDate > end.date) return undefined;
    yield candidate;
  }
}

function normalizeCompletionAnchors(
  anchors: readonly RecurrenceCompletionAnchor[],
): { readonly success: true; readonly anchors: readonly NormalizedCompletionAnchor[] }
  | { readonly success: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const byInstant = new Map<string, number | null>();
  for (const [index, anchor] of anchors.entries()) {
    const completedAt = parseExplicitInstant(anchor.completedAt);
    if (!completedAt) {
      issues.push(`completionAnchors.${index}.completedAt must include a UTC offset or Z suffix`);
      continue;
    }
    if (
      anchor.occurrenceNumber !== undefined
      && (!Number.isInteger(anchor.occurrenceNumber) || anchor.occurrenceNumber < 1)
    ) {
      issues.push(`completionAnchors.${index}.occurrenceNumber must be a positive integer`);
      continue;
    }
    const occurrenceNumber = anchor.occurrenceNumber ?? null;
    const priorOccurrenceNumber = byInstant.get(completedAt);
    if (
      priorOccurrenceNumber !== undefined
      && priorOccurrenceNumber !== occurrenceNumber
    ) {
      issues.push(`completion anchor ${completedAt} has conflicting occurrence numbers`);
      continue;
    }
    byInstant.set(completedAt, occurrenceNumber);
  }
  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    anchors: [...byInstant.entries()]
      .map(([completedAt, occurrenceNumber]) => ({ completedAt, occurrenceNumber }))
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt)),
  };
}

function completionWallClock(
  completedAt: string,
  timezone: string,
): { readonly date: string; readonly time: string } {
  const completed = new Date(completedAt);
  return {
    date: formatInTimeZone(completed, timezone, 'yyyy-MM-dd'),
    time: formatInTimeZone(completed, timezone, 'HH:mm:ss'),
  };
}

function nextCompletionCandidate(
  fromDate: string,
  pattern: Exclude<RecurrencePattern, { type: 'unsupported' }>,
  budget: WorkBudget,
): string | null {
  if (pattern.type === 'daily') {
    return consumeIteration(budget) ? addCalendarDays(fromDate, pattern.interval) : null;
  }
  if (pattern.type === 'weekly') {
    if (!consumeIteration(budget)) return null;
    if (pattern.interval > 1) {
      const currentDay = weekdayIndex(fromDate);
      const laterDay = pattern.daysOfWeek
        .map((day) => RECURRENCE_WEEKDAYS.indexOf(day))
        .find((day) => day > currentDay);
      if (laterDay !== undefined) {
        return addCalendarDays(fromDate, laterDay - currentDay);
      }
      const targetWeekStart = addCalendarDays(
        fromDate,
        -weekdayIndex(fromDate) + pattern.interval * 7,
      );
      const firstDay = RECURRENCE_WEEKDAYS.indexOf(pattern.daysOfWeek[0]);
      return addCalendarDays(targetWeekStart, firstDay);
    }
    let date = fromDate;
    for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
      if (!consumeIteration(budget)) return null;
      date = addCalendarDays(date, 1);
      if (pattern.daysOfWeek.includes(RECURRENCE_WEEKDAYS[weekdayIndex(date)])) {
        return date;
      }
    }
    return null;
  }
  if (pattern.type === 'monthly') {
    const parts = parseCalendarDate(fromDate)!;
    let monthIndex = parts.year * 12 + parts.month - 1 + pattern.interval;
    while (true) {
      if (!consumeIteration(budget)) return null;
      const date = dateForMonthIndex(monthIndex, pattern.dayOfMonth);
      if (date) return date;
      monthIndex += pattern.interval;
    }
  }

  let year = parseCalendarDate(fromDate)!.year + pattern.interval;
  while (true) {
    if (!consumeIteration(budget)) return null;
    const date = dateForMonthIndex(year * 12 + pattern.month - 1, pattern.dayOfMonth);
    if (date) return date;
    year += pattern.interval;
  }
}

function projectSchedule(
  rule: CanonicalRecurrenceRuleV1,
  range: ParsedRange,
  limits: EffectiveLimits,
): RecurrenceProjectionResult {
  const occurrences: ProjectedRecurrenceOccurrence[] = [];
  const effectiveIdentities = new Set<string>();
  const budget: WorkBudget = { iterations: 0, maximum: limits.maxIterations };
  const skipDates = new Set(rule.semantics.exceptions.skipDates);
  const candidates = scheduleCandidates(rule, budget);

  while (true) {
    const next = candidates.next();
    if (next.done) {
      return next.value === 'iterations'
        ? {
            status: 'bounds-exceeded',
            bound: 'iterations',
            maximum: limits.maxIterations,
          }
        : { status: 'success', occurrences, iterations: budget.iterations };
    }
    const candidate = next.value;
    const resolved = resolveWallClock(
      candidate.nominalDate,
      rule.semantics.start.localTime,
      rule.semantics.timezone.id,
    );
    if (isAtOrAfterRangeEnd(resolved, range)) {
      return { status: 'success', occurrences, iterations: budget.iterations };
    }
    if (!skipDates.has(candidate.nominalDate) && isInRange(resolved, range)) {
      const identity = identityFor(rule, resolved);
      const identityKey = `${identity.effective.kind}:${identity.effective.value}`;
      if (effectiveIdentities.has(identityKey)) continue;
      if (occurrences.length >= limits.maxOccurrences) {
        return {
          status: 'bounds-exceeded',
          bound: 'occurrences',
          maximum: limits.maxOccurrences,
        };
      }
      occurrences.push({
        occurrenceNumber: candidate.occurrenceNumber,
        ...resolved,
        identity,
        anchor: { kind: 'schedule', startDate: rule.semantics.start.date },
      });
      effectiveIdentities.add(identityKey);
    }
  }
}

function projectCompletion(
  rule: CanonicalRecurrenceRuleV1,
  range: ParsedRange,
  limits: EffectiveLimits,
  completionAnchors: readonly RecurrenceCompletionAnchor[] | undefined,
): RecurrenceProjectionResult {
  if (!completionAnchors) {
    return {
      status: 'invalid',
      issues: ['completion mode requires completionAnchors'],
    };
  }
  if (completionAnchors.length > limits.maxCompletionAnchors) {
    return {
      status: 'bounds-exceeded',
      bound: 'completion-anchors',
      maximum: limits.maxCompletionAnchors,
    };
  }
  const normalized = normalizeCompletionAnchors(completionAnchors);
  if (!normalized.success) return { status: 'invalid', issues: normalized.issues };
  if (
    rule.semantics.end.type === 'count'
    && normalized.anchors.some((anchor) => anchor.occurrenceNumber === null)
  ) {
    return {
      status: 'unsupported',
      reasons: ['completion_count_requires_occurrence_number'],
    };
  }

  const pattern = rule.semantics.pattern;
  if (pattern.type === 'unsupported') {
    return { status: 'unsupported', reasons: ['unsupported_pattern'] };
  }

  const budget: WorkBudget = { iterations: 0, maximum: limits.maxIterations };
  const skipDates = new Set(rule.semantics.exceptions.skipDates);
  const projected = new Map<string, ProjectedRecurrenceOccurrence>();

  for (const anchor of normalized.anchors) {
    const completion = completionWallClock(anchor.completedAt, rule.semantics.timezone.id);
    if (completion.date < rule.semantics.start.date) {
      return {
        status: 'invalid',
        issues: [`completion anchor ${anchor.completedAt} precedes recurrence start`],
      };
    }

    let candidateDate = completion.date;
    let occurrenceNumber = anchor.occurrenceNumber;
    do {
      candidateDate = nextCompletionCandidate(candidateDate, pattern, budget) ?? '';
      if (!candidateDate) {
        return {
          status: 'bounds-exceeded',
          bound: 'iterations',
          maximum: limits.maxIterations,
        };
      }
      if (occurrenceNumber !== null) occurrenceNumber += 1;
      if (
        rule.semantics.end.type === 'count'
        && occurrenceNumber! > rule.semantics.end.count
      ) {
        candidateDate = '';
        break;
      }
      if (
        rule.semantics.end.type === 'date'
        && candidateDate > rule.semantics.end.date
      ) {
        candidateDate = '';
        break;
      }
    } while (skipDates.has(candidateDate));

    if (!candidateDate) continue;
    const resolved = resolveWallClock(
      candidateDate,
      rule.semantics.start.localTime === null ? null : completion.time,
      rule.semantics.timezone.id,
    );
    if (!isInRange(resolved, range)) continue;

    const identity = identityFor(rule, resolved);
    const identityKey = `${identity.effective.kind}:${identity.effective.value}`;
    if (!projected.has(identityKey)) {
      projected.set(identityKey, {
        occurrenceNumber,
        ...resolved,
        identity,
        anchor: { kind: 'completion', completedAt: anchor.completedAt },
      });
    }
    if (projected.size > limits.maxOccurrences) {
      return {
        status: 'bounds-exceeded',
        bound: 'occurrences',
        maximum: limits.maxOccurrences,
      };
    }
  }

  const occurrences = [...projected.values()].sort((left, right) => (
    (left.instant ?? left.localDate).localeCompare(right.instant ?? right.localDate)
  ));
  return { status: 'success', occurrences, iterations: budget.iterations };
}

/**
 * Purely projects a canonical recurrence into a bounded half-open range:
 * `startInclusive <= occurrence < endExclusive`.
 *
 * Calendar recurrence is anchored to the original local calendar fields.
 * Missing monthly/yearly dates are skipped without drifting that anchor.
 * Count boundaries apply to the generated recurrence set before skip-date
 * exceptions, matching RRULE/EXDATE-style semantics.
 * Timed occurrences preserve wall-clock time; DST gaps shift forward by the
 * transition gap and folds select the earlier offset, as required by v1.
 *
 * Completion rules project only from explicit completion anchors. They never
 * invent future completion times or persist projected work.
 */
export function projectRecurrence(
  input: RecurrenceProjectionInput,
): RecurrenceProjectionResult {
  const parsedRule = parseCanonicalRecurrenceRule(input.rule);
  if (!parsedRule.success) return { status: 'invalid', issues: parsedRule.issues };

  const parsedLimits = effectiveLimits(input.limits);
  if (!parsedLimits.success) return { status: 'invalid', issues: parsedLimits.issues };

  const parsedRange = parseRange(input.range, parsedLimits.limits);
  if (!parsedRange.success) return parsedRange.result;

  const rule = parsedRule.rule;
  const unsupported = unsupportedReasons(rule);
  if (rule.semantics.pattern.type === 'unsupported') {
    return { status: 'unsupported', reasons: unsupported };
  }
  if (
    rule.semantics.timezone.kind === 'provider'
    && (rule.semantics.start.localTime !== null || rule.semantics.mode === 'completion')
  ) {
    return { status: 'unsupported', reasons: unsupported };
  }
  if (parsedRange.parsed.range.kind === 'instant' && rule.semantics.start.localTime === null) {
    return {
      status: 'invalid',
      issues: ['instant ranges require a timed recurrence'],
    };
  }

  return rule.semantics.mode === 'schedule'
    ? projectSchedule(rule, parsedRange.parsed, parsedLimits.limits)
    : projectCompletion(
        rule,
        parsedRange.parsed,
        parsedLimits.limits,
        input.completionAnchors,
      );
}
