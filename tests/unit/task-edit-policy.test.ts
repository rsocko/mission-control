import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCapabilities } from '@/types';

vi.mock('@/db', () => ({ default: {} }));
vi.mock('@/db/schema', () => ({ tasks: {} }));
vi.mock('drizzle-orm', () => ({ inArray: vi.fn() }));
vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(),
  isConnectorEnabled: vi.fn(),
}));
vi.mock('@/lib/mode', () => ({ isDemoMode: vi.fn(() => false) }));

import {
  resolveTaskEditPolicies,
  resolveTaskEditPolicy,
} from '@/lib/tasks/edit-policy';
import {
  getConnectorCapabilities,
  isConnectorEnabled,
} from '@/lib/connectors/capabilities';
import { TASK_FIELDS } from '@/lib/tasks/field-policy';

function capabilities(
  overrides: Partial<ConnectorCapabilities> = {},
): ConnectorCapabilities {
  return {
    read: true,
    write: false,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: true,
    tagWriteBack: false,
    ...overrides,
  };
}

describe('resolveTaskEditPolicy response contract', () => {
  it('serializes every logical field and local removal for MC-owned tasks', () => {
    const policy = resolveTaskEditPolicy({
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorEnabled: true,
    }, null);

    expect(Object.keys(policy.fields).sort()).toEqual([...TASK_FIELDS].sort());
    expect(policy.sourceModel).toBe('mc-owned');
    expect(policy.editableFields).toContain('status');
    expect(policy.localDeleteSupported).toBe(true);
    expect(policy.removalMode).toBe('local-delete');
    expect(policy.sourceMoveSupported).toBe(true);
    expect(policy.localDispositionSupported).toBe(false);
  });

  describe('resolveTaskEditPolicies batching', () => {
    it('uses prefetched connector contexts without querying each connector again', async () => {
      const prefetchedCapabilities = capabilities({
        write: true,
        taskSourceModel: 'remote-managed',
      });
      const policies = await resolveTaskEditPolicies([
        {
          id: 'task-1',
          sourceId: 'remote:task-1',
          connectorType: 'test',
          connectorInstanceId: 'connector-1',
        },
        {
          id: 'task-2',
          sourceId: 'remote:task-2',
          connectorType: 'test',
          connectorInstanceId: 'connector-1',
        },
      ], new Map([
        ['connector-1', {
          capabilities: prefetchedCapabilities,
          connectorEnabled: true,
        }],
      ]));

      expect(getConnectorCapabilities).not.toHaveBeenCalled();
      expect(isConnectorEnabled).not.toHaveBeenCalled();
      expect(policies.get('task-1')?.fields.status.mutation).toBe('write-through');
      expect(policies.get('task-2')?.connectorEnabled).toBe(true);
    });

    it('preserves capabilities while disabling policies for a deleted connector context', async () => {
      const policies = await resolveTaskEditPolicies([
        {
          id: 'task-1',
          sourceId: 'remote:task-1',
          connectorType: 'test',
          connectorInstanceId: 'connector-1',
        },
      ], new Map([
        ['connector-1', {
          capabilities: capabilities({
            write: true,
            taskSourceModel: 'remote-managed',
          }),
          connectorEnabled: false,
        }],
      ]));

      expect(getConnectorCapabilities).not.toHaveBeenCalled();
      expect(isConnectorEnabled).not.toHaveBeenCalled();
      expect(policies.get('task-1')).toMatchObject({
        sourceModel: 'remote-managed',
        connectorEnabled: false,
        removalMode: 'blocked',
      });
    });
  });

  it('describes source synchronization and upstream deletion for managed tasks', () => {
    const policy = resolveTaskEditPolicy({
      sourceId: 'remote:task-1',
      connectorType: 'test',
      connectorEnabled: true,
    }, capabilities({
      write: true,
      delete: true,
      taskSourceModel: 'remote-managed',
      taskMove: true,
    }));

    expect(policy.fields.status.mutation).toBe('write-through');
    expect(policy.fields.effort.mutation).toBe('local');
    expect(policy.upstreamDeleteSupported).toBe(true);
    expect(policy.removalMode).toBe('upstream-delete');
    expect(policy.sourceMoveSupported).toBe(true);
  });

  it('blocks source-owned mirror fields while preserving local overlays', () => {
    const policy = resolveTaskEditPolicy({
      sourceId: 'mirror:task-1',
      connectorType: 'test',
      connectorEnabled: true,
    }, capabilities({ taskSourceModel: 'remote-mirror' }));

    expect(policy.fields.title.mutation).toBe('blocked');
    expect(policy.fieldReasons.title).toContain('upstream task source');
    expect(policy.fields.effort.mutation).toBe('local');
    expect(policy.fields.projects.mutation).toBe('local');
    expect(policy.fields.kanbanPlacement.mutation).toBe('local');
    expect(policy.fields.localDisposition.mutation).toBe('local');
    expect(policy.localDispositionSupported).toBe(true);
    expect(policy.removalMode).toBe('local-dismiss');
  });

  it('keeps ingested tasks editable with local cancellation semantics', () => {
    const policy = resolveTaskEditPolicy({
      sourceId: 'scout:task-1',
      connectorType: 'scout',
      connectorEnabled: true,
    }, capabilities({
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    }));

    expect(policy.fields.status.mutation).toBe('pull-write-back');
    expect(policy.fields.priority.mutation).toBe('local');
    expect(policy.removalMode).toBe('local-cancel');
  });

  it('blocks source operations but preserves local overlays when disabled', () => {
    const policy = resolveTaskEditPolicy({
      sourceId: 'remote:task-1',
      connectorType: 'test',
      connectorEnabled: false,
    }, capabilities({
      write: true,
      taskSourceModel: 'remote-managed',
    }));

    expect(policy.connectorEnabled).toBe(false);
    expect(policy.fields.status.mutation).toBe('blocked');
    expect(policy.fields.status.reason).toContain('connector is disabled');
    expect(policy.fields.effort.mutation).toBe('local');
    expect(policy.removalMode).toBe('blocked');
  });
});
