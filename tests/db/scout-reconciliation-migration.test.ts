import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Scout reconciliation migration', () => {
  it('records the durable reconciliation tables in Drizzle metadata', () => {
    const snapshot = JSON.parse(
      readFileSync(resolve(process.cwd(), 'drizzle/meta/0050_snapshot.json'), 'utf8'),
    ) as { tables: Record<string, unknown> };

    expect(snapshot.tables).toMatchObject({
      scout_reconciliation_runs: expect.any(Object),
      scout_reconciliation_evaluations: expect.any(Object),
      scout_reconciliation_suggestions: expect.any(Object),
      scout_reconciliation_task_state: expect.any(Object),
    });
  });

  it('enforces one active scope and one pending suggestion per task', () => {
    const sqlite = new Database(':memory:');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0050_square_stepford_cuckoos.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO scout_reconciliation_runs (
        id, scope_key, scope_type, lookback_hours, dry_run, source, source_identity,
        idempotency_key, request_hash, lease_token, status, started_at
      ) VALUES (?, 'all', 'all', 48, 0, 'api', 'test', ?, ?, ?, 'running', '2026-08-05')
    `).run('run-1', 'idempotency-1', 'request-1', 'lease-1');
    expect(() => sqlite.prepare(`
      INSERT INTO scout_reconciliation_runs (
        id, scope_key, scope_type, lookback_hours, dry_run, source, source_identity,
        idempotency_key, request_hash, lease_token, status, started_at
      ) VALUES (?, 'all', 'all', 48, 0, 'api', 'test', ?, ?, ?, 'running', '2026-08-05')
    `).run('run-2', 'idempotency-2', 'request-2', 'lease-2')).toThrow();

    sqlite.prepare(`
      INSERT INTO scout_reconciliation_evaluations (
        id, run_id, task_id, candidate_action, action, confidence, evidence_hash,
        evidence, policy_decision, policy_reason, payload_hash, applied, created_at
      ) VALUES ('eval-1', 'run-1', 'task-1', 'suggest-complete', 'suggest-complete',
        0.8, 'evidence', '[]', 'require-confirmation', 'confirm', 'payload', 0, '2026-08-05')
    `).run();
    const insertSuggestion = sqlite.prepare(`
      INSERT INTO scout_reconciliation_suggestions (
        id, task_id, run_id, evaluation_id, action, status, confidence, evidence_hash,
        evidence, policy_decision, policy_reason, payload_hash, proposed_effect,
        created_at, updated_at, expires_at
      ) VALUES (?, 'task-1', 'run-1', 'eval-1', 'suggest-complete', 'pending', 0.8,
        'evidence', '[]', 'require-confirmation', 'confirm', 'payload', '{}',
        '2026-08-05', '2026-08-05', '2026-08-19')
    `);
    insertSuggestion.run('suggestion-1');
    expect(() => insertSuggestion.run('suggestion-2')).toThrow();
    sqlite.close();
  });
});
