import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('notification enrichment migration', () => {
  it('adds the revision fence and durable leased queue', () => {
    const sqlite = new Database(':memory:');
    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
      const notificationColumns = sqlite.prepare(
        'PRAGMA table_info(notifications)',
      ).all() as Array<{ name: string }>;
      expect(notificationColumns.map(({ name }) => name)).toContain('enrichment_revision');
      expect(notificationColumns.map(({ name }) => name)).toContain('enrichment_generation');

      const columns = sqlite.prepare(
        'PRAGMA table_info(notification_enrichment_jobs)',
      ).all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual([
        'id',
        'notification_id',
        'source_id',
        'source_revision',
        'source_generation',
        'payload',
        'status',
        'attempt_count',
        'next_attempt_at',
        'lease_owner',
        'lease_token',
        'lease_expires_at',
        'last_error',
        'created_at',
        'updated_at',
        'completed_at',
      ]);
      const indexes = sqlite.prepare(
        'PRAGMA index_list(notification_enrichment_jobs)',
      ).all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_notification_enrichment_generation', unique: 1 }),
        expect.objectContaining({ name: 'idx_notification_enrichment_claim', unique: 0 }),
        expect.objectContaining({ name: 'idx_notification_enrichment_lease', unique: 0 }),
      ]));
    } finally {
      sqlite.close();
    }
  });
});
