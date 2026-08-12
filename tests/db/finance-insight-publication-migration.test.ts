import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('finance insight publication migration', () => {
  it('creates bounded publication/cache storage and replays safely through migration ownership', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE finance_sync_state (
        connector_id text PRIMARY KEY NOT NULL,
        last_successful_window_end text
      );
      CREATE TABLE finance_transactions (
        id text PRIMARY KEY NOT NULL,
        connector_instance_id text NOT NULL,
        lifecycle_status text NOT NULL,
        tags text NOT NULL
      );
      CREATE TABLE finance_dataset_sync_state (
        connector_id text NOT NULL,
        dataset text NOT NULL
      );
      INSERT INTO finance_sync_state
        (connector_id, last_successful_window_end)
      VALUES ('legacy-finance', '2026-08-10');
      INSERT INTO finance_transactions
        (id, connector_instance_id, lifecycle_status, tags)
      VALUES ('legacy-transaction', 'legacy-finance', 'active', '["Reviewed"]');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0089_finance-insight-publication.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const stableTagMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0090_finance-insight-stable-tags.sql'),
      'utf8',
    );
    for (const statement of stableTagMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec(`
      INSERT INTO finance_insight_occurrence_cache_state (
        connector_id, source_generation, item_count, source_as_of, refreshed_at,
        summary_expires_at, purge_after, created_at, updated_at
      ) VALUES (
        'legacy-finance', 'legacy-generation', 0, '2026-08-10T00:00:00Z',
        '2026-08-10T00:00:00Z', '2026-08-17T00:00:00Z',
        '2026-09-09T00:00:00Z', '2026-08-10T00:00:00Z',
        '2026-08-10T00:00:00Z'
      )
    `);
    sqlite.exec(`
      INSERT INTO finance_insight_occurrences (
        connector_id, occurrence_id, insight_id, delivery_revision, kind,
        entity_kind, entity_source_ref, entity_label, analysis_state,
        source_lifecycle, severity, confidence, baseline_sufficiency, headline,
        freshness_state, source_as_of, target_descriptors, summary_payload,
        source_updated_at, cached_at
      ) VALUES (
        'legacy-finance', 'legacy-occurrence', 'legacy-insight', 1,
        'largeTransaction', 'transaction', 'legacy-transaction', 'Legacy',
        'qualified', 'resolved', 'info', 'low', 'limited', 'Legacy headline',
        'stale', '2026-08-10T00:00:00Z', '[]', NULL,
        '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'
      )
    `);
    const cacheSequenceMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0091_finance-insight-cache-sequence.sql'),
      'utf8',
    );
    for (const statement of cacheSequenceMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const generationProofMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0092_finance-insight-generation-proof.sql'),
      'utf8',
    );
    for (const statement of generationProofMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const historyProjectionMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0093_finance-insight-history.sql'),
      'utf8',
    );
    for (const statement of historyProjectionMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const ingestionMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0094_cultured_luke_cage.sql'),
      'utf8',
    );
    for (const statement of ingestionMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const backfillMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0095_chief_secret_warriors.sql'),
      'utf8',
    );
    for (const statement of backfillMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const tables = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'finance_insight_%'
      ORDER BY name
    `).all();
    expect(tables).toEqual([
      { name: 'finance_insight_cutovers' },
      { name: 'finance_insight_occurrence_cache_state' },
      { name: 'finance_insight_occurrences' },
      { name: 'finance_insight_publication_delivery' },
      { name: 'finance_insight_publication_facts' },
      { name: 'finance_insight_publication_state' },
      { name: 'finance_insight_publications' },
      { name: 'finance_insight_transaction_backfill_plans' },
      { name: 'finance_insight_transaction_projection_facts' },
      { name: 'finance_insight_transaction_projection_state' },
      { name: 'finance_insight_transaction_projection_windows' },
      { name: 'finance_insight_transaction_window_proofs' },
    ]);
    expect(sqlite.prepare(`PRAGMA table_info(finance_sync_state)`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'last_successful_generation_id' }),
        expect.objectContaining({ name: 'last_successful_source_as_of' }),
        expect.objectContaining({ name: 'last_successful_item_count' }),
        expect.objectContaining({ name: 'last_successful_content_digest' }),
        expect.objectContaining({ name: 'last_successful_projection_start_date' }),
        expect.objectContaining({ name: 'last_successful_projection_coverage_start' }),
        expect.objectContaining({ name: 'last_successful_projection_coverage_end' }),
        expect.objectContaining({ name: 'last_successful_bridge_contract_version' }),
      ]),
    );
    expect(sqlite.prepare(`PRAGMA table_info(finance_transactions)`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tag_references', notnull: 1 }),
      ]),
    );
    expect(sqlite.prepare(`
      SELECT last_successful_window_end AS windowEnd
      FROM finance_sync_state WHERE connector_id = 'legacy-finance'
    `).get()).toEqual({ windowEnd: null });
    expect(sqlite.prepare(`
      SELECT tag_references AS tagReferences
      FROM finance_transactions WHERE id = 'legacy-transaction'
    `).get()).toEqual({ tagReferences: '[]' });
    expect(sqlite.prepare(`PRAGMA table_info(finance_insight_occurrences)`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'summary_payload', notnull: 0 }),
        expect.objectContaining({ name: 'revision_digest', notnull: 1, dflt_value: "''" }),
        expect.objectContaining({ name: 'source_generation', notnull: 1, dflt_value: "''" }),
        expect.objectContaining({ name: 'source_sequence', notnull: 1, dflt_value: '0' }),
        expect.objectContaining({ name: 'is_tombstone', notnull: 1, dflt_value: 'false' }),
      ]),
    );
    expect(sqlite.prepare(`PRAGMA table_info(finance_dataset_sync_state)`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'insight_item_count' }),
        expect.objectContaining({ name: 'insight_content_digest' }),
        expect.objectContaining({ name: 'insight_bridge_contract_version' }),
      ]),
    );
    expect(sqlite.prepare(`PRAGMA table_info(finance_insight_occurrence_cache_state)`).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'source_sequence', notnull: 1, dflt_value: '0' }),
      ]));
    expect(sqlite.prepare(`
      PRAGMA table_info(finance_insight_transaction_projection_state)
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'successful_generation_id' }),
      expect.objectContaining({ name: 'coverage_start' }),
      expect.objectContaining({ name: 'coverage_end' }),
      expect.objectContaining({ name: 'window_count' }),
      expect.objectContaining({ name: 'windows_digest' }),
    ]));
    for (const table of [
      'finance_insight_transaction_projection_state',
      'finance_insight_transaction_projection_windows',
      'finance_insight_transaction_projection_facts',
    ]) {
      expect(sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'connector_configs',
            from: 'connector_id',
            to: 'id',
            on_delete: 'CASCADE',
          }),
        ]),
      );
    }
    expect(sqlite.prepare(`
      SELECT source_sequence AS sourceSequence
      FROM finance_insight_occurrence_cache_state WHERE connector_id = 'legacy-finance'
    `).get()).toEqual({ sourceSequence: 0 });
    expect(sqlite.prepare(`
      SELECT source_generation AS sourceGeneration, is_tombstone AS isTombstone
      FROM finance_insight_occurrences WHERE connector_id = 'legacy-finance'
    `).get()).toEqual({ sourceGeneration: 'legacy-generation', isTombstone: 0 });
    expect(sqlite.prepare(`
      SELECT purge_after AS purgeAfter
      FROM finance_insight_occurrence_cache_state WHERE connector_id = 'legacy-finance'
    `).get()).toEqual({ purgeAfter: '2026-11-08T00:00:00.000Z' });
    expect(() => sqlite.exec(`
      INSERT INTO finance_insight_publications (
        id, connector_id, source_sequence, generation_identity, contract_version,
        provider_type, source_as_of, coverage_start, coverage_end, currency,
        bridge_contract_version, captured_constituents, manifest, manifest_digest,
        create_request, idempotency_key, alert_capable, captured_at, expires_at
      ) VALUES (
        'one', 'connector', 1, 'identity', '1.0', 'finance-manager',
        '2026-08-10T00:00:00Z', '2026-08-01', '2026-08-10', 'USD',
        'bridge-v1', '[]', '[]',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{}', 'idempotency-key-one', 1,
        '2026-08-10T00:00:00Z', '2026-08-17T00:00:00Z'
      );
      INSERT INTO finance_insight_publications (
        id, connector_id, source_sequence, generation_identity, contract_version,
        provider_type, source_as_of, coverage_start, coverage_end, currency,
        bridge_contract_version, captured_constituents, manifest, manifest_digest,
        create_request, idempotency_key, alert_capable, captured_at, expires_at
      ) SELECT
        'two', connector_id, source_sequence, 'different', contract_version,
        provider_type, source_as_of, coverage_start, coverage_end, currency,
        bridge_contract_version, captured_constituents, manifest, manifest_digest,
        create_request, 'idempotency-key-two', alert_capable, captured_at, expires_at
      FROM finance_insight_publications WHERE id = 'one';
    `)).toThrow();
    sqlite.close();
  });
});
