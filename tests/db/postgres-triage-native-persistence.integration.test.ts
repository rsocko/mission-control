import { describe, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { createPostgresTriagePersistenceRepositories } from '@/db/postgres/repositories/triage-repositories';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  describeTriageNativePersistenceContract,
} from '../contracts/triage-native-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL triage native persistence integration', () => {
  describeTriageNativePersistenceContract('PostgreSQL', async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-triage-native-persistence-test',
      }),
    });
    await backend.initialize();
    return {
      repositories: createPostgresTriagePersistenceRepositories(backend.context.db),
      seedInstallationCredential: async (input) => {
        await backend.context.pool.query(`
          INSERT INTO native_installation_credentials (
            id, installation_id, token_hash, scopes, issued_at, expires_at, revoked_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
        `, [
          input.id,
          input.installationId,
          input.tokenHash ?? `installation-token-hash-${input.id}`,
          JSON.stringify(input.scopes ?? ['push:register']),
          '2026-09-01T00:00:00.000Z',
          input.expiresAt ?? '2026-10-01T00:00:00.000Z',
          input.revokedAt ?? null,
        ]);
      },
      seedShareCredential: async (input) => {
        await backend.context.pool.query(`
          INSERT INTO native_share_credentials (
            id, installation_id, token_hash, scope, issued_at, expires_at, revoked_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          input.id,
          input.installationId,
          input.tokenHash ?? `share-token-hash-${input.id}`,
          input.scope ?? 'triage:capture',
          '2026-09-01T00:00:00.000Z',
          input.expiresAt ?? '2026-10-01T00:00:00.000Z',
          input.revokedAt ?? null,
        ]);
      },
      listRegistrations: async () => {
        const { rows } = await backend.context.pool.query<Record<string, unknown>>(`
          SELECT
            id,
            installation_id AS "installationId",
            token_ciphertext AS "tokenCiphertext",
            invalidated_at AS "invalidatedAt",
            invalidation_reason AS "invalidationReason"
          FROM apns_registrations
          WHERE installation_id LIKE 'native-contract-%'
          ORDER BY created_at, id
        `);
        return rows;
      },
      corruptStoredPushResponse: async (
        credentialId: string,
        requestId: string,
        value: string,
      ) => {
        await backend.context.pool.query(`
          UPDATE native_push_requests
          SET response_body = to_jsonb($1::text)
          WHERE credential_id = $2 AND request_id = $3
        `, [value, credentialId, requestId]);
      },
      close: async () => {
        await backend.context.pool.query(
          `DELETE FROM native_push_requests WHERE credential_id LIKE 'native-contract-%'`,
        );
        await backend.context.pool.query(
          `DELETE FROM native_share_capture_requests
           WHERE credential_id LIKE 'native-contract-%'`,
        );
        await backend.context.pool.query(
          `DELETE FROM apns_registrations WHERE installation_id LIKE 'native-contract-%'`,
        );
        await backend.context.pool.query(
          `DELETE FROM native_share_credentials WHERE installation_id LIKE 'native-contract-%'`,
        );
        await backend.context.pool.query(
          `DELETE FROM native_installation_credentials
           WHERE installation_id LIKE 'native-contract-%'`,
        );
        await backend.shutdown();
      },
    };
  });
});
