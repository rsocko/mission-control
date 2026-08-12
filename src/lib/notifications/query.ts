import type { NotificationLevel, NotificationState } from '@/types';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';

export type NotificationSort = 'newest' | 'oldest';
export type NotificationDateRange = 'today' | 'week' | 'month';
export const NOTIFICATION_MERCHANT_KEY_LENGTH = 55;
export const MAX_NOTIFICATION_MERCHANT_FACETS = 50;
export const MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH = 120;
export const NOTIFICATION_MERCHANT_QUERY_ERROR =
  'merchant must be supplied once as a normalized merchant key';
export const UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR =
  'merchant does not match available normalized notification metadata';
const NOTIFICATION_MERCHANT_KEY_PATTERN = /^merchant-v1_[A-Za-z0-9_-]{43}$/;

export interface NotificationQuery {
  q: string | null;
  level: NotificationLevel | null;
  category: string | null;
  merchant: string | null;
  source: string | null;
  sourceAccount: string | null;
  state: NotificationState | null;
  actionableOnly: boolean;
  dateRange: NotificationDateRange | null;
  repository: string | null;
  owner: string | null;
  reason: string | null;
  subjectType: string | null;
  participating: boolean;
  sort: NotificationSort;
}

export const DEFAULT_NOTIFICATION_QUERY: NotificationQuery = {
  q: null,
  level: null,
  category: null,
  merchant: null,
  source: null,
  sourceAccount: null,
  state: null,
  actionableOnly: false,
  dateRange: null,
  repository: null,
  owner: null,
  reason: null,
  subjectType: null,
  participating: false,
  sort: 'newest',
};

const LEVELS = new Set<NotificationLevel>(['urgent', 'action_needed', 'heads_up', 'fyi', 'digest']);
const STATES = new Set<NotificationState>(['unread', 'read', 'dismissed', 'resolved', 'archived']);
const DATE_RANGES = new Set<NotificationDateRange>(['today', 'week', 'month']);
const STRING_KEYS = [
  'q',
  'category',
  'source',
  'sourceAccount',
  'repository',
  'owner',
  'reason',
  'subjectType',
] as const;

type QuerySource = Pick<URLSearchParams, 'get'> & Partial<Pick<URLSearchParams, 'getAll'>>
  | Record<string, unknown>;

function read(source: QuerySource, key: string): unknown {
  const getter = (source as Pick<URLSearchParams, 'get'>).get;
  return typeof getter === 'function'
    ? getter.call(source, key)
    : (source as Record<string, unknown>)[key];
}

function cleanString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function readAll(source: QuerySource, key: string): unknown[] {
  const getAll = (source as Partial<Pick<URLSearchParams, 'getAll'>>).getAll;
  if (typeof getAll === 'function') return getAll.call(source, key);
  const record = source as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return [];
  const value = record[key];
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function isNotificationMerchantKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === NOTIFICATION_MERCHANT_KEY_LENGTH
    && NOTIFICATION_MERCHANT_KEY_PATTERN.test(value);
}

export function notificationQueryValidationError(source: QuerySource): string | null {
  const merchants = readAll(source, 'merchant');
  if (merchants.length === 0) return null;
  return merchants.length === 1 && isNotificationMerchantKey(merchants[0])
    ? null
    : NOTIFICATION_MERCHANT_QUERY_ERROR;
}

export function parseNotificationQuery(source: QuerySource): NotificationQuery {
  const query = { ...DEFAULT_NOTIFICATION_QUERY };
  for (const key of STRING_KEYS) {
    query[key] = cleanString(read(source, key), key === 'q' ? 300 : 200);
  }
  if (query.source) {
    query.source = normalizeFinanceProviderAlias(query.source) ?? query.source;
  }
  const merchants = readAll(source, 'merchant');
  query.merchant = merchants.length === 1 && isNotificationMerchantKey(merchants[0])
    ? merchants[0]
    : null;

  const level = cleanString(read(source, 'level'));
  const state = cleanString(read(source, 'state'));
  const dateRange = cleanString(read(source, 'dateRange'));
  const sort = cleanString(read(source, 'sort'));
  query.level = level && LEVELS.has(level as NotificationLevel) ? level as NotificationLevel : null;
  query.state = state && STATES.has(state as NotificationState) ? state as NotificationState : null;
  query.dateRange = dateRange && DATE_RANGES.has(dateRange as NotificationDateRange)
    ? dateRange as NotificationDateRange
    : null;
  query.actionableOnly = read(source, 'actionableOnly') === true || read(source, 'actionableOnly') === 'true';
  query.participating = read(source, 'participating') === true || read(source, 'participating') === 'true';
  query.sort = sort === 'oldest' ? 'oldest' : 'newest';
  return query;
}

export function serializeNotificationQuery(query: NotificationQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of STRING_KEYS) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.level) params.set('level', query.level);
  if (query.merchant) params.set('merchant', query.merchant);
  if (query.state) params.set('state', query.state);
  if (query.dateRange) params.set('dateRange', query.dateRange);
  if (query.actionableOnly) params.set('actionableOnly', 'true');
  if (query.participating) params.set('participating', 'true');
  if (query.sort === 'oldest') params.set('sort', 'oldest');
  return params;
}

export function notificationQueriesEqual(left: NotificationQuery, right: NotificationQuery): boolean {
  return serializeNotificationQuery(left).toString() === serializeNotificationQuery(right).toString();
}

export function hasActiveNotificationFilters(query: NotificationQuery): boolean {
  return query.q !== null
    || query.level !== null
    || query.category !== null
    || query.merchant !== null
    || query.source !== null
    || query.sourceAccount !== null
    || query.state !== null
    || query.actionableOnly
    || query.dateRange !== null
    || query.repository !== null
    || query.owner !== null
    || query.reason !== null
    || query.subjectType !== null
    || query.participating;
}
