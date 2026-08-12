import { describe, expect, it } from 'vitest';
import {
  parseTaskFieldValue,
  resolveInboundSourceObservation,
  resolveLocalOverrideChange,
  serializeTaskFieldValue,
} from '@/lib/tasks/field-state';

describe('task field override state', () => {
  it('creates an override when a mergeable field differs from its source snapshot', () => {
    const change = resolveLocalOverrideChange({
      taskId: 'task-1',
      fieldName: 'title',
      newValue: 'Local title',
      currentSourceValue: 'Source title',
      state: undefined,
      sourceObservedAt: '2026-08-01T00:00:00.000Z',
      now: '2026-08-05T00:00:00.000Z',
    });

    expect(change).toMatchObject({
      sourceValue: '"Source title"',
      locallyOverridden: true,
      action: 'created',
    });
  });

  it('clears an override when the field returns to the current source snapshot', () => {
    const change = resolveLocalOverrideChange({
      taskId: 'task-1',
      fieldName: 'dueDate',
      newValue: null,
      currentSourceValue: '2026-08-10',
      state: {
        taskId: 'task-1',
        fieldName: 'dueDate',
        sourceValue: 'null',
        locallyOverridden: true,
        sourceObservedAt: '2026-08-04T00:00:00.000Z',
        localEditedAt: '2026-08-04T12:00:00.000Z',
        updatedAt: '2026-08-04T12:00:00.000Z',
      },
      sourceObservedAt: null,
      now: '2026-08-05T00:00:00.000Z',
    });

    expect(change.locallyOverridden).toBe(false);
    expect(change.action).toBe('cleared');
  });

  it('round-trips normalized nullable source values', () => {
    expect(parseTaskFieldValue(serializeTaskFieldValue(null))).toBeNull();
    expect(parseTaskFieldValue(serializeTaskFieldValue('value'))).toBe('value');
  });

  it('advances inbound snapshots while preserving a local override', () => {
    const observation = resolveInboundSourceObservation({
      fieldName: 'title',
      incomingValue: 'New source title',
      currentValue: 'Local title',
      state: {
        taskId: 'task-1',
        fieldName: 'title',
        sourceValue: '"Old source title"',
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      now: '2026-08-05T00:00:00.000Z',
    });

    expect(observation).toMatchObject({
      renderedValue: 'Local title',
      sourceValue: '"New source title"',
      locallyOverridden: true,
      action: 'preserved',
    });
  });

  it('clears an override when the inbound source converges on the local value', () => {
    const observation = resolveInboundSourceObservation({
      fieldName: 'priority',
      incomingValue: 'high',
      currentValue: 'high',
      state: {
        taskId: 'task-1',
        fieldName: 'priority',
        sourceValue: '"medium"',
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      now: '2026-08-05T00:00:00.000Z',
    });

    expect(observation.locallyOverridden).toBe(false);
    expect(observation.action).toBe('cleared');
  });
});
