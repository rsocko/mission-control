import Database from 'better-sqlite3';
import { createSqliteTriagePersistenceRepositories } from '@/db/persistence/sqlite-triage-repositories';
import {
  describeTriageNativePersistenceContract,
} from '../contracts/triage-native-persistence.contract';

describeTriageNativePersistenceContract('SQLite', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE native_installation_credentials (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE native_share_credentials (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE native_share_capture_requests (
      credential_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      item_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (credential_id, request_id)
    );
    CREATE TABLE apns_registrations (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      environment TEXT NOT NULL,
      topic TEXT NOT NULL,
      app_version TEXT NOT NULL,
      build_number INTEGER NOT NULL,
      locale TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      invalidated_at TEXT,
      invalidation_reason TEXT,
      UNIQUE (installation_id, environment, topic)
    );
    CREATE TABLE native_push_requests (
      credential_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (credential_id, request_id)
    );
  `);

  return {
    repositories: createSqliteTriagePersistenceRepositories(database),
    seedInstallationCredential: (input: {
      id: string;
      installationId: string;
      tokenHash?: string;
      scopes?: unknown;
      expiresAt?: string;
      revokedAt?: string | null;
    }) => {
      database.prepare(`
        INSERT INTO native_installation_credentials (
          id, installation_id, token_hash, scopes, issued_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.installationId,
        input.tokenHash ?? `installation-token-hash-${input.id}`,
        JSON.stringify(input.scopes ?? ['push:register']),
        '2026-09-01T00:00:00.000Z',
        input.expiresAt ?? '2026-10-01T00:00:00.000Z',
        input.revokedAt ?? null,
      );
    },
    seedShareCredential: (input: {
      id: string;
      installationId: string;
      tokenHash?: string;
      scope?: string;
      expiresAt?: string;
      revokedAt?: string | null;
    }) => {
      database.prepare(`
        INSERT INTO native_share_credentials (
          id, installation_id, token_hash, scope, issued_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.installationId,
        input.tokenHash ?? `share-token-hash-${input.id}`,
        input.scope ?? 'triage:capture',
        '2026-09-01T00:00:00.000Z',
        input.expiresAt ?? '2026-10-01T00:00:00.000Z',
        input.revokedAt ?? null,
      );
    },
    listRegistrations: async () => database.prepare(`
      SELECT
        id,
        installation_id AS installationId,
        token_ciphertext AS tokenCiphertext,
        invalidated_at AS invalidatedAt,
        invalidation_reason AS invalidationReason
      FROM apns_registrations
      ORDER BY created_at, id
    `).all() as Array<Record<string, unknown>>,
    corruptStoredPushResponse: (
      credentialId: string,
      requestId: string,
      value: string,
    ) => {
      database.prepare(`
        UPDATE native_push_requests
        SET response_body = ?
        WHERE credential_id = ? AND request_id = ?
      `).run(JSON.stringify(value), credentialId, requestId);
    },
    close: () => {
      database.close();
    },
  };
});
