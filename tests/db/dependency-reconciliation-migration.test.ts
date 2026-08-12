import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('dependency reconciliation migration', () => {
  it('creates durable generations, source items, staged edges, and active-run protection', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0045_checkpoint_dependency_reconciliation.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_snapshots
        (id, connector_instance_id, status, total, batch_size, started_at, updated_at)
      VALUES
        ('generation-1', 'github-1', 'running', 2, 1, '2026-08-03', '2026-08-03')
    `).run();
    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_items
        (snapshot_id, position, source_id)
      VALUES
        ('generation-1', 0, 'acme/app:1'),
        ('generation-1', 1, 'acme/app:2')
    `).run();
    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_edges
        (snapshot_id, blocker_source_id, blocked_source_id)
      VALUES
        ('generation-1', 'acme/app:1', 'acme/app:2')
    `).run();
    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_candidates
        (snapshot_id, dependency_id)
      VALUES
        ('generation-1', 'dependency-1')
    `).run();

    expect(() => sqlite.prepare(`
      INSERT INTO dependency_reconciliation_snapshots
        (id, connector_instance_id, status, total, batch_size, started_at, updated_at)
      VALUES
        ('generation-2', 'github-1', 'failed', 2, 1, '2026-08-04', '2026-08-04')
    `).run()).toThrow();
    const snapshotIndexes = sqlite.prepare(`
      PRAGMA index_list('dependency_reconciliation_snapshots')
    `).all() as Array<{ name: string }>;
    expect(snapshotIndexes.map(({ name }) => name)).toContain(
      'idx_dependency_snapshot_connector_status_completed',
    );
    expect(sqlite.prepare(`
      SELECT cursor, failure_count, imported_count, removed_count
      FROM dependency_reconciliation_snapshots
      WHERE id = 'generation-1'
    `).get()).toEqual({
      cursor: 0,
      failure_count: 0,
      imported_count: 0,
      removed_count: 0,
    });

    sqlite.prepare(`
      DELETE FROM dependency_reconciliation_snapshots WHERE id = 'generation-1'
    `).run();
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM dependency_reconciliation_items
    `).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM dependency_reconciliation_edges
    `).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM dependency_reconciliation_candidates
    `).get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it('adds persistent resume attempt observability', () => {
    const sqlite = new Database(':memory:');
    const checkpointMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0045_checkpoint_dependency_reconciliation.sql'),
      'utf8',
    );
    const observabilityMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0069_dependency_resume_observability.sql'),
      'utf8',
    );
    for (const migration of [checkpointMigration, observabilityMigration]) {
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }

    const columns = sqlite.prepare(`
      PRAGMA table_info('dependency_reconciliation_snapshots')
    `).all() as Array<{ name: string }>;

    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'last_resume_attempt_at',
      'last_resume_outcome',
      'last_resume_reason',
    ]));
    sqlite.close();
  });

  it('adds streamed collection phase and dependency read mode telemetry', () => {
    const sqlite = new Database(':memory:');
    const checkpointMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0045_checkpoint_dependency_reconciliation.sql'),
      'utf8',
    );
    const streamMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0071_dependency_stream_generations.sql'),
      'utf8',
    );
    for (const statement of checkpointMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_snapshots
        (id, connector_instance_id, status, total, batch_size, started_at, updated_at)
      VALUES
        ('legacy-active', 'github-legacy', 'running', 2, 25, '2026-08-08', '2026-08-08')
    `).run();
    for (const statement of streamMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_snapshots
        (id, connector_instance_id, status, phase, read_mode, total, batch_size,
         started_at, updated_at, collection_completed_at)
      VALUES
        ('generation-stream', 'github-1', 'running', 'ready', 'graphql-bulk',
         2, 25, '2026-08-09', '2026-08-09', '2026-08-09')
    `).run();

    expect(sqlite.prepare(`
      SELECT phase, read_mode, collection_completed_at
      FROM dependency_reconciliation_snapshots
      WHERE id = 'generation-stream'
    `).get()).toEqual({
      phase: 'ready',
      read_mode: 'graphql-bulk',
      collection_completed_at: '2026-08-09',
    });
    expect(sqlite.prepare(`
      SELECT phase, read_mode
      FROM dependency_reconciliation_snapshots
      WHERE id = 'legacy-active'
    `).get()).toEqual({
      phase: 'reconciling',
      read_mode: 'legacy',
    });
    sqlite.close();
  });

  it('adds relationship collection page and overflow telemetry', () => {
    const sqlite = new Database(':memory:');
    for (const migrationPath of [
      'drizzle/0045_checkpoint_dependency_reconciliation.sql',
      'drizzle/0072_dependency_poll_telemetry.sql',
    ]) {
      const migration = readFileSync(resolve(process.cwd(), migrationPath), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }

    const columns = sqlite.prepare(`
      PRAGMA table_info('dependency_reconciliation_snapshots')
    `).all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'collection_page_count',
      'overflow_fetch_count',
    ]));
    expect(sqlite.prepare(`
      SELECT collection_page_count, overflow_fetch_count
      FROM dependency_reconciliation_snapshots
      LIMIT 1
    `).get()).toBeUndefined();
    sqlite.close();
  });

  it('adds frozen dependency identity context and endpoint evidence without rewriting generations', () => {
    const sqlite = new Database(':memory:');
    for (const migrationPath of [
      'drizzle/0045_checkpoint_dependency_reconciliation.sql',
      'drizzle/0071_dependency_stream_generations.sql',
      'drizzle/0072_dependency_poll_telemetry.sql',
    ]) {
      const migration = readFileSync(resolve(process.cwd(), migrationPath), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }
    sqlite.prepare(`
      INSERT INTO dependency_reconciliation_snapshots
        (id, connector_instance_id, status, phase, read_mode, total, batch_size,
         started_at, updated_at)
      VALUES
        ('existing-generation', 'github-1', 'running', 'ready', 'graphql-bulk',
         1, 25, '2026-08-09', '2026-08-09')
    `).run();
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0075_yielding_professor_monster.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT
        identity_mode AS identityMode,
        identity_mode_revision AS identityModeRevision,
        identity_evidence_source AS identityEvidenceSource,
        identity_evidence_eligible AS identityEvidenceEligible
      FROM dependency_reconciliation_snapshots
      WHERE id = 'existing-generation'
    `).get()).toEqual({
      identityMode: 'legacy',
      identityModeRevision: 0,
      identityEvidenceSource: 'legacy-unavailable',
      identityEvidenceEligible: 0,
    });
    expect(sqlite.prepare(`
      PRAGMA table_info('dependency_reconciliation_items')
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'identity_evidence' }),
      expect.objectContaining({ name: 'identity_evidence_state' }),
    ]));
    expect(sqlite.prepare(`
      PRAGMA table_info('dependency_reconciliation_edges')
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'blocker_identity_evidence' }),
      expect.objectContaining({ name: 'blocker_identity_evidence_state' }),
    ]));
    expect(migration).not.toMatch(/(?:^|;)\s*(?:UPDATE|DELETE|DROP)\s/mi);
    sqlite.close();
  });
});
