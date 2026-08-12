import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialId = '83c45840-a47f-4269-aae9-5a3f4fbd220b';
const token = `mc_share_v1.${credentialId}.${'a'.repeat(43)}`;
const rows: Record<string, unknown>[] = [];

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  nativeShareCredentials: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq'),
}));

import {
  authenticateNativeShareCredential,
  hashNativeShareCredential,
} from '@/lib/native/share-capture-auth';

describe('native Share Sheet credential authentication', () => {
  afterEach(() => {
    rows.length = 0;
  });

  it('accepts only the hashed unexpired triage:capture credential', async () => {
    rows.push({
      id: credentialId,
      tokenHash: hashNativeShareCredential(token),
      scope: 'triage:capture',
      expiresAt: '2026-09-01T00:00:00.000Z',
      revokedAt: null,
    });

    await expect(
      authenticateNativeShareCredential(`Bearer ${token}`, new Date('2026-08-01')),
    ).resolves.toEqual({ status: 'authenticated', credentialId });
  });

  it('rejects wrong secrets, revoked credentials, and wrong scopes', async () => {
    rows.push({
      id: credentialId,
      tokenHash: hashNativeShareCredential(token),
      scope: 'triage:capture',
      expiresAt: '2026-09-01T00:00:00.000Z',
      revokedAt: null,
    });
    const wrong = `mc_share_v1.${credentialId}.${'b'.repeat(43)}`;
    await expect(authenticateNativeShareCredential(`Bearer ${wrong}`)).resolves.toEqual({
      status: 'unauthorized',
    });

    rows[0].revokedAt = '2026-08-01T00:00:00.000Z';
    await expect(authenticateNativeShareCredential(`Bearer ${token}`)).resolves.toEqual({
      status: 'unauthorized',
    });

    rows[0].revokedAt = null;
    rows[0].scope = 'push:register';
    await expect(authenticateNativeShareCredential(`Bearer ${token}`)).resolves.toEqual({
      status: 'forbidden',
    });
  });

  it('reports expiration without exposing credential material', async () => {
    rows.push({
      id: credentialId,
      tokenHash: hashNativeShareCredential(token),
      scope: 'triage:capture',
      expiresAt: '2026-07-01T00:00:00.000Z',
      revokedAt: null,
    });

    await expect(
      authenticateNativeShareCredential(`Bearer ${token}`, new Date('2026-08-01')),
    ).resolves.toEqual({ status: 'expired' });
  });
});
