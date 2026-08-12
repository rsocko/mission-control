import { NextResponse } from 'next/server';
import { generateTriageDigest } from '@/lib/triage/digest';
import logger from '@/lib/logger';

/**
 * POST /api/triage/digest
 *
 * Generates and returns a triage digest for display in the UI.
 * Body: { period: 'daily' | 'weekly' }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { period?: string };
    const period = body.period === 'weekly' ? 'weekly' : 'daily';

    const digest = await generateTriageDigest(period);
    return NextResponse.json(digest);
  } catch (error) {
    logger.error({ err: error }, 'Digest generation failed');
    return NextResponse.json({ error: 'Failed to generate digest' }, { status: 500 });
  }
}

/**
 * GET /api/triage/digest?period=daily
 *
 * Generates and returns a triage digest (convenience for GET requests).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get('period') === 'weekly' ? 'weekly' : 'daily';

    const digest = await generateTriageDigest(period);
    return NextResponse.json(digest);
  } catch (error) {
    logger.error({ err: error }, 'Digest generation failed');
    return NextResponse.json({ error: 'Failed to generate digest' }, { status: 500 });
  }
}
