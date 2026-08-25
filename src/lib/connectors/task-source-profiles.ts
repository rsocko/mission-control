import type {
  ConnectorCapabilities,
  TaskField,
  TaskFieldCapabilityProfile,
  TaskStatus,
  TaskSourceModel,
} from '@/types';

export type ConnectorProductionKind = 'tasks' | 'notifications-only';

export interface ConnectorTaskSourceProfile {
  production: 'tasks';
  taskCreate: boolean;
  sourceModel: TaskSourceModel;
  fieldProfile: Record<TaskField, TaskFieldCapabilityProfile>;
  statusWriteBack?: ConnectorCapabilities['statusWriteBack'];
  pullWriteBackWhenDisabled?: boolean;
}

export interface NotificationOnlyConnectorProfile {
  production: 'notifications-only';
}

export type ConnectorSourceProfile =
  | ConnectorTaskSourceProfile
  | NotificationOnlyConnectorProfile;

const ALL_TASK_FIELDS = [
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

const LOCAL_FIELD = Object.freeze({
  authority: 'local',
  writeBack: 'none',
}) satisfies TaskFieldCapabilityProfile;
const SOURCE_DIRECT_FIELD = Object.freeze({
  authority: 'source',
  writeBack: 'direct',
}) satisfies TaskFieldCapabilityProfile;
const SOURCE_READ_ONLY_FIELD = Object.freeze({
  authority: 'source',
  writeBack: 'none',
}) satisfies TaskFieldCapabilityProfile;
const MERGE_FIELD = Object.freeze({
  authority: 'merge',
  writeBack: 'none',
}) satisfies TaskFieldCapabilityProfile;
const LOCAL_PULL_FIELD = Object.freeze({
  authority: 'local',
  writeBack: 'pull',
}) satisfies TaskFieldCapabilityProfile;

function completeProfile(
  overrides: Partial<Record<TaskField, TaskFieldCapabilityProfile>>,
): Record<TaskField, TaskFieldCapabilityProfile> {
  return Object.fromEntries(
    ALL_TASK_FIELDS.map((field) => [field, overrides[field] ?? LOCAL_FIELD]),
  ) as Record<TaskField, TaskFieldCapabilityProfile>;
}

export const MICROSOFT_TODO_FIELD_PROFILE = completeProfile({
  title: SOURCE_DIRECT_FIELD,
  description: SOURCE_DIRECT_FIELD,
  status: SOURCE_DIRECT_FIELD,
  statusReason: SOURCE_DIRECT_FIELD,
  priority: SOURCE_DIRECT_FIELD,
  dueDate: SOURCE_DIRECT_FIELD,
  recurrence: SOURCE_DIRECT_FIELD,
  microStatus: SOURCE_DIRECT_FIELD,
});

export const WORK_TODO_FIELD_PROFILE = completeProfile({
  title: SOURCE_DIRECT_FIELD,
  description: SOURCE_DIRECT_FIELD,
  status: SOURCE_DIRECT_FIELD,
  priority: SOURCE_DIRECT_FIELD,
  dueDate: SOURCE_DIRECT_FIELD,
  recurrence: SOURCE_READ_ONLY_FIELD,
  microStatus: SOURCE_READ_ONLY_FIELD,
  tags: MERGE_FIELD,
});

export const GITHUB_ISSUES_FIELD_PROFILE = completeProfile({
  title: SOURCE_DIRECT_FIELD,
  description: SOURCE_DIRECT_FIELD,
  status: SOURCE_DIRECT_FIELD,
  statusReason: SOURCE_DIRECT_FIELD,
  priority: SOURCE_DIRECT_FIELD,
  microStatus: SOURCE_DIRECT_FIELD,
  dependencies: SOURCE_DIRECT_FIELD,
});

export const DOCUMENT_INTELLIGENCE_FIELD_PROFILE = completeProfile({
  title: SOURCE_READ_ONLY_FIELD,
  description: SOURCE_READ_ONLY_FIELD,
  status: SOURCE_DIRECT_FIELD,
  priority: SOURCE_READ_ONLY_FIELD,
  dueDate: SOURCE_READ_ONLY_FIELD,
  snoozedUntil: SOURCE_READ_ONLY_FIELD,
});

export const SCOUT_FIELD_PROFILE = completeProfile({
  title: MERGE_FIELD,
  description: MERGE_FIELD,
  status: LOCAL_PULL_FIELD,
  statusReason: LOCAL_PULL_FIELD,
  priority: MERGE_FIELD,
  dueDate: MERGE_FIELD,
});

export const BUILT_IN_TASK_SOURCE_PROFILES = Object.freeze({
  local: {
    production: 'tasks',
    taskCreate: true,
    sourceModel: 'mc-owned',
    fieldProfile: completeProfile({}),
  },
  'mission-control': {
    production: 'tasks',
    taskCreate: true,
    sourceModel: 'mc-owned',
    fieldProfile: completeProfile({}),
  },
  'inbound-webhook': {
    production: 'tasks',
    taskCreate: false,
    sourceModel: 'ingested',
    fieldProfile: completeProfile({
      title: MERGE_FIELD,
      description: MERGE_FIELD,
      priority: MERGE_FIELD,
      dueDate: MERGE_FIELD,
    }),
  },
} as const satisfies Record<string, ConnectorTaskSourceProfile>);

function customRestFieldProfile(
  writable: boolean,
): Record<TaskField, TaskFieldCapabilityProfile> {
  const sourceField = writable ? SOURCE_DIRECT_FIELD : SOURCE_READ_ONLY_FIELD;
  return completeProfile({
    title: sourceField,
    description: sourceField,
    status: sourceField,
    statusReason: sourceField,
    priority: sourceField,
    dueDate: sourceField,
  });
}

export const CONNECTOR_SOURCE_PROFILES = Object.freeze({
  'microsoft-todo': {
    production: 'tasks',
    taskCreate: true,
    sourceModel: 'remote-managed',
    fieldProfile: MICROSOFT_TODO_FIELD_PROFILE,
    statusWriteBack: 'direct',
  },
  'microsoft-todo-work': {
    production: 'tasks',
    taskCreate: false,
    sourceModel: 'remote-managed',
    fieldProfile: WORK_TODO_FIELD_PROFILE,
    statusWriteBack: 'direct',
  },
  'github-issues': {
    production: 'tasks',
    taskCreate: true,
    sourceModel: 'remote-managed',
    fieldProfile: GITHUB_ISSUES_FIELD_PROFILE,
    statusWriteBack: 'direct',
  },
  'custom-rest': {
    production: 'tasks',
    taskCreate: false,
    sourceModel: 'remote-mirror',
    fieldProfile: customRestFieldProfile(false),
    statusWriteBack: 'none',
  },
  'document-intelligence': {
    production: 'tasks',
    taskCreate: false,
    sourceModel: 'remote-managed',
    fieldProfile: DOCUMENT_INTELLIGENCE_FIELD_PROFILE,
    statusWriteBack: 'direct',
  },
  scout: {
    production: 'tasks',
    taskCreate: false,
    sourceModel: 'ingested',
    fieldProfile: SCOUT_FIELD_PROFILE,
    statusWriteBack: 'pull',
    pullWriteBackWhenDisabled: true,
  },
  'outlook-calendar': { production: 'notifications-only' },
  'outlook-email': { production: 'notifications-only' },
  rymessage: { production: 'notifications-only' },
  'home-assistant': { production: 'notifications-only' },
  finance: { production: 'notifications-only' },
  'finance-manager': { production: 'notifications-only' },
  'monarch-money': { production: 'notifications-only' },
} as const satisfies Record<string, ConnectorSourceProfile>);

export type RegisteredConnectorType = keyof typeof CONNECTOR_SOURCE_PROFILES;

export const TASK_PRODUCING_CONNECTOR_TYPES = Object.freeze([
  'microsoft-todo',
  'microsoft-todo-work',
  'github-issues',
  'custom-rest',
  'document-intelligence',
  'scout',
] as const satisfies readonly RegisteredConnectorType[]);

export const NOTIFICATION_ONLY_CONNECTOR_TYPES = Object.freeze([
  'outlook-calendar',
  'outlook-email',
  'rymessage',
  'home-assistant',
  'finance',
  'finance-manager',
  'monarch-money',
] as const satisfies readonly RegisteredConnectorType[]);

export function isRegisteredConnectorType(type: string): type is RegisteredConnectorType {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_SOURCE_PROFILES, type);
}

export function getConnectorSourceProfile(type: string): ConnectorSourceProfile | null {
  return isRegisteredConnectorType(type) ? CONNECTOR_SOURCE_PROFILES[type] : null;
}

export function isNotificationOnlyConnectorType(type: string): boolean {
  return getConnectorSourceProfile(type)?.production === 'notifications-only';
}

export function getTaskSourceProfile(type: string): ConnectorTaskSourceProfile | null {
  const builtIn = BUILT_IN_TASK_SOURCE_PROFILES[
    type as keyof typeof BUILT_IN_TASK_SOURCE_PROFILES
  ];
  if (builtIn) return builtIn;
  const connectorProfile = getConnectorSourceProfile(type);
  return connectorProfile?.production === 'tasks' ? connectorProfile : null;
}

export function resolveConnectorCapabilities(
  type: string,
  stored: ConnectorCapabilities,
  settings: Record<string, unknown> = {},
): ConnectorCapabilities {
  const profile = getConnectorSourceProfile(type);
  if (!profile) return stored;
  if (profile.production === 'notifications-only') {
    return {
      ...stored,
      write: false,
      delete: false,
      notificationOnly: true,
      taskCreate: false,
      taskSourceModel: 'remote-mirror',
      statusWriteBack: 'none',
    };
  }

  if (type === 'custom-rest') {
    const writable = typeof settings.updateEndpoint === 'string'
      && settings.updateEndpoint.trim().length > 0;
    const creatable = typeof settings.createEndpoint === 'string'
      && settings.createEndpoint.trim().length > 0;
    const deletable = typeof settings.deleteEndpoint === 'string'
      && settings.deleteEndpoint.trim().length > 0;
    return {
      ...stored,
      write: writable,
      delete: deletable,
      taskCreate: creatable,
      notificationOnly: false,
      taskSourceModel: writable ? 'remote-managed' : 'remote-mirror',
      statusWriteBack: writable ? 'direct' : 'none',
      taskFieldProfile: customRestFieldProfile(writable),
    };
  }

  return {
    ...stored,
    notificationOnly: false,
    taskCreate: profile.taskCreate,
    taskSourceModel: profile.sourceModel,
    taskFieldProfile: profile.fieldProfile,
    statusWriteBack: profile.statusWriteBack,
    pullWriteBackWhenDisabled: profile.pullWriteBackWhenDisabled,
  };
}

export const MICROSOFT_TODO_TASK_AUTHORITY = Object.freeze({
  taskSourceModel: 'remote-managed',
  statusWriteBack: 'direct',
  taskFieldProfile: MICROSOFT_TODO_FIELD_PROFILE,
}) satisfies Partial<ConnectorCapabilities>;

export const WORK_TODO_TASK_AUTHORITY = Object.freeze({
  taskSourceModel: 'remote-managed',
  statusWriteBack: 'direct',
  taskFieldProfile: WORK_TODO_FIELD_PROFILE,
}) satisfies Partial<ConnectorCapabilities>;

export const GITHUB_ISSUES_TASK_AUTHORITY = Object.freeze({
  taskSourceModel: 'remote-managed',
  statusWriteBack: 'direct',
  taskFieldProfile: GITHUB_ISSUES_FIELD_PROFILE,
}) satisfies Partial<ConnectorCapabilities>;

export const DOCUMENT_INTELLIGENCE_TASK_AUTHORITY = Object.freeze({
  taskSourceModel: 'remote-managed',
  statusWriteBack: 'direct',
  supportedTaskStatuses: ['todo', 'done', 'cancelled'] satisfies TaskStatus[],
  taskAbsenceMeansDeleted: false,
  taskFieldProfile: DOCUMENT_INTELLIGENCE_FIELD_PROFILE,
}) satisfies Partial<ConnectorCapabilities>;

export const SCOUT_TASK_AUTHORITY = Object.freeze({
  taskSourceModel: 'ingested',
  statusWriteBack: 'pull',
  pullWriteBackWhenDisabled: true,
  taskFieldProfile: SCOUT_FIELD_PROFILE,
}) satisfies Partial<ConnectorCapabilities>;
