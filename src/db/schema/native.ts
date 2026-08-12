import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const nativeInstallationCredentials = sqliteTable('native_installation_credentials', {
  id: text('id').primaryKey(),
  installationId: text('installation_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes', { mode: 'json' }).notNull(),
  issuedAt: text('issued_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('native_installation_credentials_installation_idx').on(table.installationId),
]);

export const nativeShareCredentials = sqliteTable('native_share_credentials', {
  id: text('id').primaryKey(),
  installationId: text('installation_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: text('scope').notNull(),
  issuedAt: text('issued_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('native_share_credentials_installation_idx').on(table.installationId),
]);

export const nativeShareCaptureRequests = sqliteTable('native_share_capture_requests', {
  credentialId: text('credential_id').notNull(),
  requestId: text('request_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  reservationId: text('reservation_id').notNull(),
  itemId: text('item_id'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  primaryKey({ columns: [table.credentialId, table.requestId] }),
  index('native_share_capture_requests_created_idx').on(table.createdAt),
]);

export const apnsRegistrations = sqliteTable('apns_registrations', {
  id: text('id').primaryKey(),
  installationId: text('installation_id').notNull(),
  tokenCiphertext: text('token_ciphertext').notNull(),
  tokenHash: text('token_hash').notNull(),
  environment: text('environment').notNull(),
  topic: text('topic').notNull(),
  appVersion: text('app_version').notNull(),
  buildNumber: integer('build_number').notNull(),
  locale: text('locale').notNull(),
  timeZone: text('time_zone').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  invalidatedAt: text('invalidated_at'),
  invalidationReason: text('invalidation_reason'),
}, (table) => [
  uniqueIndex('apns_registrations_installation_target_idx')
    .on(table.installationId, table.environment, table.topic),
  index('apns_registrations_token_target_idx')
    .on(table.tokenHash, table.environment, table.topic),
  index('apns_registrations_active_idx')
    .on(table.environment, table.topic, table.invalidatedAt),
  index('apns_registrations_installation_idx').on(table.installationId),
]);

export const nativePushRequests = sqliteTable('native_push_requests', {
  credentialId: text('credential_id').notNull(),
  requestId: text('request_id').notNull(),
  operation: text('operation').notNull(),
  payloadHash: text('payload_hash').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: text('response_body', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.credentialId, table.requestId] }),
  index('native_push_requests_created_idx').on(table.createdAt),
]);
