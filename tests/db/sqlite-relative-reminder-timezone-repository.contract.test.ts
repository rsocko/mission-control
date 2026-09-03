import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { createSqliteRelativeReminderTimezoneRepository } from '@/db/persistence/sqlite-relative-reminder-timezone-repository';
import {
  describeRelativeReminderTimezoneContract,
} from '../contracts/relative-reminder-timezone-repository.contract';

// This suite runs real and()/inArray()/gt()/sql`` query building against a
// live SQLite database. tests/setup.ts globally mocks 'drizzle-orm' for unit
// tests; unmock it here so the repository's query builder calls produce real
// SQL instead of test-double objects (matching every other tests/db/* file).
vi.unmock('drizzle-orm');

function createSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL DEFAULT 'seed',
      connector_type TEXT NOT NULL DEFAULT 'seed',
      connector_instance_id TEXT NOT NULL DEFAULT 'seed',
      title TEXT NOT NULL DEFAULT 'seed',
      status TEXT NOT NULL DEFAULT 'todo',
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      last_synced_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      metadata TEXT NOT NULL DEFAULT '{}',
      reminder_at TEXT,
      reminder_relative TEXT,
      reminder_due_time TEXT
    );
  `);
}

describeRelativeReminderTimezoneContract('SQLite', () => {
  const sqlite = new Database(':memory:');
  createSchema(sqlite);
  const db = drizzle(sqlite, { schema });

  return {
    repository: createSqliteRelativeReminderTimezoneRepository(db),
    seedTask: (input) => {
      sqlite.prepare(
        `INSERT INTO tasks (id, status, due_date, reminder_at, reminder_relative, reminder_due_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.status ?? 'todo',
        input.dueDate ?? null,
        input.reminderAt ?? null,
        input.reminderRelative ?? null,
        input.reminderDueTime ?? null,
      );
    },
    getTask: (id) => {
      const row = sqlite.prepare(
        `SELECT id, due_date AS dueDate, reminder_at AS reminderAt,
                reminder_relative AS reminderRelative, reminder_due_time AS reminderDueTime,
                updated_at AS updatedAt
         FROM tasks WHERE id = ?`,
      ).get(id) as {
        id: string;
        dueDate: string | null;
        reminderAt: string | null;
        reminderRelative: string | null;
        reminderDueTime: string | null;
        updatedAt: string;
      } | undefined;
      return row ?? null;
    },
    close: () => {
      sqlite.close();
    },
  };
});
