import { createHash } from 'node:crypto';
import type { CompanionActionV1 } from './action-contract';

export const COMPANION_ACTION_V2_CONTRACT_VERSION = '2.0';
export const COMPANION_ACTION_V2_MAX_LINKS = 16;
export const COMPANION_ACTION_V2_MAX_PAGE_ITEMS = 20;
export const COMPANION_ACTION_V2_MAX_WRITE_BYTES = 32 * 1024;
export const COMPANION_ACTION_FEED_PATH_V2 = '/v2/integrations/action-feed';
export const COMPANION_ACTION_V2_RELATION_NAMESPACE =
  '60ed6d9d-c9d5-5fd6-9c7a-dbb312af3fb5';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FAILURE_CODE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  providerVersion: string;
  openUrl: string;
  observedAt: string;
  availability: CompanionTaskAvailability;
}

export interface CompanionTaskMaterializationV2 {
  relationId: string;
  revision: number;
  providerId: string;
  providerAccountId: string;
  providerContainerId?: string;
  providerTaskId: string;
  state: CompanionTaskMaterializationState;
  snapshot: CompanionTaskSnapshotV2;
  management?: CompanionTaskManagementV2;
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
  state: CompanionCreationIntentState;
  draft: CompanionCreationIntentDraftV2;
  relationId?: string;
  errorCode?: string;
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

export interface CompanionTaskLifecycleProvenanceV2 {
  source: 'manual-user' | 'task-aggregate';
  state: 'visible' | 'dismissed' | 'handled' | 'linked' | 'completed' | 'link-broken';
  updatedAt: string;
}

export type CompanionActionFeedItemV2 =
  | {
      eventId: string;
      operationId: string;
      aggregateId: string;
      aggregateVersion: number;
      sourceId: string;
      occurredAt: string;
      kind: 'upsert';
      action: CompanionActionV1;
      taskMaterializations: CompanionTaskMaterializationV2[];
      creationIntents: CompanionCreationIntentV2[];
      managedTaskCommands: ManagedTaskCommandV1[];
      taskLifecycleProvenance: CompanionTaskLifecycleProvenanceV2;
    }
  | {
      eventId: string;
      operationId: string;
      aggregateId: string;
      aggregateVersion: number;
      sourceId: string;
      occurredAt: string;
      kind: 'tombstone';
    };

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
      claimedAt: string;
    }
  | {
      kind: 'creation-intent.fail';
      intentId: string;
      errorCode: string;
      failedAt: string;
    }
  | {
      kind: 'creation-intent.fulfill';
      intentId: string;
      materialization: CompanionTaskMaterializationV2;
    }
  | {
      kind: 'materialization.attach-manager';
      relationId: string;
      underlying: {
        providerId: string;
        providerAccountId: string;
        providerContainerId?: string;
        providerTaskId: string;
      };
      snapshot: CompanionTaskSnapshotV2;
      managerTaskId: string;
      managerVersion?: string;
      managerCanonicalUrl?: string;
    }
  | {
      kind: 'materialization.observe';
      relationId: string;
      snapshot: CompanionTaskSnapshotV2;
      management?: Pick<CompanionTaskManagementV2, 'managerVersion' | 'canonicalUrl'>;
    }
  | {
      kind: 'materialization.unlink';
      relationId: string;
    }
  | {
      kind: 'managed-command.claim';
      commandId: string;
      claimedAt: string;
    }
  | {
      kind: 'managed-command.complete';
      commandId: string;
      managerVersion: string;
      completedAt: string;
    }
  | {
      kind: 'managed-command.fail';
      commandId: string;
      errorCode: string;
      failedAt: string;
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

export function isCompanionActionMutationRequestV2(
  value: unknown,
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
      return exactKeys(mutation, ['kind', 'intentId', 'claimedAt'])
        && isUuid(mutation.intentId)
        && isInstant(mutation.claimedAt);
    case 'creation-intent.fail':
      return exactKeys(mutation, ['kind', 'intentId', 'errorCode', 'failedAt'])
        && isUuid(mutation.intentId)
        && isToken(mutation.errorCode, 64)
        && FAILURE_CODE_RE.test(mutation.errorCode)
        && isInstant(mutation.failedAt);
    case 'creation-intent.fulfill':
      return exactKeys(mutation, ['kind', 'intentId', 'materialization'])
        && isUuid(mutation.intentId)
        && isCompanionTaskMaterializationV2(mutation.materialization, value.actionId);
    case 'materialization.attach-manager': {
      if (!exactKeys(mutation, [
        'kind',
        'relationId',
        'underlying',
        'snapshot',
        'managerTaskId',
      ], ['managerVersion', 'managerCanonicalUrl'])) return false;
      const underlying = mutation.underlying;
      if (!isRecord(underlying) || !exactKeys(underlying, [
        'providerId',
        'providerAccountId',
        'providerTaskId',
      ], ['providerContainerId'])) return false;
      const tupleValid = typeof underlying.providerId === 'string'
        && PROVIDER_ID_RE.test(underlying.providerId)
        && isBoundedString(underlying.providerAccountId, 128)
        && isBoundedString(underlying.providerTaskId, 256)
        && (
          underlying.providerContainerId === undefined
          || isBoundedString(underlying.providerContainerId, 256)
        );
      if (!tupleValid) return false;
      const relationId = companionTaskRelationIdV2({
        actionId: value.actionId,
        providerId: underlying.providerId as string,
        providerAccountId: underlying.providerAccountId as string,
        ...(typeof underlying.providerContainerId === 'string'
          ? { providerContainerId: underlying.providerContainerId }
          : {}),
        providerTaskId: underlying.providerTaskId as string,
      });
      return mutation.relationId === relationId
        && isSnapshot(mutation.snapshot)
        && isBoundedString(mutation.managerTaskId, 256)
        && (
          mutation.managerVersion === undefined
          || isBoundedString(mutation.managerVersion, 256)
        )
        && (
          mutation.managerCanonicalUrl === undefined
          || isStrictTaskUrl(mutation.managerCanonicalUrl)
        );
    }
    case 'materialization.observe':
      return exactKeys(mutation, ['kind', 'relationId', 'snapshot'], ['management'])
        && isUuid(mutation.relationId)
        && isSnapshot(mutation.snapshot)
        && (
          mutation.management === undefined
          || (
            isRecord(mutation.management)
            && exactKeys(mutation.management, [], ['managerVersion', 'canonicalUrl'])
            && Object.keys(mutation.management).length > 0
            && (
              mutation.management.managerVersion === undefined
              || isBoundedString(mutation.management.managerVersion, 256)
            )
            && (
              mutation.management.canonicalUrl === undefined
              || isStrictTaskUrl(mutation.management.canonicalUrl)
            )
          )
        );
    case 'materialization.unlink':
      return exactKeys(mutation, ['kind', 'relationId'])
        && isUuid(mutation.relationId);
    case 'managed-command.claim':
      return exactKeys(mutation, ['kind', 'commandId', 'claimedAt'])
        && isUuid(mutation.commandId)
        && isInstant(mutation.claimedAt);
    case 'managed-command.complete':
      return exactKeys(mutation, [
        'kind',
        'commandId',
        'managerVersion',
        'completedAt',
      ])
        && isUuid(mutation.commandId)
        && isBoundedString(mutation.managerVersion, 256)
        && isInstant(mutation.completedAt);
    case 'managed-command.fail':
      return exactKeys(mutation, ['kind', 'commandId', 'errorCode', 'failedAt'])
        && isUuid(mutation.commandId)
        && isToken(mutation.errorCode, 64)
        && FAILURE_CODE_RE.test(mutation.errorCode)
        && isInstant(mutation.failedAt);
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
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximum;
}

function isToken(value: unknown, maximum: number): value is string {
  return isBoundedString(value, maximum) && TOKEN_RE.test(value);
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
  if (!isBoundedString(value, 2_048)) return false;
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

export function normalizeTrustedTaskUrl(value: unknown, trustedOrigin: string): string | null {
  if (!isBoundedString(value, 2_048)) return null;
  try {
    const trusted = new URL(trustedOrigin);
    const candidate = new URL(value);
    if (
      !['http:', 'https:'].includes(trusted.protocol)
      || trusted.pathname !== '/'
      || candidate.origin.toLowerCase() !== trusted.origin.toLowerCase()
    ) {
      return null;
    }

    if (
      trusted.username
      || trusted.password
      || trusted.search
      || trusted.hash
      || candidate.username
      || candidate.password
      || candidate.search
      || candidate.hash
    ) {
      return null;
    }
    return `${candidate.origin}${candidate.pathname}`;
  } catch {
    return null;
  }
}

export function normalizeTrustedOrigin(value: unknown): string | null {
  if (!isBoundedString(value, 2_048)) return null;
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

function isSnapshot(value: unknown): value is CompanionTaskSnapshotV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'providerLabel',
    'providerIconKey',
    'title',
    'status',
    'providerVersion',
    'openUrl',
    'observedAt',
    'availability',
  ])) return false;
  return isBoundedString(value.providerLabel, 96)
    && isToken(value.providerIconKey, 64)
    && isBoundedString(value.title, 512)
    && [
      'not-started',
      'in-progress',
      'blocked',
      'completed',
      'cancelled',
      'deleted',
      'unknown',
    ].includes(String(value.status))
    && isBoundedString(value.providerVersion, 256)
    && isStrictTaskUrl(value.openUrl)
    && isInstant(value.observedAt)
    && ['live', 'stale', 'unavailable'].includes(String(value.availability));
}

function isManagement(value: unknown): value is CompanionTaskManagementV2 {
  return isRecord(value)
    && exactKeys(value, [
      'manager',
      'managerInstanceId',
      'managerTaskId',
    ], ['managerVersion', 'canonicalUrl'])
    && value.manager === 'mission-control'
    && isBoundedString(value.managerInstanceId, 256)
    && isBoundedString(value.managerTaskId, 256)
    && (value.managerVersion === undefined || isBoundedString(value.managerVersion, 256))
    && (value.canonicalUrl === undefined || isStrictTaskUrl(value.canonicalUrl));
}

export function isCompanionTaskMaterializationV2(
  value: unknown,
  actionId?: string,
): value is CompanionTaskMaterializationV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'relationId',
    'revision',
    'providerId',
    'providerAccountId',
    'providerTaskId',
    'state',
    'snapshot',
    'updatedAt',
  ], ['providerContainerId', 'management'])) return false;
  const valid = isUuid(value.relationId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && typeof value.providerId === 'string'
    && Buffer.byteLength(value.providerId, 'utf8') <= 64
    && PROVIDER_ID_RE.test(value.providerId)
    && isBoundedString(value.providerAccountId, 128)
    && (
      value.providerContainerId === undefined
      || isBoundedString(value.providerContainerId, 256)
    )
    && isBoundedString(value.providerTaskId, 256)
    && ['linked', 'deleted', 'link-broken', 'unlinked'].includes(String(value.state))
    && isSnapshot(value.snapshot)
    && (value.management === undefined || isManagement(value.management))
    && isInstant(value.updatedAt);
  if (!valid) return false;
  if (!actionId) return true;
  return String(value.relationId) === companionTaskRelationIdV2({
    actionId,
    providerId: String(value.providerId),
    providerAccountId: String(value.providerAccountId),
    ...(typeof value.providerContainerId === 'string'
      ? { providerContainerId: value.providerContainerId }
      : {}),
    providerTaskId: String(value.providerTaskId),
  });
}

function isCreationIntentDraftV2(value: unknown): value is CompanionCreationIntentDraftV2 {
  if (!isRecord(value) || !exactKeys(
    value,
    ['title'],
    ['notes', 'dueAt', 'reminderAt', 'priority'],
  )) return false;
  return isBoundedString(value.title, 512)
    && (
      value.notes === undefined
      || (
        typeof value.notes === 'string'
        && Buffer.byteLength(value.notes, 'utf8') <= 8_192
      )
    )
    && (value.dueAt === undefined || isInstant(value.dueAt))
    && (value.reminderAt === undefined || isInstant(value.reminderAt))
    && (value.priority === undefined || typeof value.priority === 'boolean');
}

export function isCompanionCreationIntentV2(
  value: unknown,
): value is CompanionCreationIntentV2 {
  if (!isRecord(value) || !exactKeys(value, [
    'intentId',
    'revision',
    'state',
    'draft',
    'updatedAt',
  ], ['relationId', 'errorCode'])) return false;
  return isUuid(value.intentId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && ['pending', 'claimed', 'fulfilled', 'failed', 'cancelled'].includes(String(value.state))
    && isCreationIntentDraftV2(value.draft)
    && (value.relationId === undefined || isUuid(value.relationId))
    && (
      value.errorCode === undefined
      || (isToken(value.errorCode, 64) && FAILURE_CODE_RE.test(value.errorCode))
    )
    && isInstant(value.updatedAt);
}

function isManagedTaskPatchV1(value: unknown): value is ManagedTaskCommandV1['patch'] {
  if (!isRecord(value) || !exactKeys(
    value,
    [],
    ['title', 'notes', 'dueAt', 'reminderAt', 'priority', 'status'],
  )) return false;
  if (Object.keys(value).length === 0) return false;
  return (value.title === undefined || isBoundedString(value.title, 512))
    && (
      value.notes === undefined
      || (typeof value.notes === 'string' && Buffer.byteLength(value.notes, 'utf8') <= 8_192)
    )
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

export function isManagedTaskCommandV1(value: unknown): value is ManagedTaskCommandV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'commandId',
    'revision',
    'actionId',
    'relationId',
    'kind',
    'patch',
    'state',
    'createdAt',
    'updatedAt',
  ], ['expectedManagerVersion', 'failureCode'])) return false;
  return isUuid(value.commandId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && isUuid(value.actionId)
    && isUuid(value.relationId)
    && value.kind === 'patch'
    && isManagedTaskPatchV1(value.patch)
    && (
      value.expectedManagerVersion === undefined
      || isBoundedString(value.expectedManagerVersion, 256)
    )
    && ['pending', 'claimed', 'succeeded', 'failed'].includes(String(value.state))
    && (
      value.failureCode === undefined
      || (isToken(value.failureCode, 64) && FAILURE_CODE_RE.test(value.failureCode))
    )
    && isInstant(value.createdAt)
    && isInstant(value.updatedAt);
}

export function isCompanionActionFeedPageV2(
  value: unknown,
  isActionV1: (candidate: unknown) => candidate is CompanionActionV1,
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
    || !isBoundedString(value.nextCursor, 512)
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.items)
    || value.items.length > COMPANION_ACTION_V2_MAX_PAGE_ITEMS
  ) return false;
  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    const common = isUuid(item.eventId)
      && isUuid(item.operationId)
      && isUuid(item.aggregateId)
      && Number.isSafeInteger(item.aggregateVersion)
      && Number(item.aggregateVersion) >= 1
      && isBoundedString(item.sourceId, 512)
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
    return item.kind === 'upsert'
      && exactKeys(item, [
        'eventId',
        'operationId',
        'aggregateId',
        'aggregateVersion',
        'sourceId',
        'occurredAt',
        'kind',
        'action',
        'taskMaterializations',
        'creationIntents',
        'managedTaskCommands',
        'taskLifecycleProvenance',
      ])
      && isActionV1(item.action)
      && item.action.actionId === item.aggregateId
      && Array.isArray(item.taskMaterializations)
      && item.taskMaterializations.length <= COMPANION_ACTION_V2_MAX_LINKS
      && item.taskMaterializations.every((relation) => (
        isCompanionTaskMaterializationV2(relation, item.aggregateId as string)
      ))
      && Array.isArray(item.creationIntents)
      && item.creationIntents.length <= COMPANION_ACTION_V2_MAX_LINKS
      && item.creationIntents.every(isCompanionCreationIntentV2)
      && Array.isArray(item.managedTaskCommands)
      && item.managedTaskCommands.every(isManagedTaskCommandV1)
      && isRecord(item.taskLifecycleProvenance)
      && exactKeys(item.taskLifecycleProvenance, ['source', 'state', 'updatedAt'])
      && ['manual-user', 'task-aggregate'].includes(String(item.taskLifecycleProvenance.source))
      && ['visible', 'dismissed', 'handled', 'linked', 'completed', 'link-broken']
        .includes(String(item.taskLifecycleProvenance.state))
      && isInstant(item.taskLifecycleProvenance.updatedAt);
  });
}

export function companionActionV2Digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
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
  if (!UUID_RE.test(input.actionId)) throw new Error('actionId must be a canonical UUID');
  if (
    Buffer.byteLength(input.providerId, 'utf8') > 64
    || !PROVIDER_ID_RE.test(input.providerId)
  ) {
    throw new Error('providerId is outside the V2 contract');
  }
  if (!isBoundedString(input.providerAccountId, 128)) {
    throw new Error('providerAccountId is outside the V2 contract');
  }
  if (
    input.providerContainerId !== undefined
    && !isBoundedString(input.providerContainerId, 256)
  ) {
    throw new Error('providerContainerId is outside the V2 contract');
  }
  if (!isBoundedString(input.providerTaskId, 256)) {
    throw new Error('providerTaskId is outside the V2 contract');
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
