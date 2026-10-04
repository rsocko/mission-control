import { createHash } from 'node:crypto';
import {
  ACTION_STATE_CONTRACT_VERSION,
  ACTION_STATE_LIMITS,
  actionFeedSourceId,
  canonicalActionJson,
  isActionIntegrationMutationRequestV2,
  type ActionIntegrationMutationRequestV2,
  type ActionMutationReceiptV2,
  type JsonValue,
} from './action-contract';
import {
  ACTION_TASK_LINK_LIMITS,
  actionTaskRelationId,
  isActionTaskFeedProjectionV2,
  isActionTaskIntegrationMutationRequestV2,
  normalizeActionTaskTrustedOrigin,
  type ActionTaskCreationIntentV2,
  type ActionTaskFeedProjectionV2,
  type ActionTaskIntegrationMutationRequestV2,
  type ActionTaskMaterializationV2,
  type ActionTaskMutationReceiptV2,
  type ManagedTaskCommandV2 as CanonicalManagedTaskCommandV2,
} from './action-task-link-contract';

export const COMPANION_ACTION_V2_CONTRACT_VERSION = ACTION_STATE_CONTRACT_VERSION;
export const COMPANION_ACTION_V2_MAX_PAGE_ITEMS = 20;
export const COMPANION_ACTION_MAX_SYNC_PAGES = 1_000;
export const COMPANION_ACTION_V2_MAX_WRITE_BYTES = ACTION_STATE_LIMITS.maxWriteBytes;
export const COMPANION_ACTION_FEED_PATH_V2 = '/v2/integrations/action-feed';
export const COMPANION_ACTION_V2_RELATION_NAMESPACE =
  '60ed6d9d-c9d5-5fd6-9c7a-dbb312af3fb5';
export const COMPANION_ACTION_V2_MAX_LINKS = ACTION_TASK_LINK_LIMITS.maxMaterializations;
export const COMPANION_ACTION_V2_MAX_RETAINED_INTENTS =
  ACTION_TASK_LINK_LIMITS.maxRetainedIntents;
export const COMPANION_ACTION_V2_MAX_COMMANDS = ACTION_TASK_LINK_LIMITS.maxCommands;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CompanionTaskMaterializationV2 = ActionTaskMaterializationV2;
export type CompanionCreationIntentV2 = ActionTaskCreationIntentV2;
export type ManagedTaskCommandV2 = CanonicalManagedTaskCommandV2;
export type CompanionActionFeedProjectionV2 = ActionTaskFeedProjectionV2;
export type CompanionActionMutationRequestV2 =
  | ActionIntegrationMutationRequestV2
  | ActionTaskIntegrationMutationRequestV2;
export type CompanionActionMutationReceiptV2 =
  | ActionMutationReceiptV2
  | ActionTaskMutationReceiptV2;

export type CompanionActionFeedItemV2 =
  | {
      eventId: string;
      operationId: string;
      aggregateId: string;
      aggregateVersion: number;
      sourceId: string;
      occurredAt: string;
      kind: 'upsert';
      projection: ActionTaskFeedProjectionV2;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && UTC_MILLIS_RE.test(value)
    && new Date(value).toISOString() === value;
}

function canonicalByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(canonicalActionJson(value as JsonValue), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validEnvelope(
  value: Record<string, unknown>,
  feedId: string,
): boolean {
  return typeof value.eventId === 'string'
    && UUID_RE.test(value.eventId)
    && typeof value.operationId === 'string'
    && UUID_RE.test(value.operationId)
    && typeof value.aggregateId === 'string'
    && UUID_RE.test(value.aggregateId)
    && Number.isSafeInteger(value.aggregateVersion)
    && (value.aggregateVersion as number) >= 1
    && typeof value.sourceId === 'string'
    && value.sourceId === actionFeedSourceId(feedId, value.aggregateId)
    && validTimestamp(value.occurredAt);
}

export function isCompanionActionFeedPageV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is CompanionActionFeedPageV2 {
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
    || value.schemaVersion !== COMPANION_ACTION_V2_CONTRACT_VERSION
    || typeof value.feedId !== 'string'
    || !UUID_RE.test(value.feedId)
    || (value.mode !== 'full' && value.mode !== 'incremental')
    || !validTimestamp(value.producedAt)
    || typeof value.nextCursor !== 'string'
    || value.nextCursor.length === 0
    || Buffer.byteLength(value.nextCursor, 'utf8') > ACTION_STATE_LIMITS.maxCursorBytes
    || typeof value.complete !== 'boolean'
    || !Array.isArray(value.items)
    || value.items.length > COMPANION_ACTION_V2_MAX_PAGE_ITEMS
    || canonicalByteLength(value) > ACTION_STATE_LIMITS.maxPageBytes
  ) return false;

  return value.items.every((candidate) => {
    if (!isRecord(candidate) || !validEnvelope(candidate, value.feedId as string)) {
      return false;
    }
    if (candidate.kind === 'tombstone') {
      return exactKeys(candidate, [
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
      candidate.kind !== 'upsert'
      || !exactKeys(candidate, [
        'eventId',
        'operationId',
        'aggregateId',
        'aggregateVersion',
        'sourceId',
        'occurredAt',
        'kind',
        'projection',
      ])
      || !isActionTaskFeedProjectionV2(candidate.projection, trustedOrigins)
    ) return false;
    const projection = candidate.projection as ActionTaskFeedProjectionV2;
    return projection.action.actionId === candidate.aggregateId
      && projection.action.revision === candidate.aggregateVersion;
  });
}

export function isCompanionActionMutationRequestV2(
  value: unknown,
  trustedOrigins: ReadonlySet<string>,
): value is CompanionActionMutationRequestV2 {
  return isActionIntegrationMutationRequestV2(value)
    || isActionTaskIntegrationMutationRequestV2(value, trustedOrigins);
}

export function isCompanionActionMutationReceiptV2(
  value: unknown,
): value is CompanionActionMutationReceiptV2 {
  if (
    !isRecord(value)
    || typeof value.operationId !== 'string'
    || !UUID_RE.test(value.operationId)
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !['applied', 'duplicate', 'stale-noop', 'conflict'].includes(String(value.outcome))
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
  ) return false;
  const optional = ['conflictingFields', 'relationId', 'intentId', 'commandId'];
  const keys = Object.keys(value);
  if (
    !['operationId', 'actionId', 'outcome', 'revision'].every(key => keys.includes(key))
    || keys.some(key => !['operationId', 'actionId', 'outcome', 'revision', ...optional].includes(key))
  ) return false;
  if (
    value.conflictingFields !== undefined
    && (
      !Array.isArray(value.conflictingFields)
      || !value.conflictingFields.every(field => typeof field === 'string')
    )
  ) return false;
  return ['relationId', 'intentId', 'commandId'].every(key => (
    value[key] === undefined || (typeof value[key] === 'string' && UUID_RE.test(value[key]))
  ));
}

export function companionActionV2Digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalActionJson(value as JsonValue), 'utf8')
    .digest('hex');
}

export function companionTaskRelationIdV2(input: {
  actionId: string;
  providerId: string;
  providerAccountId: string;
  providerContainerId?: string;
  providerTaskId: string;
}): string {
  return actionTaskRelationId(input.actionId, {
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    ...(input.providerContainerId ? { providerContainerId: input.providerContainerId } : {}),
    providerTaskId: input.providerTaskId,
  });
}

export function normalizeTrustedOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return normalizeActionTaskTrustedOrigin(value);
  } catch {
    return null;
  }
}

export function normalizeTrustedOrigins(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  for (const candidate of value) {
    const origin = normalizeTrustedOrigin(candidate);
    if (!origin) return null;
    normalized.push(origin);
  }
  return [...new Set(normalized)];
}
