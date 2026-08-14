import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  configureDatabaseConnection,
  DEFAULT_DATABASE_BUSY_TIMEOUT_MS,
  resolveDatabaseBusyTimeout,
} from '@/db/bootstrap/connection';
import { createOrderedBootstrapSteps } from '@/db/bootstrap/registry';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('database bootstrap modules', () => {
  it('configures initializer PRAGMAs in order with a positive timeout', () => {
    process.env.MC_PROCESS_ROLE = 'web';
    process.env.MC_DATABASE_INITIALIZER_ROLE = 'web';
    process.env.MC_DB_BUSY_TIMEOUT_MS = '2750';
    const pragmas: string[] = [];
    const sqlite = {
      pragma(statement: string) {
        pragmas.push(statement);
      },
    } as Database.Database;

    configureDatabaseConnection(sqlite);

    expect(pragmas).toEqual([
      'journal_mode = WAL',
      'foreign_keys = ON',
      'busy_timeout = 2750',
    ]);
  });

  it('omits WAL for workers and defaults invalid timeouts', () => {
    process.env.MC_PROCESS_ROLE = 'worker';
    process.env.MC_DATABASE_INITIALIZER_ROLE = 'web';
    process.env.MC_DB_BUSY_TIMEOUT_MS = '0';
    const pragmas: string[] = [];
    const sqlite = {
      pragma(statement: string) {
        pragmas.push(statement);
      },
    } as Database.Database;

    configureDatabaseConnection(sqlite);

    expect(pragmas).toEqual([
      'foreign_keys = ON',
      `busy_timeout = ${DEFAULT_DATABASE_BUSY_TIMEOUT_MS}`,
    ]);
    expect(resolveDatabaseBusyTimeout('12.5')).toBe(DEFAULT_DATABASE_BUSY_TIMEOUT_MS);
  });

  it('publishes the deterministic migration, safety-net, and repair order', () => {
    expect(createOrderedBootstrapSteps('drizzle').map((step) => step.id)).toEqual([
      'migrations',
      'task-sync-tables',
      'repair-task-linked-source-duplicates',
      'task-linked-source-identity',
      'backfill-task-field-states',
      'list-group-table',
      'triage-tables',
      'productivity-tables',
      'project-hierarchy-tables',
      'inbound-webhook-safety-nets',
      'reset-safety-nets',
      'notification-safety-nets',
      'core-query-indexes',
      'tag-unification-column',
      'secondary-query-indexes',
      'connector-config-soft-delete',
      'connector-source-list-columns',
      'hub-project-columns',
      'task-safety-nets',
      'backfill-tasks-last-synced-at',
      'alert-columns',
      'subtask-template-columns',
      'connector-sync-log-columns',
      'project-phase-columns',
      'triage-columns',
      'task-activity-safety-nets',
      'notification-delivery-safety-nets',
      'sync-deletion-safety-nets',
      'repair-inbound-webhook-actions',
    ]);
  });
});
