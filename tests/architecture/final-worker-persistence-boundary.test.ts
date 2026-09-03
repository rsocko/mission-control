import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = 'src/sync-worker.ts';
const INTEGRATION_ROOT = 'src/sync-worker-integration.ts';
const COMPOSITION_ROOT = 'src/lib/runtime/packaged-sync-worker.ts';
const POSTGRES_EXCLUDED_ENTRY_IMPORTS = new Set([
  '@/lib/semantic-index/runtime',
]);
const POSTGRES_GUARDED_DYNAMIC_IMPORTERS = new Set([
  COMPOSITION_ROOT,
  'src/db/runtime.ts',
  'src/lib/ai/durable-runs/runtime.ts',
  'src/lib/semantic-index/embedding-provider.ts',
  'src/lib/connectors/github-issues/backup-verifier.ts',
  'src/lib/connectors/monarch-money/index.ts',
  'src/lib/connectors/rymessage/rymessage-client.ts',
  'src/lib/houston-memory/service.ts',
  'src/lib/notifications/enrichment/ai-enrichment.ts',
  'src/lib/persistence/worker-runtime.ts',
  'src/lib/persistence/runtime.ts',
  'src/lib/search/fts.ts',
  'src/lib/semantic-index/publication.ts',
  'src/lib/semantic-index/repository-facade.ts',
  'src/lib/semantic-index/source/facade.ts',
  'src/lib/sync/connector-lock-runtime.ts',
  'src/lib/sync/control-state.ts',
  'src/lib/sync/job-runtime.ts',
  'src/lib/sync/maintenance-lock.ts',
  'src/lib/sync/search-indexer.ts',
  'src/lib/telemetry/database-health-runtime.ts',
  'src/lib/telemetry/health-snapshot.ts',
  'src/lib/telemetry/runtime.ts',
]);
const POSTGRES_GUARDED_DYNAMIC_BARRELS = new Set([
  '@/lib/search',
  '@/lib/semantic-index/runtime',
]);
const POSTGRES_BACKEND_GUARDED_DYNAMIC_EDGES = new Set([
  'src/lib/connectors/monarch-money/index.ts -> ./attribution-service',
  'src/lib/connectors/monarch-money/index.ts -> ./snapshot-sync',
  'src/lib/notifications/enrichment/ai-enrichment.ts -> @/lib/ai/provider-factory',
  'src/lib/semantic-index/embedding-provider.ts -> @/lib/search/embedding-request',
  'src/lib/semantic-index/publication.ts -> ./config',
  'src/lib/semantic-index/publication.ts -> ./runtime',
]);
const FEATURE_GUARDED_DYNAMIC_EDGES = new Set([
  'src/lib/triage/scheduler.ts -> ./importers/github-importer',
  'src/lib/triage/scheduler.ts -> ./importers/reddit-importer',
  'src/lib/triage/scheduler.ts -> ./importers/youtube-importer',
  'src/lib/triage/scheduler.ts -> ./importers/document-intelligence-importer',
]);
const SQLITE_MODULE = /(?:^|\/)(?:db\/(?:index|schema)(?:\.ts|\/)|[^/]*sqlite[^/]*\.ts$)/;
const SQLITE_PACKAGE = /^(?:better-sqlite3|drizzle-orm\/better-sqlite3)$/;
function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
}

function staticImports(path: string): string[] {
  return sourceFile(path).statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const onlyNamedTypes = clause?.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && !clause.name
        && clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (clause?.isTypeOnly || onlyNamedTypes) return [];
      return ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [];
    }
    if (ts.isExportDeclaration(statement)) {
      const onlyNamedTypes = statement.exportClause
        && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.every((element) => element.isTypeOnly);
      if (statement.isTypeOnly || onlyNamedTypes || !statement.moduleSpecifier) return [];
      return ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [];
    }
    return [];
  });
}

function dynamicImports(path: string): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path));
  return imports;
}

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

function postgresApplicationGraph(
  roots: string[],
  initialPaths: string[] = [],
): Set<string> {
  const visited = new Set<string>(initialPaths);
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of [
      ...staticImports(path),
      ...dynamicImports(path).filter((specifier) => {
        const resolved = resolveApplicationImport(path, specifier);
        const sqliteTarget = SQLITE_PACKAGE.test(specifier)
          || Boolean(resolved && SQLITE_MODULE.test(resolved));
        return !sqliteTarget
          && !POSTGRES_GUARDED_DYNAMIC_BARRELS.has(specifier)
          && !POSTGRES_BACKEND_GUARDED_DYNAMIC_EDGES.has(`${path} -> ${specifier}`)
          && !FEATURE_GUARDED_DYNAMIC_EDGES.has(`${path} -> ${specifier}`);
      }),
    ]) {
      const resolved = resolveApplicationImport(path, specifier);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

function postgresStartupGraph(): Set<string> {
  const roots = [...staticImports(ROOT), ...dynamicImports(ROOT)]
    .filter((specifier) => !POSTGRES_EXCLUDED_ENTRY_IMPORTS.has(specifier))
    .map((specifier) => resolveApplicationImport(ROOT, specifier))
    .filter((path): path is string => path !== null);
  return postgresApplicationGraph(roots, [ROOT]);
}

function staticSqliteViolations(graph: Set<string>): string[] {
  return [...graph].flatMap((path) => {
    return staticImports(path).filter((specifier) => {
      const resolved = resolveApplicationImport(path, specifier);
      return SQLITE_PACKAGE.test(specifier) || Boolean(resolved && SQLITE_MODULE.test(resolved));
    })
      .map((specifier) => `${path} -> ${specifier}`);
  });
}

describe('Layer 7 final PostgreSQL worker persistence boundary', () => {
  it('keeps the real PostgreSQL startup graph free of SQLite evaluation', () => {
    const graph = postgresStartupGraph();
    const violations = staticSqliteViolations(graph);

    const configImporters = [...graph].filter((path) =>
      source(path).includes('config-resolver')
    );
    expect(violations, `AI config importers: ${configImporters.join(', ')}`).toEqual([]);
    expect(graph).toContain('src/lib/connectors/monarch-money/recovery-scheduler.ts');
    expect(graph).toContain('src/lib/telemetry/health-snapshot.ts');
    expect(graph).toContain('src/lib/triage/scheduler.ts');
    expect(graph).toContain('src/lib/ai/durable-runs/packaged-worker.ts');
    expect(graph).toContain('src/lib/semantic-index/packaged-worker-runtime.ts');
    expect(graph).toContain('src/lib/notifications/enrichment/packaged-executor.ts');
    expect([...graph].filter((path) => path.includes('src/lib/triage/importers/'))).toEqual([]);
  });

  it('allowlists every guarded dynamic startup edge', () => {
    const graph = postgresStartupGraph();
    const monarchClient = source('src/lib/connectors/monarch-money/index.ts');
    const guardedEdges = [...graph].flatMap((path) =>
      dynamicImports(path).flatMap((specifier) => {
        const resolved = resolveApplicationImport(path, specifier);
        return (
          SQLITE_PACKAGE.test(specifier)
          || Boolean(resolved && SQLITE_MODULE.test(resolved))
          || POSTGRES_GUARDED_DYNAMIC_BARRELS.has(specifier)
          || POSTGRES_BACKEND_GUARDED_DYNAMIC_EDGES.has(`${path} -> ${specifier}`)
          || FEATURE_GUARDED_DYNAMIC_EDGES.has(`${path} -> ${specifier}`)
        )
          ? [`${path} -> ${specifier}`]
          : [];
      })
    );
    const unexpectedImporters = guardedEdges.filter((edge) =>
      !POSTGRES_GUARDED_DYNAMIC_IMPORTERS.has(edge.split(' -> ')[0])
      && !edge.startsWith(`${ROOT} -> `)
    );

    expect(unexpectedImporters).toEqual([]);
    expect(guardedEdges).toContain('src/db/runtime.ts -> ./index');
    expect(guardedEdges).toContain(
      'src/lib/ai/durable-runs/runtime.ts -> ./sqlite-adapter',
    );
    expect(guardedEdges).toContain(
      'src/lib/sync/search-indexer.ts -> @/lib/search',
    );
    expect(guardedEdges).toContain(
      'src/lib/connectors/monarch-money/index.ts -> ./attribution-service',
    );
    expect(guardedEdges).toContain(
      'src/lib/connectors/monarch-money/index.ts -> ./snapshot-sync',
    );
    expect(guardedEdges).toContain(
      'src/lib/notifications/enrichment/ai-enrichment.ts -> @/lib/ai/provider-factory',
    );
    expect(guardedEdges).toContain(
      'src/lib/semantic-index/embedding-provider.ts -> @/lib/search/embedding-request',
    );
    expect(guardedEdges).toContain(
      'src/lib/semantic-index/publication.ts -> ./config',
    );
    expect(guardedEdges).toContain(
      'src/lib/semantic-index/publication.ts -> ./runtime',
    );
    expect(
      guardedEdges.filter((edge) => edge.startsWith('src/lib/triage/scheduler.ts -> ')),
    ).toEqual([...FEATURE_GUARDED_DYNAMIC_EDGES]);
    const triageScheduler = source('src/lib/triage/scheduler.ts');
    expect(triageScheduler.match(/enabled: false/g)).toHaveLength(4);
    expect(triageScheduler.indexOf('if (sourceConfig.enabled)'))
      .toBeLessThan(triageScheduler.indexOf('this.scheduleSource('));
    const configuredTriageImporters = [...FEATURE_GUARDED_DYNAMIC_EDGES].map((edge) => {
      const separator = edge.indexOf(' -> ');
      return resolveApplicationImport(
        edge.slice(0, separator),
        edge.slice(separator + ' -> '.length),
      );
    }).filter((path): path is string => path !== null);
    expect(configuredTriageImporters).toHaveLength(FEATURE_GUARDED_DYNAMIC_EDGES.size);
    const configuredTriageGraph = postgresApplicationGraph(configuredTriageImporters);
    expect(staticSqliteViolations(configuredTriageGraph)).toEqual([]);
    expect([...configuredTriageGraph].flatMap((path) =>
      dynamicImports(path).filter((specifier) => {
        const resolved = resolveApplicationImport(path, specifier);
        return SQLITE_PACKAGE.test(specifier) || Boolean(resolved && SQLITE_MODULE.test(resolved));
      }).map((specifier) => `${path} -> ${specifier}`)
    )).toEqual([]);
    expect(monarchClient.match(/MC_DATABASE_BACKEND === 'postgres'/g)).toHaveLength(2);
    const categoryFailure = monarchClient.indexOf(
      'Legacy finance category write-back is unavailable',
    );
    const attributionFailure = monarchClient.indexOf(
      'Legacy finance attribution write-back is unavailable',
    );
    expect(categoryFailure).toBeGreaterThan(-1);
    expect(attributionFailure).toBeGreaterThan(-1);
    expect(categoryFailure).toBeLessThan(monarchClient.indexOf("import('./snapshot-sync')"));
    expect(attributionFailure)
      .toBeLessThan(monarchClient.indexOf("import('./attribution-service')"));
  });

  it('keeps producer capability validation out of the native worker registry', () => {
    const capability = source('src/lib/runtime/postgres-workflow-capability.ts');
    expect(capability).toContain('@/lib/ai/durable-runs/route-contract');
    expect(capability).not.toContain('@/lib/ai/durable-runs/executor-registry');
    expect(capability).not.toContain('@github/copilot-sdk');
  });

  it('preserves notification entity linking through backend-selected persistence', () => {
    const linker = source('src/lib/notifications/enrichment/entity-linker.ts');
    const workerPersistence = source('src/db/persistence/worker-repositories.ts');
    const postgresComposition = source('src/db/postgres/repositories/index.ts');
    const sqliteComposition = source('src/lib/persistence/worker-runtime.ts');

    expect(linker).toContain('notificationEntityLinking');
    expect(linker).not.toMatch(/from ['"]@\/db['"]/);
    expect(linker).not.toContain('@/db/schema');
    expect(workerPersistence).toContain(
      'notificationEntityLinking: NotificationEntityLinkingRepository',
    );
    expect(postgresComposition).toContain(
      'createPostgresNotificationEntityLinkingRepository(pool)',
    );
    expect(sqliteComposition).toContain(
      'createSqliteNotificationEntityLinkingRepository(sqlite)',
    );
  });

  it('selects real PostgreSQL composition without retired disable branches', () => {
    const entry = source(COMPOSITION_ROOT);
    expect(entry).toContain("import('@/lib/ai/durable-runs/packaged-worker')");
    expect(entry).toContain("import('@/lib/semantic-index/packaged-worker-runtime')");
    expect(entry).toContain('createPackagedDurableAiRuntime');
    expect(entry).toContain('createPackagedPostgresSemanticRuntime');
    expect(entry).toContain('composePostgresPackagedWorkflowCapability');
    expect(entry).toContain('PostgresWorkerProcessingLatch');
    expect(entry).toContain('processingLatch.activate');
    expect(entry).toContain('startAtomicWorkerComponents');
    expect(entry).not.toContain('legacy durable AI run worker is disabled on PostgreSQL');
  });

  it('requires every inherited repository in the atomic composition', () => {
    const entry = source(COMPOSITION_ROOT);
    for (const member of [
      'connectors',
      'syncRuns',
      'execution',
      'github',
      'connectorState',
      'notificationDelivery',
      'reminders',
      'triage',
      'planningSignals',
      'projectAutomation',
      'eventDelivery',
      'eventDelivery.outbox',
      'eventDelivery.subscriptions',
      'notificationEntityLinking',
      'notificationEnrichment',
      'finance',
      'finance.recovery',
    ]) {
      expect(entry).toContain(`workerPersistence.${member}`);
    }
    expect(entry).toContain("throw new Error('Selected worker persistence composition is incomplete')");
  });

  it('uses the same composition for production and guarded integration bootstraps', () => {
    const production = source(ROOT);
    const integration = source(INTEGRATION_ROOT);
    expect(production).toContain(
      "import { runPackagedSyncWorker } from '@/lib/runtime/packaged-sync-worker'",
    );
    expect(integration).toContain(
      "import { runPackagedSyncWorker } from '@/lib/runtime/packaged-sync-worker'",
    );
    expect(production).toContain('runPackagedSyncWorker()');
    expect(production).not.toContain('createCopilotClient');
    expect(integration).toContain('createCopilotClient:');
    expect(integration).toContain('MC_PACKAGED_WORKER_INTEGRATION');
  });
});
