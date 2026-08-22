/**
 * Document Intelligence data transformation — maps API responses to TaskItem/InboundNotification/TriageItem.
 */

import type { TaskItem, InboundNotification, TriageItem, TriageActionType } from '@/types';
import { buildDocHubTaskLinks, buildDocHubEobUrl, buildDocHubStatementsUrl } from './doc-hub-links';

export interface DocAction {
  id: string;
  document_id: number;
  document_title: string;
  action_type: 'pay' | 'respond' | 'file' | 'review' | 'sign' | 'schedule';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  due_date?: string | null;
  amount?: number | null;
  correspondent?: string | null;
  summary: string;
  status: 'pending' | 'in_progress' | 'done' | 'dismissed';
  created_at: string;
  document_url?: string;
  document_type?: string | null;
  preview_url?: string | null;
  preview_type?: 'pdf' | 'iframe' | 'image' | 'external' | null;
  thumbnail_url?: string | null;
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
  'review',
]);

export function isTaskAction(action: DocAction): boolean {
  return TASK_ACTION_TYPES.has(action.action_type);
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
  const hubLinks = docHubBaseUrl
    ? buildDocHubTaskLinks(docHubBaseUrl, action.id, action.document_id)
    : { actionUrl: null, documentUrl: null };
  const preview = resolveActionPreview(action);

  return {
    id: `docintel-${action.id}`,
    sourceId: action.id,
    connectorType,
    connectorInstanceId,
    title: buildTaskTitle(action),
    description: action.summary,
    status: mapActionStatus(action.status),
    priority: mapUrgency(action.urgency),
    dueDate: action.due_date || undefined,
    createdAt: action.created_at || new Date().toISOString(),
    updatedAt: action.created_at || new Date().toISOString(),
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: 'action-queue',
    sourceListName: 'Action Queue',
    hubProjectIds: [],
    tags: buildTaskTags(action, connectorType),
    metadata: {
      actionType: action.action_type,
      amount: action.amount,
      correspondent: action.correspondent,
      documentId: action.document_id,
      documentTitle: action.document_title,
      documentType: action.document_type,
      documentUrl: action.document_url,
      urgency: action.urgency,
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

  const paperlessPreviewUrl = buildPaperlessPreviewUrl(action.document_url, action.document_id);
  return paperlessPreviewUrl
    ? { url: paperlessPreviewUrl, type: 'pdf' }
    : { url: action.document_url, type: 'external' };
}

function inferPreviewType(url: string): NonNullable<DocAction['preview_type']> {
  const pathname = safeUrl(url)?.pathname.toLowerCase() || '';
  if (pathname.endsWith('.pdf') || pathname.endsWith('/preview/')) return 'pdf';
  if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(pathname)) return 'image';
  return 'iframe';
}

function buildPaperlessPreviewUrl(documentUrl: string | undefined, documentId: number): string | undefined {
  const url = safeUrl(documentUrl);
  if (!url) return undefined;

  const documentsPathIndex = url.pathname.indexOf('/documents/');
  const basePath = documentsPathIndex >= 0
    ? url.pathname.slice(0, documentsPathIndex)
    : '';
  url.pathname = `${basePath}/api/documents/${documentId}/preview/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function safeUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
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
      amount: action.amount,
      correspondent: action.correspondent,
      documentId: action.document_id,
      documentTitle: action.document_title,
      documentUrl,
      urgency: action.urgency,
      dueDate: action.due_date,
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
    case 'done': return 'done';
    case 'dismissed': return 'cancelled';
    case 'in_progress': return 'in_progress';
    default: return 'todo';
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

function buildTag(slug: string, name: string, _source: string) {
  return {
    id: `docintel-tag-${slug}`,
    name,
    slug,
    type: 'source' as const,
    source: 'document-intelligence',
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
