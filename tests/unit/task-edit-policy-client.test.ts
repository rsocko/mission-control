import { describe, expect, it } from 'vitest';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  selectedTaskFieldBlockedReason,
  taskFieldBlockedReason,
  taskFieldSaveLabel,
  taskRemovalLabel,
} from '@/lib/tasks/client-edit-policy';
import { makeTaskEditPolicy } from '../fixtures/task-edit-policy';

describe('task edit-policy client contract', () => {
  it.each([
    ['mc-owned', 'local', 'Delete task'],
    ['remote-managed', 'write-through', 'Delete from source'],
    ['ingested', 'local', 'Cancel task'],
  ] as const)('preserves editable %s behavior', (sourceModel, mutation, removalLabel) => {
    const policy = makeTaskEditPolicy({ sourceModel });

    expect(policy.fields.priority.mutation).toBe(mutation);
    expect(canEditTaskField(policy, 'priority')).toBe(true);
    expect(canRemoveTask(policy)).toBe(true);
    expect(taskRemovalLabel(policy)).toBe(removalLabel);
  });

  it('retains MC-owned overlays while blocking source-owned mirror fields', () => {
    const policy = makeTaskEditPolicy({
      sourceModel: 'remote-mirror',
      reasons: { title: 'Title is controlled by the upstream task source' },
      removalReason: 'Mirrored tasks must be handled or dismissed in Mission Control',
    });

    expect(canEditTaskField(policy, 'title')).toBe(false);
    expect(taskFieldBlockedReason(policy, 'title')).toBe('Title is controlled by the upstream task source');
    expect(canEditTaskField(policy, 'effort')).toBe(true);
    expect(canEditTaskField(policy, 'projects')).toBe(true);
    expect(canEditTaskField(policy, 'localDisposition')).toBe(true);
    expect(canRemoveTask(policy)).toBe(true);
    expect(taskRemovalLabel(policy)).toBe('Dismiss here');
  });

  it('allows mirror disposition while disabled and only recovery for transitioned tasks', () => {
    const disabledMirror = makeTaskEditPolicy({
      sourceModel: 'remote-mirror',
      connectorEnabled: false,
    });
    const transitioned = makeTaskEditPolicy({ sourceModel: 'remote-managed' });

    expect(canSetTaskLocalDisposition(disabledMirror, 'active', 'handled')).toBe(true);
    expect(canSetTaskLocalDisposition(transitioned, 'handled', 'active')).toBe(true);
    expect(canSetTaskLocalDisposition(transitioned, 'active', 'dismissed')).toBe(false);
  });

  it('keeps local overlays editable when a connector is disabled', () => {
    const policy = makeTaskEditPolicy({
      sourceModel: 'remote-managed',
      connectorEnabled: false,
      reasons: { status: 'Status cannot be changed while its connector is disabled' },
    });

    expect(canEditTaskField(policy, 'status')).toBe(false);
    expect(taskFieldBlockedReason(policy, 'status')).toContain('connector is disabled');
    expect(canEditTaskField(policy, 'effort')).toBe(true);
    expect(taskFieldSaveLabel(policy, 'effort')).toBe('Saved in Mission Control');
  });

  it('distinguishes local saves from source synchronization', () => {
    const policy = makeTaskEditPolicy({ sourceModel: 'remote-managed' });

    expect(taskFieldSaveLabel(policy, 'status')).toBe('Synced to source');
    expect(taskFieldSaveLabel(policy, 'effort')).toBe('Saved in Mission Control');
  });

  it('fails closed when a policy is missing and blocks mixed bulk fields', () => {
    const blockedReason = 'Priority is controlled by the upstream task source';
    const policies = [
      makeTaskEditPolicy(),
      makeTaskEditPolicy({
        sourceModel: 'remote-mirror',
        reasons: { priority: blockedReason },
      }),
    ];

    expect(canEditTaskField(undefined, 'status')).toBe(false);
    expect(selectedTaskFieldBlockedReason(policies, 'priority')).toBe(blockedReason);
  });
});
