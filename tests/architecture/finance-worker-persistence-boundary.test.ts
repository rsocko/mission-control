import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const CONTRACTS = [
  'src/db/persistence/finance-worker.ts',
  'src/db/persistence/finance-snapshot.ts',
  'src/db/persistence/finance-datasets.ts',
  'src/db/persistence/finance-attribution.ts',
  'src/db/persistence/finance-operator.ts',
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

const FINANCE_WORKER_ROOTS = [
  'src/lib/connectors/monarch-money/index.ts',
  'src/lib/connectors/monarch-money/snapshot-synchronizer.ts',
  'src/lib/connectors/monarch-money/dataset-synchronizer.ts',
  'src/lib/connectors/monarch-money/attribution-coordinator.ts',
  'src/lib/connectors/monarch-money/finance-insight-history-sync.ts',
  'src/lib/connectors/monarch-money/transaction-backfill.ts',
  'src/lib/connectors/monarch-money/recovery-scheduler.ts',
  'src/lib/finance-insights/continuation.ts',
  'src/lib/finance-insights/orchestrator.ts',
  'src/lib/finance/attention-routing.ts',
] as const;

function resolveApplicationImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? resolve(process.cwd(), 'src', specifier.slice(2))
    : resolve(dirname(resolve(process.cwd(), fromPath)), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate.slice(resolve(process.cwd()).length + 1).replaceAll('\\', '/');
    }
  }
  return null;
}

function staticApplicationGraph(roots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const pending = [...roots];
  const importPattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const contents = source(path);
    for (const match of contents.matchAll(importPattern)) {
      const resolved = resolveApplicationImport(path, match[1] ?? match[2]);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

describe('Layer 5C finance persistence boundary', () => {
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
    const sqliteRuntime = source('src/db/persistence/sqlite-worker-runtime.ts');
    const postgres = source('src/db/postgres/repositories/index.ts');
    const runtime = source('src/db/runtime.ts');

    expect(finance).toContain('readonly insights:');
    expect(finance).toContain('readonly attention:');
    expect(finance).toContain('readonly operator:');
    expect(worker).toContain('finance: FinanceWorkerPersistence');
    expect(sqliteRuntime).toContain(
      "from './sqlite-finance-worker-repositories'",
    );
    expect(sqliteRuntime).toContain(
      "from './sqlite-finance-operator-repository'",
    );
    expect(sqliteRuntime).toContain('createSqliteFinanceOperatorPersistence({ sqlite, db })');
    expect(sqliteRuntime).toContain('finance,');
    expect(postgres).toContain('createPostgresFinanceWorkerPersistence(pool)');
    expect(postgres).toContain('createPostgresFinanceOperatorPersistence(pool)');
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
    const snapshots = source('src/lib/connectors/monarch-money/snapshot-synchronizer.ts');
    const datasets = source('src/lib/connectors/monarch-money/dataset-synchronizer.ts');
    const attribution = source(
      'src/lib/connectors/monarch-money/attribution-coordinator.ts',
    );

    expect(snapshots).toContain(
      '(await getWorkerPersistenceRepositories()).finance',
    );
    expect(snapshots).toContain('finance.snapshots.complete');
    expect(datasets).toContain(
      '(await getWorkerPersistenceRepositories()).finance.datasets',
    );
    expect(datasets).toContain('persistence.publishRecurring');
    expect(attribution).toContain('this.dependencies.persistence.attribution.applyResults');
    expect(attribution).toContain('this.dependencies.persistence.identity.ensureNamespace');
  });

  it('keeps the packaged finance execution graph free of SQLite imports', () => {
    const graph = staticApplicationGraph(FINANCE_WORKER_ROOTS);
    for (const path of graph) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"](?:better-sqlite3|drizzle-orm\/better-sqlite3|@\/db(?:['"]|\/(?:index|schema|finance-schema|sqlite)[^'"]*['"]))/,
      );
      expect(contents, path).not.toMatch(/\bsqlite\.(?:prepare|transaction|exec|pragma)\b/);
    }
    expect(graph).toContain('src/lib/connectors/monarch-money/attribution-coordinator.ts');
    expect(graph).not.toContain('src/lib/connectors/monarch-money/attribution-service.ts');
    expect(graph).not.toContain('src/lib/connectors/monarch-money/snapshot-sync.ts');
    expect(graph).not.toContain('src/lib/connectors/monarch-money/dataset-sync.ts');
  });

  it('keeps finance domain execution active alongside portable notification delivery', () => {
    const connector = source('src/lib/connectors/monarch-money/index.ts');
    const support = source(
      'src/db/postgres/repositories/connector-execution-repositories.ts',
    );
    const backfill = source(
      'src/lib/connectors/monarch-money/transaction-backfill.ts',
    );
    const history = connector.indexOf('new FinanceInsightHistorySynchronizer');
    const publication = connector.indexOf(
      'const publication = await captureFinanceInsightPublication',
    );

    expect(history).toBeGreaterThan(0);
    expect(publication).toBeGreaterThan(history);
    expect(connector).not.toContain("resolveDatabaseBackend() === 'postgres'");
    expect(support).toContain('normalizeFinanceProviderAlias(connector.type)');
    expect(support).toContain(
      "throw new UnsupportedConnectorExecutionError('connector-owned domain state')",
    );
    expect(support).toContain('return isPostgresBackendWorkflowSupported(workflow)');
    expect(support).toContain("workflow === 'notification-dispatcher'");
    expect(backfill.indexOf('repositories.execution.support.assertConfigSupported(input.config)'))
      .toBeGreaterThan(0);
    expect(backfill.indexOf('repositories.execution.support.assertConfigSupported(input.config)'))
      .toBeLessThan(backfill.indexOf('finance.identity.ensureNamespace'));
  });
});
