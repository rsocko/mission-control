import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('notification delivery persistence boundary', () => {
  it('keeps dispatcher orchestration and default senders free of database drivers', () => {
    for (const path of [
      'src/lib/push/dispatcher.ts',
      'src/lib/push/web-push-sender.ts',
      'src/lib/push/apns-sender.ts',
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(
        /from\s+['"](?:@\/db(?:['"]|\/schema)|better-sqlite3|drizzle-orm|pg)['"]/,
      );
      expect(source, path).not.toContain('sqlite.prepare');
    }
  });

  it('keeps the PostgreSQL delivery adapter unable to reach SQLite', () => {
    const source = read(
      'src/db/postgres/repositories/notification-delivery-repository.ts',
    );
    const execution = read(
      'src/db/postgres/repositories/connector-execution-repositories.ts',
    );
    expect(source).not.toMatch(/from\s+['"]better-sqlite3['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*sqlite[^'"]*['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"]|\/index['"])/);
    expect(execution).toContain(
      "from '@/lib/notifications/push-policy/constants'",
    );
    expect(execution).not.toContain(
      "from '@/lib/notifications/push-policy/rules'",
    );
    const jobs = read('src/db/postgres/sync/job-repository.ts');
    expect(jobs).toContain("from '@/lib/sync/control-state-error'");
    expect(jobs).not.toContain("from '@/lib/sync/control-state'");
  });

  it('loads the SQLite adapter lazily and registers both backends atomically', () => {
    const runtime = read('src/lib/persistence/worker-runtime.ts');
    expect(runtime).toContain(
      "import('@/db/persistence/sqlite-notification-delivery-repository')",
    );
    expect(runtime).not.toMatch(
      /(?:^|\n)import\s+[^;]*from\s+['"]@\/db\/persistence\/sqlite-notification-delivery-repository['"]/,
    );
    expect(runtime).toContain(
      'notificationDelivery: createSqliteNotificationDeliveryRepository(sqlite)',
    );

    const postgres = read('src/db/postgres/repositories/index.ts');
    expect(postgres).toContain(
      'notificationDelivery: createPostgresNotificationDeliveryRepository(pool)',
    );
    expect(postgres).toContain('finance: {');
    expect(postgres).toContain('createPostgresFinanceWorkerPersistence(pool)');
  });

  it('enables the PostgreSQL dispatcher only through the portable composition', () => {
    const support = read(
      'src/db/postgres/repositories/connector-execution-repositories.ts',
    );
    expect(support).toContain("workflow === 'notification-dispatcher'");
    const dispatcher = read('src/lib/push/dispatcher.ts');
    expect(dispatcher).toContain('getWorkerPersistenceRepositories()');
    expect(dispatcher).toContain('.notificationDelivery');
  });

  it('wakes portable delivery recovery after both runtime entrypoints initialize persistence', () => {
    for (const path of [
      'src/instrumentation.ts',
      'src/lib/runtime/packaged-sync-worker.ts',
    ]) {
      const source = read(path);
      expect(
        source.indexOf('wakeNotificationDeliveryDispatcher()'),
        path,
      ).toBeGreaterThan(source.indexOf('await initializeDatabaseWithRetry()'));
    }
    expect(read('src/lib/push/scheduler.ts')).not.toContain(
      'wakeNotificationDeliveryDispatcher',
    );
  });
});
