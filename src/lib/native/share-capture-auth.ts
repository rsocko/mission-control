import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import db from '@/db';
import { nativeShareCredentials } from '@/db/schema';
import { safeEqual } from '@/lib/api/trusted-request';

const nativeShareTokenPattern =
  /^mc_share_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43,128})$/i;

export type NativeShareAuthentication =
  | { status: 'authenticated'; credentialId: string }
  | { status: 'unauthorized' | 'expired' | 'forbidden' };

export function hashNativeShareCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function authenticateNativeShareCredential(
  authorization: string | null,
  now: Date = new Date(),
): Promise<NativeShareAuthentication> {
  if (!authorization?.startsWith('Bearer ')) {
    return { status: 'unauthorized' };
  }

  const token = authorization.slice('Bearer '.length).trim();
  const match = nativeShareTokenPattern.exec(token);
  if (!match) {
    return { status: 'unauthorized' };
  }

  const credentialId = match[1].toLowerCase();
  const [credential] = await db
    .select()
    .from(nativeShareCredentials)
    .where(eq(nativeShareCredentials.id, credentialId))
    .limit(1);
  if (!credential || credential.revokedAt) {
    return { status: 'unauthorized' };
  }
  if (credential.scope !== 'triage:capture') {
    return { status: 'forbidden' };
  }
  if (Date.parse(credential.expiresAt) <= now.getTime()) {
    return { status: 'expired' };
  }

  const actualHash = hashNativeShareCredential(token);
  if (!safeEqual(actualHash, credential.tokenHash)) {
    return { status: 'unauthorized' };
  }
  return { status: 'authenticated', credentialId };
}
