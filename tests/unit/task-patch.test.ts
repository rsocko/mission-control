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
});
