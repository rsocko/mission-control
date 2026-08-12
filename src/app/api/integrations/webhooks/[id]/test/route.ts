import db from '@/db';
import { outboundWebhooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sendWebhookEvent } from '@/lib/events';
import type { MCEvent } from '@/lib/events';
import { ApiErrors } from '@/lib/api-error';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const [webhook] = await db
      .select()
      .from(outboundWebhooks)
      .where(eq(outboundWebhooks.id, id))
      .limit(1);

    if (!webhook) {
      return Response.json({ error: 'Webhook not found' }, { status: 404 });
    }

    const testEvent: MCEvent = {
      type: 'sync.completed',
      timestamp: new Date().toISOString(),
      payload: {
        message: 'Mission Control test event',
        webhookId: webhook.id,
        webhookName: webhook.name,
      },
    };

    const result = await sendWebhookEvent(webhook, testEvent);

    return Response.json({
      success: result.ok,
      status: result.status,
    }, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return ApiErrors.internal('Failed to send test event', error);
  }
}
