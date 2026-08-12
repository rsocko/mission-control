import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('durable AI runs migration', () => {
  it('creates run, event, and protected provider-session tables', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0055_far_daredevil.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO ai_runs (
        id, idempotency_key, request_fingerprint, feature_id, sensitivity,
        status, execution_route, fallback_state, correlation_id, available_at,
        timeout_at, created_at, updated_at, expires_at
      ) VALUES (
        'run-1', 'feature:request-1', 'fingerprint', 'test-feature', 'standard',
        'queued', 'test-route', 'not_requested', 'correlation-1', '2026-08-06',
        '2026-08-07', '2026-08-06', '2026-08-06', '2026-09-06'
      )
    `).run();
    expect(() => sqlite.prepare(`
      INSERT INTO ai_runs (
        id, idempotency_key, request_fingerprint, feature_id, sensitivity,
        status, execution_route, fallback_state, correlation_id, available_at,
        timeout_at, created_at, updated_at, expires_at
      ) VALUES (
        'run-2', 'feature:request-1', 'other', 'test-feature', 'standard',
        'queued', 'test-route', 'not_requested', 'correlation-2', '2026-08-06',
        '2026-08-07', '2026-08-06', '2026-08-06', '2026-09-06'
      )
    `).run()).toThrow();

    sqlite.prepare(`
      INSERT INTO ai_run_events (
        event_id, run_id, sequence, idempotency_key, kind, payload, created_at
      ) VALUES (
        'event-1', 'run-1', 1, 'run:queued', 'run.queued', '{}', '2026-08-06'
      )
    `).run();
    sqlite.prepare(`
      INSERT INTO ai_provider_sessions (
        run_id, provider, encrypted_reference, initialization_vector, auth_tag,
        key_version, state, expires_at, created_at, updated_at
      ) VALUES (
        'run-1', 'provider', 'ciphertext', 'iv', 'tag', 'v1', 'active',
        '2026-08-07', '2026-08-06', '2026-08-06'
      )
    `).run();

    sqlite.prepare(`DELETE FROM ai_runs WHERE id = 'run-1'`).run();
    expect(sqlite.prepare('SELECT count(*) AS count FROM ai_run_events').get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT count(*) AS count FROM ai_provider_sessions').get())
      .toEqual({ count: 0 });
    sqlite.close();
  });
});
