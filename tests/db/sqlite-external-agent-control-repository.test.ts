import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  externalAgentControlRepositoryContract,
  type ExternalAgentControlContractSeed,
} from '../contracts/external-agent-control-repository.contract';
import type { ExternalAgentControlPersistence } from '@/db/persistence/external-agent-control';

vi.unmock('@/db');
process.env.MC_DB_PATH = ':memory:';

describe('SQLite external-agent control adapter', () => {
  let sqlite: Database.Database;
  let repository: ExternalAgentControlPersistence;
  let contractSeed: ExternalAgentControlContractSeed;

  beforeAll(async () => {
    const database = await import('@/db');
    const { createSqliteExternalAgentControlRepository } = await import(
      '@/db/persistence/sqlite-external-agent-control-repository'
    );
    sqlite = database.sqlite;
    sqlite.prepare('SELECT 1').get();
    repository = createSqliteExternalAgentControlRepository(sqlite);
    contractSeed = {
      async reset() {
        sqlite.exec(`
          DELETE FROM agent_dispatch_events;
          DELETE FROM agent_dispatch_attempts;
          DELETE FROM agent_dispatches;
          DELETE FROM external_agents;
          DELETE FROM inbound_webhooks;
          DELETE FROM tasks;
        `);
      },
      async protectedWebhook(id) {
        sqlite.prepare(`
          INSERT INTO inbound_webhooks (
            id, name, source_label, secret, enabled, default_action,
            field_mappings, total_received, created_at, updated_at
          ) VALUES (?, 'Contract callback', 'agent', 'secret', 1, 'auto', '{}', 0, ?, ?)
        `).run(id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      },
      async richTask() {
        sqlite.exec(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, effort, assignee, source_list_name,
            created_at, updated_at, last_synced_at
          ) VALUES (
            'contract-task', 'octo/example:1', 'github-issues', 'github',
            'Contract parent', 'Parent details', 'todo', 'high', '2026-02-01',
            3, 'octocat', 'octo/example',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title,
            status, priority, parent_id, sibling_order, depth, is_checklist_item,
            created_at, updated_at, last_synced_at
          ) VALUES
            (
              'contract-child-b', 'contract-child-b', 'local', 'local',
              'Second child', 'todo', 'medium', 'contract-task', 2, 1, 0,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z'
            ),
            (
              'contract-child-a', 'contract-child-a', 'local', 'local',
              'First child', 'todo', 'medium', 'contract-task', 1, 1, 1,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z'
            );
        `);
      },
    };
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  externalAgentControlRepositoryContract(
    'SQLite',
    () => repository,
    () => contractSeed,
  );
});
