import type { TaskField } from '@/types';
import { MERGEABLE_TASK_FIELDS } from './field-policy';

export type MergeableTaskField = typeof MERGEABLE_TASK_FIELDS[number];

export interface TaskFieldStateRecord {
  taskId: string;
  fieldName: string;
  sourceValue: string;
  locallyOverridden: boolean;
  sourceObservedAt: string | null;
  localEditedAt: string | null;
  updatedAt: string;
}

export interface LocalOverrideChange {
  fieldName: MergeableTaskField;
  sourceValue: string;
  locallyOverridden: boolean;
  sourceObservedAt: string | null;
  localEditedAt: string;
  updatedAt: string;
  action: 'created' | 'cleared' | 'unchanged';
}

export interface InboundSourceObservation<T = unknown> {
  fieldName: MergeableTaskField;
  renderedValue: T;
  sourceValue: string;
  locallyOverridden: boolean;
  sourceObservedAt: string;
  localEditedAt: string | null;
  updatedAt: string;
  action: 'applied' | 'preserved' | 'cleared' | 'unchanged';
}

export function isMergeableTaskField(field: TaskField): field is MergeableTaskField {
  return (MERGEABLE_TASK_FIELDS as readonly TaskField[]).includes(field);
}

export function serializeTaskFieldValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Task field state values must be JSON serializable');
  }
  return serialized;
}

export function parseTaskFieldValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError('Task field state contains invalid JSON', { cause: error });
  }
}

export function resolveLocalOverrideChange(input: {
  taskId: string;
  fieldName: MergeableTaskField;
  newValue: unknown;
  currentSourceValue: unknown;
  state: TaskFieldStateRecord | undefined;
  sourceObservedAt: string | null;
  now: string;
}): LocalOverrideChange {
  const sourceValue = input.state?.sourceValue
    ?? serializeTaskFieldValue(input.currentSourceValue);
  const overridden = serializeTaskFieldValue(input.newValue) !== sourceValue;
  const wasOverridden = input.state?.locallyOverridden ?? false;

  return {
    fieldName: input.fieldName,
    sourceValue,
    locallyOverridden: overridden,
    sourceObservedAt: input.state?.sourceObservedAt ?? input.sourceObservedAt,
    localEditedAt: input.now,
    updatedAt: input.now,
    action: overridden === wasOverridden
      ? 'unchanged'
      : overridden
        ? 'created'
        : 'cleared',
  };
}

export function resolveInboundSourceObservation<T>(input: {
  fieldName: MergeableTaskField;
  incomingValue: T;
  currentValue: T;
  state: TaskFieldStateRecord | undefined;
  now: string;
}): InboundSourceObservation<T> {
  const incomingValue = serializeTaskFieldValue(input.incomingValue);
  const currentValue = serializeTaskFieldValue(input.currentValue);
  const wasOverridden = input.state?.locallyOverridden ?? false;
  const sourceMatchesLocal = incomingValue === currentValue;
  const preserveLocal = wasOverridden && !sourceMatchesLocal;

  return {
    fieldName: input.fieldName,
    renderedValue: preserveLocal ? input.currentValue : input.incomingValue,
    sourceValue: incomingValue,
    locallyOverridden: preserveLocal,
    sourceObservedAt: input.now,
    localEditedAt: input.state?.localEditedAt ?? null,
    updatedAt: input.now,
    action: preserveLocal
      ? 'preserved'
      : wasOverridden && sourceMatchesLocal
        ? 'cleared'
        : incomingValue !== currentValue
          ? 'applied'
          : 'unchanged',
  };
}
