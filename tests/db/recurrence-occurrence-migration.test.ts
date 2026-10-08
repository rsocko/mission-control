import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeLegacyRecurrence,
  writeRecurrenceMetadata,
} from '@/lib/recurrence/canonical';
import { createRecurrenceOccurrenceId } from '@/lib/recurrence/projection';

const sqliteMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/0135_recurring_occurrence_identity.sql'),
  'utf8',
);
const postgresMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/postgres/0011_recurring_occurrence_identity.sql'),
  'utf8',
);

function applySqliteMigration(sqlite: Database.Database): void {
  for (const statement of sqliteMigration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('recurrence occurrence identity migration', () => {
  it('backfills only canonical completion successors and is idempotent', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        due_date TEXT,
        metadata TEXT NOT NULL,
        recurrence_generated_from_task_id TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE task_schedules (
        task_id TEXT PRIMARY KEY NOT NULL,
        scheduled_date TEXT NOT NULL
      );
    `);
    const rule = canonicalizeLegacyRecurrence({
      recurrence: 'daily',
      mode: 'completion',
      startDate: '2026-08-10',
      localTime: null,
      timezone: 'UTC',
      seriesIdentity: { kind: 'mission-control', stableId: 'legacy-series' },
    });
    const metadata = JSON.stringify(writeRecurrenceMetadata({}, rule));
    const insertTask = sqlite.prepare(`
      INSERT INTO tasks (
        id, due_date, metadata, recurrence_generated_from_task_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertTask.run(
      'predecessor',
      '2026-08-10',
      '{}',
      null,
      '2026-08-10T08:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    );
    insertTask.run(
      'canonical-successor',
      '2026-08-17',
      metadata,
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    insertTask.run(
      'ambiguous-successor',
      '2026-08-24',
      JSON.stringify({ recurrence: 'daily' }),
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    const invalidHashMetadata = JSON.parse(metadata) as {
      canonicalRecurrence: { series: { id: string } };
    };
    invalidHashMetadata.canonicalRecurrence.series.id = `series:v1:a${'g'.repeat(63)}`;
    insertTask.run(
      'invalid-hash-successor',
      '2026-08-31',
      JSON.stringify(invalidHashMetadata),
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    const stringVersionMetadata = JSON.parse(metadata) as {
      canonicalRecurrence: { version: number | string };
    };
    stringVersionMetadata.canonicalRecurrence.version = '1';
    insertTask.run(
      'string-version-successor',
      '2026-09-07',
      JSON.stringify(stringVersionMetadata),
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    const booleanVersionMetadata = JSON.parse(metadata) as {
      canonicalRecurrence: { version: number | boolean };
    };
    booleanVersionMetadata.canonicalRecurrence.version = true;
    insertTask.run(
      'boolean-version-successor',
      '2026-09-14',
      JSON.stringify(booleanVersionMetadata),
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    insertTask.run(
      'mismatched-date-successor',
      '2026-09-21',
      metadata,
      'predecessor',
      '2026-08-10T09:00:00.000Z',
      null,
    );
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('canonical-successor', '2026-08-17');
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('ambiguous-successor', '2026-08-24');
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('invalid-hash-successor', '2026-08-31');
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('string-version-successor', '2026-09-07');
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('boolean-version-successor', '2026-09-14');
    sqlite.prepare('INSERT INTO task_schedules (task_id, scheduled_date) VALUES (?, ?)')
      .run('mismatched-date-successor', '2026-09-22');

    applySqliteMigration(sqlite);
    applySqliteMigration(sqlite);

    const rows = sqlite.prepare(`
      SELECT occurrence_id AS occurrenceId, task_id AS taskId,
        generated_from_task_id AS generatedFromTaskId
      FROM task_recurrence_occurrences
    `).all() as Array<{
      occurrenceId: string;
      taskId: string;
      generatedFromTaskId: string;
    }>;
    expect(rows).toEqual([{
      occurrenceId: createRecurrenceOccurrenceId({
        seriesId: rule.series.id,
        revisionId: rule.revision.id,
        effective: { kind: 'local-date', value: '2026-08-17' },
      }),
      taskId: 'canonical-successor',
      generatedFromTaskId: 'predecessor',
    }]);
    sqlite.close();
  });

  it('keeps SQLite and PostgreSQL uniqueness, checks, and conservative backfill aligned', () => {
    for (const migration of [sqliteMigration, postgresMigration]) {
      expect(migration).toContain('task_recurrence_occurrences');
      expect(migration).toContain('series_id');
      expect(migration).toContain('rule_revision_id');
      expect(migration).toContain('effective_kind');
      expect(migration).toContain('effective_value');
      expect(migration).toContain('task_recurrence_occurrences_effective_check');
      expect(migration).toContain('task_recurrence_occurrences_provenance_check');
      expect(migration).toContain('canonicalRecurrence');
      expect(migration).toContain('on-completion');
    }
    expect(sqliteMigration).toContain("NOT GLOB '*[^0-9a-f]*'");
    expect(sqliteMigration).toContain('successor.`due_date` = schedule.`scheduled_date`');
    expect(postgresMigration).toContain('jsonb_typeof');
    expect(postgresMigration).toContain('successor."due_date" = schedule."scheduled_date"');
  });
});
