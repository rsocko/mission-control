/**
 * Document Intelligence data transformation — maps API responses to TaskItem/InboundNotification/TriageItem.
 */

import type { TaskItem, InboundNotification, TriageItem, TriageActionType } from '@/types';
import { buildDocHubTaskLinks, buildDocHubEobUrl, buildDocHubStatementsUrl } from './doc-hub-links';

export interface DocAction {
  id: string;
  document_id: number;
  document_title: string;
  title?: string | null;
  action_type: 'pay' | 'respond' | 'file' | 'archive' | 'review' | 'sign' | 'schedule';
  category?: string | null;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  confidence?: number | null;
  due_date?: string | null;
  amount?: number | null;
  correspondent?: string | null;
  summary: string;
  recommended_cta?: {
    id?: string | null;
    label?: string | null;
    url?: string | null;
    phone?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  extracted_data?: Record<string, unknown> | null;
  action_ready?: boolean;
  review_state?: 'ready' | 'needs_review' | 'resolved_no_action' | string | null;
  action_url?: string | null;
  needs_review_url?: string | null;
  /** Transitional alias accepted from prerelease OWL builds. */
  review_url?: string | null;
  source_actions?: DocSourceAction[] | null;
  payment_check?: DocPaymentCheck | null;
  status: 'pending' | 'acknowledged' | 'completed' | 'done' | 'dismissed' | 'snoozed' | 'not_an_action';
  created_at: string;
  document_created_at?: string | null;
  updated_at?: string;
  snoozed_until?: string | null;
  document_url?: string;
  document_type?: string | null;
  preview_url?: string | null;
  preview_type?: 'pdf' | 'iframe' | 'image' | 'external' | null;
  thumbnail_url?: string | null;
}

export interface DocSourceAction {
  id: string;
  label: string;
  method: 'POST';
  url: string;
  revision?: string | number;
  idempotency_key?: string;
}

export type DocPaymentCheckState =
  | 'unchecked'
  | 'checking'
  | 'posted_match'
  | 'pending_match'
  | 'multiple_matches'
  | 'no_match'
  | 'partial_payment'
  | 'source_unavailable'
  | 'stale'
  | 'conflict'
  | 'possible_double_payment'
  | 'confirmed';

export interface DocPaymentCandidate {
  id: string;
  payee: string;
  amount: number;
  currency: string;
  transaction_date: string;
  status: 'posted' | 'pending';
  account_display_name: string;
  account_last_four: string;
  confidence: number;
  score: number;
  match_reasons: string[];
  rank?: number | null;
  score_gap_basis_points?: number | null;
  receipt_association?: {
    status?: string | null;
    label?: string | null;
    receipt_date?: string | null;
    amount?: number | null;
    currency?: string | null;
  } | null;
}

export interface DocPaymentCheck {
  state: DocPaymentCheckState;
  checked_at?: string | null;
  fresh_until?: string | null;
  stale_after?: string | null;
  source?: string | null;
  revision?: string | number | null;
  message?: string | null;
  candidates?: DocPaymentCandidate[] | null;
  matches?: DocPaymentCandidate[] | null;
  match?: DocPaymentCandidate | null;
  confirmed_at?: string | null;
  search_context?: {
    anchor_date?: string | null;
    window_start?: string | null;
    window_end?: string | null;
    amount_tolerance?: number | null;
    date_tolerance_days?: number | null;
    source_as_of?: string | null;
    searched_at?: string | null;
    eligible_account_count?: number | null;
    candidate_pool_size?: number | null;
  } | null;
}

export interface MissingStatement {
  id: string | number;
  correspondent: string;
  correspondent_id?: string | number;
  expected_period: string;
  frequency: string;
  last_received_date?: string | null;
  days_overdue: number;
}

export interface UnmatchedEob {
  id: string | number;
  provider: string;
  amount: number;
  date_of_service: string;
  patient_responsibility: number;
  document_url?: string;
  created_at?: string;
}

const TASK_ACTION_TYPES = new Set<DocAction['action_type']>([
  'pay',
  'respond',
  'sign',
  'schedule',
  'file',
  'archive',
  'review',
]);

export function isTaskAction(action: DocAction): boolean {
  return TASK_ACTION_TYPES.has(action.action_type);
}

/**
 * New OWL versions explicitly own action readiness. Missing readiness fields
 * identify a legacy response and preserve the pre-readiness behavior.
 */
export function isActionReady(action: DocAction): boolean {
  if (typeof action.action_ready === 'boolean') return action.action_ready;
  return true;
}

export function isActionAwaitingReview(action: DocAction): boolean {
  return !isActionReady(action)
    && action.review_state === 'needs_review'
    && action.status !== 'completed'
    && action.status !== 'done'
    && action.status !== 'dismissed'
    && action.status !== 'not_an_action';
}

export function isSinceMatch(value: string | undefined, since?: Date): boolean {
  if (!since || !value) {
    return true;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp > since.getTime() : true;
}

export function mapActionToTask(
  action: DocAction,
  connectorType: string,
  connectorInstanceId: string,
  docHubBaseUrl?: string,
): TaskItem {
  const documentCreatedAt = normalizeDocumentCreatedAt(action.document_created_at);
  const hubLinks = docHubBaseUrl
    ? buildDocHubTaskLinks(docHubBaseUrl, action.id, action.document_id)
    : { actionUrl: null, documentUrl: null };
  const preview = resolveActionPreview(action);
  const primaryAction = resolveActionCta(action);
  const reviewUrl = resolveReviewUrl(action, hubLinks.actionUrl, docHubBaseUrl);

  return {
    id: `docintel-${action.id}`,
    sourceId: action.id,
    connectorType,
    connectorInstanceId,
    title: buildTaskTitle(action),
    description: undefined,
    status: mapActionStatus(action.status),
    statusReason: mapActionStatusReason(action.status),
    priority: mapUrgency(action.urgency),
    dueDate: action.due_date || undefined,
    createdAt: documentCreatedAt || action.created_at || new Date().toISOString(),
    updatedAt: action.updated_at || action.created_at || new Date().toISOString(),
    completedAt: action.status === 'completed' || action.status === 'done'
      ? action.updated_at || action.created_at
      : undefined,
    snoozedUntil: action.status === 'snoozed'
      ? action.snoozed_until || undefined
      : null,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: 'action-queue',
    sourceListName: 'Action Queue',
    hubProjectIds: [],
    tags: buildTaskTags(action, connectorType),
    metadata: {
      actionType: action.action_type,
      actionTitle: action.title,
      actionSummary: action.summary,
      category: action.category,
      amount: action.amount,
      confidence: normalizeOwlConfidence(action.confidence),
      correspondent: action.correspondent,
      documentId: action.document_id,
      documentTitle: action.document_title,
      documentType: action.document_type,
      documentUrl: action.document_url,
      documentCreatedAt,
      urgency: action.urgency,
      actionReady: isActionReady(action),
      reviewState: action.review_state,
      reviewUrl,
      primaryActionId: primaryAction?.id,
      primaryActionLabel: primaryAction?.label,
      primaryActionUrl: primaryAction?.url,
      recommendedCta: action.recommended_cta,
      sourceActions: resolveSourceActions(action),
      paymentCheck: normalizePaymentCheck(action.payment_check),
      owlStatus: action.status,
      owlCreatedAt: action.created_at,
      owlDisposition: action.status === 'dismissed' || action.status === 'not_an_action'
        ? action.status
        : undefined,
      owlSnoozedUntil: action.status === 'snoozed'
        ? action.snoozed_until || undefined
        : undefined,
      owlUpdatedAt: action.updated_at || action.created_at,
      previewUrl: preview.url,
      previewType: preview.type,
      previewLabel: 'View in Paperless-ngx',
      docHubUrl: hubLinks.actionUrl,
      docHubDocumentUrl: hubLinks.documentUrl,
    },
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  };
}

function normalizeDocumentCreatedAt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalizeOwlConfidence(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
  return value > 1 ? value / 100 : value;
}

export function mapActionToReviewNotification(
  action: DocAction,
  connectorType: string,
  connectorInstanceId: string,
  docHubBaseUrl?: string,
): InboundNotification {
  const hubLinks = docHubBaseUrl
    ? buildDocHubTaskLinks(docHubBaseUrl, action.id, action.document_id)
    : { actionUrl: null, documentUrl: null };
  const reviewUrl = resolveReviewUrl(action, hubLinks.actionUrl, docHubBaseUrl);
  const preview = resolveActionPreview(action);

  return {
    id: `docintel-review-${action.id}`,
    sourceId: `review-${action.id}`,
    connectorType,
    connectorInstanceId,
    title: `Needs review in OWL: ${action.document_title}`,
    body: action.summary || 'OWL needs confirmation before this becomes an executable action.',
    level: 'heads_up',
    category: 'document',
    templateKey: 'owl_needs_review',
    isRead: false,
    isActionable: !!reviewUrl,
    actionUrl: reviewUrl || undefined,
    receivedAt: action.updated_at || action.created_at || new Date().toISOString(),
    sourceActivityAt: action.updated_at || action.created_at,
    sourceActivityKey: `${action.review_state || 'needs_review'}:${action.updated_at || action.created_at || ''}`,
    hubProjectIds: [],
    tags: [buildTag('needs-review', 'Needs Review', connectorType)],
    metadata: {
      actionId: action.id,
      actionType: action.action_type,
      category: action.category,
      confidence: normalizeOwlConfidence(action.confidence),
      documentId: action.document_id,
      documentTitle: action.document_title,
      previewUrl: preview.url,
      previewType: preview.type,
      previewLabel: 'View in Paperless-ngx',
      reviewState: action.review_state || 'needs_review',
      reviewUrl,
      docHubUrl: reviewUrl,
    },
  };
}

function resolveActionPreview(action: DocAction): {
  url: string | undefined;
  type: NonNullable<DocAction['preview_type']>;
} {
  if (action.preview_url) {
    return {
      url: action.preview_url,
      type: action.preview_type || inferPreviewType(action.preview_url),
    };
  }

  if (action.thumbnail_url) {
    return { url: action.thumbnail_url, type: 'image' };
  }

  return { url: action.document_url, type: 'external' };
}

function inferPreviewType(url: string): NonNullable<DocAction['preview_type']> {
  const pathname = safeUrl(url)?.pathname.toLowerCase() || '';
  if (pathname.endsWith('.pdf') || pathname.endsWith('/preview/')) return 'pdf';
  if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(pathname)) return 'image';
  return 'iframe';
}

function safeUrl(value: unknown, baseUrl?: string): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const absoluteUrl = safeAbsoluteUrl(value);
    if (absoluteUrl) return absoluteUrl;
    if (!baseUrl) return null;

    const base = safeAbsoluteUrl(baseUrl);
    if (!base) return null;
    const resolved = new URL(value, base);
    return resolved.origin === base.origin ? resolved : null;
  } catch {
    return null;
  }
}

function safeAbsoluteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function safeOwlUrl(value: unknown, baseUrl?: string): URL | null {
  if (!baseUrl) return safeUrl(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const base = safeAbsoluteUrl(baseUrl);
  if (!base) return null;
  try {
    const resolved = new URL(value, base);
    return (
      (resolved.protocol === 'http:' || resolved.protocol === 'https:')
      && resolved.origin === base.origin
    ) ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveReviewUrl(
  action: DocAction,
  fallback: string | null,
  baseUrl?: string,
): string | null {
  return safeOwlUrl(action.action_url, baseUrl)?.toString()
    || safeUrl(action.needs_review_url, baseUrl)?.toString()
    || safeUrl(action.review_url, baseUrl)?.toString()
    || safeUrl(fallback, baseUrl)?.toString()
    || null;
}

export function resolveSourceActions(action: DocAction): DocSourceAction[] {
  if (!Array.isArray(action.source_actions)) return [];
  return action.source_actions.filter((sourceAction): sourceAction is DocSourceAction => (
    !!sourceAction
    && typeof sourceAction.id === 'string'
    && !!sourceAction.id.trim()
    && typeof sourceAction.label === 'string'
    && !!sourceAction.label.trim()
    && sourceAction.method === 'POST'
    && typeof sourceAction.url === 'string'
    && isSafeSourceActionReference(sourceAction.url)
  )).map((sourceAction) => ({
    id: sourceAction.id.trim(),
    label: sourceAction.label.trim(),
    method: 'POST',
    url: sourceAction.url,
    ...(typeof sourceAction.revision === 'string' || typeof sourceAction.revision === 'number'
      ? { revision: sourceAction.revision }
      : {}),
    ...(typeof sourceAction.idempotency_key === 'string' && sourceAction.idempotency_key.trim()
      ? { idempotency_key: sourceAction.idempotency_key.trim() }
      : {}),
  }));
}

function normalizePaymentCheck(value: DocPaymentCheck | null | undefined) {
  if (!value || !PAYMENT_CHECK_STATES.has(value.state)) return undefined;
  const candidates = [
    ...(Array.isArray(value.candidates) ? value.candidates : []),
    ...(Array.isArray(value.matches) ? value.matches : []),
    ...(value.match ? [value.match] : []),
  ]
    .map(normalizePaymentCandidate)
    .filter((candidate): candidate is NonNullable<ReturnType<typeof normalizePaymentCandidate>> => !!candidate)
    .filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);

  return {
    state: value.state,
    checkedAt: validTimestamp(value.checked_at),
    freshUntil: validTimestamp(value.fresh_until || value.stale_after),
    source: typeof value.source === 'string' ? value.source : undefined,
    revision: typeof value.revision === 'string' || typeof value.revision === 'number'
      ? value.revision
      : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    candidates,
    confirmedAt: validTimestamp(value.confirmed_at),
    searchContext: normalizeSearchContext(value.search_context),
  };
}

const PAYMENT_CHECK_STATES = new Set<DocPaymentCheckState>([
  'unchecked',
  'checking',
  'posted_match',
  'pending_match',
  'multiple_matches',
  'no_match',
  'partial_payment',
  'source_unavailable',
  'stale',
  'conflict',
  'possible_double_payment',
  'confirmed',
]);

function normalizePaymentCandidate(value: DocPaymentCandidate) {
  if (
    !value
    || typeof value.id !== 'string'
    || typeof value.payee !== 'string'
    || typeof value.amount !== 'number'
    || !Number.isFinite(value.amount)
    || typeof value.currency !== 'string'
    || typeof value.transaction_date !== 'string'
    || (value.status !== 'posted' && value.status !== 'pending')
    || typeof value.account_display_name !== 'string'
    || typeof value.account_last_four !== 'string'
    || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || typeof value.score !== 'number'
    || !Number.isFinite(value.score)
    || !Array.isArray(value.match_reasons)
  ) {
    return null;
  }
  return {
    id: value.id,
    payee: value.payee,
    amount: value.amount,
    currency: value.currency.toUpperCase(),
    transactionDate: value.transaction_date,
    status: value.status,
    accountDisplayName: value.account_display_name,
    accountLastFour: value.account_last_four.replace(/\D/g, '').slice(-4),
    confidence: normalizeScore(value.confidence),
    score: normalizeScore(value.score),
    matchReasons: value.match_reasons.filter((reason): reason is string => typeof reason === 'string'),
    rank: positiveInteger(value.rank),
    scoreGapBasisPoints: nonNegativeNumber(value.score_gap_basis_points),
    receiptAssociation: normalizeReceiptAssociation(value.receipt_association),
  };
}

function normalizeReceiptAssociation(value: DocPaymentCandidate['receipt_association']) {
  if (!value || typeof value !== 'object') return undefined;
  const amount = nonNegativeNumber(value.amount);
  return {
    status: typeof value.status === 'string' ? value.status : undefined,
    label: typeof value.label === 'string' ? value.label : undefined,
    receiptDate: validDate(value.receipt_date),
    amount,
    currency: typeof value.currency === 'string' ? value.currency.toUpperCase() : undefined,
  };
}

function normalizeSearchContext(value: DocPaymentCheck['search_context']) {
  if (!value || typeof value !== 'object') return undefined;
  return {
    anchorDate: validDate(value.anchor_date),
    windowStart: validDate(value.window_start),
    windowEnd: validDate(value.window_end),
    amountTolerance: nonNegativeNumber(value.amount_tolerance),
    dateToleranceDays: nonNegativeNumber(value.date_tolerance_days),
    sourceAsOf: validTimestamp(value.source_as_of),
    searchedAt: validTimestamp(value.searched_at),
    eligibleAccountCount: nonNegativeNumber(value.eligible_account_count),
    candidatePoolSize: nonNegativeNumber(value.candidate_pool_size),
  };
}

function normalizeScore(value: number): number {
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function validTimestamp(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function validDate(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : undefined;
}

function nonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isSafeSourceActionReference(value: string): boolean {
  if (value.startsWith('/api/action-queue/actions/')) return true;
  return !!safeUrl(value);
}

export function resolveActionCta(action: DocAction): {
  id?: string;
  label: string;
  url: string;
} | null {
  const recommended = action.recommended_cta;
  const recommendedUrl = safeUrl(recommended?.url)?.toString();
  const recommendedPhone = normalizePhoneUrl(recommended?.phone);
  const extractedUrl = resolveExtractedActionUrl(action);
  const url = recommendedUrl || recommendedPhone || extractedUrl;
  if (!url) return null;

  return {
    id: typeof recommended?.id === 'string' && recommended.id.trim()
      ? recommended.id.trim()
      : undefined,
    label: typeof recommended?.label === 'string' && recommended.label.trim()
      ? recommended.label.trim()
      : defaultCtaLabel(action.action_type),
    url,
  };
}

function resolveExtractedActionUrl(action: DocAction): string | null {
  const data = action.extracted_data;
  if (!data) return null;
  const actionSpecificKeys: Partial<Record<DocAction['action_type'], string[]>> = {
    pay: ['payment_url', 'pay_url', 'portal_url'],
    respond: ['response_url', 'reply_url', 'portal_url'],
    sign: ['signature_url', 'sign_url', 'portal_url'],
    schedule: ['scheduling_url', 'schedule_url', 'portal_url'],
    file: ['filing_url', 'portal_url'],
    archive: ['archive_url', 'portal_url'],
    review: ['review_url', 'portal_url'],
  };
  const keys = ['action_url', ...(actionSpecificKeys[action.action_type] || [])];
  for (const key of keys) {
    const url = safeUrl(data[key]);
    if (url) return url.toString();
  }
  return null;
}

function normalizePhoneUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const phone = value.trim();
  if (!/^\+?[\d().\-\s]{3,30}$/.test(phone)) return null;
  const normalized = phone.replace(/[().\-\s]/g, '');
  return normalized ? `tel:${normalized}` : null;
}

function defaultCtaLabel(actionType: DocAction['action_type']): string {
  const labels: Record<DocAction['action_type'], string> = {
    pay: 'Pay now',
    respond: 'Respond',
    sign: 'Sign',
    schedule: 'Schedule',
    file: 'File document',
    archive: 'Archive document',
    review: 'Open document',
  };
  return labels[actionType];
}

export function mapMissingStatementToNotification(
  stmt: MissingStatement,
  connectorType: string,
  connectorInstanceId: string,
  paperlessBaseUrl?: string,
  docHubBaseUrl?: string,
): InboundNotification {
  const receivedAt = new Date().toISOString();
  const docHubUrl = docHubBaseUrl ? buildDocHubStatementsUrl(docHubBaseUrl) : undefined;
  return {
    id: `docintel-stmt-${stmt.id}`,
    sourceId: `stmt-${stmt.id}`,
    connectorType,
    connectorInstanceId,
    title: `Missing statement: ${stmt.correspondent} (${stmt.expected_period})`,
    body: `Expected ${stmt.frequency} statement from ${stmt.correspondent} not yet received. Last received: ${stmt.last_received_date || 'unknown'}`,
    level: mapStatementOverdueSeverity(stmt.days_overdue),
    category: 'document',
    isRead: false,
    isActionable: true,
    actionUrl: buildStatementActionUrl(stmt.correspondent_id, paperlessBaseUrl),
    receivedAt,
    hubProjectIds: [],
    tags: [buildTag('statements', 'Statement Tracking', connectorType)],
    metadata: {
      correspondent: stmt.correspondent,
      correspondentId: stmt.correspondent_id,
      expectedPeriod: stmt.expected_period,
      frequency: stmt.frequency,
      lastReceivedDate: stmt.last_received_date,
      daysOverdue: stmt.days_overdue,
      previewUrl: buildStatementActionUrl(stmt.correspondent_id, paperlessBaseUrl),
      previewType: 'external',
      previewLabel: 'View in Paperless-ngx',
      docHubUrl: docHubUrl || undefined,
    },
  };
}

export function mapUnmatchedEobToNotification(
  eob: UnmatchedEob,
  connectorType: string,
  connectorInstanceId: string,
  docHubBaseUrl?: string,
): InboundNotification {
  const receivedAt = eob.created_at || new Date().toISOString();
  const docHubUrl = docHubBaseUrl ? buildDocHubEobUrl(docHubBaseUrl, eob.id) : undefined;
  return {
    id: `docintel-eob-${eob.id}`,
    sourceId: `eob-${eob.id}`,
    connectorType,
    connectorInstanceId,
    title: `Unmatched EOB: ${eob.provider} — $${eob.amount}`,
    body: `EOB from ${eob.provider} (${eob.date_of_service}) has no matching bill. Patient responsibility: $${eob.patient_responsibility}`,
    level: mapEobSeverity(eob.patient_responsibility, eob.amount),
    category: 'medical',
    isRead: false,
    isActionable: true,
    actionUrl: eob.document_url,
    receivedAt,
    hubProjectIds: [],
    tags: [buildTag('eob-matching', 'EOB Matching', connectorType)],
    metadata: {
      provider: eob.provider,
      amount: eob.amount,
      dateOfService: eob.date_of_service,
      patientResponsibility: eob.patient_responsibility,
      documentUrl: eob.document_url,
      previewUrl: eob.document_url,
      previewType: 'external',
      previewLabel: 'View in Paperless-ngx',
      docHubUrl: docHubUrl || undefined,
    },
  };
}

// ─── Triage Item Mapping ──────────────────────────────────────────────────

export function mapActionToTriageItem(
  action: DocAction,
  connectorType: string,
  connectorInstanceId: string,
  paperlessBaseUrl?: string,
  docHubBaseUrl?: string,
): TriageItem {
  const now = new Date().toISOString();
  const primaryAction = mapActionTypeToTriageAction(action.action_type);
  const urgencyLevel = mapUrgencyToTriageUrgency(action.urgency);
  const relevanceScore = mapUrgencyToScore(action.urgency);
  const documentUrl = action.document_url || (paperlessBaseUrl ? `${paperlessBaseUrl}/documents/${action.document_id}` : '');
  const hubLinks = docHubBaseUrl
    ? buildDocHubTaskLinks(docHubBaseUrl, action.id, action.document_id)
    : { actionUrl: null, documentUrl: null };
  const primaryActionCta = resolveActionCta(action);

  return {
    id: `docintel-triage-${action.id}`,
    sourcePlatform: 'document-intelligence',
    sourceId: action.id,
    sourceUrl: documentUrl,
    canonicalUrl: documentUrl,
    title: buildTaskTitle(action),
    description: action.summary,
    thumbnailUrl: undefined,
    contentType: 'document',
    capturedAt: action.created_at || now,
    ingestedAt: now,
    status: 'pending',
    aiSummary: action.summary,
    aiCategories: [action.action_type, connectorType],
    aiSuggestedActions: [
      {
        actionType: primaryAction,
        confidence: 0.9,
        reason: `Document requires: ${action.action_type}`,
        label: toTitleCase(action.action_type),
      },
      {
        actionType: 'open_document',
        confidence: 0.8,
        reason: 'View original document in Paperless',
        label: 'Open Document',
      },
    ],
    aiRelevanceScore: relevanceScore,
    aiUrgency: urgencyLevel,
    rawMetadata: {
      actionType: action.action_type,
      category: action.category,
      amount: action.amount,
      correspondent: action.correspondent,
      documentId: action.document_id,
      documentTitle: action.document_title,
      documentUrl,
      urgency: action.urgency,
      dueDate: action.due_date,
      actionReady: isActionReady(action),
      reviewState: action.review_state,
      reviewUrl: resolveReviewUrl(action, hubLinks.actionUrl, docHubBaseUrl),
      primaryActionId: primaryActionCta?.id,
      primaryActionLabel: primaryActionCta?.label,
      primaryActionUrl: primaryActionCta?.url,
      recommendedCta: action.recommended_cta,
      sourceActions: resolveSourceActions(action),
      connectorInstanceId,
      docHubUrl: hubLinks.actionUrl,
      docHubDocumentUrl: hubLinks.documentUrl,
    },
    actionsTaken: [],
  };
}

function mapActionTypeToTriageAction(actionType: DocAction['action_type']): TriageActionType {
  switch (actionType) {
    case 'pay':
    case 'sign':
    case 'respond':
    case 'schedule':
      return 'complete_action';
    case 'file':
    case 'review':
      return 'open_document';
    default:
      return 'complete_action';
  }
}

function mapUrgencyToTriageUrgency(urgency: DocAction['urgency']): 'time_sensitive' | 'trending' | 'evergreen' {
  switch (urgency) {
    case 'critical':
    case 'high':
      return 'time_sensitive';
    case 'medium':
      return 'trending';
    case 'low':
      return 'evergreen';
    default:
      return 'evergreen';
  }
}

function mapUrgencyToScore(urgency: DocAction['urgency']): number {
  switch (urgency) {
    case 'critical': return 95;
    case 'high': return 82;
    case 'medium': return 65;
    case 'low': return 45;
    default: return 50;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildTaskTitle(action: DocAction): string {
  if (action.title?.trim()) return action.title.trim();
  switch (action.action_type) {
    case 'pay':
      if (action.correspondent && typeof action.amount === 'number') {
        return `Pay: ${action.correspondent} — $${action.amount}`;
      }
      return `Pay: ${action.document_title}`;
    case 'respond':
      return `Respond to: ${action.document_title}`;
    case 'sign':
      return `Sign: ${action.document_title}`;
    case 'schedule':
      return `Schedule: ${action.document_title}`;
    case 'file':
      return `File: ${action.document_title}`;
    case 'archive':
      return `Archive: ${action.document_title}`;
    case 'review':
      return `Review: ${action.document_title}`;
    default:
      return action.document_title;
  }
}

function mapUrgency(urgency: string): TaskItem['priority'] {
  switch (urgency) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    case 'low': return 'low';
    default: return 'none';
  }
}

function mapActionStatus(status: DocAction['status']): TaskItem['status'] {
  switch (status) {
    case 'completed':
    case 'done':
      return 'done';
    case 'dismissed':
    case 'not_an_action':
      return 'cancelled';
    case 'snoozed':
    case 'acknowledged':
    case 'pending':
      return 'todo';
    default: return 'todo';
  }
}

function mapActionStatusReason(status: DocAction['status']): TaskItem['statusReason'] {
  switch (status) {
    case 'completed':
    case 'done':
      return 'completed';
    case 'dismissed':
    case 'not_an_action':
      return 'not_planned';
    default:
      return undefined;
  }
}

function buildStatementActionUrl(correspondentId?: string | number, paperlessBaseUrl?: string): string | undefined {
  if (!paperlessBaseUrl || correspondentId === undefined || correspondentId === null) {
    return undefined;
  }
  const url = new URL('/documents', paperlessBaseUrl);
  url.searchParams.set('correspondent', String(correspondentId));
  return url.toString();
}

function buildTaskTags(action: DocAction, connectorType: string) {
  const tags = [
    buildTag('action-queue', 'Action Queue', connectorType),
    buildTag(action.action_type, toTitleCase(action.action_type), connectorType),
    buildTag(action.urgency, toTitleCase(action.urgency), connectorType),
  ];
  if (action.correspondent) {
    const bareSlug = action.correspondent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    tags.push(buildTag(`correspondent-${bareSlug}`, action.correspondent, connectorType));
  }
  return tags;
}

function buildTag(slug: string, name: string, source: string) {
  return {
    id: `docintel-tag-${slug}`,
    name,
    slug,
    type: 'source' as const,
    source,
    confirmed: true,
    createdAt: new Date().toISOString(),
  };
}

// ─── Severity Helpers ─────────────────────────────────────────────────────
//
// These functions map DI data into NotificationLevel values used directly
// by the notifications system.
//
// Thresholds are currently hardcoded here. A future enhancement could read
// them from the connector's settings JSON to allow per-user configuration.

/**
 * Graduated level for missing statements based on how overdue they are.
 *
 *   <7 days  -> fyi           (within normal processing window)
 *   7-13     -> heads_up      (late but not alarming)
 *   14-29    -> action_needed (significantly overdue)
 *   30+      -> urgent        (full billing cycle missed)
 */
export function mapStatementOverdueSeverity(daysOverdue: number): InboundNotification['level'] {
  if (daysOverdue >= 30) return 'urgent';
  if (daysOverdue >= 14) return 'action_needed';
  if (daysOverdue >= 7) return 'heads_up';
  return 'fyi';
}

/**
 * Graduated level for unmatched EOBs based on financial exposure.
 * Considers both patient responsibility and total claim amount -- whichever
 * produces the higher level wins.
 *
 *   <$100 resp & <$500 total   -> fyi
 *   $100-199 resp               -> heads_up
 *   $200-499 resp | $500-999    -> action_needed
 *   $500+ resp | $1000+ total   -> urgent
 */
export function mapEobSeverity(patientResponsibility: number, totalAmount: number): InboundNotification['level'] {
  if (patientResponsibility >= 500 || totalAmount >= 1000) return 'urgent';
  if (patientResponsibility >= 200 || totalAmount >= 500) return 'action_needed';
  if (patientResponsibility >= 100) return 'heads_up';
  return 'fyi';
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
