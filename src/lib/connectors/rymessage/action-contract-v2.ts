import { createHash } from 'node:crypto';
import type {
  CompanionActionFeedItem,
  CompanionActionV1,
} from './action-contract';

export const COMPANION_ACTION_V2_CONTRACT_VERSION = '2.0';
export const COMPANION_ACTION_V2_MAX_LINKS = 16;
export const COMPANION_ACTION_V2_MAX_RETAINED_INTENTS = 32;
export const COMPANION_ACTION_V2_MAX_COMMANDS = 32;
export const COMPANION_ACTION_V2_MAX_PAGE_ITEMS = 20;
export const COMPANION_ACTION_V2_MAX_WRITE_BYTES = 32 * 1024;
export const COMPANION_ACTION_FEED_PATH_V2 = '/v2/integrations/action-feed';
export const COMPANION_ACTION_V2_RELATION_NAMESPACE =
  '60ed6d9d-c9d5-5fd6-9c7a-dbb312af3fb5';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export type CompanionTaskMaterializationState =
  | 'linked'
  | 'deleted'
  | 'link-broken'
  | 'unlinked';

export type CompanionTaskNormalizedStatus =
  | 'not-started'
  | 'in-progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'deleted'
  | 'unknown';

export type CompanionTaskAvailability = 'live' | 'stale' | 'unavailable';

export interface CompanionTaskUnderlyingIdentityV2 {
  providerId: string;
  providerAccountId: string;
  providerContainerId?: string;
  providerTaskId: string;
}

export interface CompanionTaskManagementV2 {
  manager: 'mission-control';
  managerInstanceId: string;
  managerTaskId: string;
  managerVersion?: string;
  canonicalUrl?: string;
}

export interface CompanionTaskSnapshotV2 {
  providerLabel: string;
  providerIconKey: string;
  title: string;
  status: CompanionTaskNormalizedStatus;
  providerVersion?: string;
  openUrl?: string;
  observedAt: string;
  availability: CompanionTaskAvailability;
}

export interface CompanionTaskMaterializationV2 {
  contractVersion: 2;
  relationId: string;
  revision: number;
  actionId: string;
  creationIntentId?: string;
  underlying: CompanionTaskUnderlyingIdentityV2;
  state: CompanionTaskMaterializationState;
  snapshot: CompanionTaskSnapshotV2;
  management?: CompanionTaskManagementV2;
  createdAt: string;
  updatedAt: string;
}

export type CompanionCreationIntentState =
  | 'pending'
  | 'claimed'
  | 'fulfilled'
  | 'failed'
  | 'cancelled';

export interface CompanionCreationIntentDraftV2 {
  title: string;
  notes?: string;
  dueAt?: string;
  reminderAt?: string;
  priority?: boolean;
}

export interface CompanionCreationIntentV2 {
  intentId: string;
  revision: number;
  actionId: string;
  requestedBy: 'device' | 'mission-control';
  destination: 'mission-control';
  draft: CompanionCreationIntentDraftV2;
  state: CompanionCreationIntentState;
  claimedAt?: string;
  fulfilledRelationId?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export type ManagedTaskCommandV1State =
  | 'pending'
  | 'claimed'
  | 'succeeded'
  | 'failed';

export interface ManagedTaskCommandV1 {
  commandId: string;
  revision: number;
  actionId: string;
  relationId: string;
  expectedManagerVersion?: string;
  kind: 'patch';
  patch: {
    title?: string;
    notes?: string;
    dueAt?: string | null;
    reminderAt?: string | null;
    priority?: boolean;
    status?: 'not-started' | 'in-progress' | 'blocked' | 'completed' | 'cancelled';
  };
  state: ManagedTaskCommandV1State;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionTaskLifecycleV2 {
  state: 'none' | 'linked' | 'completed';
  provenance: 'none' | 'task-aggregate' | 'manual-user';
  derivedAt?: string;
}

export interface CompanionActionFeedProjectionV2 {
  action: CompanionActionV1;
  taskMaterializations: CompanionTaskMaterializationV2[];
  creationIntents: CompanionCreationIntentV2[];
  managedTaskCommands: ManagedTaskCommandV1[];
  taskLifecycle: CompanionTaskLifecycleV2;
}

type CompanionActionUpsertFeedItem = Extract<CompanionActionFeedItem, { kind: 'upsert' }>;
type CompanionActionTombstoneFeedItem = Extract<
  CompanionActionFeedItem,
  { kind: 'tombstone' }
>;

export type CompanionActionFeedItemV2 =
  | (CompanionActionUpsertFeedItem & { projection: CompanionActionFeedProjectionV2 })
  | CompanionActionTombstoneFeedItem;

export interface CompanionActionFeedPageV2 {
  schemaVersion: '2.0';
  feedId: string;
  mode: 'full' | 'incremental';
  producedAt: string;
  nextCursor: string;
  complete: boolean;
  items: CompanionActionFeedItemV2[];
}

export type CompanionActionMutationV2 =
  | {
      kind: 'creation-intent.register';
      intentId: string;
      draft: CompanionCreationIntentDraftV2;
    }
  | {
      kind: 'creation-intent.claim';
      intentId: string;
    }
  | {
      kind: 'creation-intent.fail';
      intentId: string;
      failureCode: string;
    }
  | {
      kind: 'materialization.fulfill-intent';
      intentId: string;
      relationId: string;
      underlying: CompanionTaskUnderlyingIdentityV2;
      snapshot: CompanionTaskSnapshotV2;
      managerTaskId: string;
      managerVersion?: string;
      managerCanonicalUrl?: string;
    }
  | {
      kind: 'materialization.attach-manager';
      relationId: string;
      underlying: CompanionTaskUnderlyingIdentityV2;
      snapshot: CompanionTaskSnapshotV2;
      managerTaskId: string;
      managerVersion?: string;
      managerCanonicalUrl?: string;
    }
  | {
      kind: 'materialization.observe';
      relationId: string;
      snapshot: CompanionTaskSnapshotV2;
      state?: 'linked' | 'deleted' | 'link-broken';
      managerVersion?: string;
      managerCanonicalUrl?: string;
    }
  | {
      kind: 'materialization.unlink';
      relationId: string;
    }
  | {
      kind: 'managed-task-command.claim';
      commandId: string;
    }
  | {
      kind: 'managed-task-command.complete';
      commandId: string;
      snapshot: CompanionTaskSnapshotV2;
      managerVersion?: string;
    }
  | {
      kind: 'managed-task-command.fail';
      commandId: string;
      failureCode: string;
    };

export interface CompanionActionMutationRequestV2 {
  contractVersion: '2.0';
  operationId: string;
  actionId: string;
  expectedRevision: number;
  mutation: CompanionActionMutationV2;
}

export interface CompanionActionMutationReceiptV2 {
  operationId: string;
  actionId: string;
  outcome: 'applied' | 'duplicate' | 'stale-noop' | 'conflict';
  revision: number;
  relationId?: string;
  intentId?: string;
  commandId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => key in value) && keys.every(key => allowed.has(key));
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximum
    && !ASCII_CONTROL_RE.test(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= maximum;
}

function isToken(value: unknown, maximum: number): value is string {
  return isText(value, maximum) && TOKEN_RE.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string'
    && UTC_MILLIS_RE.test(value)
    && new Date(value).toISOString() === value;
}

function isStrictTaskUrl(value: unknown): value is string {
  if (!isText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function isTrustedTaskUrl(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is string {
  if (!isStrictTaskUrl(value)) return false;
  return trustedOrigins === undefined
    || trustedOrigins.has(new URL(value).origin.toLowerCase());
}

function isUnderlyingIdentity(
  value: unknown,
): value is CompanionTaskUnderlyingIdentityV2 {
  return isRecord(value)
    && exactKeys(
      value,
      ['providerId', 'providerAccountId', 'providerTaskId'],
      ['providerContainerId'],
    )
    && typeof value.providerId === 'string'
    && PROVIDER_ID_RE.test(value.providerId)
    && isText(value.providerAccountId, 128)
    && (
      value.providerContainerId === undefined
      || isText(value.providerContainerId, 256)
    )
    && isText(value.providerTaskId, 256);
}

function isSnapshot(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionTaskSnapshotV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'providerLabel',
    'providerIconKey',
    'title',
    'status',
    'observedAt',
    'availability',
  ], ['providerVersion', 'openUrl'])) return false;
  return isText(value.providerLabel, 96)
    && isToken(value.providerIconKey, 64)
    && isText(value.title, 512)
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
      || isText(value.providerVersion, 256)
    )
    && (
      value.openUrl === undefined
      || isTrustedTaskUrl(value.openUrl, trustedOrigins)
    )
    && isInstant(value.observedAt)
    && ['live', 'stale', 'unavailable'].includes(String(value.availability));
}

function isManagement(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionTaskManagementV2 {
  return isRecord(value)
    && exactKeys(
      value,
      ['manager', 'managerInstanceId', 'managerTaskId'],
      ['managerVersion', 'canonicalUrl'],
    )
    && value.manager === 'mission-control'
    && isText(value.managerInstanceId, 128)
    && isText(value.managerTaskId, 256)
    && (value.managerVersion === undefined || isText(value.managerVersion, 256))
    && (
      value.canonicalUrl === undefined
      || isTrustedTaskUrl(value.canonicalUrl, trustedOrigins)
    );
}

export function isCompanionTaskMaterializationV2(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionTaskMaterializationV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'contractVersion',
    'relationId',
    'revision',
    'actionId',
    'underlying',
    'state',
    'snapshot',
    'createdAt',
    'updatedAt',
  ], ['creationIntentId', 'management'])) return false;
  if (
    value.contractVersion !== 2
    || !isUuid(value.relationId)
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || !isUuid(value.actionId)
    || !isUnderlyingIdentity(value.underlying)
    || !['linked', 'deleted', 'link-broken', 'unlinked'].includes(String(value.state))
    || !isSnapshot(value.snapshot, trustedOrigins)
    || !isInstant(value.createdAt)
    || !isInstant(value.updatedAt)
    || (value.creationIntentId !== undefined && !isUuid(value.creationIntentId))
    || (
      value.management !== undefined
      && !isManagement(value.management, trustedOrigins)
    )
  ) return false;
  return value.relationId === companionTaskRelationIdV2({
    actionId: value.actionId,
    ...value.underlying,
  });
}

function isCreationIntentDraftV2(
  value: unknown,
): value is CompanionCreationIntentDraftV2 {
  return isRecord(value)
    && exactKeys(value, ['title'], ['notes', 'dueAt', 'reminderAt', 'priority'])
    && isText(value.title, 512)
    && (value.notes === undefined || isText(value.notes, 8_192))
    && (value.dueAt === undefined || isInstant(value.dueAt))
    && (value.reminderAt === undefined || isInstant(value.reminderAt))
    && (value.priority === undefined || typeof value.priority === 'boolean');
}

export function isCompanionCreationIntentV2(
  value: unknown,
  actionId?: string,
): value is CompanionCreationIntentV2 {
  return isRecord(value)
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
    && isUuid(value.intentId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && isUuid(value.actionId)
    && (actionId === undefined || value.actionId === actionId)
    && ['device', 'mission-control'].includes(String(value.requestedBy))
    && value.destination === 'mission-control'
    && isCreationIntentDraftV2(value.draft)
    && ['pending', 'claimed', 'fulfilled', 'failed', 'cancelled'].includes(String(value.state))
    && (value.claimedAt === undefined || isInstant(value.claimedAt))
    && (value.fulfilledRelationId === undefined || isUuid(value.fulfilledRelationId))
    && (
      value.failureCode === undefined
      || isToken(value.failureCode, 96)
    )
    && isInstant(value.createdAt)
    && isInstant(value.updatedAt);
}

function isManagedTaskPatchV1(value: unknown): value is ManagedTaskCommandV1['patch'] {
  if (!isRecord(value) || !exactKeys(
    value,
    [],
    ['title', 'notes', 'dueAt', 'reminderAt', 'priority', 'status'],
  ) || Object.keys(value).length === 0) return false;
  return (value.title === undefined || isText(value.title, 512))
    && (value.notes === undefined || isBoundedString(value.notes, 8_192))
    && (value.dueAt === undefined || value.dueAt === null || isInstant(value.dueAt))
    && (
      value.reminderAt === undefined
      || value.reminderAt === null
      || isInstant(value.reminderAt)
    )
    && (value.priority === undefined || typeof value.priority === 'boolean')
    && (
      value.status === undefined
      || ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled']
        .includes(String(value.status))
    );
}

export function isManagedTaskCommandV1(
  value: unknown,
  actionId?: string,
): value is ManagedTaskCommandV1 {
  return isRecord(value)
    && exactKeys(value, [
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
    && isUuid(value.commandId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && isUuid(value.actionId)
    && (actionId === undefined || value.actionId === actionId)
    && isUuid(value.relationId)
    && value.kind === 'patch'
    && isManagedTaskPatchV1(value.patch)
    && (
      value.expectedManagerVersion === undefined
      || isText(value.expectedManagerVersion, 256)
    )
    && ['pending', 'claimed', 'succeeded', 'failed'].includes(String(value.state))
    && (
      value.failureCode === undefined
      || isToken(value.failureCode, 96)
    )
    && isInstant(value.createdAt)
    && isInstant(value.updatedAt);
}

function isLifecycle(value: unknown): value is CompanionTaskLifecycleV2 {
  return isRecord(value)
    && exactKeys(value, ['state', 'provenance'], ['derivedAt'])
    && ['none', 'linked', 'completed'].includes(String(value.state))
    && ['none', 'task-aggregate', 'manual-user'].includes(String(value.provenance))
    && (value.derivedAt === undefined || isInstant(value.derivedAt));
}

function isFeedProjection(
  value: unknown,
  isActionV1: (candidate: unknown) => candidate is CompanionActionV1,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionActionFeedProjectionV2 {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'action',
      'taskMaterializations',
      'creationIntents',
      'managedTaskCommands',
      'taskLifecycle',
    ])
    || !isActionV1(value.action)
    || !Array.isArray(value.taskMaterializations)
    || value.taskMaterializations.length > COMPANION_ACTION_V2_MAX_LINKS
    || !value.taskMaterializations.every(item => (
      isCompanionTaskMaterializationV2(item, trustedOrigins)
      && item.actionId === (value.action as CompanionActionV1).actionId
    ))
    || !Array.isArray(value.creationIntents)
    || value.creationIntents.length > COMPANION_ACTION_V2_MAX_RETAINED_INTENTS
    || !value.creationIntents.every(item => (
      isCompanionCreationIntentV2(item, (value.action as CompanionActionV1).actionId)
    ))
    || !Array.isArray(value.managedTaskCommands)
    || value.managedTaskCommands.length > COMPANION_ACTION_V2_MAX_COMMANDS
    || !value.managedTaskCommands.every(item => (
      isManagedTaskCommandV1(item, (value.action as CompanionActionV1).actionId)
    ))
    || !isLifecycle(value.taskLifecycle)
  ) return false;
  const relationIds = value.taskMaterializations
    .map(item => (item as CompanionTaskMaterializationV2).relationId);
  return new Set(relationIds).size === relationIds.length;
}

export function isCompanionActionFeedPageV2(
  value: unknown,
  isActionV1: (candidate: unknown) => candidate is CompanionActionV1,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionActionFeedPageV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion',
    'feedId',
    'mode',
    'producedAt',
    'nextCursor',
    'complete',
    'items',
  ])) return false;
  if (
    value.schemaVersion !== COMPANION_ACTION_V2_CONTRACT_VERSION
    || !isUuid(value.feedId)
    || !['full', 'incremental'].includes(String(value.mode))
    || !isInstant(value.producedAt)
    || !isText(value.nextCursor, 512)
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.items)
    || value.items.length > COMPANION_ACTION_V2_MAX_PAGE_ITEMS
  ) return false;
  return value.items.every(item => {
    if (!isRecord(item)) return false;
    const common = isUuid(item.eventId)
      && isUuid(item.operationId)
      && isUuid(item.aggregateId)
      && Number.isSafeInteger(item.aggregateVersion)
      && Number(item.aggregateVersion) >= 1
      && isText(item.sourceId, 512)
      && isInstant(item.occurredAt);
    if (!common) return false;
    if (item.kind === 'tombstone') {
      return exactKeys(item, [
        'eventId',
        'operationId',
        'aggregateId',
        'aggregateVersion',
        'sourceId',
        'occurredAt',
        'kind',
      ]);
    }
    if (
      item.kind !== 'upsert'
      || !exactKeys(item, [
        'eventId',
        'operationId',
        'aggregateId',
        'aggregateVersion',
        'sourceId',
        'occurredAt',
        'kind',
        'action',
        'projection',
      ])
      || !isActionV1(item.action)
      || item.action.actionId !== item.aggregateId
      || !isFeedProjection(item.projection, isActionV1, trustedOrigins)
    ) return false;
    const projection = item.projection as CompanionActionFeedProjectionV2;
    return projection.action.actionId === item.aggregateId
      && companionActionV2Digest(projection.action) === companionActionV2Digest(item.action);
  });
}

export function isCompanionActionMutationRequestV2(
  value: unknown,
  trustedOrigins?: ReadonlySet<string>,
): value is CompanionActionMutationRequestV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'contractVersion',
    'operationId',
    'actionId',
    'expectedRevision',
    'mutation',
  ])) return false;
  if (
    value.contractVersion !== COMPANION_ACTION_V2_CONTRACT_VERSION
    || !isUuid(value.operationId)
    || !isUuid(value.actionId)
    || !Number.isSafeInteger(value.expectedRevision)
    || Number(value.expectedRevision) < 0
    || !isRecord(value.mutation)
  ) return false;
  const mutation = value.mutation;
  switch (mutation.kind) {
    case 'creation-intent.register':
      return exactKeys(mutation, ['kind', 'intentId', 'draft'])
        && isUuid(mutation.intentId)
        && isCreationIntentDraftV2(mutation.draft);
    case 'creation-intent.claim':
      return exactKeys(mutation, ['kind', 'intentId'])
        && isUuid(mutation.intentId);
    case 'creation-intent.fail':
      return exactKeys(mutation, ['kind', 'intentId', 'failureCode'])
        && isUuid(mutation.intentId)
        && isToken(mutation.failureCode, 96);
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
      if (!exactKeys(
        mutation,
        required,
        ['managerVersion', 'managerCanonicalUrl'],
      )) return false;
      return (
        mutation.kind !== 'materialization.fulfill-intent'
        || isUuid(mutation.intentId)
      )
        && isUuid(mutation.relationId)
        && isUnderlyingIdentity(mutation.underlying)
        && mutation.relationId === companionTaskRelationIdV2({
          actionId: value.actionId as string,
          ...mutation.underlying,
        })
        && isSnapshot(mutation.snapshot)
        && isText(mutation.managerTaskId, 256)
        && (
          mutation.managerVersion === undefined
          || isText(mutation.managerVersion, 256)
        )
        && (
          mutation.managerCanonicalUrl === undefined
          || isTrustedTaskUrl(mutation.managerCanonicalUrl, trustedOrigins)
        );
    }
    case 'materialization.observe':
      return exactKeys(
        mutation,
        ['kind', 'relationId', 'snapshot'],
        ['state', 'managerVersion', 'managerCanonicalUrl'],
      )
        && isUuid(mutation.relationId)
        && isSnapshot(mutation.snapshot)
        && (
          mutation.state === undefined
          || ['linked', 'deleted', 'link-broken'].includes(String(mutation.state))
        )
        && (
          mutation.managerVersion === undefined
          || isText(mutation.managerVersion, 256)
        )
        && (
          mutation.managerCanonicalUrl === undefined
          || isTrustedTaskUrl(mutation.managerCanonicalUrl, trustedOrigins)
        );
    case 'materialization.unlink':
      return exactKeys(mutation, ['kind', 'relationId'])
        && isUuid(mutation.relationId);
    case 'managed-task-command.claim':
      return exactKeys(mutation, ['kind', 'commandId'])
        && isUuid(mutation.commandId);
    case 'managed-task-command.complete':
      return exactKeys(
        mutation,
        ['kind', 'commandId', 'snapshot'],
        ['managerVersion'],
      )
        && isUuid(mutation.commandId)
        && isSnapshot(mutation.snapshot)
        && (
          mutation.managerVersion === undefined
          || isText(mutation.managerVersion, 256)
        );
    case 'managed-task-command.fail':
      return exactKeys(mutation, ['kind', 'commandId', 'failureCode'])
        && isUuid(mutation.commandId)
        && isToken(mutation.failureCode, 96);
    default:
      return false;
  }
}

export function isCompanionActionMutationReceiptV2(
  value: unknown,
): value is CompanionActionMutationReceiptV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'operationId',
    'actionId',
    'outcome',
    'revision',
  ], ['relationId', 'intentId', 'commandId'])) return false;
  return isUuid(value.operationId)
    && isUuid(value.actionId)
    && ['applied', 'duplicate', 'stale-noop', 'conflict'].includes(String(value.outcome))
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && (value.relationId === undefined || isUuid(value.relationId))
    && (value.intentId === undefined || isUuid(value.intentId))
    && (value.commandId === undefined || isUuid(value.commandId));
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalize(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key]!)]),
    );
  }
  return value;
}

export function companionActionV2Digest(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value as CanonicalJson));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuidString(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function companionTaskRelationIdV2(input: {
  actionId: string;
  providerId: string;
  providerAccountId: string;
  providerContainerId?: string;
  providerTaskId: string;
}): string {
  if (!isUuid(input.actionId) || !isUnderlyingIdentity({
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    ...(input.providerContainerId === undefined
      ? {}
      : { providerContainerId: input.providerContainerId }),
    providerTaskId: input.providerTaskId,
  })) {
    throw new Error('Action task relation identity is outside the V2 contract');
  }
  const name = JSON.stringify([
    input.actionId,
    input.providerId,
    input.providerAccountId,
    input.providerContainerId ?? '',
    input.providerTaskId,
  ]);
  const digest = createHash('sha1')
    .update(uuidBytes(COMPANION_ACTION_V2_RELATION_NAMESPACE))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return uuidString(digest);
}

export function normalizeTrustedTaskUrl(
  value: unknown,
  trustedOrigin: string,
): string | null {
  if (!isStrictTaskUrl(value)) return null;
  try {
    const trusted = normalizeTrustedOrigin(trustedOrigin);
    const candidate = new URL(value);
    if (!trusted || candidate.origin.toLowerCase() !== trusted) return null;
    return `${candidate.origin}${candidate.pathname}`;
  } catch {
    return null;
  }
}

export function normalizeTrustedOrigin(value: unknown): string | null {
  if (!isText(value, 2_048)) return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}
