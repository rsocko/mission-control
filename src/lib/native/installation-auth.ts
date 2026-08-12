import 'server-only';

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import db from '@/db';
import { nativeInstallationCredentials } from '@/db/schema';
import { safeEqual } from '@/lib/api/trusted-request';

const installationTokenPattern =
  /^mc_install_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43,128})$/i;

export type InstallationCredentialScope =
  | 'push:register'
  | 'push:unregister'
  | 'credentials:rotate'
  | 'credentials:revoke';

export type NativeInstallationAuthentication =
  | {
    status: 'authenticated';
    credentialId: string;
    installationId: string;
    scopes: InstallationCredentialScope[];
  }
  | { status: 'unauthorized' | 'expired' | 'forbidden' };

export function hashNativeInstallationCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseScopes(value: unknown): InstallationCredentialScope[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<InstallationCredentialScope>([
    'push:register',
    'push:unregister',
    'credentials:rotate',
    'credentials:revoke',
  ]);
  return value.filter(
    (scope): scope is InstallationCredentialScope =>
      typeof scope === 'string' && allowed.has(scope as InstallationCredentialScope),
  );
}

export async function authenticateNativeInstallationCredential(
  authorization: string | null,
  requiredScope: InstallationCredentialScope,
  now: Date = new Date(),
): Promise<NativeInstallationAuthentication> {
  if (!authorization?.startsWith('Bearer ')) return { status: 'unauthorized' };
  const token = authorization.slice('Bearer '.length).trim();
  const match = installationTokenPattern.exec(token);
  if (!match) return { status: 'unauthorized' };

  const credentialId = match[1].toLowerCase();
  const credential = db.select().from(nativeInstallationCredentials).where(
    eq(nativeInstallationCredentials.id, credentialId),
  ).get();
  if (!credential || credential.revokedAt) return { status: 'unauthorized' };
  if (Date.parse(credential.expiresAt) <= now.getTime()) return { status: 'expired' };
  if (!safeEqual(hashNativeInstallationCredential(token), credential.tokenHash)) {
    return { status: 'unauthorized' };
  }

  const scopes = parseScopes(credential.scopes);
  if (!scopes.includes(requiredScope)) return { status: 'forbidden' };
  return {
    status: 'authenticated',
    credentialId,
    installationId: credential.installationId,
    scopes,
  };
}
