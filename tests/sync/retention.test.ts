import { describe, expect, it } from 'vitest';
import {
  classifyRetainedReason,
  getAvailableRetentionActions,
  getBlockedRetentionCapability,
  getRetentionResolutionLabel,
  isDestructiveRetentionResolution,
} from '@/lib/sync/retention';

describe('retained sync taxonomy', () => {
  it.each([
    ['Completed/cancelled task retained locally (status: done)', 'closed-item-retained', 'informational'],
    ['Has pending local changes (push_error)', 'pending-local-changes', 'action-recommended'],
    ['Local-only task not yet pushed to remote', 'local-task-awaiting-creation', 'action-recommended'],
    ['Locally-created subtask escalated to pending_push for next cycle', 'local-task-awaiting-creation', 'action-recommended'],
    ['Locally-created subtask retained after its upstream parent was removed', 'orphaned-local-subtask', 'action-recommended'],
    ['Task creation disabled for connector', 'connector-creation-blocked', 'configuration-required'],
    ['Write disabled for connector', 'connector-write-blocked', 'configuration-required'],
  ])('classifies %s', (reason, category, attention) => {
    expect(classifyRetainedReason(reason)).toMatchObject({ category, attention });
  });

  it('links delete-disabled retention to the delete capability', () => {
    expect(classifyRetainedReason('Delete disabled for connector')).toMatchObject({
      category: 'connector-write-blocked',
      capabilitySetting: 'delete',
    });
  });

  it('only marks local deletion actions as destructive', () => {
    expect(isDestructiveRetentionResolution('delete_local')).toBe(true);
    expect(isDestructiveRetentionResolution('discard_local_changes')).toBe(true);
    expect(isDestructiveRetentionResolution('keep_local')).toBe(false);
    expect(getRetentionResolutionLabel('archive_local')).toBe('Archive locally');
  });

  it('does not offer retry for a subtask whose upstream parent was removed', () => {
    expect(classifyRetainedReason(
      'Locally-created subtask retained after its upstream parent was removed',
    ).actions).toEqual(['keep_local', 'discard_local_changes']);
  });

  it('replaces retry with the current connector write setting when writes are disabled', () => {
    const classification = classifyRetainedReason('Has pending local changes (push_error)');

    expect(getAvailableRetentionActions(classification, { write: false })).toEqual([
      'keep_local',
      'discard_local_changes',
    ]);
    expect(getBlockedRetentionCapability(classification, { write: false })).toBe('write');
  });

  it('uses task creation authority for locally-created retries', () => {
    const classification = classifyRetainedReason('Local-only task not yet pushed to remote');

    expect(getAvailableRetentionActions(classification, {
      write: false,
      taskCreate: true,
    })).toContain('retry_push');
    expect(getAvailableRetentionActions(classification, {
      write: true,
      taskCreate: false,
    })).not.toContain('retry_push');
    expect(getBlockedRetentionCapability(classification, {
      write: true,
      taskCreate: false,
    })).toBe('task creation');
  });

  it('offers a safe local conversion when connector task creation is blocked', () => {
    const classification = classifyRetainedReason('Task creation disabled for connector');

    expect(classification).toMatchObject({
      category: 'connector-creation-blocked',
      actions: ['keep_local'],
      capabilitySetting: 'task creation',
    });
  });
});
