import { describe, expect, it } from 'vitest';
import type {
  ConnectorCapabilities,
  TaskField,
  TaskFieldMutationMode,
  TaskSourceModel,
} from '@/types';
import {
  TASK_FIELDS,
  resolveTaskFieldPolicy,
  resolveTaskSourceModel,
} from '@/lib/tasks/field-policy';
import { DOCUMENT_INTELLIGENCE_FIELD_PROFILE } from '@/lib/connectors/task-source-profiles';

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

const SOURCE_FIELDS = new Set<TaskField>([
  'title',
  'description',
  'status',
  'statusReason',
  'priority',
  'dueDate',
  'recurrence',
  'microStatus',
  'dependencies',
]);
const MERGE_FIELDS = new Set<TaskField>(['title', 'description', 'priority', 'dueDate']);

describe('resolveTaskFieldPolicy', () => {
  const models: TaskSourceModel[] = [
    'mc-owned',
    'remote-managed',
    'remote-mirror',
    'ingested',
  ];

  for (const sourceModel of models) {
    describe(sourceModel, () => {
      for (const field of TASK_FIELDS) {
        const expected: TaskFieldMutationMode = field === 'localDisposition'
          ? sourceModel === 'remote-mirror' ? 'local' : 'blocked'
          : sourceModel === 'remote-managed' && SOURCE_FIELDS.has(field)
            ? 'write-through'
            : sourceModel === 'remote-mirror' && SOURCE_FIELDS.has(field)
              ? 'blocked'
              : sourceModel === 'ingested' && (field === 'status' || field === 'statusReason')
                ? 'pull-write-back'
                : 'local';

        it(`${field} resolves to ${expected}`, () => {
          const policy = resolveTaskFieldPolicy(
            {
              sourceId: 'source:task-1',
              connectorType: 'test',
              connectorEnabled: true,
            },
            capabilities({
              write: sourceModel === 'remote-managed',
              taskSourceModel: sourceModel,
              statusWriteBack: sourceModel === 'ingested' ? 'pull' : undefined,
            }),
            field,
          );

          expect(policy.mutation).toBe(expected);
          expect(policy.inbound).toBe(
            sourceModel === 'ingested' && MERGE_FIELDS.has(field)
              ? 'merge'
              : SOURCE_FIELDS.has(field) && sourceModel.startsWith('remote-')
                ? 'source-wins'
                : 'local-wins',
          );
          expect(policy.reason === undefined).toBe(expected !== 'blocked');
        });
      }
    });
  }

  it.each([
    ['local identity', { sourceId: 'local:1', connectorType: 'local' }, null, 'mc-owned'],
    ['legacy writable', { sourceId: 'remote:1', connectorType: 'test' }, capabilities({ write: true }), 'remote-managed'],
    ['legacy read-only', { sourceId: 'remote:1', connectorType: 'test' }, capabilities({ write: false }), 'remote-mirror'],
    ['explicit ingested', { sourceId: 'remote:1', connectorType: 'test' }, capabilities({ taskSourceModel: 'ingested' }), 'ingested'],
    ['built-in inbound webhook', { sourceId: 'webhook:1', connectorType: 'inbound-webhook' }, null, 'ingested'],
  ] as const)('applies the %s source-model default', (_name, identity, caps, expected) => {
    expect(resolveTaskSourceModel(
      { ...identity, connectorEnabled: true },
      caps,
    )).toBe(expected);
  });

  it('allows local fields while a remote-managed connector is disabled', () => {
    const caps = capabilities({ write: true, taskSourceModel: 'remote-managed' });
    const task = {
      sourceId: 'remote:1',
      connectorType: 'test',
      connectorEnabled: false,
    };

    expect(resolveTaskFieldPolicy(task, caps, 'effort').mutation).toBe('local');
    const title = resolveTaskFieldPolicy(task, caps, 'title');
    expect(title.mutation).toBe('blocked');
    expect(title.reason).toContain('connector is disabled');
  });

  it('keeps remote-mirror disposition local while status remains source-authoritative', () => {
    const caps = capabilities({ taskSourceModel: 'remote-mirror', write: false });
    const task = {
      sourceId: 'remote:1',
      connectorType: 'custom-rest',
      connectorEnabled: false,
    };

    expect(resolveTaskFieldPolicy(task, caps, 'localDisposition')).toMatchObject({
      sourceModel: 'remote-mirror',
      mutation: 'local',
      inbound: 'local-wins',
    });
    expect(resolveTaskFieldPolicy(task, caps, 'status')).toMatchObject({
      mutation: 'blocked',
      inbound: 'source-wins',
    });
  });

  it('models Document Intelligence as status-only write-back', () => {
    const caps = capabilities({
      write: true,
      taskSourceModel: 'remote-managed',
      taskFieldProfile: DOCUMENT_INTELLIGENCE_FIELD_PROFILE,
    });
    const task = {
      sourceId: 'document-action:1',
      connectorType: 'document-intelligence',
      connectorEnabled: true,
    };

    expect(resolveTaskFieldPolicy(task, caps, 'status').mutation).toBe('write-through');
    expect(resolveTaskFieldPolicy(task, caps, 'statusReason').mutation).toBe('local');
    expect(resolveTaskFieldPolicy(task, caps, 'microStatus').mutation).toBe('local');
    expect(resolveTaskFieldPolicy(task, caps, 'snoozedUntil').mutation).toBe('blocked');
  });

  it('blocks every mutation for notification-only connector history', () => {
    const caps = capabilities({
      notificationOnly: true,
      taskSourceModel: 'remote-mirror',
    });
    const task = {
      sourceId: 'legacy-notification-task:1',
      connectorType: 'monarch-money',
      connectorEnabled: true,
    };

    for (const field of TASK_FIELDS) {
      const policy = resolveTaskFieldPolicy(task, caps, field);
      expect(policy.mutation).toBe('blocked');
      expect(policy.reason).toContain('notification-only');
    }
  });

  it('keeps pull write-back available while an ingested connector is disabled', () => {
    const policy = resolveTaskFieldPolicy(
      {
        sourceId: 'scout:item-1',
        connectorType: 'scout',
        connectorEnabled: false,
      },
      capabilities({
        taskSourceModel: 'ingested',
        statusWriteBack: 'pull',
        pullWriteBackWhenDisabled: true,
      }),
      'status',
    );

    expect(policy.mutation).toBe('pull-write-back');
  });

  it('blocks pull write-back while disabled unless the capability opts in', () => {
    const policy = resolveTaskFieldPolicy(
      {
        sourceId: 'ingested:item-1',
        connectorType: 'ingested',
        connectorEnabled: false,
      },
      capabilities({
        taskSourceModel: 'ingested',
        statusWriteBack: 'pull',
      }),
      'status',
    );

    expect(policy.mutation).toBe('blocked');
    expect(policy.reason).toContain('connector is disabled');
  });

  it('honors connector field profiles without connector-type conditions', () => {
    const caps = capabilities({
      write: true,
      taskSourceModel: 'remote-managed',
      taskFieldProfile: {
        priority: { authority: 'local', writeBack: 'none' },
        effort: { authority: 'source', writeBack: 'queued' },
      },
    });
    const task = {
      sourceId: 'remote:1',
      connectorType: 'hybrid',
      connectorEnabled: true,
    };

    expect(resolveTaskFieldPolicy(task, caps, 'priority').mutation).toBe('local');
    expect(resolveTaskFieldPolicy(task, caps, 'effort').mutation).toBe('write-through');
  });

  it('uses write-through for tags when the connector supports tag write-back', () => {
    const policy = resolveTaskFieldPolicy(
      {
        sourceId: 'remote:1',
        connectorType: 'test',
        connectorEnabled: true,
      },
      capabilities({
        write: true,
        tagWriteBack: true,
        taskSourceModel: 'remote-managed',
      }),
      'tags',
    );

    expect(policy.mutation).toBe('write-through');
  });

  it.each([
    ['priority', { priority: false }, 'local'],
    ['priority', { priority: true, priorityWriteBack: false }, 'blocked'],
    ['dueDate', { dueDate: false }, 'local'],
    ['microStatus', { microStatusSync: true, microStatusWriteBack: false }, 'blocked'],
    ['dependencies', { dependencyRead: false, dependencyWrite: false }, 'local'],
    ['dependencies', { dependencyRead: true, dependencyWrite: false }, 'blocked'],
  ] as const)('resolves %s from field-specific capabilities', (field, overrides, expected) => {
    const policy = resolveTaskFieldPolicy(
      {
        sourceId: 'remote:1',
        connectorType: 'test',
        connectorEnabled: true,
      },
      capabilities({
        write: true,
        taskSourceModel: 'remote-managed',
        ...overrides,
      }),
      field,
    );

    expect(policy.mutation).toBe(expected);
  });
});
