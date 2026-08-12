import { NextResponse } from 'next/server';
import { getVapidPublicKey } from '@/lib/push';

/** Return the public VAPID key so the client can subscribe */
export async function GET() {
  const key = getVapidPublicKey();
  if (!key) {
    return NextResponse.json(
      { error: 'Push notifications not configured (VAPID_PUBLIC_KEY missing)' },
      { status: 503 }
    );
  }
  return NextResponse.json({ publicKey: key });
}
