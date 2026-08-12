/**
 * Transforms raw RyMessage action records into normalized RyMessageAction objects.
 */

import type { InboundNotification } from '@/types';

export interface RyMessageAction {
  id: string;
  stableKey: string;
  chatGuid: string;
  messageGuid?: string;
  sourceKind: 'message' | 'thread' | 'provider-event' | 'manual';
  actionType: string;
  kind: string;
  title: string;
  summary?: string;
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore?: number;
  detectionSource: 'deterministic' | 'pattern' | 'extraction' | 'ai';
  lifecycleState: 'detected' | 'visible' | 'snoozed' | 'dismissed' | 'handled' | 'linked_task' | 'completed';
  severity: 'critical' | 'focus' | 'safe';
  recommendation: 'reply' | 'review' | 'copy-code' | 'create-task' | 'acknowledge';
  direction: 'sent' | 'received';
  senderLabel: string;
  chatLabel: string;
  messageTextSnippet?: string;
  snoozedUntil?: number;
  taskLinkId?: string;
  taskProviderId?: string;
  taskProviderTaskId?: string;
  taskStatusCached?: string;
  createdAt: string;
  updatedAt?: string;
}

type RawActionRecord = Record<string, unknown>;

const ACTIVE_LIFECYCLE_STATES = new Set<RyMessageAction['lifecycleState']>(['visible', 'detected']);
const ACTIONABLE_RECOMMENDATIONS = new Set<RyMessageAction['recommendation']>(['reply', 'create-task', 'review']);

export function normalizeActionRecord(record: RawActionRecord): RyMessageAction | null {
  const id = pickString(record, ['id']);
  const stableKey = pickString(record, ['stableKey', 'stable_key']) ?? id;
  const chatGuid = pickString(record, ['chatGuid', 'chat_guid']);
  const actionType = pickString(record, ['actionType', 'action_type'])
    ?? pickString(record, ['kind'])
    ?? 'action-required';
  const kind = pickString(record, ['kind']) ?? actionType;
  const title = pickString(record, ['title'])
    ?? pickString(record, ['summary'])
    ?? pickString(record, ['messageTextSnippet', 'message_text_snippet'])
    ?? `${humanize(kind)} action`;

  if (!id || !stableKey || !chatGuid) {
    return null;
  }

  const confidenceScore = pickNumber(record, ['confidenceScore', 'confidence_score']);
  const confidence = normalizeConfidence(
    pickString(record, ['confidence']),
    confidenceScore,
  );
  const lifecycleState = normalizeLifecycleState(pickString(record, ['lifecycleState', 'lifecycle_state']));

  return {
    id,
    stableKey,
    chatGuid,
    messageGuid: pickString(record, ['messageGuid', 'message_guid']),
    sourceKind: normalizeSourceKind(pickString(record, ['sourceKind', 'source_kind'])),
    actionType,
    kind,
    title,
    summary: pickString(record, ['summary']),
    reason: pickString(record, ['reason']),
    confidence,
    confidenceScore: confidenceScore ?? undefined,
    detectionSource: normalizeDetectionSource(pickString(record, ['detectionSource', 'detection_source'])),
    lifecycleState,
    severity: normalizeSeverity(pickString(record, ['severity']), kind),
    recommendation: normalizeRecommendation(
      pickString(record, ['recommendation', 'recommendedCta', 'recommended_cta']),
      kind,
    ),
    direction: normalizeDirection(pickString(record, ['direction'])),
    senderLabel: pickString(record, ['senderLabel', 'sender_label']) ?? 'Unknown sender',
    chatLabel: pickString(record, ['chatLabel', 'chat_label']) ?? chatGuid,
    messageTextSnippet: pickString(record, ['messageTextSnippet', 'message_text_snippet']),
    snoozedUntil: pickTimestamp(record, ['snoozedUntil', 'snoozed_until']) ?? undefined,
    taskLinkId: pickString(record, ['taskLinkId', 'task_link_id']),
    taskProviderId: pickString(record, ['taskProviderId', 'task_provider_id']),
    taskProviderTaskId: pickString(record, ['taskProviderTaskId', 'task_provider_task_id']),
    taskStatusCached: pickString(record, ['taskStatusCached', 'task_status_cached']),
    createdAt: normalizeDate(
      pickValue(record, ['createdAt', 'created_at'])
      ?? pickValue(record, ['firstSeenAt', 'first_seen_at'])
    ),
    updatedAt: normalizeOptionalDate(
      pickValue(record, ['updatedAt', 'updated_at'])
      ?? pickValue(record, ['lastSeenAt', 'last_seen_at'])
    ),
  };
}

export function shouldImportAction(action: RyMessageAction, minConfidence: number): boolean {
  if (!ACTIVE_LIFECYCLE_STATES.has(action.lifecycleState)) {
    return false;
  }
  return resolveConfidenceScore(action) >= minConfidence;
}

export function mapActionToAlert(
  action: RyMessageAction,
  connectorType: string,
  connectorInstanceId: string,
  alertId: string,
): InboundNotification {
  return {
    id: alertId,
    sourceId: `rymessage:${action.id}`,
    connectorType,
    connectorInstanceId,
    title: action.title,
    body: buildNotificationBody(action),
    level: mapSeverity(action.severity),
    category: mapCategory(action.kind),
    isRead: false,
    isActionable: ACTIONABLE_RECOMMENDATIONS.has(action.recommendation),
    actionUrl: undefined,
    receivedAt: action.updatedAt ?? action.createdAt,
    expiresAt: undefined,
    relatedTaskId: action.taskLinkId,
    hubProjectIds: [],
    tags: [],
    metadata: {
      stableKey: action.stableKey,
      chatGuid: action.chatGuid,
      messageGuid: action.messageGuid,
      sourceKind: action.sourceKind,
      actionType: action.actionType,
      kind: action.kind,
      summary: action.summary,
      reason: action.reason,
      confidence: action.confidence,
      confidenceScore: action.confidenceScore,
      detectionSource: action.detectionSource,
      lifecycleState: action.lifecycleState,
      severity: action.severity,
      recommendation: action.recommendation,
      direction: action.direction,
      senderLabel: action.senderLabel,
      chatLabel: action.chatLabel,
      messageTextSnippet: action.messageTextSnippet,
      snoozedUntil: action.snoozedUntil,
      taskProviderId: action.taskProviderId,
      taskProviderTaskId: action.taskProviderTaskId,
      taskStatusCached: action.taskStatusCached,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapSeverity(severity: RyMessageAction['severity']): InboundNotification['level'] {
  switch (severity) {
    case 'critical': return 'urgent';
    case 'focus': return 'action_needed';
    case 'safe':
    default: return 'heads_up';
  }
}

function mapCategory(kind: string): string {
  const categories: Record<string, string> = {
    'shipping-delivery': 'shipment',
    financial: 'finance',
    scheduling: 'calendar',
    'needs-reply': 'action_required',
    'action-required': 'action_required',
    'waiting-on-action': 'action_required',
    'waiting-on-reply': 'action_required',
    'security-code': 'security',
    travel: 'travel',
    'critical-alert': 'security',
    commitment: 'action_required',
    'repeated-ask': 'action_required',
  };
  return categories[kind] ?? 'message';
}

function buildNotificationBody(action: RyMessageAction): string {
  const preview = action.summary ?? action.messageTextSnippet ?? action.reason ?? '';
  return preview
    ? `From: ${action.senderLabel} - ${preview}`
    : `From: ${action.senderLabel}`;
}

function resolveConfidenceScore(action: RyMessageAction): number {
  if (typeof action.confidenceScore === 'number') {
    return action.confidenceScore;
  }

  switch (action.confidence) {
    case 'high': return 0.9;
    case 'medium': return 0.75;
    case 'low':
    default: return 0.5;
  }
}

function pickValue(record: RawActionRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== null && record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function pickString(record: RawActionRecord, keys: string[]): string | undefined {
  const value = pickValue(record, keys);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function pickNumber(record: RawActionRecord, keys: string[]): number | undefined {
  const value = pickValue(record, keys);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickTimestamp(record: RawActionRecord, keys: string[]): number | undefined {
  const value = pickValue(record, keys);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      return direct;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeDate(value: unknown): string {
  const normalized = normalizeOptionalDate(value);
  return normalized ?? new Date().toISOString();
}

function normalizeOptionalDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric).toISOString();
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function normalizeConfidence(
  value: string | undefined,
  score?: number,
): RyMessageAction['confidence'] {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  if (typeof score === 'number') {
    if (score >= 0.85) return 'high';
    if (score >= 0.65) return 'medium';
  }
  return 'low';
}

function normalizeDetectionSource(value: string | undefined): RyMessageAction['detectionSource'] {
  switch (value) {
    case 'pattern':
    case 'extraction':
    case 'ai':
    case 'deterministic':
      return value;
    default:
      return 'deterministic';
  }
}

function normalizeLifecycleState(value: string | undefined): RyMessageAction['lifecycleState'] {
  switch (value) {
    case 'detected':
    case 'visible':
    case 'snoozed':
    case 'dismissed':
    case 'handled':
    case 'linked_task':
    case 'completed':
      return value;
    default:
      return 'visible';
  }
}

function normalizeSeverity(value: string | undefined, kind: string): RyMessageAction['severity'] {
  if (value === 'critical' || value === 'focus' || value === 'safe') {
    return value;
  }
  if (kind === 'critical-alert') return 'critical';
  if (kind === 'commitment' || kind === 'waiting-on-reply') return 'safe';
  return 'focus';
}

function normalizeRecommendation(value: string | undefined, kind: string): RyMessageAction['recommendation'] {
  if (value === 'reply' || value === 'review' || value === 'copy-code' || value === 'create-task' || value === 'acknowledge') {
    return value;
  }
  if (kind === 'needs-reply' || kind === 'repeated-ask') return 'reply';
  if (kind === 'security-code') return 'copy-code';
  if (kind === 'commitment') return 'create-task';
  if (kind === 'waiting-on-reply' || kind === 'waiting-on-action') return 'acknowledge';
  return 'review';
}

function normalizeDirection(value: string | undefined): RyMessageAction['direction'] {
  return value === 'sent' ? 'sent' : 'received';
}

function normalizeSourceKind(value: string | undefined): RyMessageAction['sourceKind'] {
  switch (value) {
    case 'thread':
    case 'provider-event':
    case 'manual':
    case 'message':
      return value;
    default:
      return 'message';
  }
}

function humanize(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
