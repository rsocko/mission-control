import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const CONTRACTS = [
  'src/db/persistence/finance-worker.ts',
  'src/db/persistence/finance-snapshot.ts',
  'src/db/persistence/finance-datasets.ts',
  'src/db/persistence/finance-attribution.ts',
] as const;

describe('Layer 5A finance persistence boundary', () => {
  it('keeps every public contract free of database drivers and schemas', () => {
    for (const path of CONTRACTS) {
      expect(source(path), path).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:\/schema|\/finance-schema)?)/,
      );
    }
  });

  it('composes all four finance ports atomically on both backends', () => {
    const worker = source('src/db/persistence/worker-repositories.ts');
    const sqliteRuntime = source('src/lib/persistence/worker-runtime.ts');
    const postgres = source('src/db/postgres/repositories/index.ts');
    const runtime = source('src/db/runtime.ts');

    expect(worker).toContain('finance: FinanceWorkerPersistence');
    expect(sqliteRuntime).toContain(
      "import('@/db/persistence/sqlite-finance-worker-repositories')",
    );
    expect(sqliteRuntime).toContain('finance,');
    expect(postgres).toContain('createPostgresFinanceWorkerPersistence(pool)');
    expect(runtime).toContain(
      "finance: new Proxy({} as WorkerPersistenceRepositories['finance']",
    );
  });

  it('routes the core Monarch projection through finance ports', () => {
    const snapshots = source('src/lib/connectors/monarch-money/snapshot-sync.ts');
    const datasets = source('src/lib/connectors/monarch-money/dataset-sync.ts');
    const attribution = source(
      'src/lib/connectors/monarch-money/attribution-service.ts',
    );

    expect(snapshots).toContain(
      '(await getWorkerPersistenceRepositories()).finance',
    );
    expect(snapshots).toContain('finance.snapshots.complete');
    expect(datasets).toContain(
      '(await getWorkerPersistenceRepositories()).finance.datasets',
    );
    expect(datasets).toContain('persistence.publishRecurring');
    expect(attribution).toContain('this.persistence.attribution.applyResults');
    expect(attribution).toContain('this.persistence.identity.ensureNamespace');
  });

  it('gates Layer 5B before history/proof side effects and keeps finance rejected', () => {
    const connector = source('src/lib/connectors/monarch-money/index.ts');
    const rejection = source(
      'src/db/postgres/repositories/connector-execution-repositories.ts',
    );
    const gate = connector.indexOf("resolveDatabaseBackend() === 'postgres'");
    const history = connector.indexOf('new FinanceInsightHistorySynchronizer');
    const publication = connector.indexOf(
      'const publication = captureFinanceInsightPublication',
    );

    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(history);
    expect(gate).toBeLessThan(publication);
    expect(rejection).toContain("config.type === 'finance-manager'");
    expect(rejection).toContain(
      "throw new UnsupportedConnectorExecutionError('connector-owned state')",
    );
  });
});
