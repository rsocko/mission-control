import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const PORTABLE_TRIAGE_MODULES = [
  'src/db/persistence/triage-repositories.ts',
  'src/lib/triage/credentials.ts',
  'src/lib/triage/import-capture.ts',
  'src/lib/triage/persistence.ts',
  'src/lib/triage/scheduler.ts',
  'src/lib/triage/sync-state.ts',
  'src/lib/triage/importers/base-importer.ts',
  'src/lib/triage/importers/github-importer.ts',
  'src/lib/triage/importers/reddit-importer.ts',
  'src/lib/triage/importers/youtube-importer.ts',
  'src/lib/triage/importers/document-intelligence-importer.ts',
] as const;

describe('Layer 7 triage worker persistence boundary', () => {
  it('keeps portable triage contracts and orchestration free of database drivers', () => {
    for (const path of PORTABLE_TRIAGE_MODULES) {
      expect(source(path), path).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:['"]|\/(?:index|schema|sqlite)))/,
      );
    }
  });

  it('composes triage atomically beside every inherited worker member', () => {
    const worker = source('src/db/persistence/worker-repositories.ts');
    const sqliteRuntime = source('src/lib/persistence/worker-runtime.ts');
    const postgres = source('src/db/postgres/repositories/index.ts');
    const runtime = source('src/db/runtime.ts');

    expect(worker).toContain('triage: TriagePersistenceRepositories');
    expect(worker).toContain('notificationDelivery: NotificationDeliveryRepository');
    expect(worker).toContain('reminders: TaskReminderRepository');
    expect(worker).toContain('finance: FinanceWorkerPersistence');
    expect(sqliteRuntime).toContain("import('@/db/persistence/sqlite-triage-repositories')");
    expect(sqliteRuntime).not.toMatch(
      /(?:^|\n)import\s+[^;]*from\s+['"]@\/db\/persistence\/sqlite-triage-repositories['"]/,
    );
    expect(sqliteRuntime).toContain('triage: createSqliteTriagePersistenceRepositories(sqlite)');
    expect(postgres).toContain('triage: createPostgresTriagePersistenceRepositories(db)');
    expect(runtime).toContain(
      "triage: new Proxy({} as WorkerPersistenceRepositories['triage']",
    );
  });

  it('keeps PostgreSQL selection fail-closed before SQLite adapter evaluation', () => {
    const runtime = source('src/lib/persistence/worker-runtime.ts');
    const failure = runtime.indexOf(
      'PostgreSQL worker repositories must be registered before worker persistence is accessed',
    );
    const sqliteEvaluation = runtime.indexOf(
      'sqliteWorkerPersistencePromise ??= createSqliteWorkerPersistenceRepositories()',
    );
    expect(failure).toBeGreaterThan(-1);
    expect(sqliteEvaluation).toBeGreaterThan(failure);
  });

  it('routes scheduled capture and sync state through the triage ports', () => {
    const capture = source('src/lib/triage/import-capture.ts');
    const syncState = source('src/lib/triage/sync-state.ts');
    const scheduler = source('src/lib/triage/scheduler.ts');

    expect(capture).toContain('getTriagePersistenceRepositories().capture.captureBatch(items)');
    expect(syncState).toContain('getTriagePersistenceRepositories().syncState.recordRun');
    expect(scheduler).toContain('getCorePersistenceRepositories().settings');
    for (const contents of [capture, syncState, scheduler]) {
      expect(contents).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:['"]|\/(?:index|schema|sqlite)))/,
      );
    }
  });

  it('keeps both adapters on the shared complete contract', () => {
    const sqlite = source('src/db/persistence/sqlite-triage-repositories.ts');
    const postgres = source('src/db/postgres/repositories/triage-repositories.ts');
    for (const adapter of [sqlite, postgres]) {
      expect(adapter).toContain('captureBatch(');
      expect(adapter).toContain('expectedRevision');
      expect(adapter).toContain('githubCredentialFallback');
    }
    expect(postgres).not.toMatch(/from\s+['"][^'"]*sqlite[^'"]*['"]/);
    expect(postgres).not.toMatch(/from\s+['"]@\/db(?:['"]|\/index['"])/);
  });
});
