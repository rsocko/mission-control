export type RetentionCategory =
  | 'closed-item-retained'
  | 'pending-local-changes'
  | 'local-task-awaiting-creation'
  | 'orphaned-local-subtask'
  | 'connector-creation-blocked'
  | 'connector-write-blocked'
  | 'unknown-retention';

export type RetentionAttention = 'informational' | 'action-recommended' | 'configuration-required';

export type RetentionResolution =
  | 'retry_push'
  | 'keep_local'
  | 'archive_local'
  | 'discard_local_changes'
  | 'delete_local';

export type RetentionResolutionStatus = 'in_progress' | 'succeeded' | 'failed' | 'indeterminate';

export interface RetentionResolutionRecord {
  action: RetentionResolution;
  status: RetentionResolutionStatus;
  resolvedAt: string;
  message: string;
  claimId?: string;
  leaseExpiresAt?: string;
}

export interface RetentionClassification {
  category: RetentionCategory;
  label: string;
  explanation: string;
  attention: RetentionAttention;
  actions: RetentionResolution[];
  capabilitySetting?: 'write' | 'delete' | 'task creation';
}

export type RetentionCapabilities = Partial<Record<
  'write' | 'delete' | 'taskCreate' | 'notificationOnly',
  boolean
>>;

const CLASSIFICATIONS: Record<RetentionCategory, RetentionClassification> = {
  'closed-item-retained': {
    category: 'closed-item-retained',
    label: 'Closed item retained',
    explanation: 'The item is completed or cancelled in Mission Control and no longer exists upstream. Keeping it preserves local history.',
    attention: 'informational',
    actions: ['archive_local', 'delete_local'],
  },
  'pending-local-changes': {
    category: 'pending-local-changes',
    label: 'Local changes pending',
    explanation: 'Mission Control has local changes, but the upstream item is missing. Retention prevents those changes from being discarded automatically.',
    attention: 'action-recommended',
    actions: ['retry_push', 'keep_local', 'discard_local_changes'],
  },
  'local-task-awaiting-creation': {
    category: 'local-task-awaiting-creation',
    label: 'Local task awaiting creation',
    explanation: 'The task was created in Mission Control and has not received an upstream identity yet.',
    attention: 'action-recommended',
    actions: ['retry_push', 'keep_local'],
  },
  'orphaned-local-subtask': {
    category: 'orphaned-local-subtask',
    label: 'Local subtask without an upstream parent',
    explanation: 'The upstream parent was removed before this locally-created subtask could be created. It can be kept locally or discarded.',
    attention: 'action-recommended',
    actions: ['keep_local', 'discard_local_changes'],
  },
  'connector-creation-blocked': {
    category: 'connector-creation-blocked',
    label: 'Connector task creation blocked',
    explanation: 'The connector configuration prevents this local task from being created upstream.',
    attention: 'configuration-required',
    actions: ['keep_local'],
    capabilitySetting: 'task creation',
  },
  'connector-write-blocked': {
    category: 'connector-write-blocked',
    label: 'Connector write blocked',
    explanation: 'The connector configuration prevents the requested upstream change. The local task was retained unchanged.',
    attention: 'configuration-required',
    actions: [],
    capabilitySetting: 'write',
  },
  'unknown-retention': {
    category: 'unknown-retention',
    label: 'Retained locally',
    explanation: 'Mission Control retained this task to avoid an unsafe automatic change.',
    attention: 'action-recommended',
    actions: [],
  },
};

export function classifyRetainedReason(reason?: string): RetentionClassification {
  if (!reason) return CLASSIFICATIONS['unknown-retention'];
  if (reason.startsWith('Completed/cancelled task retained locally')) {
    return CLASSIFICATIONS['closed-item-retained'];
  }
  if (reason.startsWith('Has pending local changes')) {
    return CLASSIFICATIONS['pending-local-changes'];
  }
  if (
    reason.startsWith('Locally-created subtask retained after its upstream parent was removed')
  ) {
    return CLASSIFICATIONS['orphaned-local-subtask'];
  }
  if (
    reason.startsWith('Local-only task')
    || reason.startsWith('Locally-created task')
    || reason.startsWith('Locally-created subtask')
  ) {
    return CLASSIFICATIONS['local-task-awaiting-creation'];
  }
  if (reason === 'Task creation disabled for connector') {
    return CLASSIFICATIONS['connector-creation-blocked'];
  }
  if (reason === 'Write disabled for connector') {
    return CLASSIFICATIONS['connector-write-blocked'];
  }
  if (reason === 'Delete disabled for connector') {
    return {
      ...CLASSIFICATIONS['connector-write-blocked'],
      capabilitySetting: 'delete',
    };
  }
  return CLASSIFICATIONS['unknown-retention'];
}

export function isDestructiveRetentionResolution(action: RetentionResolution): boolean {
  return action === 'discard_local_changes' || action === 'delete_local';
}

export function getAvailableRetentionActions(
  classification: RetentionClassification,
  capabilities: RetentionCapabilities,
): RetentionResolution[] {
  const canCreate = capabilities.notificationOnly !== true
    && (capabilities.taskCreate ?? capabilities.write) !== false;
  return classification.actions.filter((action) => (
    action !== 'retry_push'
    || (
      classification.category === 'local-task-awaiting-creation'
        ? canCreate
        : capabilities.write !== false
    )
  ));
}

export function getBlockedRetentionCapability(
  classification: RetentionClassification,
  capabilities: RetentionCapabilities,
): 'write' | 'delete' | 'task creation' | undefined {
  if (classification.capabilitySetting) return classification.capabilitySetting;
  if (
    classification.category === 'local-task-awaiting-creation'
    && (
      capabilities.notificationOnly === true
      || (capabilities.taskCreate ?? capabilities.write) === false
    )
  ) {
    return 'task creation';
  }
  if (classification.actions.includes('retry_push') && capabilities.write === false) {
    return 'write';
  }
  return undefined;
}

export function getRetentionResolutionLabel(action: RetentionResolution): string {
  switch (action) {
    case 'retry_push':
      return 'Retry push';
    case 'keep_local':
      return 'Keep as local task';
    case 'archive_local':
      return 'Archive locally';
    case 'discard_local_changes':
      return 'Discard local changes';
    case 'delete_local':
      return 'Delete local copy';
  }
}
