import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { createPostgresTriagePersistenceRepositories } from '@/db/postgres/repositories/triage-repositories';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import {
  clearTriagePersistenceRepositories,
  registerTriagePersistenceRepositories,
} from '@/lib/triage/persistence';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());
vi.mock('@/db', () => {
  sqliteTouch();
  throw new Error('SQLite must not load in PostgreSQL native routes');
});

process.env.APNS_TEAM_ID = 'ABCDEFGHIJ';
process.env.APNS_KEY_ID = 'KLMNOPQRST';
process.env.APNS_TOPIC = 'com.example.missioncontrol';
process.env.APNS_ENVIRONMENT = 'production';
process.env.APNS_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APNS_PRIVATE_KEY_P8_BASE64 = Buffer.from(
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }),
).toString('base64');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const installationId = randomUUID();
const installationCredentialId = randomUUID();
const shareCredentialId = randomUUID();
const installationToken = `mc_install_v1.${installationCredentialId}.${'a'.repeat(43)}`;
const shareToken = `mc_share_v1.${shareCredentialId}.${'b'.repeat(43)}`;
const shareRequestId = randomUUID();
const registrationRequestId = randomUUID();
const unregistrationRequestId = randomUUID();
const reregistrationRequestId = randomUUID();
const logoutRequestId = randomUUID();
const deviceToken = 'ab'.repeat(32);

let backend: PostgresPersistenceBackend;
let repositories: TriagePersistenceRepositories;
let registrationId: string;

function request(url: string, method: string, token: string, requestId: string, body: unknown) {
  return new Request(url, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'idempotency-key': requestId,
    },
    body: JSON.stringify(body),
  });
}

describePostgres('PostgreSQL native route parity', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-native-route-parity-test',
      }),
    });
    await backend.initialize();
    repositories = createPostgresTriagePersistenceRepositories(backend.context.db);
    registerTriagePersistenceRepositories(repositories);
    await backend.context.pool.query(`
      INSERT INTO native_installation_credentials (
        id, installation_id, token_hash, scopes, issued_at, expires_at, revoked_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, NULL)
    `, [
      installationCredentialId,
      installationId,
      createHash('sha256').update(installationToken, 'utf8').digest('hex'),
      JSON.stringify([
        'push:register',
        'push:unregister',
        'credentials:rotate',
        'credentials:revoke',
      ]),
      '2026-09-01T00:00:00.000Z',
      '2027-09-01T00:00:00.000Z',
    ]);
    await backend.context.pool.query(`
      INSERT INTO native_share_credentials (
        id, installation_id, token_hash, scope, issued_at, expires_at, revoked_at
      ) VALUES ($1, $2, $3, 'triage:capture', $4, $5, NULL)
    `, [
      shareCredentialId,
      installationId,
      createHash('sha256').update(shareToken, 'utf8').digest('hex'),
      '2026-09-01T00:00:00.000Z',
      '2027-09-01T00:00:00.000Z',
    ]);
  }, 30_000);

  afterAll(async () => {
    if (!backend) return;
    await backend.context.pool.query(
      `DELETE FROM native_push_requests WHERE credential_id = $1`,
      [installationCredentialId],
    );
    await backend.context.pool.query(
      `DELETE FROM native_share_capture_requests WHERE credential_id = $1`,
      [shareCredentialId],
    );
    await backend.context.pool.query(
      `DELETE FROM triage_items WHERE source_id = $1`,
      [`ios_share:${shareRequestId}`],
    );
    await backend.context.pool.query(
      `DELETE FROM apns_registrations WHERE installation_id = $1`,
      [installationId],
    );
    await backend.context.pool.query(
      `DELETE FROM native_share_credentials WHERE id = $1`,
      [shareCredentialId],
    );
    await backend.context.pool.query(
      `DELETE FROM native_installation_credentials WHERE id = $1`,
      [installationCredentialId],
    );
    clearTriagePersistenceRepositories(repositories);
    await backend.shutdown();
  });

  it('captures Share Sheet text without evaluating SQLite', async () => {
    const body = {
      version: 1,
      requestId: shareRequestId,
      client: 'ios',
      contentType: 'text',
      text: 'Portable native capture',
    };
    const { POST } = await import('@/app/api/triage/capture/route');
    const response = await POST(request(
      'http://localhost/api/triage/capture',
      'POST',
      shareToken,
      shareRequestId,
      body,
    ));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { status: 'created' },
    });
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('registers, replays, unregisters, and logs out without evaluating SQLite', async () => {
    const registrationBody = {
      version: 1,
      requestId: registrationRequestId,
      installationId,
      deviceToken,
      environment: 'production',
      topic: 'com.example.missioncontrol',
      appVersion: '1.0.0',
      buildNumber: 42,
      locale: 'en-US',
      timeZone: 'America/New_York',
    };
    const { POST: register } = await import('@/app/api/native/push/registrations/route');
    const first = await register(request(
      'http://localhost/api/native/push/registrations',
      'POST',
      installationToken,
      registrationRequestId,
      registrationBody,
    ));
    const firstBody = await first.json();
    registrationId = firstBody.data.registrationId as string;
    const replay = await register(request(
      'http://localhost/api/native/push/registrations',
      'POST',
      installationToken,
      registrationRequestId,
      registrationBody,
    ));
    expect(await replay.json()).toEqual(firstBody);

    const unregisterBody = {
      version: 1,
      requestId: unregistrationRequestId,
      installationId,
      registrationId,
    };
    const { DELETE: unregister } = await import(
      '@/app/api/native/push/registrations/[registrationId]/route'
    );
    const retired = await unregister(
      request(
        `http://localhost/api/native/push/registrations/${registrationId}`,
        'DELETE',
        installationToken,
        unregistrationRequestId,
        unregisterBody,
      ),
      { params: Promise.resolve({ registrationId }) },
    );
    expect(retired.status).toBe(200);

    const reregistrationBody = {
      ...registrationBody,
      requestId: reregistrationRequestId,
    };
    expect((await register(request(
      'http://localhost/api/native/push/registrations',
      'POST',
      installationToken,
      reregistrationRequestId,
      reregistrationBody,
    ))).status).toBe(200);

    const logoutBody = {
      version: 1,
      requestId: logoutRequestId,
      installationId,
    };
    const { POST: logout } = await import('@/app/api/native/logout/route');
    const loggedOut = await logout(request(
      'http://localhost/api/native/logout',
      'POST',
      installationToken,
      logoutRequestId,
      logoutBody,
    ));
    expect(await loggedOut.json()).toMatchObject({
      ok: true,
      data: { credentialsRevoked: 2, registrationsRetired: 1 },
    });
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
