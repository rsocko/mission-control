import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  NativeApnsRegistrationStoredResponse,
  TriagePersistenceRepositories,
} from '@/db/persistence/triage-repositories';

export interface NativePersistenceHarness {
  repositories: TriagePersistenceRepositories;
  seedInstallationCredential(input: {
    id: string;
    installationId: string;
    tokenHash?: string;
    scopes?: unknown;
    expiresAt?: string;
    revokedAt?: string | null;
  }): Promise<void> | void;
  seedShareCredential(input: {
    id: string;
    installationId: string;
    tokenHash?: string;
    scope?: string;
    expiresAt?: string;
    revokedAt?: string | null;
  }): Promise<void> | void;
  listRegistrations(): Promise<Array<Record<string, unknown>>>;
  corruptStoredPushResponse(
    credentialId: string,
    requestId: string,
    value: string,
  ): Promise<void> | void;
  close(): Promise<void> | void;
}

const now = '2026-09-04T12:00:00.000Z';
const retentionCutoff = '2026-09-03T12:00:00.000Z';
const rateWindowStart = '2026-09-04T11:59:00.000Z';

function randomUUID(): string {
  return `native-contract-${nodeRandomUUID()}`;
}

function shareClaim(
  credentialId: string,
  requestId: string,
  payloadHash: string,
  overrides: Partial<{
    reservationId: string;
    now: string;
    retentionCutoff: string;
    rateWindowStart: string;
    maximumCaptures: number;
  }> = {},
) {
  return {
    credentialId,
    requestId,
    payloadHash,
    reservationId: overrides.reservationId ?? randomUUID(),
    now: overrides.now ?? now,
    retentionCutoff: overrides.retentionCutoff ?? retentionCutoff,
    rateWindowStart: overrides.rateWindowStart ?? rateWindowStart,
    maximumCaptures: overrides.maximumCaptures ?? 30,
  };
}

function registrationInput(
  credentialId: string,
  installationId: string,
  overrides: Partial<{
    requestId: string;
    payloadHash: string;
    legacyPayloadHash: string;
    registrationId: string;
    tokenCiphertext: string;
    tokenHash: string;
    environment: string;
    topic: string;
    now: string;
  }> = {},
) {
  return {
    credentialId,
    requestId: overrides.requestId ?? randomUUID(),
    payloadHash: overrides.payloadHash ?? randomUUID(),
    legacyPayloadHash: overrides.legacyPayloadHash ?? randomUUID(),
    registrationId: overrides.registrationId ?? randomUUID(),
    installationId,
    tokenCiphertext: overrides.tokenCiphertext ?? 'encrypted-device-token',
    tokenHash: overrides.tokenHash ?? 'device-token-hash',
    environment: overrides.environment ?? 'production',
    topic: overrides.topic ?? 'com.example.missioncontrol',
    appVersion: '1.0.0',
    buildNumber: 42,
    locale: 'en-US',
    timeZone: 'America/New_York',
    now: overrides.now ?? now,
  };
}

export function describeTriageNativePersistenceContract(
  name: string,
  createHarness: () => NativePersistenceHarness | Promise<NativePersistenceHarness>,
): void {
  describe(`${name} triage native persistence contract`, () => {
    let harness: NativePersistenceHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('returns bounded credential records, null misses, and parsed scope JSON', async () => {
      const installationId = randomUUID();
      const installationCredentialId = randomUUID();
      const shareCredentialId = randomUUID();
      await harness.seedInstallationCredential({
        id: installationCredentialId,
        installationId,
        tokenHash: 'installation-token-hash',
        scopes: ['push:register', { ignored: true }],
      });
      await harness.seedShareCredential({
        id: shareCredentialId,
        installationId,
        tokenHash: 'share-token-hash',
      });

      await expect(
        harness.repositories.native.credentials.findInstallationCredential(
          installationCredentialId,
        ),
      ).resolves.toEqual({
        id: installationCredentialId,
        installationId,
        tokenHash: 'installation-token-hash',
        scopes: ['push:register', { ignored: true }],
        expiresAt: '2026-10-01T00:00:00.000Z',
        revokedAt: null,
      });
      await expect(
        harness.repositories.native.credentials.findShareCredential(shareCredentialId),
      ).resolves.toEqual({
        id: shareCredentialId,
        tokenHash: 'share-token-hash',
        scope: 'triage:capture',
        expiresAt: '2026-10-01T00:00:00.000Z',
        revokedAt: null,
      });
      await expect(
        harness.repositories.native.credentials.findInstallationCredential(randomUUID()),
      ).resolves.toBeNull();
      await expect(
        harness.repositories.native.credentials.findShareCredential(randomUUID()),
      ).resolves.toBeNull();
    });

    it('fences share completion and release by reservation and payload ownership', async () => {
      const credentialId = randomUUID();
      const requestId = randomUUID();
      const claim = shareClaim(credentialId, requestId, 'payload-a');

      await expect(harness.repositories.native.shareCapture.claim(claim)).resolves.toEqual({
        status: 'acquired',
        reservationId: claim.reservationId,
      });
      await expect(
        harness.repositories.native.shareCapture.claim({
          ...claim,
          reservationId: randomUUID(),
        }),
      ).resolves.toEqual({ status: 'pending' });
      await expect(
        harness.repositories.native.shareCapture.claim({
          ...claim,
          payloadHash: 'payload-b',
          reservationId: randomUUID(),
        }),
      ).resolves.toEqual({ status: 'replay' });
      await expect(harness.repositories.native.shareCapture.complete({
        credentialId,
        requestId,
        reservationId: randomUUID(),
        payloadHash: 'payload-a',
        itemId: 'item-a',
        completedAt: now,
      })).resolves.toBe(false);
      await expect(harness.repositories.native.shareCapture.release({
        credentialId,
        requestId,
        reservationId: randomUUID(),
      })).resolves.toBe(false);
      await expect(harness.repositories.native.shareCapture.complete({
        credentialId,
        requestId,
        reservationId: claim.reservationId,
        payloadHash: 'payload-a',
        itemId: 'item-a',
        completedAt: now,
      })).resolves.toBe(true);
      await expect(harness.repositories.native.shareCapture.release({
        credentialId,
        requestId,
        reservationId: claim.reservationId,
      })).resolves.toBe(false);
      await expect(
        harness.repositories.native.shareCapture.claim({
          ...claim,
          reservationId: randomUUID(),
        }),
      ).resolves.toEqual({ status: 'duplicate', itemId: 'item-a' });
    });

    it('enforces exactly thirty captures per credential and prunes expired claims', async () => {
      const credentialId = randomUUID();
      for (let index = 0; index < 30; index += 1) {
        await expect(harness.repositories.native.shareCapture.claim(
          shareClaim(credentialId, randomUUID(), `payload-${index}`),
        )).resolves.toMatchObject({ status: 'acquired' });
      }
      await expect(harness.repositories.native.shareCapture.claim(
        shareClaim(credentialId, randomUUID(), 'payload-31'),
      )).resolves.toEqual({ status: 'rateLimited' });
      await expect(harness.repositories.native.shareCapture.claim(
        shareClaim(randomUUID(), randomUUID(), 'other-credential'),
      )).resolves.toMatchObject({ status: 'acquired' });

      const oldRequestId = randomUUID();
      const oldClaim = shareClaim(randomUUID(), oldRequestId, 'old-payload', {
        now: '2026-09-02T11:59:59.999Z',
        retentionCutoff: '2026-09-01T11:59:59.999Z',
        rateWindowStart: '2026-09-02T11:58:59.999Z',
      });
      await harness.repositories.native.shareCapture.claim(oldClaim);
      await expect(harness.repositories.native.shareCapture.claim(
        shareClaim(oldClaim.credentialId, oldRequestId, 'new-payload'),
      )).resolves.toMatchObject({ status: 'acquired' });
    });

    it('serializes racing share claims to one owner', async () => {
      const credentialId = randomUUID();
      const requestId = randomUUID();
      const outcomes = await Promise.all([
        harness.repositories.native.shareCapture.claim(
          shareClaim(credentialId, requestId, 'payload', { reservationId: randomUUID() }),
        ),
        harness.repositories.native.shareCapture.claim(
          shareClaim(credentialId, requestId, 'payload', { reservationId: randomUUID() }),
        ),
      ]);
      expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['acquired', 'pending']);
    });

    it('replays APNs outcomes, rejects mismatches, rotates targets, and retires reassigned tokens', async () => {
      const credentialId = randomUUID();
      const installationId = randomUUID();
      await harness.seedInstallationCredential({ id: credentialId, installationId });
      const first = registrationInput(credentialId, installationId);
      const applied = await harness.repositories.native.apns.register(first);
      expect(applied).toMatchObject({
        status: 'applied',
        response: {
          responseStatus: 201,
          responseBody: {
            kind: 'registration',
            registrationId: first.registrationId,
            state: 'registered',
          },
        },
      });
      await expect(harness.repositories.native.apns.register({
        ...first,
        registrationId: randomUUID(),
        now: '2026-09-04T12:00:01.000Z',
      })).resolves.toEqual({
        status: 'replay',
        response: (applied as { response: unknown }).response,
      });
      await expect(harness.repositories.native.apns.register({
        ...first,
        payloadHash: 'different-content',
      })).resolves.toEqual({ status: 'mismatch' });

      const rotated = registrationInput(credentialId, installationId, {
        tokenHash: 'rotated-token-hash',
        tokenCiphertext: 'rotated-encrypted-token',
        now: '2026-09-04T12:00:02.000Z',
      });
      await expect(harness.repositories.native.apns.register(rotated)).resolves.toMatchObject({
        status: 'applied',
        response: {
          responseStatus: 200,
          responseBody: {
            registrationId: first.registrationId,
            state: 'rotated',
          },
        },
      });

      const replacementInstallation = randomUUID();
      const replacementCredential = randomUUID();
      await harness.seedInstallationCredential({
        id: replacementCredential,
        installationId: replacementInstallation,
      });
      const reassigned = registrationInput(replacementCredential, replacementInstallation, {
        tokenHash: rotated.tokenHash,
        tokenCiphertext: 'replacement-encrypted-token',
        now: '2026-09-04T12:00:03.000Z',
      });
      await harness.repositories.native.apns.register(reassigned);
      const rows = await harness.listRegistrations();
      expect(rows.find(row => row.installationId === installationId)).toMatchObject({
        invalidationReason: 'token_reassigned',
      });
      expect(rows.find(row => row.installationId === replacementInstallation)).toMatchObject({
        tokenCiphertext: 'replacement-encrypted-token',
        invalidatedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain('device-token-plaintext');
    });

    it('rotates installation targets and unregisters only owned registrations idempotently', async () => {
      const credentialId = randomUUID();
      const installationId = randomUUID();
      await harness.seedInstallationCredential({ id: credentialId, installationId });
      const first = registrationInput(credentialId, installationId);
      await harness.repositories.native.apns.register(first);
      const targetRotation = registrationInput(credentialId, installationId, {
        environment: 'sandbox',
        topic: 'com.example.missioncontrol.beta',
        now: '2026-09-04T12:00:01.000Z',
      });
      await harness.repositories.native.apns.register(targetRotation);
      expect(await harness.listRegistrations()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: first.registrationId,
          invalidationReason: 'target_changed',
        }),
        expect.objectContaining({
          id: targetRotation.registrationId,
          invalidatedAt: null,
        }),
      ]));

      const unregister = {
        credentialId,
        requestId: randomUUID(),
        payloadHash: 'unregister-payload',
        legacyPayloadHash: 'legacy-unregister-payload',
        registrationId: targetRotation.registrationId,
        installationId,
        now: '2026-09-04T12:00:02.000Z',
      };
      await expect(harness.repositories.native.apns.unregister({
        ...unregister,
        installationId: randomUUID(),
      })).resolves.toEqual({ status: 'notOwned' });
      const retired = await harness.repositories.native.apns.unregister(unregister);
      expect(retired).toMatchObject({
        status: 'applied',
        response: {
          responseBody: {
            kind: 'unregistration',
            registrationId: targetRotation.registrationId,
          },
        },
      });
      await expect(harness.repositories.native.apns.unregister({
        ...unregister,
        now: '2026-09-04T12:00:03.000Z',
      })).resolves.toEqual({
        status: 'replay',
        response: (retired as { response: unknown }).response,
      });
    });

    it('returns malformed stored APNs JSON as data for service-owned validation', async () => {
      const credentialId = randomUUID();
      const installationId = randomUUID();
      await harness.seedInstallationCredential({ id: credentialId, installationId });
      const input = registrationInput(credentialId, installationId);
      await harness.repositories.native.apns.register(input);
      await harness.corruptStoredPushResponse(
        credentialId,
        input.requestId,
        'not-valid-stored-json',
      );

      await expect(harness.repositories.native.apns.register(input)).resolves.toEqual({
        status: 'replay',
        response: {
          responseStatus: 201,
          responseBody: 'not-valid-stored-json',
        },
      });
    });

    it('atomically revokes both credential kinds and retires active registrations with exact counts', async () => {
      const installationId = randomUUID();
      const credentialId = randomUUID();
      await harness.seedInstallationCredential({ id: credentialId, installationId });
      await harness.seedInstallationCredential({
        id: randomUUID(),
        installationId,
        revokedAt: '2026-09-04T11:00:00.000Z',
      });
      await harness.seedShareCredential({ id: randomUUID(), installationId });
      await harness.seedShareCredential({
        id: randomUUID(),
        installationId,
        revokedAt: '2026-09-04T11:00:00.000Z',
      });
      const registration = registrationInput(credentialId, installationId);
      await harness.repositories.native.apns.register(registration);
      const result = await harness.repositories.native.apns.logout({
        installationId,
        now,
      });

      expect(result).toEqual({ credentialsRevoked: 2, registrationsRetired: 1 });
      await expect(harness.repositories.native.apns.logout({
        installationId,
        now: '2026-09-04T12:00:01.000Z',
      })).resolves.toEqual({ credentialsRevoked: 0, registrationsRetired: 0 });
      expect(await harness.listRegistrations()).toEqual([
        expect.objectContaining({ invalidationReason: 'logout' }),
      ]);
      const replay = await harness.repositories.native.apns.register(registration);
      expect((replay as {
        response: { responseBody: NativeApnsRegistrationStoredResponse };
      }).response.responseBody.registrationId).toBe(registration.registrationId);
      await expect(harness.repositories.native.apns.register(registrationInput(
        credentialId,
        installationId,
      ))).resolves.toEqual({ status: 'credentialRevoked' });
    });
  });
}
