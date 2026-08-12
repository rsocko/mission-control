import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('GitHub task transfer reconciliation migration', () => {
  it('creates append-only identity and idempotency constraints', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id text PRIMARY KEY NOT NULL);
      CREATE TABLE external_entities (id text PRIMARY KEY NOT NULL);
      INSERT INTO connector_configs (id) VALUES ('connector');
      INSERT INTO external_entities (id) VALUES ('source-entity'), ('successor-entity');
    `);
    for (const statement of readFileSync(
      resolve(process.cwd(), 'drizzle/0096_yellow_dark_phoenix.sql'),
      'utf8',
    ).split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const insert = sqlite.prepare(`
      INSERT INTO github_identity_task_transfer_reconciliations (
        id, connector_instance_id, source_task_id, successor_task_id,
        source_external_entity_id, successor_external_entity_id,
        expected_mode_revision, proof_kind, proof, proof_digest,
        observed_at, actor, reason, idempotency_key, created_at
      ) VALUES (?, 'connector', ?, ?, 'source-entity', 'successor-entity',
        4, 'rest_historical_redirect', '{}', ?,
        '2026-08-11T16:00:00.000Z', 'operator', 'Authoritative redirect proof', ?,
        '2026-08-11T16:00:00.000Z')
    `);
    insert.run('proof-1', 'source-task', 'successor-task', 'a'.repeat(64), 'proof-key-1');

    expect(() => insert.run(
      'proof-2',
      'source-task',
      'other-successor',
      'b'.repeat(64),
      'proof-key-2',
    )).toThrow();
    expect(() => insert.run(
      'proof-3',
      'same-task',
      'same-task',
      'c'.repeat(64),
      'proof-key-3',
    )).toThrow();
    expect(sqlite.prepare(`
      SELECT source_task_id AS sourceTaskId, successor_task_id AS successorTaskId
      FROM github_identity_task_transfer_reconciliations
    `).all()).toEqual([{
      sourceTaskId: 'source-task',
      successorTaskId: 'successor-task',
    }]);
    sqlite.close();
  });
});
