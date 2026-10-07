import 'server-only';

import type {
  ConnectorCapabilities,
  ConnectorConfig,
  InboundNotification,
  NotificationLevel,
  SourceList,
  TaskItem,
} from '@/types';
import type {
  ConnectorFactory,
  IConnector,
} from '../index';
import type { ConnectorNotificationTypeDefinition } from '@/lib/notifications/push-policy/catalog';
import { redactPushText } from '@/lib/notifications/push-text';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import { getExternalAgentControlPersistence } from '@/lib/external-agents/persistence';
import {
  discoverPaperclip,
  listPaperclipApprovalIssues,
  listPaperclipApprovals,
  listPaperclipAttention,
  type PaperclipAttentionItem,
  type PaperclipIssue,
  type PaperclipApproval,
} from '@/lib/external-agents/paperclip';

interface PaperclipConnectorSettings {
  apiOrigin: string;
  monitorAllCompanies: boolean;
  companyIds: string[];
  companyNames: Record<string, string>;
  boardKeyId?: string;
  boardKeyExpiresAt?: string | null;
  boardUserName?: string | null;
}

const PAPERCLIP_NOTIFICATION_TYPES: readonly ConnectorNotificationTypeDefinition[] = [
  {
    key: 'paperclip_approval',
    label: 'Paperclip approval',
    description: 'A Paperclip agent is waiting for an authoritative approval decision.',
    defaultLevel: 'action_needed',
    pushEligible: true,
    pushRecommendation: 'off',
    sensitivity: 'sensitive',
    defaultPreview: 'title_only',
  },
  {
    key: 'paperclip_credential_expiring',
    label: 'Paperclip connection expiring',
    description: 'The Paperclip Board API key used by Mission Control needs renewal.',
    defaultLevel: 'action_needed',
    pushEligible: true,
    pushRecommendation: 'action_needed_or_higher',
    sensitivity: 'sensitive',
    defaultPreview: 'title_only',
  },
  {
    key: 'paperclip_attention',
    label: 'Paperclip attention',
    description: 'A Paperclip decision, interaction, review, or operational item needs attention.',
    defaultLevel: 'heads_up',
    pushEligible: true,
    pushRecommendation: 'off',
    sensitivity: 'sensitive',
    defaultPreview: 'title_only',
  },
];

const CONNECTOR_CAPABILITIES: ConnectorCapabilities = {
  read: true,
  write: false,
  delete: false,
  sync: true,
  subtasks: false,
  lists: false,
  tags: false,
  tagWriteBack: false,
  listSelectionMode: 'not-applicable',
  notificationOnly: true,
};

const KNOWN_TERMINAL_STATES = new Set([
  'approved',
  'rejected',
  'expired',
  'withdrawn',
  'cancelled',
  'revision_requested',
]);
const PENDING_STATES = new Set(['pending', 'resubmitted']);
const SUMMARY_FIELDS = ['summary', 'description', 'reason', 'requestSummary', 'plan'] as const;
const CREDENTIAL_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

function approvalNotificationId(approvalId: string): string {
  return `paperclip-approval:${approvalId}`;
}

function attentionNotificationId(attentionId: string): string {
  return `paperclip-attention:${attentionId}`;
}

function credentialExpiryNotificationId(connectorId: string): string {
  return `paperclip-credential-expiry:${connectorId}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedText(value: unknown, maxLength = 320): string | null {
  if (typeof value !== 'string') return null;
  const text = redactPushText(value.trim(), maxLength);
  return text || null;
}

function approvalSummary(approval: PaperclipApproval): string | null {
  const payload = record(approval.payload);
  for (const key of SUMMARY_FIELDS) {
    const value = boundedText(payload[key]);
    if (value) return value;
  }
  return boundedText(approval.summary);
}

function dateText(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function requesterName(approval: PaperclipApproval): string {
  const requester = record(approval.requester);
  const agent = record(approval.requestedByAgent);
  return boundedText(requester.name, 120)
    ?? boundedText(agent.name, 120)
    ?? boundedText(approval.requestedByAgentName, 120)
    ?? boundedText(approval.requestedByAgentId, 120)
    ?? boundedText(approval.requestedByUserId, 120)
    ?? 'Paperclip agent';
}

function approvalRisk(approval: PaperclipApproval): string {
  const payload = record(approval.payload);
  return boundedText(approval.riskLevel, 80)
    ?? boundedText(payload.riskLevel, 80)
    ?? boundedText(payload.risk, 80)
    ?? 'Not specified';
}

function approvalNotification({
  approval,
  settings,
  companyId,
  companyName,
  connectorId,
  linkedIssues,
  relatedTaskId,
}: {
  approval: PaperclipApproval;
  settings: PaperclipConnectorSettings;
  companyId: string;
  companyName: string;
  connectorId: string;
  linkedIssues: PaperclipIssue[];
  relatedTaskId?: string;
}): InboundNotification {
  const approvalType = boundedText(approval.type, 120) ?? 'Approval request';
  const issueId = boundedText(linkedIssues[0]?.identifier, 160)
    ?? boundedText(approval.issueId, 160)
    ?? boundedText(linkedIssues[0]?.id, 160)
    ?? null;
  const requester = requesterName(approval);
  const risk = approvalRisk(approval);
  const summary = approvalSummary(approval);
  const createdAt = dateText(approval.createdAt) ?? new Date().toISOString();
  const expiresAt = dateText(approval.expiresAt);
  const detailLines = [
    `Company: ${companyName}`,
    `Requested by: ${requester}`,
    `Type: ${approvalType}`,
    `Risk: ${risk}`,
    ...(relatedTaskId ? [`Mission Control task: ${relatedTaskId}`] : []),
    ...(issueId ? [`Paperclip issue: ${issueId}`] : []),
    ...(summary ? [`Summary: ${summary}`] : []),
    `Created: ${createdAt}`,
    ...(expiresAt ? [`Expires: ${expiresAt}`] : []),
  ];
  const apiOrigin = new URL(settings.apiOrigin).origin;

  return {
    id: approvalNotificationId(approval.id),
    sourceId: `approval:${approval.id}`,
    connectorType: 'paperclip',
    connectorInstanceId: connectorId,
    title: `Paperclip approval: ${approvalType}`,
    body: detailLines.join('\n'),
    level: 'action_needed',
    category: 'automation',
    templateKey: 'paperclip_approval',
    isRead: false,
    isActionable: true,
    actionUrl: `${apiOrigin}/approvals/${encodeURIComponent(approval.id)}`,
    receivedAt: createdAt,
    sourceState: 'active',
    sourceActivityAt: dateText(approval.updatedAt) ?? createdAt,
    sourceActivityKey: `${approval.status}:${dateText(approval.updatedAt) ?? createdAt}`,
    reopenPolicy: 'handled_and_dismissed',
    ...(relatedTaskId ? { relatedTaskId } : {}),
    hubProjectIds: [],
    tags: [],
    metadata: {
      approvalId: approval.id,
      companyId,
      companyName,
      requester,
      requesterAgentId: boundedText(approval.requestedByAgentId, 160),
      approvalType,
      risk,
      issueId,
      issueIds: linkedIssues.map((issue) => issue.id).slice(0, 10),
      summary,
      status: approval.status,
      createdAt,
      expiresAt,
      relatedTaskId: relatedTaskId ?? null,
    },
  };
}

function attentionLevel(value: unknown): NotificationLevel {
  switch (value) {
    case 'critical': return 'urgent';
    case 'high': return 'action_needed';
    case 'medium': return 'heads_up';
    default: return 'fyi';
  }
}

function attentionActionUrl(
  settings: PaperclipConnectorSettings,
  attention: PaperclipAttentionItem,
): string {
  const apiOrigin = new URL(settings.apiOrigin).origin;
  const href = boundedText(record(attention.subject).href, 2048);
  if (!href) return apiOrigin;
  try {
    const url = new URL(href, apiOrigin);
    return url.origin === apiOrigin ? url.toString() : apiOrigin;
  } catch {
    return apiOrigin;
  }
}

function attentionNotification({
  attention,
  settings,
  companyName,
  connectorId,
  relatedTaskId,
}: {
  attention: PaperclipAttentionItem;
  settings: PaperclipConnectorSettings;
  companyName: string;
  connectorId: string;
  relatedTaskId?: string;
}): InboundNotification {
  const subject = record(attention.subject);
  const relatedIssue = record(attention.relatedIssue);
  const detail = record(attention.detail);
  const sourceKind = boundedText(attention.sourceKind, 120) ?? 'attention';
  const detailKind = boundedText(detail.kind, 120);
  const title = boundedText(subject.title, 240)
    ?? boundedText(detail.title, 240)
    ?? `Paperclip ${sourceKind.replaceAll('_', ' ')}`;
  const identifier = boundedText(subject.identifier, 160)
    ?? boundedText(relatedIssue.identifier, 160);
  const whyNow = boundedText(attention.whyNow, 600);
  const summary = boundedText(detail.summaryExcerpt, 600)
    ?? boundedText(detail.promptExcerpt, 600);
  const createdAt = dateText(attention.createdAt)
    ?? dateText(attention.activityAt)
    ?? new Date().toISOString();
  const activityAt = dateText(attention.activityAt)
    ?? dateText(attention.updatedAt)
    ?? createdAt;
  const decisionVerbs = Array.isArray(attention.decisionVerbs)
    ? attention.decisionVerbs
      .map((verb) => boundedText(record(verb).label, 80))
      .filter((label): label is string => Boolean(label))
      .slice(0, 10)
    : [];
  const detailLines = [
    `Company: ${companyName}`,
    `Type: ${sourceKind}`,
    ...(detailKind ? [`Detail: ${detailKind}`] : []),
    ...(identifier ? [`Paperclip issue: ${identifier}`] : []),
    ...(relatedTaskId ? [`Mission Control task: ${relatedTaskId}`] : []),
    ...(whyNow ? [`Why now: ${whyNow}`] : []),
    ...(summary ? [`Summary: ${summary}`] : []),
    ...(decisionVerbs.length > 0 ? [`Available decisions: ${decisionVerbs.join(', ')}`] : []),
    `Created: ${createdAt}`,
  ];
  const isActionable = attention.inlineResolvable === true
    || decisionVerbs.length > 0
    || ['decision', 'issue_thread_interaction', 'join_request', 'recovery_action']
      .includes(sourceKind);

  return {
    id: attentionNotificationId(attention.id),
    sourceId: `attention:${attention.id}`,
    connectorType: 'paperclip',
    connectorInstanceId: connectorId,
    title,
    body: detailLines.join('\n'),
    level: attentionLevel(attention.severity),
    category: 'automation',
    templateKey: 'paperclip_attention',
    isRead: false,
    isActionable,
    actionUrl: attentionActionUrl(settings, attention),
    receivedAt: createdAt,
    sourceState: 'active',
    sourceActivityAt: activityAt,
    sourceActivityKey: activityAt,
    reopenPolicy: 'handled_and_dismissed',
    ...(relatedTaskId ? { relatedTaskId } : {}),
    hubProjectIds: [],
    tags: [],
    metadata: {
      attentionId: attention.id,
      companyId: attention.companyId,
      companyName,
      sourceKind,
      detailKind,
      subjectKind: boundedText(subject.kind, 120),
      subjectId: boundedText(subject.id, 160),
      relatedIssueId: boundedText(relatedIssue.id, 160),
      identifier,
      whyNow,
      summary,
      severity: boundedText(attention.severity, 80),
      decisionVerbs,
      inlineResolvable: attention.inlineResolvable === true,
      relatedTaskId: relatedTaskId ?? null,
    },
  };
}

function credentialExpiryNotification(
  settings: PaperclipConnectorSettings,
  connectorId: string,
): InboundNotification | null {
  if (!settings.boardKeyExpiresAt) return null;
  const expiresAtMs = Date.parse(settings.boardKeyExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs > CREDENTIAL_WARNING_MS) return null;
  const expired = remainingMs <= 0;
  const companyScope = settings.monitorAllCompanies
    ? 'all accessible companies'
    : settings.companyIds
      .map((companyId) => settings.companyNames[companyId] ?? companyId)
      .join(', ');
  const warningAt = new Date(expiresAtMs - CREDENTIAL_WARNING_MS).toISOString();
  return {
    id: credentialExpiryNotificationId(connectorId),
    sourceId: `credential-expiry:${settings.boardKeyId ?? connectorId}`,
    connectorType: 'paperclip',
    connectorInstanceId: connectorId,
    title: expired
      ? `Paperclip connection expired: ${companyScope}`
      : `Renew Paperclip connection for ${companyScope}`,
    body: expired
      ? `Mission Control can no longer read Paperclip approvals for ${companyScope}. Reconnect Paperclip in Settings.`
      : `The Paperclip Board API key for ${companyScope} expires ${settings.boardKeyExpiresAt}. Reconnect before then to keep approvals and delegated-work status available.`,
    level: 'action_needed',
    category: 'system',
    templateKey: 'paperclip_credential_expiring',
    isRead: false,
    isActionable: true,
    actionUrl: '/settings/connectors',
    receivedAt: warningAt,
    sourceState: 'active',
    sourceActivityAt: warningAt,
    sourceActivityKey: settings.boardKeyExpiresAt,
    reopenPolicy: 'handled_and_dismissed',
    hubProjectIds: [],
    tags: [],
    metadata: {
      monitorAllCompanies: settings.monitorAllCompanies,
      companyIds: settings.companyIds,
      boardKeyId: settings.boardKeyId ?? null,
      boardUserName: settings.boardUserName ?? null,
      expiresAt: settings.boardKeyExpiresAt,
      expired,
    },
  };
}

export function validatePaperclipConnectorConfig(
  settingsValue: Record<string, unknown>,
  credentials: Record<string, unknown>,
): PaperclipConnectorSettings {
  const settings = normalizeSettings(settingsValue);
  if (typeof credentials.apiToken !== 'string' || !credentials.apiToken.trim()) {
    throw new Error('Paperclip API token is required');
  }
  const url = new URL(settings.apiOrigin);
  const local = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '::1'
    || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !local) {
    throw new Error('Paperclip API tokens require HTTPS for non-local endpoints');
  }
  return settings;
}

function normalizeSettings(value: Record<string, unknown>): PaperclipConnectorSettings {
  const apiOrigin = boundedText(value.apiOrigin, 2048);
  const legacyCompanyId = boundedText(value.companyId, 160);
  const configuredCompanyIds = Array.isArray(value.companyIds)
    ? value.companyIds
      .map((companyId) => boundedText(companyId, 160))
      .filter((companyId): companyId is string => companyId !== null)
    : [];
  const companyIds = [...new Set([
    ...configuredCompanyIds,
    ...(legacyCompanyId ? [legacyCompanyId] : []),
  ])];
  const monitorAllCompanies = value.monitorAllCompanies === true;
  if (!apiOrigin || (!monitorAllCompanies && companyIds.length === 0)) {
    throw new Error('Paperclip API origin and at least one company are required');
  }
  const companyNameValues = record(value.companyNames);
  const legacyCompanyName = boundedText(value.companyName, 120);
  const companyNames = Object.fromEntries(companyIds.map((companyId) => [
    companyId,
    boundedText(companyNameValues[companyId], 120)
      ?? (companyId === legacyCompanyId ? legacyCompanyName : null)
      ?? companyId,
  ]));
  let url: URL;
  try {
    url = new URL(apiOrigin);
  } catch {
    throw new Error('Paperclip API origin must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    throw new Error('Paperclip API origin must not contain credentials, a path, query, or fragment');
  }
  return {
    apiOrigin: url.origin,
    monitorAllCompanies,
    companyIds: monitorAllCompanies ? [] : companyIds,
    companyNames,
    ...(boundedText(value.boardKeyId, 160)
      ? { boardKeyId: boundedText(value.boardKeyId, 160)! }
      : {}),
    ...(value.boardKeyExpiresAt === null
      ? { boardKeyExpiresAt: null }
      : dateText(value.boardKeyExpiresAt)
        ? { boardKeyExpiresAt: dateText(value.boardKeyExpiresAt) }
        : {}),
    ...(value.boardUserName === null
      ? { boardUserName: null }
      : boundedText(value.boardUserName, 120)
        ? { boardUserName: boundedText(value.boardUserName, 120) }
        : {}),
  };
}

function isPending(approval: PaperclipApproval): boolean {
  return PENDING_STATES.has(approval.status.toLowerCase());
}

function isAuthoritativelyActive(approval: PaperclipApproval): boolean {
  const status = approval.status.toLowerCase();
  return !KNOWN_TERMINAL_STATES.has(status);
}

export class PaperclipConnector implements IConnector {
  readonly id = '';
  readonly type = 'paperclip';
  readonly displayName = 'Paperclip';
  readonly icon = 'paperclip';
  readonly capabilities = CONNECTOR_CAPABILITIES;
  readonly notificationTypes = PAPERCLIP_NOTIFICATION_TYPES;

  private settings: PaperclipConnectorSettings | null = null;
  private credential = '';
  private approvals: PaperclipApproval[] | null = null;
  private attention: PaperclipAttentionItem[] | null = null;
  private companyNames = new Map<string, string>();

  async initialize(config: ConnectorConfig): Promise<void> {
    (this as { id: string }).id = config.id;
    this.settings = validatePaperclipConnectorConfig(config.settings, config.credentials);
    this.credential = config.credentials.apiToken?.trim() ?? '';
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.fetchPaperclipState();
      return { success: true, message: 'Connected to Paperclip approvals and attention' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Paperclip connection failed',
      };
    }
  }

  async dispose(): Promise<void> {
    this.settings = null;
    this.credential = '';
    this.approvals = null;
    this.attention = null;
    this.companyNames.clear();
  }

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    yield [];
  }

  async fetchNotifications(): Promise<InboundNotification[]> {
    const settings = this.requireSettings();
    const credentialNotification = credentialExpiryNotification(settings, this.id);
    const { approvals, attention } = await this.fetchPaperclipState();
    const pendingApprovals = approvals.filter(isPending);
    const issuesByApproval = new Map<string, PaperclipIssue[]>();
    for (let index = 0; index < pendingApprovals.length; index += 5) {
      const batch = pendingApprovals.slice(index, index + 5);
      const batchIssues = await Promise.all(batch.map((approval) => {
        const companyId = approval.companyId;
        if (!companyId) {
          throw new Error(`Paperclip approval ${approval.id} has no company`);
        }
        return listPaperclipApprovalIssues({
          endpoint: settings.apiOrigin,
          credential: this.credential,
        }, companyId, approval.id).catch((error: unknown) => {
          if (
            error instanceof ExternalAgentError
            && (error.status === 403 || error.status === 404)
          ) {
            return [];
          }
          throw error;
        });
      }));
      batch.forEach((approval, batchIndex) => {
        issuesByApproval.set(approval.id, batchIssues[batchIndex] ?? []);
      });
    }
    const persistence = await getExternalAgentControlPersistence();
    const dispatches = await persistence.dispatches.list({ limit: 1000 });
    const taskByIssueId = new Map<string, string>();
    for (const dispatch of dispatches) {
      if (
        dispatch.providerTaskId
        && dispatch.externalAgentId
        && !taskByIssueId.has(dispatch.providerTaskId)
      ) {
        const taskId = dispatch.scope.taskIds?.[0];
        if (taskId) taskByIssueId.set(dispatch.providerTaskId, taskId);
      }
    }
    const approvalNotifications = pendingApprovals.map((approval) => {
      const companyId = approval.companyId;
      if (!companyId) {
        throw new Error(`Paperclip approval ${approval.id} has no company`);
      }
      const linkedIssues = issuesByApproval.get(approval.id) ?? [];
      const relatedTaskId = linkedIssues
        .map((issue) => issue.id)
        .map((issueId) => taskByIssueId.get(issueId))
        .find((taskId): taskId is string => Boolean(taskId));
      return approvalNotification({
        approval,
        settings,
        companyId,
        companyName: this.companyNames.get(companyId) ?? companyId,
        connectorId: this.id,
        linkedIssues,
        ...(relatedTaskId ? { relatedTaskId } : {}),
      });
    });
    const attentionNotifications = attention
      .filter((item) => item.sourceKind !== 'approval')
      .map((item) => {
        const subject = record(item.subject);
        const relatedIssue = record(item.relatedIssue);
        const relatedTaskId = [
          boundedText(subject.id, 160),
          boundedText(relatedIssue.id, 160),
        ]
          .filter((issueId): issueId is string => Boolean(issueId))
          .map((issueId) => taskByIssueId.get(issueId))
          .find((taskId): taskId is string => Boolean(taskId));
        return attentionNotification({
          attention: item,
          settings,
          companyName: this.companyNames.get(item.companyId) ?? item.companyId,
          connectorId: this.id,
          ...(relatedTaskId ? { relatedTaskId } : {}),
        });
      });
    return [
      ...(credentialNotification ? [credentialNotification] : []),
      ...approvalNotifications,
      ...attentionNotifications,
    ];
  }

  async getActiveAlertSourceIds(): Promise<string[]> {
    const state = this.approvals && this.attention
      ? { approvals: this.approvals, attention: this.attention }
      : await this.fetchPaperclipState();
    const approvalIds = state.approvals
      .filter(isAuthoritativelyActive)
      .map((approval) => approvalNotificationId(approval.id));
    const attentionIds = state.attention
      .filter((item) => item.sourceKind !== 'approval')
      .map((item) => attentionNotificationId(item.id));
    const credentialNotification = credentialExpiryNotification(
      this.requireSettings(),
      this.id,
    );
    return credentialNotification
      ? [credentialExpiryNotificationId(this.id), ...approvalIds, ...attentionIds]
      : [...approvalIds, ...attentionIds];
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    return [];
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  private requireSettings(): PaperclipConnectorSettings {
    if (!this.settings) throw new Error('Paperclip connector is not initialized');
    return this.settings;
  }

  private async fetchPaperclipState(): Promise<{
    approvals: PaperclipApproval[];
    attention: PaperclipAttentionItem[];
  }> {
    const settings = this.requireSettings();
    const connection = {
      endpoint: settings.apiOrigin,
      credential: this.credential,
    };
    const companies = settings.monitorAllCompanies
      ? (await discoverPaperclip(connection)).companies
      : settings.companyIds.map((companyId) => ({
        id: companyId,
        name: settings.companyNames[companyId] ?? companyId,
      }));
    this.companyNames = new Map(companies.map((company) => [company.id, company.name]));
    const [approvals, attention] = await Promise.all([
      Promise.all(companies.map((company) =>
        listPaperclipApprovals(connection, company.id))).then((items) => items.flat()),
      Promise.all(companies.map((company) =>
        listPaperclipAttention(connection, company.id))).then((items) => items.flat()),
    ]);
    this.approvals = approvals;
    this.attention = attention;
    return { approvals, attention };
  }
}

export const paperclipFactory: ConnectorFactory = {
  create: () => new PaperclipConnector(),
  notificationTypes: PAPERCLIP_NOTIFICATION_TYPES,
};
