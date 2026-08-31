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
  'src/db/persistence/finance-insights.ts',
  'src/db/persistence/finance-attention.ts',
] as const;

const LAYER_5B_MODULES = [
  'src/app/api/finance/sync/route.ts',
  'src/lib/connectors/monarch-money/finance-insight-history-sync.ts',
  'src/lib/connectors/monarch-money/transaction-backfill.ts',
  'src/lib/finance-insights/notification-ingestion.ts',
  'src/lib/finance-insights/notification-shared.ts',
  'src/lib/finance-insights/occurrence-cache.ts',
  'src/lib/finance-insights/occurrence-shared.ts',
  'src/lib/finance-insights/orchestrator.ts',
  'src/lib/finance-insights/publication.ts',
  'src/lib/finance/attention-repair.ts',
  'src/lib/finance/attention-routing.ts',
] as const;

describe('Layer 5B finance persistence boundary', () => {
  it('keeps every public contract free of database drivers and schemas', () => {
    for (const path of CONTRACTS) {
      expect(source(path), path).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:\/schema|\/finance-schema)?)/,
      );
    }
  });

  it('composes the core, insight, and attention ports atomically on both backends', () => {
    const finance = source('src/db/persistence/finance-worker.ts');
    const worker = source('src/db/persistence/worker-repositories.ts');
    const sqliteRuntime = source('src/lib/persistence/worker-runtime.ts');
    const postgres = source('src/db/postgres/repositories/index.ts');
    const runtime = source('src/db/runtime.ts');

    expect(finance).toContain('readonly insights:');
    expect(finance).toContain('readonly attention:');
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

  it('keeps every migrated Layer 5B orchestration module behind persistence ports', () => {
    for (const path of LAYER_5B_MODULES) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*|@\/db(?:['"]|\/(?:index|schema)['"]))/,
      );
      expect(contents, path).not.toMatch(
        /import\(\s*['"]@\/db(?:\/(?:index|schema))?['"]\s*\)/,
      );
      expect(contents, path).not.toMatch(
        /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@\/lib\/(?:finance-insights\/cutover|notifications\/service)['"]/,
      );
    }
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

  it('keeps Layer 5C activation gated before finance side effects', () => {
    const connector = source('src/lib/connectors/monarch-money/index.ts');
    const rejection = source(
      'src/db/postgres/repositories/connector-execution-repositories.ts',
    );
    const backfill = source(
      'src/lib/connectors/monarch-money/transaction-backfill.ts',
    );
    const gate = connector.indexOf("resolveDatabaseBackend() === 'postgres'");
    const history = connector.indexOf('new FinanceInsightHistorySynchronizer');
    const publication = connector.indexOf(
      'const publication = await captureFinanceInsightPublication',
    );

    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(history);
    expect(gate).toBeLessThan(publication);
    expect(rejection).toContain("config.type === 'finance-manager'");
    expect(rejection).toContain(
      "throw new UnsupportedConnectorExecutionError('connector-owned state')",
    );
    expect(rejection).toContain('if (connector.syncDomainData)');
    expect(rejection).toContain(
      "throw new UnsupportedConnectorExecutionError('connector-owned domain state')",
    );
    expect(backfill.indexOf('repositories.execution.support.assertConfigSupported(input.config)'))
      .toBeGreaterThan(0);
    expect(backfill.indexOf('repositories.execution.support.assertConfigSupported(input.config)'))
      .toBeLessThan(backfill.indexOf('finance.identity.ensureNamespace'));
  });
});
