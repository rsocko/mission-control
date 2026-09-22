import {
  parseCanonicalRecurrenceRule,
  type CanonicalRecurrenceRuleV1,
} from './canonical';
import {
  createRecurrenceOccurrenceId,
  type RecurrenceOccurrenceIdentityInput,
} from './projection';

export type RecurrenceOccurrenceAnchor =
  | { readonly kind: 'schedule'; readonly startDate: string }
  | { readonly kind: 'completion'; readonly completedAt: string };

export interface RecurrenceOccurrenceDescriptor {
  readonly localDate: string;
  readonly instant: string | null;
  readonly occurrenceNumber: number | null;
  readonly anchor: RecurrenceOccurrenceAnchor;
}

export interface RecurrenceOccurrenceProvenance {
  readonly occurrenceId: string;
  readonly seriesId: string;
  readonly ruleRevisionId: string;
  readonly effectiveKind: 'local-date' | 'instant';
  readonly effectiveValue: string;
  readonly localDate: string;
  readonly instant: string | null;
  readonly occurrenceNumber: number | null;
  readonly anchorKind: 'schedule' | 'completion';
  readonly anchorValue: string;
  readonly timezoneId: string;
  readonly timezoneKind: 'iana' | 'provider';
  readonly materializationStrategy: 'on-schedule' | 'on-completion';
  readonly sourceOwner: 'mission-control' | 'connector';
  readonly seriesIdentityKind: 'mission-control' | 'connector';
  readonly stableSeriesId: string | null;
  readonly connectorType: string | null;
  readonly connectorInstanceId: string | null;
  readonly externalSeriesId: string | null;
  readonly seriesStability: 'provider' | 'derived' | null;
}

export class RecurrenceOccurrenceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceOccurrenceIdentityError';
  }
}

export interface PersistedRecurrenceOccurrence extends RecurrenceOccurrenceProvenance {
  readonly taskId: string;
  readonly generatedFromTaskId: string | null;
  readonly createdAt: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireCalendarDate(value: string, field: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new RecurrenceOccurrenceIdentityError(`${field} must be a calendar date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new RecurrenceOccurrenceIdentityError(`${field} must be a calendar date`);
  }
}

function requireInstant(value: string, field: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RecurrenceOccurrenceIdentityError(`${field} must be a normalized ISO instant`);
  }
}

export function deriveRecurrenceOccurrenceProvenance(input: {
  readonly rule: unknown;
  readonly occurrence: RecurrenceOccurrenceDescriptor;
}): {
  readonly rule: CanonicalRecurrenceRuleV1;
  readonly identity: RecurrenceOccurrenceIdentityInput;
  readonly provenance: RecurrenceOccurrenceProvenance;
} {
  const parsed = parseCanonicalRecurrenceRule(input.rule);
  if (!parsed.success) {
    throw new RecurrenceOccurrenceIdentityError(
      `Invalid canonical recurrence: ${parsed.issues.join('; ')}`,
    );
  }
  const { rule } = parsed;
  const { occurrence } = input;
  requireCalendarDate(occurrence.localDate, 'occurrence.localDate');
  if (
    occurrence.occurrenceNumber !== null
    && (!Number.isInteger(occurrence.occurrenceNumber) || occurrence.occurrenceNumber < 1)
  ) {
    throw new RecurrenceOccurrenceIdentityError(
      'occurrence.occurrenceNumber must be a positive integer or null',
    );
  }
  if (occurrence.instant !== null) {
    requireInstant(occurrence.instant, 'occurrence.instant');
  }
  if (occurrence.anchor.kind === 'schedule') {
    requireCalendarDate(occurrence.anchor.startDate, 'occurrence.anchor.startDate');
  } else {
    requireInstant(occurrence.anchor.completedAt, 'occurrence.anchor.completedAt');
  }
  const expectedAnchor = rule.semantics.materialization.strategy === 'on-schedule'
    ? 'schedule'
    : 'completion';
  if (occurrence.anchor.kind !== expectedAnchor) {
    throw new RecurrenceOccurrenceIdentityError(
      `occurrence.anchor.kind must be ${expectedAnchor} for this recurrence rule`,
    );
  }

  const identity: RecurrenceOccurrenceIdentityInput = {
    seriesId: rule.series.id,
    revisionId: rule.revision.id,
    effective: occurrence.instant === null
      ? { kind: 'local-date', value: occurrence.localDate }
      : { kind: 'instant', value: occurrence.instant },
  };
  const seriesIdentity = rule.series.identity;
  const source = rule.source;
  return {
    rule,
    identity,
    provenance: {
      occurrenceId: createRecurrenceOccurrenceId(identity),
      seriesId: identity.seriesId,
      ruleRevisionId: identity.revisionId,
      effectiveKind: identity.effective.kind,
      effectiveValue: identity.effective.value,
      localDate: occurrence.localDate,
      instant: occurrence.instant,
      occurrenceNumber: occurrence.occurrenceNumber,
      anchorKind: occurrence.anchor.kind,
      anchorValue: occurrence.anchor.kind === 'schedule'
        ? occurrence.anchor.startDate
        : occurrence.anchor.completedAt,
      timezoneId: rule.semantics.timezone.id,
      timezoneKind: rule.semantics.timezone.kind,
      materializationStrategy: rule.semantics.materialization.strategy,
      sourceOwner: source.owner,
      seriesIdentityKind: seriesIdentity.kind,
      stableSeriesId: seriesIdentity.kind === 'mission-control'
        ? seriesIdentity.stableId
        : null,
      connectorType: source.owner === 'connector' ? source.connectorType : null,
      connectorInstanceId: source.owner === 'connector'
        ? source.connectorInstanceId
        : null,
      externalSeriesId: seriesIdentity.kind === 'connector'
        ? seriesIdentity.externalSeriesId
        : null,
      seriesStability: seriesIdentity.kind === 'connector'
        ? seriesIdentity.stability
        : null,
    },
  };
}

export function createPersistedRecurrenceOccurrence(
  provenance: RecurrenceOccurrenceProvenance,
  taskId: string,
  generatedFromTaskId: string | null,
  createdAt: string,
): PersistedRecurrenceOccurrence {
  return { ...provenance, taskId, generatedFromTaskId, createdAt };
}

export function assertRecurrenceOccurrenceTaskScope(
  task: { readonly connectorType: string; readonly connectorInstanceId: string },
  provenance: RecurrenceOccurrenceProvenance,
): void {
  if (provenance.sourceOwner === 'mission-control') {
    if (task.connectorType !== 'local') {
      throw new RecurrenceOccurrenceIdentityError(
        'Mission Control-owned recurrence occurrences must materialize as local tasks',
      );
    }
    return;
  }
  if (
    task.connectorType !== provenance.connectorType
    || task.connectorInstanceId !== provenance.connectorInstanceId
  ) {
    throw new RecurrenceOccurrenceIdentityError(
      'Connector-owned recurrence occurrence scope does not match the task source',
    );
  }
}

export function assertRecurrenceOccurrenceTiming(
  task: { readonly dueDate: string | null },
  schedule: { readonly taskId: string; readonly scheduledDate: string } | null,
  provenance: RecurrenceOccurrenceProvenance,
  taskId: string,
): void {
  if (task.dueDate !== provenance.effectiveValue) {
    throw new RecurrenceOccurrenceIdentityError(
      'Recurrence occurrence effective value must match the candidate task due date',
    );
  }
  if (schedule && (
    schedule.taskId !== taskId
    || schedule.scheduledDate !== provenance.localDate
  )) {
    throw new RecurrenceOccurrenceIdentityError(
      'Recurrence occurrence schedule must match the candidate task and local date',
    );
  }
}

const PROVENANCE_KEYS = [
  'occurrenceId',
  'seriesId',
  'ruleRevisionId',
  'effectiveKind',
  'effectiveValue',
  'localDate',
  'instant',
  'occurrenceNumber',
  'anchorKind',
  'anchorValue',
  'timezoneId',
  'timezoneKind',
  'materializationStrategy',
  'sourceOwner',
  'seriesIdentityKind',
  'stableSeriesId',
  'connectorType',
  'connectorInstanceId',
  'externalSeriesId',
  'seriesStability',
] as const satisfies readonly (keyof RecurrenceOccurrenceProvenance)[];

export function assertRecurrenceOccurrenceMatches(
  stored: PersistedRecurrenceOccurrence,
  expected: RecurrenceOccurrenceProvenance,
): void {
  const mismatched = PROVENANCE_KEYS.find((key) => stored[key] !== expected[key]);
  if (mismatched) {
    throw new RecurrenceOccurrenceIdentityError(
      `Stored recurrence occurrence conflicts on ${mismatched}`,
    );
  }
}
