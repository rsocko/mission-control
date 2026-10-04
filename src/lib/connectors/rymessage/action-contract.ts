import { createHash } from 'node:crypto';

export const ACTION_MUTATION_EVENT_DOMAIN = 'action_mutation_event';
export const ACTION_STATE_PROJECTION_DOMAIN = 'action_state_projection';
export const ACTION_STATE_FEATURE = 'action_state_v2';
export const ACTION_STATE_SCHEMA_VERSION = 2;
export const ACTION_STATE_CONTRACT_VERSION = '2.0';

export const ACTION_STATE_LIMITS = Object.freeze({
  maxAggregateBytes: 24 * 1024,
  maxMutationBytes: 24 * 1024,
  maxWriteBytes: 32 * 1024,
  maxPageItems: 100,
  defaultPageItems: 50,
  maxPageBytes: 512 * 1024,
  maxTitleBytes: 512,
  maxSummaryBytes: 2 * 1024,
  maxDetailsBytes: 8 * 1024,
  maxMessageExcerptBytes: 4 * 1024,
  maxSourceUrlBytes: 2 * 1024,
  maxExtractedPayloadBytes: 8 * 1024,
  maxAttachments: 16,
  maxFeedback: 32,
  maxMaterializations: 16,
  maxCursorBytes: 512,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_KEY_RE = /^ak1:[0-9a-f]{64}$/;
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActionPriority = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type ActionLifecycleState =
  | 'visible'
  | 'snoozed'
  | 'dismissed'
  | 'handled'
  | 'linked'
  | 'completed'
  | 'link-broken';
export type ActionCorrection =
  | 'confirmed'
  | 'incorrect'
  | 'not-an-action'
  | 'reclassified';
export type ActionMaterializationState =
  | 'requested'
  | 'pending'
  | 'materialized'
  | 'failed'
  | 'rejected'
  | 'deleted'
  | 'link-broken';

export interface ActionAttachmentV2 {
  readonly attachmentId: string;
  readonly name?: string;
  readonly mediaType?: string;
  readonly byteLength?: number;
}

export interface ActionSourceV2 {
  readonly identity: JsonValue;
  readonly sourceKind: 'message' | 'thread';
  readonly sourceFamily?: string;
  readonly senderDisplayName?: string;
  readonly conversationTitle?: string;
  readonly messageExcerpt?: string;
  readonly sourceUrl?: string;
  readonly attachments?: readonly ActionAttachmentV2[];
  readonly sourceCreatedAt?: string;
}

export interface ActionContentV2 {
  readonly title: string;
  readonly summary?: string;
  readonly details?: string;
  readonly actionType: string;
  readonly category?: string;
  readonly direction?: 'sent' | 'received';
  readonly recommendation?: string;
  readonly priority?: ActionPriority;
  readonly dueAt?: string;
  readonly reminderAt?: string;
  readonly disposition?: string;
}

export interface ActionClassificationV2 {
  readonly confidenceClass?: 'low' | 'medium' | 'high';
  readonly confidenceScore?: number;
  readonly reason?: string;
  readonly derivationMethod: 'deterministic' | 'pattern' | 'extraction' | 'ai' | 'manual';
  readonly model?: string;
  readonly derivationVersion?: string;
  readonly inputFingerprint: string;
  readonly extractedPayload?: JsonValue;
}

export interface ActionFeedbackV2 {
  readonly feedbackId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly correctedActionType?: string;
  readonly correctedCategory?: string;
}

export interface ActionLifecycleV2 {
  readonly state: ActionLifecycleState;
  readonly snoozedUntil?: string;
  readonly dismissedAt?: string;
  readonly dismissedReason?: string;
  readonly handledAt?: string;
  readonly correction?: ActionCorrection;
  readonly feedback?: readonly ActionFeedbackV2[];
}

export interface ActionMaterializationV2 {
  readonly materializationId: string;
  readonly revision: number;
  readonly provider: 'microsoft-todo';
  readonly providerAccountId: string;
  readonly providerListId: string;
  readonly providerTaskId: string;
  readonly state: ActionMaterializationState;
  readonly updatedAt: string;
  readonly providerTaskStatusSnapshot?: string;
  readonly providerVersionSnapshot?: string;
  readonly lastObservedAt?: string;
}

export interface ActionV2 {
  readonly contractVersion: 2;
  readonly actionId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string;
  readonly source: ActionSourceV2;
  readonly content: ActionContentV2;
  readonly classification: ActionClassificationV2;
  readonly lifecycle: ActionLifecycleV2;
  readonly userOverrides?: Readonly<Partial<Record<ActionEditableField, JsonValue>>>;
  readonly fieldRevisions: Readonly<Record<string, number>>;
  readonly materializations: readonly ActionMaterializationV2[];
}

export type ActionEditableField =
  | 'title'
  | 'summary'
  | 'details'
  | 'actionType'
  | 'category'
  | 'priority'
  | 'dueAt'
  | 'reminderAt'
  | 'disposition';

export type ActionMutation =
  | {
      readonly kind: 'action.user-edit';
      readonly patch: Readonly<Partial<Record<ActionEditableField, JsonValue>>>;
    }
  | {
      readonly kind: 'action.lifecycle';
      readonly state: ActionLifecycleState;
      readonly snoozedUntil?: string;
      readonly dismissedReason?: string;
    }
  | {
      readonly kind: 'action.correction';
      readonly correction: ActionCorrection;
      readonly correctedActionType?: string;
      readonly correctedCategory?: string;
    }
  | {
      readonly kind: 'materialization.link';
      readonly materializationId: string;
      readonly provider: 'microsoft-todo';
      readonly providerAccountId: string;
      readonly providerListId: string;
      readonly providerTaskId: string;
    }
  | {
      readonly kind: 'materialization.observe';
      readonly materializationId: string;
      readonly state?: 'deleted' | 'link-broken';
      readonly providerTaskStatusSnapshot?: string;
      readonly providerVersionSnapshot?: string;
      readonly observedAt: string;
    };

export interface ActionIntegrationMutationRequestV2 {
  readonly contractVersion: '2.0';
  readonly operationId: string;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly mutation: ActionMutation;
}

export interface ActionDeviceMutationRequestV2 {
  readonly contractVersion: '2.0';
  readonly operationId: string;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly mutation:
    | {
        readonly kind: 'action.create';
        readonly action: ActionV2;
      }
    | {
        readonly kind: 'action.source-refresh';
        readonly action: ActionV2;
      };
}

export type ActionClientMutationRequestV2 =
  | ActionIntegrationMutationRequestV2
  | ActionDeviceMutationRequestV2;

export interface ActionMutationReceiptV2 {
  readonly operationId: string;
  readonly actionId: string;
  readonly outcome: 'applied' | 'stale-noop' | 'conflict';
  readonly revision: number;
  readonly conflictingFields?: readonly string[];
}

export type ActionMutationReduction =
  | {
      readonly outcome: 'applied';
      readonly action: ActionV2;
      readonly touchedFields: readonly string[];
    }
  | {
      readonly outcome: 'stale-noop';
      readonly action: ActionV2;
      readonly touchedFields: readonly string[];
    }
  | {
      readonly outcome: 'conflict';
      readonly action: ActionV2;
      readonly conflictingFields: readonly string[];
    }
  | {
      readonly outcome: 'rejected';
      readonly action: ActionV2;
      readonly reason:
        | 'action-id-mismatch'
        | 'materialization-not-found'
        | 'mutation-invalid'
        | 'revision-ahead';
    };

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

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value as JsonValue;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key] as JsonValue)]),
  );
}

export function canonicalActionJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function uuidFromDigest(namespace: string, value: JsonValue | string): string {
  const canonical = typeof value === 'string' ? value : canonicalActionJson(value);
  const bytes = createHash('sha256')
    .update(`${namespace}\0`, 'utf8')
    .update(canonical, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function actionStableKey(
  portableSourceIdentity: JsonValue,
  sourceKind: 'message' | 'thread',
  generatorNamespace: string,
  candidateKey: string,
): string {
  if (
    !validToken(generatorNamespace, 96)
    || !validToken(candidateKey, 256)
    || !isPortableSourceIdentity(portableSourceIdentity)
  ) {
    throw new Error('action-identity-invalid');
  }
  return `ak1:${createHash('sha256')
    .update(canonicalActionJson([
      portableSourceIdentity,
      sourceKind,
      generatorNamespace,
      candidateKey,
    ]), 'utf8')
    .digest('hex')}`;
}

export function actionIdFromStableKey(stableKey: string): string {
  if (!STABLE_KEY_RE.test(stableKey)) throw new Error('action-identity-invalid');
  return uuidFromDigest('rymessage:action:v1', stableKey);
}

export function actionFeedSourceId(feedId: string, actionId: string): string {
  if (!UUID_RE.test(feedId) || !UUID_RE.test(actionId)) {
    throw new Error('action-feed-source-identity-invalid');
  }
  return `rymessage:${feedId}:action:${actionId}`;
}

export function actionMaterializationId(
  actionId: string,
  provider: 'microsoft-todo',
  providerAccountId: string,
  providerListId: string,
  providerTaskId: string,
): string {
  if (
    !UUID_RE.test(actionId)
    || provider !== 'microsoft-todo'
    || !validText(providerAccountId, 128)
    || !validText(providerListId, 256)
    || !validText(providerTaskId, 256)
  ) {
    throw new Error('action-materialization-identity-invalid');
  }
  return uuidFromDigest('rymessage:action_materialization:v1', [
    actionId,
    provider,
    providerAccountId,
    providerListId,
    providerTaskId,
  ]);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validToken(value: unknown, maximum: number): value is string {
  return validText(value, maximum) && TOKEN_RE.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && UTC_MILLIS_RE.test(value)
    && new Date(value).toISOString() === value;
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || validTimestamp(value);
}

function jsonDepth(value: JsonValue): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  if (isObject(value)) {
    return 1 + Math.max(0, ...Object.values(value).map((child) => jsonDepth(child as JsonValue)));
  }
  return 1;
}

const PROHIBITED_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'cookie',
  'authorization',
  'password',
  'secret',
  'local_path',
  'file_path',
  'raw_response',
  'diagnostic',
]);

function containsProhibitedKey(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsProhibitedKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    PROHIBITED_KEYS.has(key.toLowerCase()) || containsProhibitedKey(child as JsonValue)
  ));
}

function validBoundedJson(value: unknown, maximum: number): value is JsonValue {
  try {
    const json = value as JsonValue;
    return jsonDepth(json) <= 8
      && Buffer.byteLength(canonicalActionJson(json), 'utf8') <= maximum
      && !containsProhibitedKey(json);
  } catch {
    return false;
  }
}

function validUserEditValue(field: string, value: unknown): boolean {
  switch (field) {
    case 'title':
      return validText(value, ACTION_STATE_LIMITS.maxTitleBytes);
    case 'summary':
      return value === null || validText(value, ACTION_STATE_LIMITS.maxSummaryBytes);
    case 'details':
      return value === null || validText(value, ACTION_STATE_LIMITS.maxDetailsBytes);
    case 'actionType':
    case 'category':
    case 'disposition':
      return value === null || validToken(value, 96);
    case 'priority':
      return value === null || ['none', 'low', 'medium', 'high', 'critical'].includes(String(value));
    case 'dueAt':
    case 'reminderAt':
      return value === null || validTimestamp(value);
    default:
      return false;
  }
}

function validUserEditPatch(
  value: unknown,
): value is Partial<Record<ActionEditableField, JsonValue>> {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0
    && entries.every(([field, fieldValue]) => validUserEditValue(field, fieldValue))
    && validBoundedJson(value, 12 * 1024);
}

function isPortableSourceIdentity(value: unknown): value is JsonValue {
  return isObject(value)
    && typeof value.kind === 'string'
    && [
      'bluebubbles_message',
      'provider_message',
      'bluebubbles_chat_guid',
      'provider_thread',
    ].includes(value.kind)
    && validBoundedJson(value, 2 * 1024);
}

function validAttachment(value: unknown): value is ActionAttachmentV2 {
  if (!isObject(value) || !exactKeys(
    value,
    ['attachmentId'],
    ['name', 'mediaType', 'byteLength'],
  )) return false;
  return validText(value.attachmentId, 256)
    && (value.name === undefined || validText(value.name, 512))
    && (value.mediaType === undefined || validToken(value.mediaType, 128))
    && (
      value.byteLength === undefined
      || (Number.isSafeInteger(value.byteLength) && (value.byteLength as number) >= 0)
    );
}

function validSource(value: unknown): value is ActionSourceV2 {
  if (!isObject(value) || !exactKeys(value, ['identity', 'sourceKind'], [
    'sourceFamily',
    'senderDisplayName',
    'conversationTitle',
    'messageExcerpt',
    'sourceUrl',
    'attachments',
    'sourceCreatedAt',
  ])) return false;
  let validUrl = true;
  if (value.sourceUrl !== undefined) {
    if (!validText(value.sourceUrl, ACTION_STATE_LIMITS.maxSourceUrlBytes)) return false;
    try {
      const url = new URL(value.sourceUrl);
      validUrl = (url.protocol === 'https:' || url.protocol === 'http:')
        && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch {
      validUrl = false;
    }
  }
  return isPortableSourceIdentity(value.identity)
    && (value.sourceKind === 'message' || value.sourceKind === 'thread')
    && (value.sourceFamily === undefined || validToken(value.sourceFamily, 96))
    && (value.senderDisplayName === undefined || validText(value.senderDisplayName, 512))
    && (value.conversationTitle === undefined || validText(value.conversationTitle, 512))
    && (
      value.messageExcerpt === undefined
      || validText(value.messageExcerpt, ACTION_STATE_LIMITS.maxMessageExcerptBytes)
    )
    && validUrl
    && (
      value.attachments === undefined
      || (
        Array.isArray(value.attachments)
        && value.attachments.length <= ACTION_STATE_LIMITS.maxAttachments
        && value.attachments.every(validAttachment)
      )
    )
    && validOptionalTimestamp(value.sourceCreatedAt);
}

function validContent(value: unknown): value is ActionContentV2 {
  if (!isObject(value) || !exactKeys(value, ['title', 'actionType'], [
    'summary',
    'details',
    'category',
    'direction',
    'recommendation',
    'priority',
    'dueAt',
    'reminderAt',
    'disposition',
  ])) return false;
  return validText(value.title, ACTION_STATE_LIMITS.maxTitleBytes)
    && (value.summary === undefined || validText(value.summary, ACTION_STATE_LIMITS.maxSummaryBytes))
    && (value.details === undefined || validText(value.details, ACTION_STATE_LIMITS.maxDetailsBytes))
    && validToken(value.actionType, 96)
    && (value.category === undefined || validToken(value.category, 96))
    && (value.direction === undefined || value.direction === 'sent' || value.direction === 'received')
    && (value.recommendation === undefined || validToken(value.recommendation, 96))
    && (
      value.priority === undefined
      || ['none', 'low', 'medium', 'high', 'critical'].includes(String(value.priority))
    )
    && validOptionalTimestamp(value.dueAt)
    && validOptionalTimestamp(value.reminderAt)
    && (value.disposition === undefined || validToken(value.disposition, 96));
}

function validClassification(value: unknown): value is ActionClassificationV2 {
  if (!isObject(value) || !exactKeys(value, ['derivationMethod', 'inputFingerprint'], [
    'confidenceClass',
    'confidenceScore',
    'reason',
    'model',
    'derivationVersion',
    'extractedPayload',
  ])) return false;
  return (
    value.confidenceClass === undefined
    || ['low', 'medium', 'high'].includes(String(value.confidenceClass))
  )
    && (
      value.confidenceScore === undefined
      || (
        typeof value.confidenceScore === 'number'
        && Number.isFinite(value.confidenceScore)
        && value.confidenceScore >= 0
        && value.confidenceScore <= 1
      )
    )
    && (value.reason === undefined || validText(value.reason, 2 * 1024))
    && ['deterministic', 'pattern', 'extraction', 'ai', 'manual']
      .includes(String(value.derivationMethod))
    && (value.model === undefined || validText(value.model, 128))
    && (value.derivationVersion === undefined || validText(value.derivationVersion, 128))
    && typeof value.inputFingerprint === 'string'
    && HEX_DIGEST_RE.test(value.inputFingerprint)
    && (
      value.extractedPayload === undefined
      || validBoundedJson(value.extractedPayload, ACTION_STATE_LIMITS.maxExtractedPayloadBytes)
    );
}

function validLifecycle(value: unknown): value is ActionLifecycleV2 {
  if (!isObject(value) || !exactKeys(value, ['state'], [
    'snoozedUntil',
    'dismissedAt',
    'dismissedReason',
    'handledAt',
    'correction',
    'feedback',
  ])) return false;
  if (!['visible', 'snoozed', 'dismissed', 'handled', 'linked', 'completed', 'link-broken']
    .includes(String(value.state))) return false;
  if (
    !validOptionalTimestamp(value.snoozedUntil)
    || !validOptionalTimestamp(value.dismissedAt)
    || !validOptionalTimestamp(value.handledAt)
    || (value.dismissedReason !== undefined && !validText(value.dismissedReason, 512))
    || (
      value.correction !== undefined
      && !['confirmed', 'incorrect', 'not-an-action', 'reclassified']
        .includes(String(value.correction))
    )
  ) return false;
  if (value.feedback === undefined) return true;
  if (!Array.isArray(value.feedback) || value.feedback.length > ACTION_STATE_LIMITS.maxFeedback) {
    return false;
  }
  const ids = new Set<string>();
  return value.feedback.every((feedback) => {
    if (!isObject(feedback) || !exactKeys(feedback, ['feedbackId', 'kind', 'occurredAt'], [
      'correctedActionType',
      'correctedCategory',
    ])) return false;
    if (
      typeof feedback.feedbackId !== 'string'
      || !UUID_RE.test(feedback.feedbackId)
      || ids.has(feedback.feedbackId)
      || !validToken(feedback.kind, 64)
      || !validTimestamp(feedback.occurredAt)
      || (
        feedback.correctedActionType !== undefined
        && !validToken(feedback.correctedActionType, 96)
      )
      || (
        feedback.correctedCategory !== undefined
        && !validToken(feedback.correctedCategory, 96)
      )
    ) return false;
    ids.add(feedback.feedbackId);
    return true;
  });
}

function validMaterialization(
  value: unknown,
  actionId: string,
): value is ActionMaterializationV2 {
  if (!isObject(value) || !exactKeys(value, [
    'materializationId',
    'revision',
    'provider',
    'providerAccountId',
    'providerListId',
    'providerTaskId',
    'state',
    'updatedAt',
  ], ['providerTaskStatusSnapshot', 'providerVersionSnapshot', 'lastObservedAt'])) return false;
  if (
    typeof value.materializationId !== 'string'
    || !UUID_RE.test(value.materializationId)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || value.provider !== 'microsoft-todo'
    || !validText(value.providerAccountId, 128)
    || !validText(value.providerListId, 256)
    || !validText(value.providerTaskId, 256)
    || !['requested', 'pending', 'materialized', 'failed', 'rejected', 'deleted', 'link-broken']
      .includes(String(value.state))
    || !validTimestamp(value.updatedAt)
    || (
      value.providerTaskStatusSnapshot !== undefined
      && !validToken(value.providerTaskStatusSnapshot, 96)
    )
    || (
      value.providerVersionSnapshot !== undefined
      && !validText(value.providerVersionSnapshot, 256)
    )
    || !validOptionalTimestamp(value.lastObservedAt)
  ) return false;
  return value.materializationId === actionMaterializationId(
    actionId,
    'microsoft-todo',
    value.providerAccountId,
    value.providerListId,
    value.providerTaskId,
  );
}

export function isActionV2(value: unknown): value is ActionV2 {
  if (!isObject(value) || !exactKeys(value, [
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
  if (
    value.contractVersion !== ACTION_STATE_SCHEMA_VERSION
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || typeof value.stableKey !== 'string'
    || !STABLE_KEY_RE.test(value.stableKey)
    || value.actionId !== actionIdFromStableKey(value.stableKey)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || !validTimestamp(value.lastSeenAt)
    || !validSource(value.source)
    || !validContent(value.content)
    || !validClassification(value.classification)
    || !validLifecycle(value.lifecycle)
    || !isObject(value.fieldRevisions)
    || Object.values(value.fieldRevisions).some(
      (revision) => !Number.isSafeInteger(revision)
        || (revision as number) < 1
        || (revision as number) > (value.revision as number),
    )
    || !Array.isArray(value.materializations)
    || value.materializations.length > ACTION_STATE_LIMITS.maxMaterializations
    || !value.materializations.every((relation) => validMaterialization(relation, value.actionId as string))
  ) return false;
  const relationIds = value.materializations.map(
    (relation) => (relation as ActionMaterializationV2).materializationId,
  );
  if (new Set(relationIds).size !== relationIds.length) return false;
  if (value.userOverrides !== undefined) {
    if (!isObject(value.userOverrides)) return false;
    const fields = new Set<ActionEditableField>([
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
    if (
      Object.keys(value.userOverrides).some((field) => !fields.has(field as ActionEditableField))
      || !validBoundedJson(value.userOverrides, 12 * 1024)
    ) return false;
  }
  return Buffer.byteLength(canonicalActionJson(value as JsonValue), 'utf8')
    <= ACTION_STATE_LIMITS.maxAggregateBytes;
}

export function storedActionV2(value: unknown): ActionV2 | null {
  if (isActionV2(value)) return value;
  if (!isObject(value) || value.contractVersion !== 1) return null;
  const upgraded = { ...value, contractVersion: ACTION_STATE_SCHEMA_VERSION };
  return isActionV2(upgraded) ? upgraded : null;
}

export function isActionIntegrationMutationRequestV2(
  value: unknown,
): value is ActionIntegrationMutationRequestV2 {
  if (!isObject(value) || !exactKeys(value, [
    'contractVersion',
    'operationId',
    'actionId',
    'baseRevision',
    'mutation',
  ])) return false;
  if (
    value.contractVersion !== ACTION_STATE_CONTRACT_VERSION
    || typeof value.operationId !== 'string'
    || !UUID_RE.test(value.operationId)
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !Number.isSafeInteger(value.baseRevision)
    || (value.baseRevision as number) < 1
    || !isObject(value.mutation)
    || typeof value.mutation.kind !== 'string'
    || 'accountId' in value
    || 'accountScope' in value
    || 'feedId' in value
  ) return false;
  const mutation = value.mutation;
  switch (mutation.kind) {
    case 'action.user-edit': {
      if (!exactKeys(mutation, ['kind', 'patch']) || !isObject(mutation.patch)) return false;
      return validUserEditPatch(mutation.patch);
    }

    case 'action.lifecycle':
      return exactKeys(mutation, ['kind', 'state'], ['snoozedUntil', 'dismissedReason'])
        && ['visible', 'snoozed', 'dismissed', 'handled', 'linked', 'completed', 'link-broken']
          .includes(String(mutation.state))
        && validOptionalTimestamp(mutation.snoozedUntil)
        && (
          mutation.dismissedReason === undefined
          || validText(mutation.dismissedReason, 512)
        );
    case 'action.correction':
      return exactKeys(mutation, ['kind', 'correction'], [
        'correctedActionType',
        'correctedCategory',
      ])
        && ['confirmed', 'incorrect', 'not-an-action', 'reclassified']
          .includes(String(mutation.correction))
        && (
          mutation.correctedActionType === undefined
          || validToken(mutation.correctedActionType, 96)
        )
        && (
          mutation.correctedCategory === undefined
          || validToken(mutation.correctedCategory, 96)
        );
    case 'materialization.link':
      return exactKeys(mutation, [
        'kind',
        'materializationId',
        'provider',
        'providerAccountId',
        'providerListId',
        'providerTaskId',
      ])
        && mutation.provider === 'microsoft-todo'
        && typeof mutation.materializationId === 'string'
        && UUID_RE.test(mutation.materializationId)
        && validText(mutation.providerAccountId, 128)
        && validText(mutation.providerListId, 256)
        && validText(mutation.providerTaskId, 256)
        && mutation.materializationId === actionMaterializationId(
          value.actionId as string,
          mutation.provider,
          mutation.providerAccountId,
          mutation.providerListId,
          mutation.providerTaskId,
        );
    case 'materialization.observe':
      return exactKeys(mutation, ['kind', 'materializationId', 'observedAt'], [
        'state',
        'providerTaskStatusSnapshot',
        'providerVersionSnapshot',
      ])
        && typeof mutation.materializationId === 'string'
        && UUID_RE.test(mutation.materializationId)
        && validTimestamp(mutation.observedAt)
        && (
          mutation.state === undefined
          || mutation.state === 'deleted'
          || mutation.state === 'link-broken'
        )
        && (
          mutation.providerTaskStatusSnapshot === undefined
          || validToken(mutation.providerTaskStatusSnapshot, 96)
        )
        && (
          mutation.providerVersionSnapshot === undefined
          || validText(mutation.providerVersionSnapshot, 256)
        );
    default:
      return false;
  }
}

export function isActionDeviceMutationRequestV2(
  value: unknown,
): value is ActionClientMutationRequestV2 {
  if (isActionIntegrationMutationRequestV2(value)) return true;
  if (!isObject(value) || !exactKeys(value, [
    'contractVersion',
    'operationId',
    'actionId',
    'baseRevision',
    'mutation',
  ])) return false;
  if (
    value.contractVersion !== ACTION_STATE_CONTRACT_VERSION
    || typeof value.operationId !== 'string'
    || !UUID_RE.test(value.operationId)
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !isObject(value.mutation)
    || !exactKeys(value.mutation, ['kind', 'action'])
    || !isActionV2(value.mutation.action)
  ) return false;
  if (
    value.mutation.action.actionId !== value.actionId
    || value.mutation.action.materializations.length !== 0
    || value.mutation.action.revision !== 1
  ) return false;
  if (value.mutation.kind === 'action.create') return value.baseRevision === 0;
  return value.mutation.kind === 'action.source-refresh'
    && Number.isSafeInteger(value.baseRevision)
    && (value.baseRevision as number) >= 1;
}

export function actionMutationDigest(
  request: ActionIntegrationMutationRequestV2 | ActionDeviceMutationRequestV2,
): string {
  return createHash('sha256')
    .update(canonicalActionJson(request as unknown as JsonValue), 'utf8')
    .digest('hex');
}

function mutationFields(mutation: ActionMutation): readonly string[] {
  switch (mutation.kind) {
    case 'action.user-edit':
      return Object.keys(mutation.patch).sort();
    case 'action.lifecycle':
      return ['lifecycle'];
    case 'action.correction':
      return [
        'correction',
        ...(mutation.correctedActionType === undefined ? [] : ['actionType']),
        ...(mutation.correctedCategory === undefined ? [] : ['category']),
      ];
    case 'materialization.link':
    case 'materialization.observe':
      return [`materialization:${mutation.materializationId}`];
  }
}

function contentWithPatch(
  content: ActionContentV2,
  patch: Readonly<Partial<Record<ActionEditableField, JsonValue>>>,
): ActionContentV2 {
  const next = { ...content } as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next as unknown as ActionContentV2;
}

export function reduceActionMutation(
  action: ActionV2,
  request: ActionIntegrationMutationRequestV2,
  occurredAt: string,
): ActionMutationReduction {
  if (
    !isActionV2(action)
    || !isActionIntegrationMutationRequestV2(request)
    || !validTimestamp(occurredAt)
  ) {
    return { outcome: 'rejected', action, reason: 'mutation-invalid' };
  }
  if (request.actionId !== action.actionId) {
    return { outcome: 'rejected', action, reason: 'action-id-mismatch' };
  }
  if (request.baseRevision > action.revision) {
    return { outcome: 'rejected', action, reason: 'revision-ahead' };
  }
  const touchedFields = mutationFields(request.mutation);
  if (request.mutation.kind === 'materialization.link') {
    const mutation = request.mutation;
    const existing = action.materializations.find(
      ({ materializationId }) => materializationId === mutation.materializationId,
    );
    if (existing !== undefined) {
      const sameRelation = existing.provider === mutation.provider
        && existing.providerAccountId === mutation.providerAccountId
        && existing.providerListId === mutation.providerListId
        && existing.providerTaskId === mutation.providerTaskId;
      return sameRelation
        ? { outcome: 'stale-noop', action, touchedFields }
        : { outcome: 'conflict', action, conflictingFields: touchedFields };
    }
  }
  const conflictingFields = touchedFields.filter(
    (field) => (action.fieldRevisions[field] ?? 0) > request.baseRevision,
  );
  if (conflictingFields.length > 0) {
    return { outcome: 'conflict', action, conflictingFields };
  }
  if (request.baseRevision < action.revision && touchedFields.every(
    (field) => (action.fieldRevisions[field] ?? 0) === request.baseRevision,
  )) {
    // A stale mutation may still merge when its exact fields have not changed.
  }

  const revision = action.revision + 1;
  const fieldRevisions = { ...action.fieldRevisions };
  for (const field of touchedFields) fieldRevisions[field] = revision;
  let content = action.content;
  let lifecycle = action.lifecycle;
  let materializations = action.materializations;
  let userOverrides = { ...(action.userOverrides ?? {}) };

  switch (request.mutation.kind) {
    case 'action.user-edit':
      content = contentWithPatch(content, request.mutation.patch);
      userOverrides = { ...userOverrides, ...request.mutation.patch };
      break;
    case 'action.lifecycle': {
      const state = request.mutation.state;
      const snooze = state === 'snoozed' && request.mutation.snoozedUntil !== undefined
        ? { snoozedUntil: request.mutation.snoozedUntil }
        : {};
      const dismissal = state === 'dismissed'
        ? {
            dismissedAt: occurredAt,
            ...(request.mutation.dismissedReason === undefined
              ? {}
              : { dismissedReason: request.mutation.dismissedReason }),
          }
        : {};
      lifecycle = {
        ...lifecycle,
        state,
        ...snooze,
        ...dismissal,
        ...(['handled', 'completed'].includes(state) ? { handledAt: occurredAt } : {}),
      };
      break;
    }
    case 'action.correction': {
      lifecycle = {
        ...lifecycle,
        correction: request.mutation.correction,
      };
      const patch: Partial<Record<ActionEditableField, JsonValue>> = {};
      if (request.mutation.correctedActionType !== undefined) {
        patch.actionType = request.mutation.correctedActionType;
      }
      if (request.mutation.correctedCategory !== undefined) {
        patch.category = request.mutation.correctedCategory;
      }
      content = contentWithPatch(content, patch);
      userOverrides = { ...userOverrides, ...patch };
      break;
    }
    case 'materialization.link': {
      const mutation = request.mutation;
      materializations = [
        ...materializations,
        {
          materializationId: mutation.materializationId,
          revision: 1,
          provider: mutation.provider,
          providerAccountId: mutation.providerAccountId,
          providerListId: mutation.providerListId,
          providerTaskId: mutation.providerTaskId,
          state: 'materialized',
          updatedAt: occurredAt,
        },
      ];
      break;
    }
    case 'materialization.observe': {
      const mutation = request.mutation;
      const index = materializations.findIndex(
        ({ materializationId }) => materializationId === mutation.materializationId,
      );
      if (index < 0) {
        return { outcome: 'rejected', action, reason: 'materialization-not-found' };
      }
      materializations = materializations.map((materialization, relationIndex) => (
        relationIndex === index
          ? {
              ...materialization,
              ...(mutation.state === undefined ? {} : { state: mutation.state }),
              ...(mutation.providerTaskStatusSnapshot === undefined
                ? {}
                : { providerTaskStatusSnapshot: mutation.providerTaskStatusSnapshot }),
              ...(mutation.providerVersionSnapshot === undefined
                ? {}
                : { providerVersionSnapshot: mutation.providerVersionSnapshot }),
              lastObservedAt: mutation.observedAt,
              revision: materialization.revision + 1,
              updatedAt: occurredAt,
            }
          : materialization
      ));
      break;
    }
  }

  const next: ActionV2 = {
    ...action,
    revision,
    updatedAt: occurredAt,
    content,
    lifecycle,
    userOverrides,
    fieldRevisions,
    materializations,
  };
  return isActionV2(next)
    ? { outcome: 'applied', action: next, touchedFields }
    : { outcome: 'rejected', action, reason: 'mutation-invalid' };
}
