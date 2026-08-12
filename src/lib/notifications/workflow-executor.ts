/**
 * Workflow Execution — handles the `run_workflow` notification action type.
 * 
 * Triggers outbound webhooks or n8n workflows based on the action payload.
 */

import db from '@/db';
import { outboundWebhooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

export interface WorkflowExecutionResult {
  success: boolean;
  workflowId?: string;
  response?: unknown;
  error?: string;
}

/** Block requests to private/internal network ranges */
function isInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    // Block link-local (AWS metadata etc.)
    if (hostname.startsWith('169.254.')) return true;
    // Block private IPv4 ranges
    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    // Block .local, .internal TLDs
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
    return false;
  } catch {
    return true; // Invalid URLs are blocked
  }
}

/**
 * Execute a workflow by ID, passing notification context as payload.
 */
export async function executeWorkflow(
  workflowId: string,
  params: Record<string, unknown>,
  notificationContext: {
    notificationId: string;
    title: string;
    body?: string | null;
    connectorType: string;
    category: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }
): Promise<WorkflowExecutionResult> {
  try {
    // Look up the webhook/workflow endpoint
    const [webhook] = await db.select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.id, workflowId))
      .limit(1);

    if (!webhook) {
      // Try treating workflowId as a direct URL (for n8n webhook URLs)
      if (workflowId.startsWith('http')) {
        if (isInternalUrl(workflowId)) {
          return { success: false, error: 'Cannot call internal/private URLs' };
        }
        return await callWebhook(workflowId, params, notificationContext);
      }
      return { success: false, error: `Workflow not found: ${workflowId}` };
    }

    const url = webhook.url;
    if (!url) {
      return { success: false, error: 'Webhook has no URL configured' };
    }

    return await callWebhook(url, params, notificationContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, workflowId }, 'Workflow execution failed');
    return { success: false, error: message };
  }
}

async function callWebhook(
  url: string,
  params: Record<string, unknown>,
  context: {
    notificationId: string;
    title: string;
    body?: string | null;
    connectorType: string;
    category: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }
): Promise<WorkflowExecutionResult> {
  const payload = {
    trigger: 'notification_action',
    notification: {
      id: context.notificationId,
      title: context.title,
      body: context.body,
      connectorType: context.connectorType,
      category: context.category,
      metadata: context.metadata,
    },
    params,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mission-Control-Event': 'notification.action',
      'Idempotency-Key': context.idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      success: false,
      error: `Webhook returned ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  const data = await response.json().catch(() => ({}));
  return { success: true, workflowId: url, response: data };
}
