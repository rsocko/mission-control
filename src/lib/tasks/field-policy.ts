import type {
  ConnectorCapabilities,
  TaskField,
  TaskFieldCapabilityProfile,
  TaskFieldInboundMode,
  TaskFieldMutationMode,
  TaskFieldPolicy,
  TaskSourceModel,
  WriteBackMode,
} from '@/types';
import {
  getTaskSourceProfile,
  isNotificationOnlyConnectorType,
} from '@/lib/connectors/task-source-profiles';

export const TASK_FIELDS = [
  'title',
  'description',
  'status',
  'statusReason',
  'priority',
  'planningHorizon',
  'dueDate',
  'effort',
  'estimatedDuration',
  'recurrence',
  'reminderAt',
  'snoozedUntil',
  'microStatus',
  'tags',
  'projects',
  'phases',
  'dependencies',
  'localDisposition',
  'kanbanPlacement',
] as const satisfies readonly TaskField[];

export const MERGEABLE_TASK_FIELDS = [
  'title',
  'description',
  'priority',
  'dueDate',
] as const satisfies readonly TaskField[];

const SOURCE_NATIVE_DEFAULTS = new Set<TaskField>([
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

export interface TaskSourceIdentity {
  sourceId: string;
  connectorType: string;
  connectorEnabled: boolean;
  forceLocal?: boolean;
}

export type FieldPolicy = TaskFieldPolicy;

function titleFor(field: TaskField): string {
  const words = field === 'kanbanPlacement'
    ? 'Kanban placement'
    : field.replace(/([A-Z])/g, ' $1');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function defaultSourceModel(
  task: TaskSourceIdentity,
  capabilities: ConnectorCapabilities | null,
): TaskSourceModel {
  if (
    task.forceLocal
    || task.connectorType === 'local'
    || task.connectorType === 'mission-control'
    || task.sourceId.startsWith('local:')
  ) {
    return 'mc-owned';
  }
  return capabilities?.taskSourceModel
    ?? getTaskSourceProfile(task.connectorType)?.sourceModel
    ?? (capabilities?.write ? 'remote-managed' : 'remote-mirror');
}

function defaultWriteBack(
  sourceModel: TaskSourceModel,
  capabilities: ConnectorCapabilities | null,
): WriteBackMode {
  if (sourceModel === 'mc-owned' || sourceModel === 'ingested') return 'none';
  return capabilities?.write ? 'direct' : 'none';
}

function defaultAuthority(
  sourceModel: TaskSourceModel,
  field: TaskField,
): TaskFieldCapabilityProfile['authority'] {
  if (sourceModel === 'mc-owned') return 'local';
  if (sourceModel === 'ingested') {
    return (MERGEABLE_TASK_FIELDS as readonly TaskField[]).includes(field)
      ? 'merge'
      : 'local';
  }
  return SOURCE_NATIVE_DEFAULTS.has(field) ? 'source' : 'local';
}

function capabilityProfile(
  sourceModel: TaskSourceModel,
  capabilities: ConnectorCapabilities | null,
  field: TaskField,
): TaskFieldCapabilityProfile | undefined {
  if (sourceModel !== 'remote-managed' && sourceModel !== 'remote-mirror') return undefined;

  if (field === 'priority') {
    if (capabilities?.priority === false) return { authority: 'local', writeBack: 'none' };
    if (capabilities?.priorityWriteBack === false) return { authority: 'source', writeBack: 'none' };
  }
  if (field === 'dueDate' && capabilities?.dueDate === false) {
    return { authority: 'local', writeBack: 'none' };
  }
  if (field === 'microStatus') {
    if (capabilities?.microStatusSync === false) return { authority: 'local', writeBack: 'none' };
    if (capabilities?.microStatusWriteBack === false) {
      return { authority: 'source', writeBack: 'none' };
    }
  }
  if (field === 'tags' && capabilities?.tagWriteBack === true) {
    return { authority: 'source', writeBack: 'direct' };
  }
  if (field === 'dependencies') {
    if (capabilities?.dependencyRead === false && capabilities.dependencyWrite === false) {
      return { authority: 'local', writeBack: 'none' };
    }
    if (capabilities?.dependencyWrite === false) {
      return { authority: 'source', writeBack: 'none' };
    }
  }
  return undefined;
}

function resolveMutation(
  sourceModel: TaskSourceModel,
  authority: TaskFieldCapabilityProfile['authority'],
  writeBack: WriteBackMode,
): TaskFieldMutationMode {
  if (authority === 'local' || authority === 'merge' || sourceModel === 'mc-owned') {
    return writeBack === 'pull' ? 'pull-write-back' : 'local';
  }
  if (sourceModel === 'remote-mirror' || writeBack === 'none') return 'blocked';
  return writeBack === 'pull' ? 'pull-write-back' : 'write-through';
}

/**
 * Resolve one logical task field without consulting the database or connector
 * implementations. Connector-specific behavior enters only through capabilities.
 */
export function resolveTaskFieldPolicy(
  task: TaskSourceIdentity,
  capabilities: ConnectorCapabilities | null,
  field: TaskField,
): FieldPolicy {
  const sourceModel = defaultSourceModel(task, capabilities);
  if (field === 'planningHorizon') {
    return {
      field,
      sourceModel,
      mutation: 'local',
      inbound: 'local-wins',
    };
  }
  if (
    capabilities?.notificationOnly
    || isNotificationOnlyConnectorType(task.connectorType)
  ) {
    return {
      field,
      sourceModel,
      mutation: 'blocked',
      inbound: 'source-wins',
      reason: `${titleFor(field)} cannot be changed because this connector is notification-only`,
    };
  }
  if (field === 'localDisposition') {
    if (sourceModel === 'remote-mirror') {
      return {
        field,
        sourceModel,
        mutation: 'local',
        inbound: 'local-wins',
      };
    }
    return {
      field,
      sourceModel,
      mutation: 'blocked',
      inbound: 'local-wins',
      reason: 'Local disposition is only available for read-only remote mirrors',
    };
  }
  const catalogProfile = getTaskSourceProfile(task.connectorType);
  const catalogFieldProfile = (
    !capabilities?.taskSourceModel
    || capabilities.taskSourceModel === catalogProfile?.sourceModel
  )
    ? catalogProfile?.fieldProfile[field]
    : undefined;
  const profile = capabilities?.taskFieldProfile?.[field]
    ?? capabilityProfile(sourceModel, capabilities, field)
    ?? catalogFieldProfile;
  const authority = profile?.authority ?? defaultAuthority(sourceModel, field);
  const writeBack = profile?.writeBack
    ?? (field === 'status' || field === 'statusReason'
      ? capabilities?.statusWriteBack ?? defaultWriteBack(sourceModel, capabilities)
      : defaultWriteBack(sourceModel, capabilities));
  const inbound: TaskFieldInboundMode = authority === 'source'
    ? 'source-wins'
    : authority === 'merge'
      ? 'merge'
      : 'local-wins';
  const mutation = resolveMutation(sourceModel, authority, writeBack);

  if (mutation === 'blocked') {
    return {
      field,
      sourceModel,
      mutation,
      inbound,
      reason: `${titleFor(field)} is controlled by the upstream task source`,
    };
  }

  if (
    !task.connectorEnabled
    && (
      mutation === 'write-through'
      || (
        mutation === 'pull-write-back'
        && capabilities?.pullWriteBackWhenDisabled !== true
      )
    )
  ) {
    return {
      field,
      sourceModel,
      mutation: 'blocked',
      inbound,
      reason: `${titleFor(field)} cannot be changed while its connector is disabled`,
    };
  }

  return { field, sourceModel, mutation, inbound };
}

export function resolveTaskSourceModel(
  task: TaskSourceIdentity,
  capabilities: ConnectorCapabilities | null,
): TaskSourceModel {
  return defaultSourceModel(task, capabilities);
}
