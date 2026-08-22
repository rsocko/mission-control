import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('finance connection recovery migration', () => {
  it('persists one durable outage episode per connector with an escalation index', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(
      resolve(process.cwd(), 'drizzle/0112_finance_connection_recovery.sql'),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''));

    const columns = sqlite.prepare('PRAGMA table_info(finance_connection_outages)').all() as
      Array<{ name: string; pk: number }>;
    expect(columns.find((column) => column.name === 'connector_id')?.pk).toBe(1);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'episode_id',
      'started_at',
      'notification_created_at',
      'task_created_at',
      'recovery_sync_succeeded_at',
      'recovered_at',
    ]));
    const indexes = sqlite.prepare('PRAGMA index_list(finance_connection_outages)').all() as
      Array<{ name: string }>;
    expect(indexes.map((index) => index.name))
      .toContain('idx_finance_connection_outages_status');
    sqlite.close();
  });
});
