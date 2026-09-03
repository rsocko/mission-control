import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('task reminder persistence boundary', () => {
  it('keeps reminder application orchestration free of drivers and schema access', () => {
    const source = read('src/lib/push/task-reminders.ts');
    expect(source).not.toMatch(
      /from\s+['"](?:@\/db(?:['"]|\/schema)|better-sqlite3|drizzle-orm|pg)['"]/,
    );
    expect(source).not.toContain('sqlite.prepare');
    expect(source).not.toContain('taskReminderOccurrences');
    expect(source).toContain('getWorkerPersistenceRepositories()');
    expect(source).toContain('.reminders');
  });

  it('keeps the PostgreSQL reminder adapter unable to reach SQLite', () => {
    const source = read('src/db/postgres/repositories/task-reminder-repository.ts');
    expect(source).not.toMatch(/from\s+['"]better-sqlite3['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*sqlite[^'"]*['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"]|\/index['"])/);
    expect(source).toContain('FOR UPDATE OF task SKIP LOCKED');
    expect(source).toContain('pg_input_is_valid');
    expect(source).toContain('task.reminder_at::timestamptz');
  });

  it('registers reminders atomically without replacing inherited worker members', () => {
    const runtime = read('src/db/persistence/sqlite-worker-runtime.ts');
    expect(runtime).toContain(
      "from './sqlite-task-reminder-repository'",
    );
    expect(runtime).toContain('reminders: createSqliteTaskReminderRepository(sqlite)');
    expect(runtime).toContain(
      'notificationDelivery: createSqliteNotificationDeliveryRepository(sqlite)',
    );
    expect(runtime).toContain('finance,');

    const postgres = read('src/db/postgres/repositories/index.ts');
    expect(postgres).toContain('reminders: createPostgresTaskReminderRepository(pool)');
    expect(postgres).toContain(
      'notificationDelivery: createPostgresNotificationDeliveryRepository(pool)',
    );
    expect(postgres).toContain('createPostgresFinanceWorkerPersistence(pool)');
  });

  it('keeps PostgreSQL selection fail-closed before atomic registration', () => {
    const runtime = read('src/lib/persistence/worker-runtime.ts');
    expect(runtime).toContain(
      'Worker persistence repositories must be registered before worker persistence is accessed',
    );
    expect(runtime).not.toContain('sqlite');
    expect(read('src/db/runtime.ts')).toContain(
      "import('./persistence/sqlite-worker-runtime')",
    );
  });

  it('uses the inherited delivery outbox and dispatcher wake', () => {
    const sqlite = read('src/db/persistence/sqlite-task-reminder-repository.ts');
    const postgres = read('src/db/postgres/repositories/task-reminder-repository.ts');
    const application = read('src/lib/push/task-reminders.ts');
    for (const source of [sqlite, postgres]) {
      expect(source).toContain('notification_delivery_events');
      expect(source).not.toContain('dispatchNotificationDeliveries');
    }
    expect(application).toContain('wakeNotificationDeliveryDispatcher()');
    expect(application).not.toContain('notification_delivery_events');
  });
});
