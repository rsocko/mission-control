import 'server-only';

import logger from '@/lib/logger';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import { createNotification } from '@/lib/notifications/service';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';
import { redactPushText } from '@/lib/notifications/push-text';
import type {
  AgentDispatchRecord,
  ExternalAgentRecord,
} from './contracts';
import { isExternalAgentError } from './errors';
import {
  getPaperclipAgent,
  getPaperclipApproval,
  getPaperclipCompany,
  listPaperclipApprovalIssues,
  listPaperclipApprovals,
  paperclipApprovalDeepLink,
  type PaperclipApproval,
  type PaperclipApprovalIssue,
  type PaperclipConnection,
} from './paperclip';
import { hashCanonical, redactForPersistence } from './policy';
import {
  getExternalAgent,
  listExternalAgents,
  resolveAgentCredential,
} from './registry';
import { listDispatches } from './service';
import type {
  NotificationItem,
  NotificationLevel,
  NotificationSourceState,
} from '@/types';

const reconciliationLogger = logger.child({ module: 'paperclip-approvals' });
const MAX_APPROVALS_PER_AGENT_RUN = 50;
const MAX_EXISTING_NOTIFICATIONS = 500;
const TERMINAL_STATUSES = new Set([
  'approved',
  'rejected',
  'revision_requested',
  'cancelled',
  'expired',
  'withdrawn',
]);

interface ApprovalContext {
  approval: PaperclipApproval;
  issues: PaperclipApprovalIssue[];
  companyName: string;
  requesterName: string | null;
  dispatch: AgentDispatchRecord | null;
  deepLink: string;
}

export interface PaperclipApprovalReconciliationResult {
  agents: number;
  created: number;
  updated: number;
  resolved: number;
  deleted: number;
  deferred: number;
  failures: Array<{ agentId: string; approvalId?: string; error: string }>;
}

function connectionFor(agent: ExternalAgentRecord, fetcher?: typeof fetch): PaperclipConnection {
  const config = agent.providerConfig.paperclip;
  if (!agent.endpoint || !config) {
    throw new Error(`Paperclip agent "${agent.id}" is missing provider configuration`);
  }
  return {
    endpoint: agent.endpoint,
    credential: resolveAgentCredential(agent.authCredentialRef),
    config,
    fetcher,
  };
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = redactPushText(value, maxLength).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function riskFrom(approval: PaperclipApproval): string {
  const raw = text(
    approval.payload.risk ?? approval.payload.riskLevel ?? approval.payload.severity,
    32,
  )?.toLowerCase();
  return raw && ['low', 'moderate', 'medium', 'high', 'critical'].includes(raw)
    ? raw
    : approval.type === 'budget_override_required'
      ? 'high'
      : 'unspecified';
}

function summaryFrom(approval: PaperclipApproval): string {
  return text(
    approval.payload.summary
      ?? approval.payload.title
      ?? approval.payload.reason
      ?? approval.payload.recommendedAction,
    500,
  ) ?? `Paperclip ${approval.type.replaceAll('_', ' ')} request`;
}

function expiresAtFrom(approval: PaperclipApproval): string | null {
  const value = text(approval.payload.expiresAt, 64);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function runIdFrom(approval: PaperclipApproval, issues: PaperclipApprovalIssue[]): string | null {
  return text(approval.payload.runId ?? approval.payload.heartbeatRunId, 255)
    ?? issues.find((issue) => issue.executionRunId)?.executionRunId
    ?? null;
}

function statusState(status: string): NotificationSourceState {
  if (status === 'pending') return 'active';
  if (TERMINAL_STATUSES.has(status)) return 'resolved';
  throw new Error(`Unsupported Paperclip approval status "${status}"`);
}

function statusLabel(status: string): string {
  if (status === 'cancelled') return 'withdrawn';
  return status.replaceAll('_', ' ');
}

function levelFor(risk: string): NotificationLevel {
  if (risk === 'critical') return 'urgent';
  if (risk === 'high') return 'action_needed';
  if (risk === 'moderate' || risk === 'medium') return 'heads_up';
  return 'fyi';
}

function typeLabel(type: string): string {
  return type.split('_').map((part) => (
    part ? `${part[0].toUpperCase()}${part.slice(1)}` : part
  )).join(' ');
}

function sourceId(agentId: string, approvalId: string): string {
  return `paperclip:approval:${agentId}:${approvalId}`;
}

function notificationId(agentId: string, approvalId: string): string {
  return `paperclip-approval:${agentId}:${approvalId}`;
}

function approvalIdFromNotification(notification: { metadata: unknown }): string | null {
  if (!notification.metadata || typeof notification.metadata !== 'object') return null;
  return text((notification.metadata as Record<string, unknown>).approvalId, 255);
}

function findDispatch(
  issues: PaperclipApprovalIssue[],
  approvalId: string,
  dispatches: AgentDispatchRecord[],
): AgentDispatchRecord | null {
  const issueIds = new Set(issues.map((issue) => issue.id));
  return dispatches.find((dispatch) => {
    if (dispatch.providerTaskId && issueIds.has(dispatch.providerTaskId)) return true;
    const approvals = dispatch.providerDetail?.pendingApprovals;
    return Array.isArray(approvals) && approvals.some((approval) => (
      approval
      && typeof approval === 'object'
      && (approval as Record<string, unknown>).id === approvalId
    ));
  }) ?? null;
}

function bodyFor(context: ApprovalContext): string {
  const { approval, issues, companyName, requesterName, dispatch } = context;
  const risk = riskFrom(approval);
  const runId = runIdFrom(approval, issues);
  const issue = issues[0];
  const lines = [
    summaryFrom(approval),
    `Company: ${companyName}`,
    `Requester: ${requesterName ?? approval.requestedByAgentId ?? approval.requestedByUserId ?? 'Unknown'}`,
    `Approval: ${typeLabel(approval.type)}`,
    `Risk: ${risk}`,
    `Status: ${statusLabel(approval.status)}`,
  ];
  if (dispatch) lines.push(`Mission Control dispatch: ${dispatch.id}`);
  if (dispatch?.scope.taskIds?.[0]) lines.push(`Mission Control task: ${dispatch.scope.taskIds[0]}`);
  if (issue) lines.push(`Paperclip issue: ${issue.identifier ?? issue.id}`);
  if (runId) lines.push(`Paperclip run: ${runId}`);
  lines.push(`Created: ${approval.createdAt}`);
  const expiresAt = expiresAtFrom(approval);
  if (expiresAt) lines.push(`Expires: ${expiresAt}`);
  return lines.join('\n');
}

async function upsertApprovalNotification(
  agent: ExternalAgentRecord,
  context: ApprovalContext,
  sourceState: NotificationSourceState,
) {
  const { approval, issues, dispatch, deepLink } = context;
  const risk = riskFrom(approval);
  const expiresAt = expiresAtFrom(approval);
  const currentStatus = statusLabel(approval.status);
  const active = sourceState === 'active';
  const activityKey = `${approval.updatedAt}:${approval.status}`;
  const actionId = `${notificationId(agent.id, approval.id)}:review:${
    hashCanonical(activityKey).slice(0, 16)
  }`;
  const minimizedMetadata = redactForPersistence({
    contract: 'paperclip-approval-v1',
    approvalId: approval.id,
    companyId: approval.companyId,
    companyName: context.companyName,
    requesterAgentId: approval.requestedByAgentId,
    requesterName: context.requesterName,
    approvalType: approval.type,
    risk,
    status: approval.status,
    issueId: issues[0]?.id ?? null,
    issueIdentifier: issues[0]?.identifier ?? null,
    runId: runIdFrom(approval, issues),
    dispatchId: dispatch?.id ?? null,
    taskId: dispatch?.scope.taskIds?.[0] ?? null,
    dataClassification: risk === 'high' || risk === 'critical' ? 'restricted' : 'standard',
    decisionAuthority: 'paperclip',
  }, { maxText: 500, maxBytes: 8 * 1024 }) as Record<string, unknown>;
  const result = await createNotification({
    id: notificationId(agent.id, approval.id),
    sourceId: sourceId(agent.id, approval.id),
    connectorType: 'paperclip',
    connectorInstanceId: agent.id,
    title: active
      ? `Paperclip approval: ${typeLabel(approval.type)}`
      : `Paperclip approval ${currentStatus}: ${typeLabel(approval.type)}`,
    body: bodyFor(context),
    level: levelFor(risk),
    category: risk === 'high' || risk === 'critical' ? 'security' : 'automation',
    templateKey: 'paperclip.approval',
    sourceState,
    sourceActivityAt: approval.updatedAt,
    sourceActivityKey: activityKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: approval.createdAt,
    sortAt: approval.updatedAt,
    expiresAt,
    groupKey: `paperclip-company:${approval.companyId}`,
    dedupeKey: sourceId(agent.id, approval.id),
    relatedTaskId: dispatch?.scope.taskIds?.[0] ?? null,
    relatedProjectId: dispatch?.scope.projectId ?? null,
    relatedEntityType: 'paperclip-approval',
    relatedEntityId: approval.id,
    metadata: minimizedMetadata,
    presentation: {
      sourceName: 'Paperclip',
      subtitle: `${context.companyName} · ${context.requesterName ?? 'Unknown requester'}`,
      richContent: {
        primaryText: summaryFrom(approval),
        stats: [
          { label: 'Type', value: typeLabel(approval.type) },
          { label: 'Risk', value: risk, tone: risk === 'critical' ? 'danger' : 'warning' },
          { label: 'Status', value: currentStatus },
        ],
        footerText: expiresAt ? `Expires ${expiresAt}` : `Created ${approval.createdAt}`,
        links: [{ label: 'Review in Paperclip', url: deepLink }],
      },
    },
    enrichmentRevision: activityKey,
    isActionable: active,
    primaryActionId: active ? actionId : null,
    occurrenceKey: activityKey,
  }, { wakeDispatcher: active });

  const notification: NotificationItem = {
    ...result.notification,
    level: result.notification.level as NotificationItem['level'],
    category: result.notification.category as NotificationItem['category'],
    state: result.notification.state as NotificationItem['state'],
    readState: result.notification.readState as NotificationItem['readState'],
    disposition: result.notification.disposition as NotificationItem['disposition'],
    sourceState: result.notification.sourceState as NotificationItem['sourceState'],
    syncState: result.notification.syncState as NotificationItem['syncState'],
    metadata: minimizedMetadata,
    presentation: result.notification.presentation as Record<string, unknown>,
    actions: active
      ? [{
          id: actionId,
          notificationId: result.notification.id,
          actionType: 'open_url',
          label: 'Review in Paperclip',
          icon: 'external-link',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: { url: deepLink },
          opensExternal: true,
          requiresConfirmation: false,
          createdBy: 'connector',
        }]
      : [],
  };
  const notificationRepository = getCorePersistenceRepositories().notifications;
  await notificationRepository.upsert(notification);
  if (!active) {
    if (!notificationRepository.completeActions) {
      throw new Error('Notification action completion persistence is unavailable');
    }
    await notificationRepository.completeActions(
      result.notification.id,
      approval.updatedAt,
    );
  }
  reconciliationLogger.info({
    externalAgentId: agent.id,
    companyId: approval.companyId,
    approvalId: approval.id,
    approvalStatus: approval.status,
    notificationId: result.notification.id,
    created: result.created,
    sourceState,
  }, 'Paperclip approval notification reconciled');
  return result.created;
}

async function listExisting(agentId: string) {
  const page = await (await getNotificationWebPersistence()).queryNotifications({
    query: {
      ...DEFAULT_NOTIFICATION_QUERY,
      source: 'paperclip',
      sourceAccount: agentId,
      sort: 'oldest',
    },
    limit: MAX_EXISTING_NOTIFICATIONS,
    cursor: null,
  });
  if (page.hasMore) {
    throw new Error(
      `Paperclip approval reconciliation exceeded ${MAX_EXISTING_NOTIFICATIONS} notifications`,
    );
  }
  return page.items.filter((item) => (
    item.connectorType === 'paperclip'
    && item.connectorInstanceId === agentId
    && item.sourceState === 'active'
  ));
}

async function approvalContext(
  connection: PaperclipConnection,
  approval: PaperclipApproval,
  companyName: string,
  dispatches: AgentDispatchRecord[],
  requesterNames: Map<string, string | null>,
): Promise<ApprovalContext> {
  const issues = await listPaperclipApprovalIssues(connection, approval.id);
  let requesterName: string | null = null;
  if (approval.requestedByAgentId) {
    if (!requesterNames.has(approval.requestedByAgentId)) {
      try {
        const requester = await getPaperclipAgent(connection, approval.requestedByAgentId);
        requesterNames.set(approval.requestedByAgentId, text(requester.name, 160));
      } catch (error) {
        if (!isExternalAgentError(error) || error.code !== 'PROVIDER_NOT_FOUND') throw error;
        requesterNames.set(approval.requestedByAgentId, null);
      }
    }
    requesterName = requesterNames.get(approval.requestedByAgentId) ?? null;
  }
  return {
    approval,
    issues,
    companyName,
    requesterName,
    dispatch: findDispatch(issues, approval.id, dispatches),
    deepLink: paperclipApprovalDeepLink(connection, approval.id),
  };
}

async function reconcileAgent(
  agent: ExternalAgentRecord,
  result: PaperclipApprovalReconciliationResult,
  fetcher?: typeof fetch,
) {
  const connection = connectionFor(agent, fetcher);
  const [company, pendingList, existing, dispatches] = await Promise.all([
    getPaperclipCompany(connection),
    listPaperclipApprovals(connection, 'pending'),
    listExisting(agent.id),
    listDispatches({ agentId: agent.id, limit: 500 }),
  ]);
  const companyName = text(company.name, 160) ?? company.id;
  const pendingIds = new Set(pendingList.map((approval) => approval.id));
  const requesterNames = new Map<string, string | null>();
  const existingIds = new Set(
    existing.map(approvalIdFromNotification).filter((id): id is string => Boolean(id)),
  );
  const perRunLimit = Math.max(
    1,
    Math.min(
      MAX_APPROVALS_PER_AGENT_RUN,
      Math.floor((agent.dataPolicy.maxRequestsPerMinute - 2) / 3),
    ),
  );
  const selected = [
    ...pendingList.filter((approval) => !existingIds.has(approval.id)),
    ...pendingList.filter((approval) => existingIds.has(approval.id)),
  ].slice(0, perRunLimit);

  for (const listed of selected) {
    try {
      const approval = await getPaperclipApproval(connection, listed.id);
      const context = await approvalContext(
        connection,
        approval,
        companyName,
        dispatches,
        requesterNames,
      );
      const state = statusState(approval.status);
      if (state !== 'active' && !existingIds.has(approval.id)) {
        reconciliationLogger.info({
          externalAgentId: agent.id,
          companyId: approval.companyId,
          approvalId: approval.id,
          approvalStatus: approval.status,
        }, 'Skipped Paperclip approval decided during reconciliation');
        continue;
      }
      const created = await upsertApprovalNotification(agent, context, state);
      if (created) result.created += 1;
      else if (state === 'active') result.updated += 1;
      else result.resolved += 1;
    } catch (error) {
      result.failures.push({
        agentId: agent.id,
        approvalId: listed.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.deferred += Math.max(0, pendingList.length - selected.length);

  for (const notification of existing) {
    const approvalId = approvalIdFromNotification(notification);
    if (!approvalId || pendingIds.has(approvalId)) continue;
    try {
      const approval = await getPaperclipApproval(connection, approvalId);
      const context = await approvalContext(
        connection,
        approval,
        companyName,
        dispatches,
        requesterNames,
      );
      await upsertApprovalNotification(agent, context, statusState(approval.status));
      if (approval.status === 'pending') result.updated += 1;
      else result.resolved += 1;
    } catch (error) {
      if (isExternalAgentError(error) && error.code === 'PROVIDER_NOT_FOUND') {
        const now = new Date().toISOString();
        const metadata = notification.metadata && typeof notification.metadata === 'object'
          ? notification.metadata as Record<string, unknown>
          : {};
        const item = await getCorePersistenceRepositories().notifications.get(notification.id);
        if (item) {
          const notificationRepository = getCorePersistenceRepositories().notifications;
          await notificationRepository.upsert({
            ...item,
            title: `${item.title} (unavailable)`,
            sourceState: 'deleted',
            state: 'resolved',
            isActionable: false,
            primaryActionId: null,
            sourceResolvedAt: item.sourceResolvedAt ?? now,
            lastSourceSyncedAt: now,
            metadata: { ...metadata, status: 'inaccessible_or_deleted' },
            actions: [],
          });
          if (!notificationRepository.completeActions) {
            throw new Error('Notification action completion persistence is unavailable');
          }
          await notificationRepository.completeActions(notification.id, now);
          result.deleted += 1;
          reconciliationLogger.info({
            externalAgentId: agent.id,
            approvalId,
            notificationId: notification.id,
          }, 'Paperclip approval notification closed after authoritative not-found');
        }
        continue;
      }
      result.failures.push({
        agentId: agent.id,
        approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function reconcilePaperclipApprovals(
  options: { fetcher?: typeof fetch } = {},
): Promise<PaperclipApprovalReconciliationResult> {
  const agents = (await listExternalAgents())
    .filter((agent) => agent.type === 'paperclip' && agent.enabled && !agent.deletedAt);
  const result: PaperclipApprovalReconciliationResult = {
    agents: agents.length,
    created: 0,
    updated: 0,
    resolved: 0,
    deleted: 0,
    deferred: 0,
    failures: [],
  };
  for (const publicAgent of agents) {
    const agent = await getExternalAgent(publicAgent.id);
    if (!agent) continue;
    try {
      await reconcileAgent(agent, result, options.fetcher);
    } catch (error) {
      result.failures.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      reconciliationLogger.error({
        err: error,
        externalAgentId: agent.id,
        companyId: agent.providerConfig.paperclip?.companyId,
      }, 'Paperclip approval reconciliation failed without changing notification state');
    }
  }
  return result;
}

export const paperclipApprovalProjection = {
  sourceId,
  notificationId,
  riskFrom,
  summaryFrom,
  expiresAtFrom,
  statusState,
};
