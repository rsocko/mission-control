import { describe, expect, it } from 'vitest';
import { parseTaskPatchInput } from '@/lib/tasks/task-patch';

describe('parseTaskPatchInput', () => {
  it('maps request keys to unique logical fields', () => {
    const parsed = parseTaskPatchInput({
      status: 'done',
      kanbanColumn: 'complete',
      kanbanOrder: 2,
    });

    expect(parsed).toMatchObject({
      success: true,
      fields: ['status', 'kanbanPlacement'],
    });
  });

  it.each([
    'metadata',
    'sourceId',
    'connectorType',
    'connectorInstanceId',
    'sourceListId',
    'sourceListName',
    'completedAt',
    'syncStatus',
    'lastSyncedAt',
    'pushRetryCount',
  ])('rejects immutable %s input', (field) => {
    const parsed = parseTaskPatchInput({ [field]: {} });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error).toContain('Immutable task fields');
  });

  it('rejects invalid field values before mutation', () => {
    const parsed = parseTaskPatchInput({ effort: 6 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error).toContain('Invalid effort');
  });

  it('accepts planning horizons and clearing the field', () => {
    expect(parseTaskPatchInput({ planningHorizon: 'next' })).toMatchObject({
      success: true,
      fields: ['planningHorizon'],
    });
    expect(parseTaskPatchInput({ planningHorizon: null })).toMatchObject({
      success: true,
      fields: ['planningHorizon'],
    });
    expect(parseTaskPatchInput({ planningHorizon: 'today' }).success).toBe(false);
    expect(parseTaskPatchInput({ planningHorizon: 'now' }).success).toBe(false);
  });

  it('maps relative reminder configuration to reminder edit policy', () => {
    const parsed = parseTaskPatchInput({
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
    expect(parsed).toMatchObject({ success: true, fields: ['reminderAt'] });
  });

  it('rejects unsupported relative reminder rules and due times', () => {
    expect(parseTaskPatchInput({
      reminderRelative: '2_days_before',
      reminderDueTime: '25:00',
    }).success).toBe(false);
  });
});
