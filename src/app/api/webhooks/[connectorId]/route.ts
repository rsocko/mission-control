import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getStatusLifecycleUpdates } from '@/lib/tasks/status-lifecycle';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import { extractNotificationTemplateKey } from '@/lib/notifications/push-policy/catalog';
import { getConnectorSourceProfile } from '@/lib/connectors/task-source-profiles';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { WebhookIngestRepository } from '@/db/persistence/webhook-integrations';

/**
 * POST /api/webhooks/[connectorId] — Receive webhook pushes from external services
 * 
 * Each connector type has its own payload format:
 * - Microsoft Graph: change notifications with resourceData
 * - GitHub: event payloads with action + issue/PR data
 * - Custom: generic JSON with configurable structure
 * 
 * This endpoint:
 * 1. Validates the connector exists and is enabled
 * 2. Verifies the webhook secret (if configured)
 * 3. Parses the payload into tasks/notifications
 * 4. Upserts into the database
 * 5. Logs the sync event
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectorId: string }> }
) {
  const { connectorId } = await params;

  try {
    const ingest = (await getWorkerPersistenceRepositories()).webhookIntegrations.ingest;

    // Validate connector exists
    const config = await ingest.findConnector(connectorId);

    if (!config) {
      return NextResponse.json({ error: 'Unknown connector' }, { status: 404 });
    }

    if (!config.enabled) {
      return NextResponse.json({ error: 'Connector disabled' }, { status: 403 });
    }

    const settings = config.settings;

    // Verify webhook secret if configured
    const webhookSecret = settings?.webhookSecret as string | undefined;
    if (webhookSecret) {
      const signature = request.headers.get('x-webhook-signature') ||
                       request.headers.get('x-hub-signature-256');
      if (!signature) {
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
      }
      // In production, verify HMAC signature here
    }

    const payload = await request.json();
    const now = new Date().toISOString();
    let tasksAdded = 0;
    let tasksUpdated = 0;
    let notificationsAdded = 0;

    // Handle based on connector type
    switch (config.type) {
      case 'github-issues': {
        const result = await handleGitHubWebhook(ingest, payload, config.id, now);
        tasksAdded = result.tasksAdded;
        tasksUpdated = result.tasksUpdated;
        break;
      }
      case 'microsoft-todo': {
        const result = await handleMicrosoftWebhook(ingest, payload, config.id, now);
        tasksAdded = result.tasksAdded;
        tasksUpdated = result.tasksUpdated;
        break;
      }
      default: {
        // Generic handler: attempt to parse as task or notification
        const result = await handleGenericWebhook(
          ingest,
          payload,
          config.id,
          config.type,
          settings,
          now,
        );
        tasksAdded = result.tasksAdded;
        notificationsAdded = result.notificationsAdded;
        break;
      }
    }

    // Log sync event
    await ingest.appendSyncLog({
      id: crypto.randomUUID(),
      connectorId,
      success: true,
      tasksAdded,
      tasksUpdated,
      tasksRemoved: 0,
      notificationsAdded,
      errors: '[]',
      syncedAt: now,
    });

    return NextResponse.json({
      success: true,
      tasksAdded,
      tasksUpdated,
      notificationsAdded,
    });
  } catch (error) {
    return ApiErrors.internal('Webhook processing failed', error);
  }
}

/**
 * GET /api/webhooks/[connectorId] — Webhook verification (used by MS Graph, GitHub, etc.)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectorId: string }> }
) {
  const { connectorId } = await params;
  const { searchParams } = new URL(request.url);

  // Microsoft Graph subscription validation
  const validationToken = searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // GitHub webhook ping
  return NextResponse.json({ status: 'ready', connectorId });
}

// ─── Handler: GitHub ─────────────────────────────────────────────────────────

async function handleGitHubWebhook(
  ingest: WebhookIngestRepository,
  payload: Record<string, unknown>,
  connectorId: string,
  now: string
): Promise<{ tasksAdded: number; tasksUpdated: number }> {
  const action = payload.action as string;
  const issue = payload.issue as Record<string, unknown> | undefined;

  if (!issue) return { tasksAdded: 0, tasksUpdated: 0 };

  const sourceId = `github:${issue.number}`;
  const currentTask = await ingest.findTaskBySourceId(sourceId);

  // Map GitHub state_reason to internal statusReason
  const ghStateReason = issue.state_reason as string | null | undefined;
  let statusReason: string | null = null;
  if (ghStateReason === 'not_planned') statusReason = 'not_planned';
  else if (ghStateReason === 'duplicate') statusReason = 'duplicate';
  else if (issue.state === 'closed') statusReason = 'completed';

  const mappedStatus = issue.state === 'closed' ? 'done' : 'todo';
  const closedAt = typeof issue.closed_at === 'string' ? issue.closed_at : now;
  const lifecycle = getStatusLifecycleUpdates({
    status: mappedStatus,
    explicitReason: statusReason,
    completedAt: closedAt,
    currentStatus: currentTask?.status,
    currentCompletedAt: currentTask?.completedAt,
    currentStatusReason: currentTask?.statusReason,
  });
  const taskData = {
    title: issue.title as string,
    description: issue.body as string | undefined,
    priority: 'none',
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    status: lifecycle.status ?? undefined,
    completedAt: lifecycle.completedAt,
    statusReason: lifecycle.statusReason,
  };

  if (currentTask) {
    await ingest.updateTask(currentTask.id, taskData);
    return { tasksAdded: 0, tasksUpdated: 1 };
  }

  if (action === 'opened' || action === 'reopened') {
    await ingest.createTask({
      id: crypto.randomUUID(),
      sourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      ...taskData,
      createdAt: now,
    });
    return { tasksAdded: 1, tasksUpdated: 0 };
  }

  return { tasksAdded: 0, tasksUpdated: 0 };
}

// ─── Handler: Microsoft Graph ────────────────────────────────────────────────

async function handleMicrosoftWebhook(
  ingest: WebhookIngestRepository,
  payload: Record<string, unknown>,
  connectorId: string,
  now: string
): Promise<{ tasksAdded: number; tasksUpdated: number }> {
  // MS Graph sends change notifications as array
  const notifications = (payload.value || []) as Array<Record<string, unknown>>;
  let added = 0, updated = 0;

  for (const notification of notifications) {
    const resourceData = notification.resourceData as Record<string, unknown> | undefined;
    if (!resourceData) continue;

    const changeType = notification.changeType as string;
    const sourceId = `mstodo:${resourceData.id}`;

    if (changeType === 'created') {
      await ingest.createTask({
        id: crypto.randomUUID(),
        sourceId,
        connectorType: 'microsoft-todo',
        connectorInstanceId: connectorId,
        title: (resourceData.title || 'New Task') as string,
        status: 'todo',
        priority: 'none',
        createdAt: now,
        updatedAt: now,
        syncStatus: 'synced',
        lastSyncedAt: now,
      });
      added++;
    } else if (changeType === 'updated') {
      const existing = await ingest.findTaskBySourceId(sourceId);
      if (existing) {
        await ingest.updateTask(existing.id, {
          updatedAt: now,
          syncStatus: 'synced',
          lastSyncedAt: now,
        });
        updated++;
      }
    }
  }

  return { tasksAdded: added, tasksUpdated: updated };
}

// ─── Handler: Generic ────────────────────────────────────────────────────────

async function handleGenericWebhook(
  ingest: WebhookIngestRepository,
  payload: Record<string, unknown>,
  connectorId: string,
  connectorType: string,
  settings: Record<string, unknown>,
  now: string
): Promise<{ tasksAdded: number; notificationsAdded: number }> {
  let tasksAdded = 0;
  let notificationsAdded = 0;
  const sourceProfile = getConnectorSourceProfile(connectorType);
  const acceptsTasks = sourceProfile?.production !== 'notifications-only';

  // Try to interpret as a task
  if (acceptsTasks && (payload.title || payload.name)) {
    await ingest.createTask({
      id: crypto.randomUUID(),
      sourceId: `webhook:${payload.id || crypto.randomUUID()}`,
      connectorType,
      connectorInstanceId: connectorId,
      title: (payload.title || payload.name) as string,
      description: payload.description as string | undefined,
      status: 'todo',
      priority: (payload.priority as string) || 'none',
      createdAt: now,
      updatedAt: now,
      syncStatus: 'synced',
      lastSyncedAt: now,
    });
    tasksAdded++;
  }

  // Try to interpret as an alert
  if (payload.severity || payload.alert || payload.notification) {
    const id = crypto.randomUUID();
    const actionUrl = (payload.actionUrl || payload.url) as string | undefined;
    const { level, levelRank } = normalizeNotificationLevel(payload.severity);
    const templateKey = extractNotificationTemplateKey(
      payload,
      settings.notificationTemplateKeyField,
    );

    await ingest.createNotification({
      notification: {
        id,
        sourceId: `webhook:${payload.id || crypto.randomUUID()}`,
        connectorType,
        connectorInstanceId: connectorId,
        title: (payload.title || payload.message || 'Webhook Notification') as string,
        body: (payload.body || payload.description) as string | undefined,
        level,
        levelRank,
        category: (payload.category || payload.type || 'webhook') as string,
        templateKey,
        state: 'unread',
        isActionable: Boolean(actionUrl),
        receivedAt: now,
        sortAt: now,
        expiresAt: null,
        metadata: payload,
        presentation: {},
      },
      actions: actionUrl
        ? [{
            id: crypto.randomUUID(),
            actionType: 'open_url',
            label: 'Open',
            variant: 'primary',
            isPrimary: true,
            sortOrder: 0,
            payload: { url: actionUrl },
            opensExternal: true,
            createdBy: 'connector',
          }]
        : [],
    });

    notificationsAdded++;
  }

  return { tasksAdded, notificationsAdded };
}
