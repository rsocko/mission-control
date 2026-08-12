import { NextResponse } from 'next/server';
import { generateTriageDigest, sendDigestWebhook } from '@/lib/triage/digest';
import logger from '@/lib/logger';

/**
 * POST /api/triage/digest/send
 *
 * Generates a digest and sends it via configured delivery channel (webhook).
 * Body: { period: 'daily' | 'weekly' }
 *
 * The webhook URL is read from MC_DIGEST_WEBHOOK_URL env var.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { period?: string };
    const period = body.period === 'weekly' ? 'weekly' : 'daily';

    const digest = await generateTriageDigest(period);
    const delivery = await sendDigestWebhook(digest);

    return NextResponse.json({
      digest,
      delivery,
    });
  } catch (error) {
    logger.error({ err: error }, 'Digest send failed');
    return NextResponse.json({ error: 'Failed to send digest' }, { status: 500 });
  }
}
