import { createHash } from 'node:crypto';
import {
  ACTION_STATE_LIMITS,
  canonicalActionJson,
  type JsonValue,
} from './action-contract';

export const ACTION_CONTEXT_CONTRACT_VERSION = '2.0';
export const ACTION_CONTEXT_TARGET = '/v2/integrations/action-feed/context';
export const ACTION_CONTEXT_MAX_WRITE_BYTES = 16 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ActionSourceContextV2 {
  readonly messageExcerpt: string;
  readonly senderDisplayName?: string;
  readonly conversationTitle?: string;
  readonly sourceCreatedAt?: string;
  readonly sourceUrl?: string;
}

export interface ActionContextRequestV2 {
  readonly contractVersion: '2.0';
  readonly operationId: string;
  readonly actionId: string;
  readonly baseRevision: number;
  readonly contextRevision: number;
  readonly context: ActionSourceContextV2;
}

export interface ActionContextReceiptV2 {
  readonly operationId: string;
  readonly actionId: string;
  readonly outcome: 'applied' | 'duplicate' | 'stale-noop';
  readonly contextRevision: number;
  readonly aggregateRevision: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

function validText(value: string, maximumBytes: number): boolean {
  return value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value: string): boolean {
  return UTC_MILLIS_RE.test(value)
    && new Date(value).toISOString() === value;
}

function validSourceUrl(value: string): boolean {
  if (!validText(value, ACTION_STATE_LIMITS.maxSourceUrlBytes)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isActionContextRequestV2(value: unknown): value is ActionContextRequestV2 {
  if (!isObject(value) || !exactKeys(value, [
    'contractVersion',
    'operationId',
    'actionId',
    'baseRevision',
    'contextRevision',
    'context',
  ])) return false;
  if (
    value.contractVersion !== ACTION_CONTEXT_CONTRACT_VERSION
    || typeof value.operationId !== 'string'
    || !UUID_RE.test(value.operationId)
    || typeof value.actionId !== 'string'
    || !UUID_RE.test(value.actionId)
    || !Number.isSafeInteger(value.baseRevision)
    || (value.baseRevision as number) < 1
    || !Number.isSafeInteger(value.contextRevision)
    || (value.contextRevision as number) < 1
    || !isObject(value.context)
    || !exactKeys(value.context, ['messageExcerpt'], [
      'senderDisplayName',
      'conversationTitle',
      'sourceCreatedAt',
      'sourceUrl',
    ])
  ) return false;
  const context = value.context;
  return typeof context.messageExcerpt === 'string'
    && validText(context.messageExcerpt, ACTION_STATE_LIMITS.maxMessageExcerptBytes)
    && (
      context.senderDisplayName === undefined
      || (
        typeof context.senderDisplayName === 'string'
        && validText(context.senderDisplayName, 512)
      )
    )
    && (
      context.conversationTitle === undefined
      || (
        typeof context.conversationTitle === 'string'
        && validText(context.conversationTitle, 512)
      )
    )
    && (
      context.sourceCreatedAt === undefined
      || (
        typeof context.sourceCreatedAt === 'string'
        && validTimestamp(context.sourceCreatedAt)
      )
    )
    && (
      context.sourceUrl === undefined
      || (
        typeof context.sourceUrl === 'string'
        && validSourceUrl(context.sourceUrl)
      )
    );
}

export function actionContextDigest(request: ActionContextRequestV2): string {
  return createHash('sha256')
    .update(canonicalActionJson(request as unknown as JsonValue), 'utf8')
    .digest('hex');
}
