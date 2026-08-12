import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub write outcome resolution migration', () => {
  it('adds immutable proof fields and audit storage without rewriting existing leases', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id TEXT PRIMARY KEY);
      CREATE TABLE github_identity_write_cycles (
        id TEXT PRIMARY KEY,
        connector_instance_id TEXT NOT NULL,
        FOREIGN KEY (connector_instance_id) REFERENCES connector_configs(id)
      );
      CREATE TABLE task_source_write_leases (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        task_version TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL,
        write_cycle_id TEXT,
        FOREIGN KEY (connector_instance_id) REFERENCES connector_configs(id),
        FOREIGN KEY (write_cycle_id) REFERENCES github_identity_write_cycles(id)
      );
      INSERT INTO connector_configs VALUES ('github-1');
      INSERT INTO github_identity_write_cycles VALUES ('cycle-1', 'github-1');
      INSERT INTO task_source_write_leases VALUES (
        'lease-1', 'secret-token', 'github-1', 'task-1', 'complete', 'v1',
        'task-1:complete:v1', 'unknown', 'cycle-1'
      );
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0085_github_write_outcome_resolution.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT id, token, task_id AS taskId, state, intent_kind AS intentKind,
        intent_digest AS intentDigest, result_digest AS resultDigest
      FROM task_source_write_leases
      WHERE id = 'lease-1'
    `).get()).toEqual({
      id: 'lease-1',
      token: 'secret-token',
      taskId: 'task-1',
      state: 'unknown',
      intentKind: null,
      intentDigest: null,
      resultDigest: null,
    });

    const validEvent = `
      INSERT INTO github_write_outcome_events (
        id, connector_instance_id, cycle_id, lease_id, task_id, operation,
        task_version, expected_mode_revision, outcome, proof_kind, proof_digest,
        remote_state, actor, reason, idempotency_key, created_at
      ) VALUES (
        'event-1', 'github-1', 'cycle-1', 'lease-1', 'task-1', 'complete',
        'v1', 1, 'proven_applied', 'issue_state',
        '${'a'.repeat(64)}', 'closed', 'operator', 'Authoritative issue readback',
        'resolve-cycle-1-lease-1', '2026-08-10T00:00:00Z'
      )
    `;
    sqlite.exec(validEvent);
    expect(sqlite.prepare(`
      SELECT outcome, proof_kind AS proofKind, remote_state AS remoteState
      FROM github_write_outcome_events
    `).get()).toEqual({
      outcome: 'proven_applied',
      proofKind: 'issue_state',
      remoteState: 'closed',
    });
    expect(() => sqlite.exec(validEvent.replace("'event-1'", "'event-2'"))).toThrow();
    expect(() => sqlite.exec(validEvent
      .replace("'event-1'", "'event-invalid'")
      .replace("'closed'", "'asserted_success'"))).toThrow();
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE|DROP)\s/mi);
    sqlite.close();
  });
});
