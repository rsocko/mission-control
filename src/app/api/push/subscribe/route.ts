import { NextResponse } from 'next/server';
import db from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/** Known legitimate push service domain patterns */
const ALLOWED_PUSH_DOMAINS = [
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  '.push.apple.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];

/** Validate that a push endpoint URL belongs to a known push service */
function isValidPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    // Must be HTTPS
    if (url.protocol !== 'https:') return false;
    // Must match a known push service domain
    return ALLOWED_PUSH_DOMAINS.some(
      (domain) =>
        domain.startsWith('.')
          ? url.hostname.endsWith(domain) || url.hostname === domain.slice(1)
          : url.hostname === domain
    );
  } catch {
    return false;
  }
}

/** Register or update a push subscription */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { endpoint, keys } = body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { error: 'endpoint and keys (p256dh, auth) are required' },
        { status: 400 }
      );
    }

    // Validate endpoint is a legitimate push service URL (prevent SSRF)
    if (!isValidPushEndpoint(endpoint)) {
      return NextResponse.json(
        { error: 'Invalid push endpoint' },
        { status: 400 }
      );
    }

    // Check if this endpoint is already registered
    const existing = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ id: existing[0].id, status: 'already_registered' });
    }

    const id = randomUUID();
    await db.insert(pushSubscriptions).values({
      id,
      platform: 'web',
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgent: request.headers.get('user-agent') || undefined,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ id, status: 'subscribed' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to register subscription' }, { status: 500 });
  }
}

/** Unsubscribe — remove a push subscription by endpoint */
export async function DELETE(request: Request) {
  try {
    const { endpoint } = await request.json();
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
    }

    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return NextResponse.json({ status: 'unsubscribed' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
