import { createHash, createHmac, timingSafeEqual } from 'crypto';
import db, { sqlite } from '@/db';
import { inboundWebhooks, inboundWebhookLog, tasks, notificationActions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { normalizeNotificationUrl } from '@/lib/notifications/providers';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
} from '@/lib/notifications';
import { getExternalAgent } from '@/lib/external-agents/registry';
import {
  getDispatch,
  submitDispatchResult,
  type DispatchResultInput,
} from '@/lib/external-agents/service';
import { isExternalAgentError } from '@/lib/external-agents/errors';
import { redactForPersistence } from '@/lib/external-agents/policy';
import {
  getRateLimitClientKey,
  InMemoryRateLimiter,
  rateLimitHeaders,
  type RateLimitPolicy,
} from '@/lib/api/rate-limit';
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from '@/lib/api/bounded-body';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const REPLAY_WINDOW_MS = 5 * 60 * 1_000;
const WEBHOOK_RATE_POLICY: RateLimitPolicy = {
  name: 'inbound-webhook-id',
  limit: 60,
  windowMs: 60_000,
};
const SOURCE_BURST_POLICY: RateLimitPolicy = {
  name: 'inbound-webhook-source',
  limit: 20,
  windowMs: 10_000,
};
const webhookRateLimiter = new InMemoryRateLimiter();
let replayCleanupCounter = 0;
const lastLogCompaction = new Map<string, number>();

/**
 * POST /api/inbound-webhooks/[id]/receive
 *
 * Public endpoint for external system pushes. Any system (n8n, IFTTT, Home Assistant,
 * iOS Shortcuts, custom scripts) can POST a JSON payload here to create tasks or alerts
 * in Mission Control.
 *
 * Authentication: Optional HMAC-SHA256 via X-Webhook-Signature header.
 * Payload: Flexible JSON — fields are extracted using configurable field mappings
 * or sensible defaults (title, description, status, priority, severity, etc.).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const now = new Date().toISOString();

  // Load webhook config
  const [webhook] = await db
    .select()
    .from(inboundWebhooks)
    .where(eq(inboundWebhooks.id, id))
    .limit(1);

  if (!webhook) {
    return Response.json({ error: 'Unknown webhook endpoint' }, { status: 404 });
  }

  if (!webhook.enabled) {
    await logReceive(id, 'auth_failed', 403, null, null, 'Webhook is disabled', null, now);
    return Response.json({ error: 'Webhook endpoint is disabled' }, { status: 403 });
  }

  if (
    !webhook.secret
    && process.env.NODE_ENV === 'production'
    && process.env.MC_ALLOW_UNSIGNED_INBOUND_WEBHOOKS !== 'true'
  ) {
    logger.warn({ webhookId: id }, 'Rejected unsigned production webhook');
    return Response.json(
      { error: 'Webhook verification secret is required' },
      { status: 403 },
    );
  }

  const sourceKey = getRateLimitClientKey(request);
  for (const [key, policy] of [
    [id, WEBHOOK_RATE_POLICY],
    [`${id}:${sourceKey}`, SOURCE_BURST_POLICY],
  ] as const) {
    const result = webhookRateLimiter.check(key, policy);
    if (!result.allowed) {
      logger.warn({ webhookId: id, sourceKey, policy: policy.name }, 'Inbound webhook rate limited');
      return Response.json(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        {
          status: 429,
          headers: {
            ...rateLimitHeaders(result),
            'Retry-After': String(result.retryAfterSeconds),
          },
        },
      );
    }
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await readBoundedRequestBody(request, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      logger.warn({ webhookId: id, maxBytes: error.maxBytes }, 'Rejected oversized inbound webhook');
      return Response.json(
        { error: 'Webhook payload is too large', maxBytes: error.maxBytes },
        { status: 413 },
      );
    }
    await logReceive(id, 'parse_error', 400, null, null, 'Failed to read request body', null, now);
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  // Verify HMAC signature if secret is configured
  if (webhook.secret) {
    const signature = request.headers.get('x-webhook-signature')
      || request.headers.get('x-hub-signature-256')
      || request.headers.get('x-mc-signature');

    if (!signature) {
      await logReceive(id, 'auth_failed', 401, null, null, 'Missing signature header', safePayloadPreview(rawBody), now);
      return Response.json({ error: 'Missing signature' }, { status: 401 });
    }

    const expected = createHmac('sha256', webhook.secret).update(rawBytes).digest();
    const suppliedHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const supplied = /^[a-f0-9]{64}$/i.test(suppliedHex)
      ? Buffer.from(suppliedHex, 'hex')
      : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      await logReceive(id, 'auth_failed', 401, null, null, 'Signature verification failed', safePayloadPreview(rawBody), now);
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  // Parse JSON payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload must be a JSON object');
    }
  } catch (parseError) {
    await logReceive(id, 'parse_error', 400, null, null, `Invalid JSON: ${parseError}`, safePayloadPreview(rawBody), now);
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const deliveryKey = getDeliveryKey(rawBytes);
  if (!claimWebhookDelivery(id, deliveryKey, now)) {
    logger.info({ webhookId: id, deliveryKey }, 'Ignored duplicate inbound webhook');
    return Response.json({ success: true, duplicate: true }, { status: 200 });
  }

  const mappings = (webhook.fieldMappings || {}) as Record<string, string>;
  let sideEffectCommitted = false;

  try {
    if (payload.type === 'agent-result') {
      const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId : '';
      if (!dispatchId) {
        releaseWebhookDelivery(id, deliveryKey);
        await logReceive(
          id,
          'parse_error',
          422,
          'agent-result',
          null,
          'Agent result requires dispatchId',
          null,
          now,
        );
        return ApiErrors.validation('Agent result requires dispatchId');
      }
      const dispatch = await getDispatch(dispatchId);
      const agent = dispatch ? await getExternalAgent(dispatch.externalAgentId) : null;
      if (
        !dispatch
        || !agent
        || !agent.enabled
        || agent.deletedAt
        || agent.inboundWebhookId !== id
      ) {
        releaseWebhookDelivery(id, deliveryKey);
        await logReceive(
          id,
          'auth_failed',
          404,
          'agent-result',
          null,
          'Dispatch is not associated with this webhook',
          null,
          now,
        );
        return ApiErrors.notFound('Agent dispatch');
      }
      if (!webhook.secret) {
        await logReceive(
          id,
          'auth_failed',
          403,
          'agent-result',
          dispatchId,
          'Agent result webhook requires HMAC authentication',
          null,
          now,
        );
        return ApiErrors.forbidden('Agent result webhook requires HMAC authentication');
      }
      const resultPayload = { ...payload };
      delete resultPayload.type;
      delete resultPayload.dispatchId;
      const result = submitDispatchResult(
        dispatchId,
        resultPayload as DispatchResultInput,
        { agentAuthenticated: true },
      );
      sideEffectCommitted = true;
      await db.update(inboundWebhooks).set({
        totalReceived: sql`${inboundWebhooks.totalReceived} + 1`,
        lastReceivedAt: now,
        lastStatus: result.duplicate ? 200 : 202,
        updatedAt: now,
      }).where(eq(inboundWebhooks.id, id));
      await logReceive(
        id,
        'success',
        result.duplicate ? 200 : 202,
        'agent-result',
        dispatchId,
        null,
        truncate(JSON.stringify(redactForPersistence(resultPayload))),
        now,
      );
      return Response.json(result, { status: result.duplicate ? 200 : 202 });
    }

    // Determine what to create
    const action = resolveAction(webhook.defaultAction, payload, mappings);
    let createdId: string;
    let createdType: string;

    if (action === 'task') {
      createdId = crypto.randomUUID();
      createdType = 'task';

      await db.insert(tasks).values({
        id: createdId,
        sourceId: `inbound:${webhook.id}:${createdId}`,
        connectorType: 'inbound-webhook',
        connectorInstanceId: webhook.id,
        title: extractString(payload, mappings.title, ['title', 'name', 'subject', 'summary']) || 'Webhook Task',
        description: extractString(payload, mappings.description, ['description', 'body', 'text', 'content', 'message']) || null,
        status: extractString(payload, mappings.status, ['status']) || 'todo',
        priority: extractString(payload, mappings.priority, ['priority']) || 'none',
        dueDate: extractString(payload, mappings.dueDate, ['dueDate', 'due_date', 'due', 'deadline']) || null,
        createdAt: now,
        updatedAt: now,
        depth: 0,
        isChecklistItem: false,
        sourceListId: null,
        sourceListName: webhook.sourceLabel,
        assignee: extractString(payload, mappings.assignee, ['assignee', 'assigned_to']) || null,
        metadata: { webhookId: webhook.id, webhookName: webhook.name, originalPayload: payload },
        syncStatus: 'synced',
        lastSyncedAt: now,
      });
      sideEffectCommitted = true;
    } else {
      createdId = crypto.randomUUID();
      createdType = 'alert';

      const severity = extractString(payload, mappings.severity, ['severity', 'level', 'priority']) || 'info';
      const { level } = normalizeNotificationLevel(severity);
      const templateKey = extractString(
        payload,
        mappings.templateKey,
        ['templateKey', 'template_key'],
      );
      const rawActionUrl = extractString(payload, mappings.actionUrl, ['actionUrl', 'action_url', 'url', 'link']);
      const actionUrl = normalizeNotificationUrl(rawActionUrl);
      if (rawActionUrl && !actionUrl) {
        releaseWebhookDelivery(id, deliveryKey);
        await db.update(inboundWebhooks).set({
          totalReceived: sql`${inboundWebhooks.totalReceived} + 1`,
          lastReceivedAt: now,
          lastStatus: 400,
          updatedAt: now,
        }).where(eq(inboundWebhooks.id, id));
        await logReceive(
          id,
          'parse_error',
          400,
          null,
          null,
          'Action URL must use http or https',
          safePayloadPreview(rawBody),
          now,
        );
        return Response.json({ error: 'Action URL must use http or https' }, { status: 400 });
      }
      const actionId = actionUrl ? crypto.randomUUID() : null;

      const creationResult = db.transaction((tx) => {
        const [result] = createNotificationsInTransaction(tx, [{
          id: createdId,
          sourceId: `inbound:${webhook.id}:${createdId}`,
          connectorType: 'inbound-webhook',
          connectorInstanceId: webhook.id,
          title: extractString(payload, mappings.title, ['title', 'name', 'subject', 'summary', 'message']) || 'Webhook Alert',
          body: extractString(payload, mappings.body, ['body', 'description', 'text', 'content', 'message']) || null,
          level,
          category: extractString(payload, mappings.category, ['category', 'type', 'source']) || webhook.sourceLabel,
          templateKey,
          state: 'unread',
          isActionable: Boolean(actionId),
          primaryActionId: actionId,
          receivedAt: now,
          sortAt: now,
          expiresAt: extractString(payload, mappings.expiresAt, ['expiresAt', 'expires_at', 'expiry']) || null,
          metadata: { webhookId: webhook.id, webhookName: webhook.name, originalPayload: payload },
          presentation: {},
        }]);

        if (result.created && actionUrl && actionId) {
          tx.insert(notificationActions).values({
            id: actionId,
            notificationId: createdId,
            actionType: 'open_url',
            label: `Open ${webhook.sourceLabel}`,
            icon: 'external-link',
            variant: 'primary',
            isPrimary: true,
            sortOrder: 0,
            payload: { url: actionUrl },
            opensExternal: true,
            createdBy: 'connector',
          }).run();
        }
        return result;
      });
      sideEffectCommitted = true;
      if (creationResult.deliveryEvent?.status === 'pending') {
        wakeNotificationDeliveryDispatcher();
      }
    }

    // Update webhook stats
    await db.update(inboundWebhooks).set({
      totalReceived: sql`${inboundWebhooks.totalReceived} + 1`,
      lastReceivedAt: now,
      lastStatus: 201,
      updatedAt: now,
    }).where(eq(inboundWebhooks.id, id));

    await logReceive(id, 'success', 201, createdType, createdId, null, safePayloadPreview(rawBody), now);

    return Response.json({
      success: true,
      created: createdType,
      id: createdId,
    }, { status: 201 });
  } catch (error) {
    if (!sideEffectCommitted) releaseWebhookDelivery(id, deliveryKey);
    // Update stats even on error
    await db.update(inboundWebhooks).set({
      totalReceived: sql`${inboundWebhooks.totalReceived} + 1`,
      lastReceivedAt: now,
      lastStatus: 500,
      updatedAt: now,
    }).where(eq(inboundWebhooks.id, id)).catch((err) => {
      logger.error({ err, webhookId: id }, 'Failed to update webhook stats after error');
    });

    await logReceive(id, 'error', 500, null, null, `${error}`, safePayloadPreview(rawBody), now);

    if (isExternalAgentError(error)) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return ApiErrors.internal('Processing failed', error);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Determine whether to create a task or alert based on config and payload heuristics */
function resolveAction(
  defaultAction: string,
  payload: Record<string, unknown>,
  mappings: Record<string, string>,
): 'task' | 'alert' {
  if (defaultAction === 'task') return 'task';
  if (defaultAction === 'alert') return 'alert';

  // Auto-detect: if payload has severity/alert/notification fields, treat as alert
  const alertIndicators = ['severity', 'level', 'alert', 'notification', 'alarm'];
  const hasAlertSignal = alertIndicators.some((key) => key in payload);

  // If payload explicitly specifies type
  const payloadType = extractString(payload, mappings.type, ['type', 'action', 'kind']);
  if (payloadType === 'alert' || payloadType === 'notification') return 'alert';
  if (payloadType === 'task' || payloadType === 'todo') return 'task';

  return hasAlertSignal ? 'alert' : 'task';
}

/**
 * Extract a string value from the payload using:
 * 1. A configured mapping path (e.g. "data.attributes.title")
 * 2. A list of fallback top-level keys
 */
function extractString(
  payload: Record<string, unknown>,
  mappingPath: string | undefined,
  fallbackKeys: string[],
): string | undefined {
  // Try configured mapping path first
  if (mappingPath) {
    const value = getNestedValue(payload, mappingPath);
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }

  // Try fallback keys
  for (const key of fallbackKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }

  return undefined;
}

/** Navigate a dot-separated path into a nested object */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/** Truncate a string to 2KB for log storage */
function truncate(str: string, maxLen = 2048): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function safePayloadPreview(rawBody: string) {
  try {
    return truncate(JSON.stringify(redactForPersistence(JSON.parse(rawBody))));
  } catch {
    return '[unparseable payload omitted]';
  }
}

/** Write an entry to the inbound webhook log */
async function logReceive(
  webhookId: string,
  status: string,
  httpStatus: number,
  createdType: string | null,
  createdId: string | null,
  errorMessage: string | null,
  payloadPreview: string | null,
  receivedAt: string,
) {
  try {
    await db.insert(inboundWebhookLog).values({
      id: crypto.randomUUID(),
      webhookId,
      status,
      httpStatus,
      createdType,
      createdId,
      errorMessage,
      payloadPreview,
      receivedAt,
    });
    compactWebhookLogs(webhookId);
  } catch (error) {
    logger.warn({ err: error, webhookId }, 'Failed to persist inbound webhook log');
  }
}

function getDeliveryKey(rawBytes: Uint8Array): string {
  return `payload:${createHash('sha256').update(rawBytes).digest('hex')}`;
}

function claimWebhookDelivery(webhookId: string, deliveryKey: string, receivedAt: string): boolean {
  replayCleanupCounter++;
  if (replayCleanupCounter % 100 === 1) {
    sqlite.prepare('DELETE FROM inbound_webhook_replays WHERE expires_at <= ?').run(receivedAt);
  }
  sqlite.prepare(`
    DELETE FROM inbound_webhook_replays
    WHERE webhook_id = ? AND delivery_key = ? AND expires_at <= ?
  `).run(webhookId, deliveryKey, receivedAt);
  const expiresAt = new Date(Date.parse(receivedAt) + REPLAY_WINDOW_MS).toISOString();
  const result = sqlite.prepare(`
    INSERT OR IGNORE INTO inbound_webhook_replays (
      id, webhook_id, delivery_key, received_at, expires_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), webhookId, deliveryKey, receivedAt, expiresAt);
  return result.changes === 1;
}

function releaseWebhookDelivery(webhookId: string, deliveryKey: string): void {
  sqlite.prepare(`
    DELETE FROM inbound_webhook_replays
    WHERE webhook_id = ? AND delivery_key = ?
  `).run(webhookId, deliveryKey);
}

function compactWebhookLogs(webhookId: string): void {
  const now = Date.now();
  const lastCompactedAt = lastLogCompaction.get(webhookId) ?? 0;
  if (now - lastCompactedAt < 60 * 60 * 1_000) return;
  lastLogCompaction.set(webhookId, now);
  const retentionThreshold = new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString();
  sqlite.prepare(`
    DELETE FROM inbound_webhook_log
    WHERE webhook_id = ? AND received_at < ?
  `).run(webhookId, retentionThreshold);
  sqlite.prepare(`
    DELETE FROM inbound_webhook_log
    WHERE webhook_id = ?
      AND id NOT IN (
        SELECT id FROM inbound_webhook_log
        WHERE webhook_id = ?
        ORDER BY received_at DESC
        LIMIT 1000
      )
  `).run(webhookId, webhookId);
}
