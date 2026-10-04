import { createHash } from 'node:crypto';
import {
  canonicalActionJson,
  isActionV2,
  type ActionV2,
  type JsonValue,
} from './action-contract';

export const ACTION_TASK_LINK_CONTRACT_VERSION = '2.0';
export const ACTION_TASK_LINK_PROJECTION_DOMAIN = 'action_task_links_v2';
export const ACTION_TASK_LINK_FEATURE = 'action_task_links_v2';
export const ACTION_TASK_RELATION_NAMESPACE_UUID = '60ed6d9d-c9d5-5fd6-9c7a-dbb312af3fb5';

export const ACTION_TASK_LINK_LIMITS = Object.freeze({
  maxMaterializations: 16,
  maxLiveIntents: 16,
  maxRetainedIntents: 32,
  maxCommands: 32,
  maxProviderIdBytes: 64,
  maxProviderAccountIdBytes: 128,
  maxProviderContainerIdBytes: 256,
  maxProviderTaskIdBytes: 256,
  maxProviderLabelBytes: 96,
  maxProviderIconKeyBytes: 64,
  maxTitleBytes: 512,
  maxNotesBytes: 8 * 1024,
  maxVersionBytes: 256,
  maxUrlBytes: 2 * 1024,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ActionTaskStatus =
  | 'not-started'
  | 'in-progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'deleted'
  | 'unknown';

export interface ActionTaskUnderlyingIdentityV2 {
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly providerContainerId?: string;
  readonly providerTaskId: string;
}

export interface ActionTaskSnapshotV2 {
  readonly providerLabel: string;
  readonly providerIconKey: string;
  readonly title: string;
  readonly status: ActionTaskStatus;
  readonly providerVersion?: string;
  readonly openUrl?: string;
  readonly observedAt: string;
  readonly availability: 'live' | 'stale' | 'unavailable';
}

export interface ActionTaskManagementV2 {
  readonly manager: 'mission-control';
  readonly managerInstanceId: string;
  readonly managerTaskId: string;
  readonly managerVersion?: string;
  readonly canonicalUrl?: string;
}

export interface ActionTaskMaterializationV2 {
  readonly contractVersion: 2;
  readonly relationId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly creationIntentId?: string;
  readonly underlying: ActionTaskUnderlyingIdentityV2;
  readonly state: 'linked' | 'deleted' | 'link-broken' | 'unlinked';
  readonly snapshot: ActionTaskSnapshotV2;
  readonly management?: ActionTaskManagementV2;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActionTaskDraftV2 {
  readonly title: string;
  readonly notes?: string;
  readonly dueAt?: string;
  readonly reminderAt?: string;
  readonly priority?: boolean;
}

export interface ActionTaskCreationIntentV2 {
  readonly intentId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly requestedBy: 'device' | 'mission-control';
  readonly destination: 'mission-control';
  readonly draft: ActionTaskDraftV2;
  readonly state: 'pending' | 'claimed' | 'fulfilled' | 'failed' | 'cancelled';
  readonly claimedAt?: string;
  readonly fulfilledRelationId?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedTaskCommandV2 {
  readonly commandId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly relationId: string;
  readonly kind: 'patch';
  readonly expectedManagerVersion?: string;
  readonly patch: Readonly<{
    title?: string;
    notes?: string;
    dueAt?: string | null;
    reminderAt?: string | null;
    priority?: boolean;
    status?: Exclude<ActionTaskStatus, 'deleted' | 'unknown'>;
  }>;
  readonly state: 'pending' | 'claimed' | 'succeeded' | 'failed';
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActionTaskLifecycleProjectionV2 {
  readonly state: 'none' | 'linked' | 'completed';
  readonly provenance: 'none' | 'task-aggregate' | 'manual-user';
  readonly derivedAt?: string;
}

export interface ActionTaskFeedProjectionV2 {
  readonly action: ActionV2;
  readonly taskMaterializations: readonly ActionTaskMaterializationV2[];
  readonly creationIntents: readonly ActionTaskCreationIntentV2[];
  readonly managedTaskCommands: readonly ManagedTaskCommandV2[];
  readonly taskLifecycle: ActionTaskLifecycleProjectionV2;
}

export type ActionTaskIntegrationMutationV2 =
  | {
      readonly kind: 'creation-intent.register';
      readonly intentId: string;
      readonly draft: ActionTaskDraftV2;
    }
  | {
      readonly kind: 'creation-intent.claim';
      readonly intentId: string;
    }
  | {
      readonly kind: 'creation-intent.fail';
      readonly intentId: string;
      readonly failureCode: string;
    }
  | {
      readonly kind: 'materialization.fulfill-intent';
      readonly intentId: string;
      readonly relationId: string;
      readonly underlying: ActionTaskUnderlyingIdentityV2;
      readonly snapshot: ActionTaskSnapshotV2;
      readonly managerTaskId: string;
      readonly managerVersion?: string;
      readonly managerCanonicalUrl?: string;
    }
  | {
      readonly kind: 'materialization.attach-manager';
      readonly relationId: string;
      readonly underlying: ActionTaskUnderlyingIdentityV2;
      readonly snapshot: ActionTaskSnapshotV2;
      readonly managerTaskId: string;
      readonly managerVersion?: string;
      readonly managerCanonicalUrl?: string;
    }
  | {
      readonly kind: 'materialization.observe';
      readonly relationId: string;
      readonly snapshot: ActionTaskSnapshotV2;
      readonly state?: 'linked' | 'deleted' | 'link-broken';
      readonly managerVersion?: string;
      readonly managerCanonicalUrl?: string;
    }
  | {
      readonly kind: 'materialization.unlink';
      readonly relationId: string;
    }
  | {
      readonly kind: 'managed-task-command.claim';
      readonly commandId: string;
    }
  | {
      readonly kind: 'managed-task-command.complete';
      readonly commandId: string;
      readonly snapshot: ActionTaskSnapshotV2;
      readonly managerVersion?: string;
    }
  | {
      readonly kind: 'managed-task-command.fail';
      readonly commandId: string;
      readonly failureCode: string;
    };

export interface ActionTaskIntegrationMutationRequestV2 {
  readonly contractVersion: '2.0';
  readonly operationId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly mutation: ActionTaskIntegrationMutationV2;
}

export interface ActionTaskMutationReceiptV2 {
  readonly operationId: string;
  readonly actionId: string;
  readonly outcome: 'applied' | 'duplicate' | 'stale-noop' | 'conflict';
  readonly revision: number;
  readonly relationId?: string;
  readonly intentId?: string;
  readonly commandId?: string;
}

export type ActionTaskDeviceSyncRequestV2 =
  | {
      readonly kind: 'creation-intent.register';
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly intentId: string;
      readonly draft: ActionTaskDraftV2;
    }
  | {
      readonly kind: 'managed-task-command.patch';
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly commandId: string;
      readonly relationId: string;
      readonly expectedManagerVersion?: string;
      readonly patch: ManagedTaskCommandV2['patch'];
    }
  | {
      readonly kind: 'materialization.unlink';
      readonly relationId: string;
    };

export type ActionTaskSyncProjectionV2 =
  | {
      readonly kind: 'materialization.projection';
      readonly materialization: ActionTaskMaterializationV2;
    }
  | {
      readonly kind: 'creation-intent.projection';
      readonly creationIntent: ActionTaskCreationIntentV2;
    }
  | {
      readonly kind: 'managed-task-command.projection';
      readonly managedTaskCommand: ManagedTaskCommandV2;
    };

function uuidV5(namespaceUuid: string, value: string): string {
  const namespace = Buffer.from(namespaceUuid.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(value, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function actionTaskRelationId(
  actionId: string,
  identity: ActionTaskUnderlyingIdentityV2,
): string {
  if (!UUID_RE.test(actionId) || !validUnderlyingIdentity(identity)) {
    throw new Error('action-task-relation-identity-invalid');
  }
  const canonical = canonicalActionJson([
    actionId,
    identity.providerId,
    identity.providerAccountId,
    identity.providerContainerId ?? '',
    identity.providerTaskId,
  ]);
  return uuidV5(ACTION_TASK_RELATION_NAMESPACE_UUID, canonical);
}

export function normalizeActionTaskTrustedOrigin(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > ACTION_TASK_LINK_LIMITS.maxUrlBytes) {
    throw new Error('action-task-origin-invalid');
  }
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('action-task-origin-invalid');
  }
  return url.origin.toLowerCase();
}

export function isActionTaskUrlTrusted(
  value: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (Buffer.byteLength(value, 'utf8') > ACTION_TASK_LINK_LIMITS.maxUrlBytes) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && url.search === ''
      && trustedOrigins.has(url.origin.toLowerCase());
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MILLIS_RE.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function validUnderlyingIdentity(value: unknown): value is ActionTaskUnderlyingIdentityV2 {
  return isObject(value)
    && exactKeys(value, ['providerId', 'providerAccountId', 'providerTaskId'], ['providerContainerId'])
    && typeof value.providerId === 'string'
    && PROVIDER_ID_RE.test(value.providerId)
    && validText(value.providerAccountId, ACTION_TASK_LINK_LIMITS.maxProviderAccountIdBytes)
    && (
      value.providerContainerId === undefined
      || validText(value.providerContainerId, ACTION_TASK_LINK_LIMITS.maxProviderContainerIdBytes)
    )
    && validText(value.providerTaskId, ACTION_TASK_LINK_LIMITS.maxProviderTaskIdBytes);
}

function validTaskSnapshot(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is ActionTaskSnapshotV2 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      'providerLabel',
      'providerIconKey',
      'title',
      'status',
      'observedAt',
      'availability',
    ], ['providerVersion', 'openUrl'])
  ) return false;
  return validText(value.providerLabel, ACTION_TASK_LINK_LIMITS.maxProviderLabelBytes)
    && validText(value.providerIconKey, ACTION_TASK_LINK_LIMITS.maxProviderIconKeyBytes)
    && TOKEN_RE.test(value.providerIconKey)
    && validText(value.title, ACTION_TASK_LINK_LIMITS.maxTitleBytes)
    && [
      'not-started',
      'in-progress',
      'blocked',
      'completed',
      'cancelled',
      'deleted',
      'unknown',
    ].includes(String(value.status))
    && (
      value.providerVersion === undefined
      || validText(value.providerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
    )
    && (
      value.openUrl === undefined
      || (
        typeof value.openUrl === 'string'
        && trustedOrigins !== undefined
        && isActionTaskUrlTrusted(value.openUrl, trustedOrigins)
      )
    )
    && validTimestamp(value.observedAt)
    && ['live', 'stale', 'unavailable'].includes(String(value.availability));
}

function validTaskDraft(value: unknown): value is ActionTaskDraftV2 {
  return isObject(value)
    && exactKeys(value, ['title'], ['notes', 'dueAt', 'reminderAt', 'priority'])
    && validText(value.title, ACTION_TASK_LINK_LIMITS.maxTitleBytes)
    && (value.notes === undefined || validText(value.notes, ACTION_TASK_LINK_LIMITS.maxNotesBytes))
    && (value.dueAt === undefined || validTimestamp(value.dueAt))
    && (value.reminderAt === undefined || validTimestamp(value.reminderAt))
    && (value.priority === undefined || typeof value.priority === 'boolean');
}

function validCreationIntent(
  value: unknown,
  actionId: string,
): value is ActionTaskCreationIntentV2 {
  return isObject(value)
    && exactKeys(value, [
      'intentId',
      'revision',
      'actionId',
      'requestedBy',
      'destination',
      'draft',
      'state',
      'createdAt',
      'updatedAt',
    ], ['claimedAt', 'fulfilledRelationId', 'failureCode'])
    && typeof value.intentId === 'string'
    && UUID_RE.test(value.intentId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 1
    && value.actionId === actionId
    && ['device', 'mission-control'].includes(String(value.requestedBy))
    && value.destination === 'mission-control'
    && validTaskDraft(value.draft)
    && ['pending', 'claimed', 'fulfilled', 'failed', 'cancelled'].includes(String(value.state))
    && (value.claimedAt === undefined || validTimestamp(value.claimedAt))
    && (
      value.fulfilledRelationId === undefined
      || (typeof value.fulfilledRelationId === 'string' && UUID_RE.test(value.fulfilledRelationId))
    )
    && (
      value.failureCode === undefined
      || (validText(value.failureCode, 96) && TOKEN_RE.test(value.failureCode))
    )
    && validTimestamp(value.createdAt)
    && validTimestamp(value.updatedAt);
}

function validManagedCommand(
  value: unknown,
  actionId: string,
): value is ManagedTaskCommandV2 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      'commandId',
      'revision',
      'actionId',
      'relationId',
      'kind',
      'patch',
      'state',
      'createdAt',
      'updatedAt',
    ], ['expectedManagerVersion', 'failureCode'])
    || typeof value.commandId !== 'string'
    || !UUID_RE.test(value.commandId)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || value.actionId !== actionId
    || typeof value.relationId !== 'string'
    || !UUID_RE.test(value.relationId)
    || value.kind !== 'patch'
    || !isObject(value.patch)
    || !exactKeys(value.patch, [], ['title', 'notes', 'dueAt', 'reminderAt', 'priority', 'status'])
    || Object.keys(value.patch).length === 0
  ) return false;
  return (value.patch.title === undefined
      || validText(value.patch.title, ACTION_TASK_LINK_LIMITS.maxTitleBytes))
    && (value.patch.notes === undefined
      || validBoundedString(value.patch.notes, ACTION_TASK_LINK_LIMITS.maxNotesBytes))
    && (value.patch.dueAt === undefined || value.patch.dueAt === null
      || validTimestamp(value.patch.dueAt))
    && (value.patch.reminderAt === undefined || value.patch.reminderAt === null
      || validTimestamp(value.patch.reminderAt))
    && (value.patch.priority === undefined || typeof value.patch.priority === 'boolean')
    && (value.patch.status === undefined
      || ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled']
        .includes(String(value.patch.status)))
    && (value.expectedManagerVersion === undefined
      || validText(value.expectedManagerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes))
    && ['pending', 'claimed', 'succeeded', 'failed'].includes(String(value.state))
    && (value.failureCode === undefined
      || (validText(value.failureCode, 96) && TOKEN_RE.test(value.failureCode)))
    && validTimestamp(value.createdAt)
    && validTimestamp(value.updatedAt);
}

function validManagedTaskPatch(value: unknown): value is ManagedTaskCommandV2['patch'] {
  return isObject(value)
    && exactKeys(value, [], ['title', 'notes', 'dueAt', 'reminderAt', 'priority', 'status'])
    && Object.keys(value).length > 0
    && (value.title === undefined
      || validText(value.title, ACTION_TASK_LINK_LIMITS.maxTitleBytes))
    && (value.notes === undefined
      || validBoundedString(value.notes, ACTION_TASK_LINK_LIMITS.maxNotesBytes))
    && (value.dueAt === undefined || value.dueAt === null || validTimestamp(value.dueAt))
    && (
      value.reminderAt === undefined
      || value.reminderAt === null
      || validTimestamp(value.reminderAt)
    )
    && (value.priority === undefined || typeof value.priority === 'boolean')
    && (
      value.status === undefined
      || ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled']
        .includes(String(value.status))
    );
}

export function isActionTaskDeviceSyncRequestV2(
  value: unknown,
): value is ActionTaskDeviceSyncRequestV2 {
  if (!isObject(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'creation-intent.register':
      return exactKeys(value, [
        'kind',
        'actionId',
        'expectedRevision',
        'intentId',
        'draft',
      ])
        && typeof value.actionId === 'string'
        && UUID_RE.test(value.actionId)
        && Number.isSafeInteger(value.expectedRevision)
        && (value.expectedRevision as number) >= 1
        && typeof value.intentId === 'string'
        && UUID_RE.test(value.intentId)
        && validTaskDraft(value.draft);
    case 'managed-task-command.patch':
      return exactKeys(value, [
        'kind',
        'actionId',
        'expectedRevision',
        'commandId',
        'relationId',
        'patch',
      ], ['expectedManagerVersion'])
        && typeof value.actionId === 'string'
        && UUID_RE.test(value.actionId)
        && Number.isSafeInteger(value.expectedRevision)
        && (value.expectedRevision as number) >= 1
        && typeof value.commandId === 'string'
        && UUID_RE.test(value.commandId)
        && typeof value.relationId === 'string'
        && UUID_RE.test(value.relationId)
        && (
          value.expectedManagerVersion === undefined
          || validText(value.expectedManagerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
        )
        && validManagedTaskPatch(value.patch);
    case 'materialization.unlink':
      return exactKeys(value, ['kind', 'relationId'])
        && typeof value.relationId === 'string'
        && UUID_RE.test(value.relationId);
    default:
      return false;
  }
}

export function isActionTaskSyncProjectionV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is ActionTaskSyncProjectionV2 {
  if (!isObject(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'materialization.projection':
      return exactKeys(value, ['kind', 'materialization'])
        && isActionTaskMaterializationV2(value.materialization, trustedOrigins);
    case 'creation-intent.projection':
      return exactKeys(value, ['kind', 'creationIntent'])
        && isObject(value.creationIntent)
        && typeof value.creationIntent.intentId === 'string'
        && UUID_RE.test(value.creationIntent.intentId)
        && typeof value.creationIntent.actionId === 'string'
        && UUID_RE.test(value.creationIntent.actionId)
        && validCreationIntent(value.creationIntent, value.creationIntent.actionId);
    case 'managed-task-command.projection':
      return exactKeys(value, ['kind', 'managedTaskCommand'])
        && isObject(value.managedTaskCommand)
        && typeof value.managedTaskCommand.commandId === 'string'
        && UUID_RE.test(value.managedTaskCommand.commandId)
        && typeof value.managedTaskCommand.actionId === 'string'
        && UUID_RE.test(value.managedTaskCommand.actionId)
        && validManagedCommand(value.managedTaskCommand, value.managedTaskCommand.actionId);
    default:
      return false;
  }
}

export function isActionTaskMaterializationV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is ActionTaskMaterializationV2 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      'contractVersion',
      'relationId',
      'revision',
      'actionId',
      'underlying',
      'state',
      'snapshot',
      'createdAt',
      'updatedAt',
    ], ['creationIntentId', 'management'])
    || value.contractVersion !== 2
    || typeof value.relationId !== 'string'
    || !UUID_RE.test(value.relationId)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !validUnderlyingIdentity(value.underlying)
    || !['linked', 'deleted', 'link-broken', 'unlinked'].includes(String(value.state))
    || !validTaskSnapshot(value.snapshot, trustedOrigins)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || (
      value.creationIntentId !== undefined
      && (typeof value.creationIntentId !== 'string' || !UUID_RE.test(value.creationIntentId))
    )
  ) return false;
  if (value.relationId !== actionTaskRelationId(value.actionId, value.underlying)) return false;
  if (value.management === undefined) return true;
  const management = value.management;
  return isObject(management)
    && exactKeys(management, [
      'manager',
      'managerInstanceId',
      'managerTaskId',
    ], ['managerVersion', 'canonicalUrl'])
    && management.manager === 'mission-control'
    && validText(management.managerInstanceId, 128)
    && validText(management.managerTaskId, ACTION_TASK_LINK_LIMITS.maxProviderTaskIdBytes)
    && (
      management.managerVersion === undefined
      || validText(management.managerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
    )
    && (
      management.canonicalUrl === undefined
      || (
        typeof management.canonicalUrl === 'string'
        && isActionTaskUrlTrusted(management.canonicalUrl, trustedOrigins)
      )
    );
}

export function isActionTaskIntegrationMutationRequestV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is ActionTaskIntegrationMutationRequestV2 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      'contractVersion',
      'operationId',
      'actionId',
      'expectedRevision',
      'mutation',
    ])
    || value.contractVersion !== ACTION_TASK_LINK_CONTRACT_VERSION
    || typeof value.operationId !== 'string'
    || !UUID_RE.test(value.operationId)
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !Number.isSafeInteger(value.expectedRevision)
    || (value.expectedRevision as number) < 0
    || !isObject(value.mutation)
    || typeof value.mutation.kind !== 'string'
    || 'accountScope' in value
    || 'feedId' in value
    || 'manager' in value
    || 'managerInstanceId' in value
  ) return false;
  const mutation = value.mutation;
  switch (mutation.kind) {
    case 'creation-intent.register':
      return exactKeys(mutation, ['kind', 'intentId', 'draft'])
        && typeof mutation.intentId === 'string'
        && UUID_RE.test(mutation.intentId)
        && validTaskDraft(mutation.draft);
    case 'creation-intent.claim':
    case 'managed-task-command.claim':
      return exactKeys(mutation, ['kind', mutation.kind === 'creation-intent.claim'
        ? 'intentId'
        : 'commandId'])
        && typeof (
          mutation.kind === 'creation-intent.claim' ? mutation.intentId : mutation.commandId
        ) === 'string'
        && UUID_RE.test(
          String(mutation.kind === 'creation-intent.claim' ? mutation.intentId : mutation.commandId),
        );
    case 'creation-intent.fail':
    case 'managed-task-command.fail':
      return exactKeys(mutation, [
        'kind',
        mutation.kind === 'creation-intent.fail' ? 'intentId' : 'commandId',
        'failureCode',
      ])
        && UUID_RE.test(String(
          mutation.kind === 'creation-intent.fail' ? mutation.intentId : mutation.commandId,
        ))
        && validText(mutation.failureCode, 96)
        && TOKEN_RE.test(mutation.failureCode);
    case 'materialization.fulfill-intent':
    case 'materialization.attach-manager': {
      const required = [
        'kind',
        ...(mutation.kind === 'materialization.fulfill-intent' ? ['intentId'] : []),
        'relationId',
        'underlying',
        'snapshot',
        'managerTaskId',
      ];
      if (!exactKeys(mutation, required, ['managerVersion', 'managerCanonicalUrl'])) return false;
      return (
        mutation.kind !== 'materialization.fulfill-intent'
        || (typeof mutation.intentId === 'string' && UUID_RE.test(mutation.intentId))
      )
        && typeof mutation.relationId === 'string'
        && UUID_RE.test(mutation.relationId)
        && validUnderlyingIdentity(mutation.underlying)
        && mutation.relationId === actionTaskRelationId(value.actionId, mutation.underlying)
        && validTaskSnapshot(mutation.snapshot, trustedOrigins)
        && validText(mutation.managerTaskId, ACTION_TASK_LINK_LIMITS.maxProviderTaskIdBytes)
        && (
          mutation.managerVersion === undefined
          || validText(mutation.managerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
        )
        && (
          mutation.managerCanonicalUrl === undefined
          || (
            typeof mutation.managerCanonicalUrl === 'string'
            && isActionTaskUrlTrusted(mutation.managerCanonicalUrl, trustedOrigins)
          )
        );
    }
    case 'materialization.observe':
      return exactKeys(mutation, ['kind', 'relationId', 'snapshot'], [
        'state',
        'managerVersion',
        'managerCanonicalUrl',
      ])
        && typeof mutation.relationId === 'string'
        && UUID_RE.test(mutation.relationId)
        && validTaskSnapshot(mutation.snapshot, trustedOrigins)
        && (
          mutation.state === undefined
          || ['linked', 'deleted', 'link-broken'].includes(String(mutation.state))
        )
        && (
          mutation.managerVersion === undefined
          || validText(mutation.managerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
        )
        && (
          mutation.managerCanonicalUrl === undefined
          || (
            typeof mutation.managerCanonicalUrl === 'string'
            && isActionTaskUrlTrusted(mutation.managerCanonicalUrl, trustedOrigins)
          )
        );
    case 'materialization.unlink':
      return exactKeys(mutation, ['kind', 'relationId'])
        && typeof mutation.relationId === 'string'
        && UUID_RE.test(mutation.relationId);
    case 'managed-task-command.complete':
      return exactKeys(mutation, ['kind', 'commandId', 'snapshot'], ['managerVersion'])
        && typeof mutation.commandId === 'string'
        && UUID_RE.test(mutation.commandId)
        && validTaskSnapshot(mutation.snapshot, trustedOrigins)
        && (
          mutation.managerVersion === undefined
          || validText(mutation.managerVersion, ACTION_TASK_LINK_LIMITS.maxVersionBytes)
        );
    default:
      return false;
  }
}

export function isActionTaskFeedProjectionV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is ActionTaskFeedProjectionV2 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      'action',
      'taskMaterializations',
      'creationIntents',
      'managedTaskCommands',
      'taskLifecycle',
    ])
    || !isActionV2(value.action)
    || !Array.isArray(value.taskMaterializations)
    || value.taskMaterializations.length > ACTION_TASK_LINK_LIMITS.maxMaterializations
    || !value.taskMaterializations.every((item) => (
      isActionTaskMaterializationV2(item, trustedOrigins)
      && item.actionId === (value.action as ActionV2).actionId
    ))
    || !Array.isArray(value.creationIntents)
    || value.creationIntents.length > ACTION_TASK_LINK_LIMITS.maxRetainedIntents
    || !value.creationIntents.every((item) => validCreationIntent(
      item,
      (value.action as ActionV2).actionId,
    ))
    || !Array.isArray(value.managedTaskCommands)
    || value.managedTaskCommands.length > ACTION_TASK_LINK_LIMITS.maxCommands
    || !value.managedTaskCommands.every((item) => validManagedCommand(
      item,
      (value.action as ActionV2).actionId,
    ))
    || !isObject(value.taskLifecycle)
  ) return false;
  if (
    !exactKeys(value.taskLifecycle, ['state', 'provenance'], ['derivedAt'])
    || !['none', 'linked', 'completed'].includes(String(value.taskLifecycle.state))
    || !['none', 'task-aggregate', 'manual-user'].includes(
      String(value.taskLifecycle.provenance),
    )
    || (
      value.taskLifecycle.derivedAt !== undefined
      && !validTimestamp(value.taskLifecycle.derivedAt)
    )
  ) return false;
  const relationIds = value.taskMaterializations
    .map((item) => (item as ActionTaskMaterializationV2).relationId);
  return new Set(relationIds).size === relationIds.length;
}

export function actionTaskMutationDigest(
  request: ActionTaskIntegrationMutationRequestV2,
): string {
  return createHash('sha256')
    .update(canonicalActionJson(request as unknown as JsonValue), 'utf8')
    .digest('hex');
}
