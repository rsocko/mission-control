import { createHash } from 'node:crypto';

export const COMPANION_ACTION_CONTRACT_VERSION = '1.0';
export const COMPANION_ACTION_MAX_AGGREGATE_BYTES = 24 * 1024;
export const COMPANION_ACTION_MAX_WRITE_BYTES = 32 * 1024;
export const COMPANION_ACTION_MAX_PAGE_ITEMS = 100;
export const COMPANION_ACTION_EFFECTIVE_PAGE_ITEMS = 20;
export const COMPANION_ACTION_MAX_SYNC_PAGES = 1_250;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_KEY_RE = /^ak1:[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_KEY_RE = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret)/i;
const PROHIBITED_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'cookie',
  'authorization',
  'credential',
  'password',
  'secret',
  'local_path',
  'file_path',
  'raw_response',
  'diagnostic',
]);

export type ActionPriority = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type ActionLifecycleState =
  | 'visible'
  | 'snoozed'
  | 'dismissed'
  | 'handled'
  | 'linked'
  | 'completed'
  | 'link-broken';
export type ActionCorrection = 'confirmed' | 'incorrect' | 'not-an-action' | 'reclassified';
export type ActionMaterializationState =
  | 'requested'
  | 'pending'
  | 'materialized'
  | 'failed'
  | 'rejected'
  | 'deleted'
  | 'link-broken';

export interface CompanionActionContent {
  title: string;
  summary?: string;
  details?: string;
  actionType: string;
  category?: string;
  direction?: 'sent' | 'received';
  recommendation?: string;
  priority?: ActionPriority;
  dueAt?: string;
  reminderAt?: string;
  disposition?: string;
}

export interface CompanionActionMaterialization {
  materializationId: string;
  revision: number;
  provider: 'microsoft-todo';
  providerAccountId: string;
  providerListId: string;
  providerTaskId: string;
  state: ActionMaterializationState;
  updatedAt: string;
  providerTaskStatusSnapshot?: string;
  providerVersionSnapshot?: string;
  lastObservedAt?: string;
}

export interface CompanionActionV1 {
  contractVersion: 1;
  actionId: string;
  stableKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  source: {
    identity: unknown;
    sourceKind: 'message' | 'thread';
    sourceFamily?: string;
    senderDisplayName?: string;
    conversationTitle?: string;
    messageExcerpt?: string;
    sourceUrl?: string;
    attachments?: readonly {
      attachmentId: string;
      name?: string;
      mediaType?: string;
      byteLength?: number;
    }[];
    sourceCreatedAt?: string;
  };
  content: CompanionActionContent;
  classification: {
    confidenceClass?: 'low' | 'medium' | 'high';
    confidenceScore?: number;
    reason?: string;
    derivationMethod: 'deterministic' | 'pattern' | 'extraction' | 'ai' | 'manual';
    model?: string;
    derivationVersion?: string;
    inputFingerprint: string;
    extractedPayload?: unknown;
  };
  lifecycle: {
    state: ActionLifecycleState;
    snoozedUntil?: string;
    dismissedAt?: string;
    dismissedReason?: string;
    handledAt?: string;
    correction?: ActionCorrection;
    feedback?: readonly unknown[];
  };
  userOverrides?: Readonly<Record<string, unknown>>;
  fieldRevisions: Readonly<Record<string, number>>;
  materializations: readonly CompanionActionMaterialization[];
}

export interface PortableCompanionAction {
  contractVersion: 1;
  actionId: string;
  stableKey: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  sourceKind: 'message' | 'thread';
  sourceFamily?: string;
  source?: {
    senderDisplayName?: string;
    conversationTitle?: string;
    messageExcerpt?: string;
    sourceUrl?: string;
    sourceCreatedAt?: string;
  };
  content: CompanionActionContent;
  classification: {
    confidenceClass?: 'low' | 'medium' | 'high';
    confidenceScore?: number;
    reason?: string;
    derivationMethod: 'deterministic' | 'pattern' | 'extraction' | 'ai' | 'manual';
    model?: string;
    derivationVersion?: string;
    inputFingerprint: string;
  };
  lifecycle: CompanionActionV1['lifecycle'];
  userOverrides?: Readonly<Record<string, unknown>>;
  fieldRevisions: Readonly<Record<string, number>>;
}

export type CompanionActionFeedItem =
  | {
      eventId: string;
      operationId: string;
      aggregateId: string;
      aggregateVersion: number;
      sourceId: string;
      occurredAt: string;
      kind: 'upsert';
      action: CompanionActionV1;
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

export interface CompanionActionFeedPage {
  schemaVersion: '1.0';
  feedId: string;
  mode: 'full' | 'incremental';
  producedAt: string;
  nextCursor: string;
  complete: boolean;
  items: CompanionActionFeedItem[];
}

export type CompanionActionEditableField =
  | 'title'
  | 'summary'
  | 'details'
  | 'actionType'
  | 'category'
  | 'priority'
  | 'dueAt'
  | 'reminderAt'
  | 'disposition';

export type CompanionActionMutation =
  | {
      kind: 'action.user-edit';
      patch: Partial<Record<CompanionActionEditableField, unknown>>;
    }
  | {
      kind: 'action.lifecycle';
      state: ActionLifecycleState;
      snoozedUntil?: string;
      dismissedReason?: string;
    }
  | {
      kind: 'action.correction';
      correction: ActionCorrection;
      correctedActionType?: string;
      correctedCategory?: string;
    }
  | {
      kind: 'materialization.observe';
      materializationId: string;
      providerTaskStatusSnapshot?: string;
      providerVersionSnapshot?: string;
      observedAt: string;
    };

export interface CompanionActionMutationRequest {
  contractVersion: '1.0';
  operationId: string;
  actionId: string;
  baseRevision: number;
  mutation: CompanionActionMutation;
}

export interface CompanionActionMutationReceipt {
  operationId: string;
  actionId: string;
  outcome: 'applied' | 'duplicate' | 'stale-noop' | 'conflict';
  revision: number;
  changeId?: string;
  conflictingFields?: readonly string[];
}

export interface CompanionActionQueueRequest {
  operationId: string;
  actionId: string;
  baseRevision: number;
  expectedFieldRevisions: Readonly<Record<string, number>>;
  mutation: Exclude<CompanionActionMutation, { kind: 'materialization.observe' }>;
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

function isSafeJson(
  value: unknown,
  maximum = 12 * 1024,
  depth = 1,
  seen = new Set<object>(),
): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return true;
  if (typeof value !== 'object' || depth > 8) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const safe = Array.isArray(value)
    ? value.every((item) => isSafeJson(item, maximum, depth + 1, seen))
    : Object.entries(value).every(([key, item]) => (
        !PROHIBITED_KEYS.has(key.toLowerCase())
        && !SECRET_KEY_RE.test(key)
        && isSafeJson(item, maximum, depth + 1, seen)
      ));
  if (!safe) return false;
  try {
    return Buffer.byteLength(canonicalJson(value), 'utf8') <= maximum;
  } catch {
    return false;
  }
}

function isString(value: unknown, max = 8_192): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= max
    && !/[^\u0009\u000a\u000d\u0020-\u007e]/.test(value);
}

function isToken(value: unknown, max: number): value is string {
  return isString(value, max) && TOKEN_RE.test(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string'
    && UTC_MILLIS_RE.test(value)
    && new Date(value).toISOString() === value;
}

function uuidFromDigest(namespace: string, value: unknown): string {
  const bytes = createHash('sha256')
    .update(`${namespace}\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function actionIdFromStableKey(stableKey: string): string {
  return uuidFromDigest('rymessage:action:v1', stableKey);
}

function materializationId(
  actionId: string,
  providerAccountId: string,
  providerListId: string,
  providerTaskId: string,
): string {
  return uuidFromDigest('rymessage:action_materialization:v1', [
    actionId,
    'microsoft-todo',
    providerAccountId,
    providerListId,
    providerTaskId,
  ]);
}

function isMaterialization(
  value: unknown,
  actionId: string,
): value is CompanionActionMaterialization {
  if (!isRecord(value) || !exactKeys(value, [
    'materializationId',
    'revision',
    'provider',
    'providerAccountId',
    'providerListId',
    'providerTaskId',
    'state',
    'updatedAt',
  ], [
    'providerTaskStatusSnapshot',
    'providerVersionSnapshot',
    'lastObservedAt',
  ])) return false;
  return UUID_RE.test(String(value.materializationId ?? ''))
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && value.provider === 'microsoft-todo'
    && isString(value.providerAccountId, 128)
    && isString(value.providerListId, 256)
    && isString(value.providerTaskId, 256)
    && [
      'requested',
      'pending',
      'materialized',
      'failed',
      'rejected',
      'deleted',
      'link-broken',
    ].includes(String(value.state))
    && isIsoInstant(value.updatedAt)
    && (value.providerTaskStatusSnapshot === undefined
      || isToken(value.providerTaskStatusSnapshot, 96))
    && (value.providerVersionSnapshot === undefined
      || isString(value.providerVersionSnapshot, 256))
    && (value.lastObservedAt === undefined || isIsoInstant(value.lastObservedAt))
    && value.materializationId === materializationId(
      actionId,
      value.providerAccountId,
      value.providerListId,
      value.providerTaskId,
    );
}

export function isCompanionActionV1(value: unknown): value is CompanionActionV1 {
  if (!isRecord(value) || !exactKeys(value, [
    'contractVersion',
    'actionId',
    'stableKey',
    'revision',
    'createdAt',
    'updatedAt',
    'lastSeenAt',
    'source',
    'content',
    'classification',
    'lifecycle',
    'fieldRevisions',
    'materializations',
  ], ['userOverrides'])) return false;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COMPANION_ACTION_MAX_AGGREGATE_BYTES) {
    return false;
  }
  const source = value.source;
  const content = value.content;
  const classification = value.classification;
  const lifecycle = value.lifecycle;
  const fieldRevisions = value.fieldRevisions;
  const materializations = value.materializations;
  return value.contractVersion === 1
    && UUID_RE.test(String(value.actionId ?? ''))
    && STABLE_KEY_RE.test(String(value.stableKey ?? ''))
    && value.actionId === actionIdFromStableKey(value.stableKey as string)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && isIsoInstant(value.createdAt)
    && isIsoInstant(value.updatedAt)
    && isIsoInstant(value.lastSeenAt)
    && isRecord(source)
    && exactKeys(source, ['identity', 'sourceKind'], [
      'sourceFamily',
      'senderDisplayName',
      'conversationTitle',
      'messageExcerpt',
      'sourceUrl',
      'attachments',
      'sourceCreatedAt',
    ])
    && isRecord(source.identity)
    && ['bluebubbles_message', 'provider_message', 'bluebubbles_chat_guid', 'provider_thread']
      .includes(String(source.identity.kind))
    && isSafeJson(source.identity, 2 * 1024)
    && (source.sourceKind === 'message' || source.sourceKind === 'thread')
    && (source.sourceFamily === undefined || isToken(source.sourceFamily, 96))
    && (source.senderDisplayName === undefined || isString(source.senderDisplayName, 512))
    && (source.conversationTitle === undefined || isString(source.conversationTitle, 512))
    && (source.messageExcerpt === undefined || isString(source.messageExcerpt, 4 * 1024))
    && (
      source.sourceUrl === undefined
      || (
        isString(source.sourceUrl, 2 * 1024)
        && (() => {
          try {
            const url = new URL(source.sourceUrl as string);
            return (url.protocol === 'https:' || url.protocol === 'http:')
              && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
          } catch {
            return false;
          }
        })()
      )
    )
    && (
      source.attachments === undefined
      || (
        Array.isArray(source.attachments)
        && source.attachments.length <= 16
        && source.attachments.every((attachment) => (
          isRecord(attachment)
          && exactKeys(attachment, ['attachmentId'], ['name', 'mediaType', 'byteLength'])
          && isString(attachment.attachmentId, 256)
          && (attachment.name === undefined || isString(attachment.name, 512))
          && (attachment.mediaType === undefined || isToken(attachment.mediaType, 128))
          && (
            attachment.byteLength === undefined
            || (Number.isSafeInteger(attachment.byteLength) && Number(attachment.byteLength) >= 0)
          )
        ))
      )
    )
    && (source.sourceCreatedAt === undefined || isIsoInstant(source.sourceCreatedAt))
    && isRecord(content)
    && exactKeys(content, ['title', 'actionType'], [
      'summary',
      'details',
      'category',
      'direction',
      'recommendation',
      'priority',
      'dueAt',
      'reminderAt',
      'disposition',
    ])
    && isString(content.title, 512)
    && (content.summary === undefined || isString(content.summary, 2 * 1024))
    && (content.details === undefined || isString(content.details, 8 * 1024))
    && isToken(content.actionType, 96)
    && (content.category === undefined || isToken(content.category, 96))
    && (
      content.direction === undefined
      || content.direction === 'sent'
      || content.direction === 'received'
    )
    && (content.recommendation === undefined || isToken(content.recommendation, 96))
    && (
      content.priority === undefined
      || ['none', 'low', 'medium', 'high', 'critical'].includes(String(content.priority))
    )
    && (content.dueAt === undefined || isIsoInstant(content.dueAt))
    && (content.reminderAt === undefined || isIsoInstant(content.reminderAt))
    && (content.disposition === undefined || isToken(content.disposition, 96))
    && isRecord(classification)
    && exactKeys(classification, ['derivationMethod', 'inputFingerprint'], [
      'confidenceClass',
      'confidenceScore',
      'reason',
      'model',
      'derivationVersion',
      'extractedPayload',
    ])
    && (
      classification.confidenceClass === undefined
      || ['low', 'medium', 'high'].includes(String(classification.confidenceClass))
    )
    && (
      classification.confidenceScore === undefined
      || (
        typeof classification.confidenceScore === 'number'
        && Number.isFinite(classification.confidenceScore)
        && classification.confidenceScore >= 0
        && classification.confidenceScore <= 1
      )
    )
    && (classification.reason === undefined || isString(classification.reason, 2 * 1024))
    && [
      'deterministic',
      'pattern',
      'extraction',
      'ai',
      'manual',
    ].includes(String(classification.derivationMethod))
    && (classification.model === undefined || isString(classification.model, 128))
    && (
      classification.derivationVersion === undefined
      || isString(classification.derivationVersion, 128)
    )
    && /^[0-9a-f]{64}$/.test(String(classification.inputFingerprint ?? ''))
    && (
      classification.extractedPayload === undefined
      || isSafeJson(classification.extractedPayload, 8 * 1024)
    )
    && isRecord(lifecycle)
    && exactKeys(lifecycle, ['state'], [
      'snoozedUntil',
      'dismissedAt',
      'dismissedReason',
      'handledAt',
      'correction',
      'feedback',
    ])
    && [
      'visible',
      'snoozed',
      'dismissed',
      'handled',
      'linked',
      'completed',
      'link-broken',
    ].includes(String(lifecycle.state))
    && (lifecycle.snoozedUntil === undefined || isIsoInstant(lifecycle.snoozedUntil))
    && (lifecycle.dismissedAt === undefined || isIsoInstant(lifecycle.dismissedAt))
    && (lifecycle.handledAt === undefined || isIsoInstant(lifecycle.handledAt))
    && (
      lifecycle.dismissedReason === undefined
      || isString(lifecycle.dismissedReason, 512)
    )
    && (
      lifecycle.correction === undefined
      || ['confirmed', 'incorrect', 'not-an-action', 'reclassified']
        .includes(String(lifecycle.correction))
    )
    && (
      lifecycle.feedback === undefined
      || (
        Array.isArray(lifecycle.feedback)
        && lifecycle.feedback.length <= 32
        && isSafeJson(lifecycle.feedback)
      )
    )
    && isRecord(fieldRevisions)
    && Object.values(fieldRevisions).every(
      (revision) => Number.isSafeInteger(revision)
        && Number(revision) >= 1
        && Number(revision) <= Number(value.revision),
    )
    && Array.isArray(materializations)
    && materializations.length <= 16
    && materializations.every((relation) => isMaterialization(
      relation,
      value.actionId as string,
    ))
    && new Set(materializations.map((relation) => (
      (relation as CompanionActionMaterialization).materializationId
    ))).size === materializations.length
    && (
      value.userOverrides === undefined
      || (
        isRecord(value.userOverrides)
        && Object.keys(value.userOverrides).every((key) => [
          'title',
          'summary',
          'details',
          'actionType',
          'category',
          'priority',
          'dueAt',
          'reminderAt',
          'disposition',
        ].includes(key))
        && isSafeJson(value.userOverrides)
      )
    );
}

export function isCompanionActionFeedPage(value: unknown): value is CompanionActionFeedPage {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'schemaVersion',
      'feedId',
      'mode',
      'producedAt',
      'nextCursor',
      'complete',
      'items',
    ])
    || !Array.isArray(value.items)
  ) return false;
  if (
    value.schemaVersion !== COMPANION_ACTION_CONTRACT_VERSION
    || !UUID_RE.test(String(value.feedId ?? ''))
    || (value.mode !== 'full' && value.mode !== 'incremental')
    || !isIsoInstant(value.producedAt)
    || !isString(value.nextCursor, 512)
    || typeof value.complete !== 'boolean'
    || value.items.length > COMPANION_ACTION_EFFECTIVE_PAGE_ITEMS
  ) return false;
  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    const itemKeys = item.kind === 'upsert'
      ? ['eventId', 'operationId', 'aggregateId', 'aggregateVersion', 'sourceId', 'occurredAt', 'kind', 'action']
      : ['eventId', 'operationId', 'aggregateId', 'aggregateVersion', 'sourceId', 'occurredAt', 'kind'];
    if (!exactKeys(item, itemKeys)) return false;
    const common = UUID_RE.test(String(item.eventId ?? ''))
      && UUID_RE.test(String(item.operationId ?? ''))
      && UUID_RE.test(String(item.aggregateId ?? ''))
      && Number.isSafeInteger(item.aggregateVersion)
      && Number(item.aggregateVersion) >= 1
      && isString(item.sourceId, 512)
      && isIsoInstant(item.occurredAt);
    if (!common) return false;
    return item.kind === 'tombstone'
      ? item.action === undefined
      : item.kind === 'upsert'
        && isCompanionActionV1(item.action)
        && item.action.actionId === item.aggregateId
        && item.action.revision === item.aggregateVersion;
  });
}

export function isCompanionActionMutation(value: unknown): value is CompanionActionMutation {
  if (!isRecord(value) || !isString(value.kind, 64)) return false;
  if (value.kind === 'action.user-edit') {
    if (!exactKeys(value, ['kind', 'patch']) || !isRecord(value.patch)) return false;
    const allowed = new Set<CompanionActionEditableField>([
      'title',
      'summary',
      'details',
      'actionType',
      'category',
      'priority',
      'dueAt',
      'reminderAt',
      'disposition',
    ]);
    const entries = Object.entries(value.patch);
    return entries.length > 0
      && entries.every(([key, item]) => {
        if (!allowed.has(key as CompanionActionEditableField)) return false;
        if (key === 'title') return isString(item, 512);
        if (key === 'summary') return item === null || isString(item, 2 * 1024);
        if (key === 'details') return item === null || isString(item, 8 * 1024);
        if (['actionType', 'category', 'disposition'].includes(key)) {
          return item === null || isToken(item, 96);
        }
        if (key === 'priority') {
          return item === null
            || ['none', 'low', 'medium', 'high', 'critical'].includes(String(item));
        }
        return item === null || isIsoInstant(item);
      })
      && isSafeJson(value.patch);
  }
  if (value.kind === 'action.lifecycle') {
    return exactKeys(value, ['kind', 'state'], ['snoozedUntil', 'dismissedReason'])
      && [
        'visible',
        'snoozed',
        'dismissed',
        'handled',
        'linked',
        'completed',
        'link-broken',
      ].includes(String(value.state))
      && (value.snoozedUntil === undefined || isIsoInstant(value.snoozedUntil))
      && (value.dismissedReason === undefined || isString(value.dismissedReason, 512));
  }
  if (value.kind === 'action.correction') {
    return exactKeys(value, ['kind', 'correction'], [
      'correctedActionType',
      'correctedCategory',
    ])
      && ['confirmed', 'incorrect', 'not-an-action', 'reclassified']
        .includes(String(value.correction))
      && (
        value.correctedActionType === undefined
        || isToken(value.correctedActionType, 96)
      )
      && (
        value.correctedCategory === undefined
        || isToken(value.correctedCategory, 96)
      );
  }
  return value.kind === 'materialization.observe'
    && exactKeys(value, ['kind', 'materializationId', 'observedAt'], [
      'providerTaskStatusSnapshot',
      'providerVersionSnapshot',
    ])
    && UUID_RE.test(String(value.materializationId ?? ''))
    && isIsoInstant(value.observedAt)
    && (value.providerTaskStatusSnapshot === undefined
      || isToken(value.providerTaskStatusSnapshot, 96))
    && (value.providerVersionSnapshot === undefined
      || isString(value.providerVersionSnapshot, 256));
}

export function isCompanionActionQueueRequest(
  value: unknown,
): value is CompanionActionQueueRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'operationId',
    'actionId',
    'baseRevision',
    'expectedFieldRevisions',
    'mutation',
  ])) return false;
  return UUID_RE.test(String(value.operationId ?? ''))
    && UUID_RE.test(String(value.actionId ?? ''))
    && Number.isSafeInteger(value.baseRevision)
    && Number(value.baseRevision) >= 1
    && isRecord(value.expectedFieldRevisions)
    && Object.keys(value.expectedFieldRevisions).length <= 32
    && Object.entries(value.expectedFieldRevisions).every(([field, revision]) => (
      isString(field, 128)
      && Number.isSafeInteger(revision)
      && Number(revision) >= 0
      && Number(revision) <= Number(value.baseRevision)
    ))
    && isCompanionActionMutation(value.mutation)
    && value.mutation.kind !== 'materialization.observe';
}

export function isCompanionActionMutationReceipt(
  value: unknown,
): value is CompanionActionMutationReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    'operationId',
    'actionId',
    'outcome',
    'revision',
  ], ['changeId', 'conflictingFields'])) return false;
  return UUID_RE.test(String(value.operationId ?? ''))
    && UUID_RE.test(String(value.actionId ?? ''))
    && ['applied', 'duplicate', 'stale-noop', 'conflict'].includes(String(value.outcome))
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && (value.changeId === undefined || UUID_RE.test(String(value.changeId)))
    && (
      value.conflictingFields === undefined
      || (
        Array.isArray(value.conflictingFields)
        && value.conflictingFields.every((field) => isString(field, 128))
      )
    );
}

export function sanitizeCompanionAction(action: CompanionActionV1): PortableCompanionAction {
  const lifecycle = { ...action.lifecycle };
  delete lifecycle.feedback;
  const source = {
    ...(action.source.senderDisplayName
      ? { senderDisplayName: action.source.senderDisplayName }
      : {}),
    ...(action.source.conversationTitle
      ? { conversationTitle: action.source.conversationTitle }
      : {}),
    ...(action.source.messageExcerpt
      ? { messageExcerpt: action.source.messageExcerpt }
      : {}),
    ...(action.source.sourceUrl ? { sourceUrl: action.source.sourceUrl } : {}),
    ...(action.source.sourceCreatedAt
      ? { sourceCreatedAt: action.source.sourceCreatedAt }
      : {}),
  };
  return {
    contractVersion: 1,
    actionId: action.actionId,
    stableKey: action.stableKey,
    revision: action.revision,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    lastSeenAt: action.lastSeenAt,
    sourceKind: action.source.sourceKind,
    ...(action.source.sourceFamily ? { sourceFamily: action.source.sourceFamily } : {}),
    ...(Object.keys(source).length > 0 ? { source } : {}),
    content: { ...action.content },
    classification: {
      ...(action.classification.confidenceClass
        ? { confidenceClass: action.classification.confidenceClass }
        : {}),
      ...(action.classification.confidenceScore !== undefined
        ? { confidenceScore: action.classification.confidenceScore }
        : {}),
      ...(action.classification.reason
        ? { reason: action.classification.reason }
        : {}),
      derivationMethod: action.classification.derivationMethod,
      ...(action.classification.model ? { model: action.classification.model } : {}),
      ...(action.classification.derivationVersion
        ? { derivationVersion: action.classification.derivationVersion }
        : {}),
      inputFingerprint: action.classification.inputFingerprint,
    },
    lifecycle,
    ...(action.userOverrides ? { userOverrides: { ...action.userOverrides } } : {}),
    fieldRevisions: { ...action.fieldRevisions },
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function companionActionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function stableCompanionOperationId(identity: string): string {
  const bytes = Buffer.from(createHash('sha256').update(identity).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
