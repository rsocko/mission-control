import {
  readRecurrenceMetadata,
  type CanonicalRecurrenceRuleV1,
} from '@/lib/recurrence/canonical';

export type RecurrenceOwner = 'mission-control' | 'provider';
export type RecurrenceWriteOperation =
  | 'create-series'
  | 'update-series'
  | 'delete-series'
  | 'create-occurrence'
  | 'update-occurrence'
  | 'delete-occurrence';

export interface ConnectorRecurrenceOwnership {
  readonly series: RecurrenceOwner;
  readonly occurrences: RecurrenceOwner;
}

export interface ConnectorRecurrenceContract {
  readonly imported: ConnectorRecurrenceOwnership;
  readonly writes?: Partial<Record<RecurrenceWriteOperation, readonly RecurrenceOwner[]>>;
}

export class ConnectorRecurrenceWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorRecurrenceWriteError';
  }
}

export function getCanonicalRecurrenceOwnership(
  rule: CanonicalRecurrenceRuleV1,
): ConnectorRecurrenceOwnership {
  return {
    series: rule.series.identity.kind === 'mission-control'
      ? 'mission-control'
      : 'provider',
    occurrences: rule.source.owner === 'mission-control'
      ? 'mission-control'
      : 'provider',
  };
}

export function getTaskRecurrenceOwnership(
  metadata: unknown,
  legacyOwnership?: ConnectorRecurrenceOwnership,
): ConnectorRecurrenceOwnership | null {
  const parsed = readRecurrenceMetadata(metadata);
  if (parsed.status === 'invalid') {
    throw new ConnectorRecurrenceWriteError(
      `Recurrence write denied: ${parsed.issues.join('; ')}`,
    );
  }
  if (parsed.rule) return getCanonicalRecurrenceOwnership(parsed.rule);
  if (parsed.status === 'legacy') return legacyOwnership ?? null;
  return null;
}

export function assertConnectorRecurrenceWriteAllowed(input: {
  readonly contract: ConnectorRecurrenceContract;
  readonly operation: RecurrenceWriteOperation;
  readonly ownership: ConnectorRecurrenceOwnership;
}): void {
  const target: keyof ConnectorRecurrenceOwnership = input.operation.endsWith('-series')
    ? 'series'
    : 'occurrences';
  const owner = input.ownership[target];
  if (!input.contract.writes?.[input.operation]?.includes(owner)) {
    throw new ConnectorRecurrenceWriteError(
      `Recurrence ${input.operation} denied for ${owner}-owned ${target}`,
    );
  }
}

export function assertTaskRecurrenceWriteAllowed(input: {
  readonly contract: ConnectorRecurrenceContract;
  readonly operation: RecurrenceWriteOperation;
  readonly metadata: unknown;
  readonly legacyOwnership?: ConnectorRecurrenceOwnership;
}): void {
  const ownership = getTaskRecurrenceOwnership(
    input.metadata,
    input.legacyOwnership,
  );
  if (!ownership) {
    throw new ConnectorRecurrenceWriteError(
      `Recurrence ${input.operation} denied without declared ownership`,
    );
  }
  assertConnectorRecurrenceWriteAllowed({
    contract: input.contract,
    operation: input.operation,
    ownership,
  });
}
