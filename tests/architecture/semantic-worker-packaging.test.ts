import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = 'src/semantic-worker-harness.ts';
const SQLITE_MODULE = /(?:^|\/)(?:db\/(?:index|schema)(?:\.ts|\/)|[^/]*sqlite[^/]*\.ts$)/;
const SQLITE_PACKAGE = /^(?:better-sqlite3|drizzle-orm\/better-sqlite3)$/;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

interface ApplicationImport {
  specifier: string;
  dynamic: boolean;
  reexport: boolean;
}

function applicationImports(path: string): ApplicationImport[] {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  const imports: ApplicationImport[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const onlyNamedTypes = clause?.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && !clause.name
        && clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (
        !clause?.isTypeOnly
        && !onlyNamedTypes
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push({
          specifier: node.moduleSpecifier.text,
          dynamic: false,
          reexport: false,
        });
      }
    } else if (
      ts.isExportDeclaration(node)
      && !node.isTypeOnly
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        dynamic: false,
        reexport: true,
      });
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        dynamic: true,
        reexport: false,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

function staticImports(path: string): string[] {
  return applicationImports(path)
    .filter((entry) => !entry.dynamic)
    .map((entry) => entry.specifier);
}

function resolveApplicationImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? resolve(process.cwd(), 'src', specifier.slice(2))
    : resolve(dirname(resolve(process.cwd(), fromPath)), specifier);
  const extension = extname(base);
  const candidates = extension
    ? [
        base,
        ...(['.js', '.mjs', '.cjs'].includes(extension)
          ? ['.ts', '.tsx', '.mts', '.cts'].map(
              (sourceExtension) => `${base.slice(0, -extension.length)}${sourceExtension}`,
            )
          : []),
      ]
    : [
        ...['.ts', '.tsx', '.mts', '.cts'].map((sourceExtension) => `${base}${sourceExtension}`),
        ...['.ts', '.tsx', '.mts', '.cts'].map(
          (sourceExtension) => resolve(base, `index${sourceExtension}`),
        ),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate.slice(resolve(process.cwd()).length + 1).replaceAll('\\', '/');
    }
  }
  return null;
}

function sqliteImportViolations(graph: ReadonlySet<string>): string[] {
  return [...graph].flatMap((path) =>
    staticImports(path).flatMap((specifier) => {
      const resolved = resolveApplicationImport(path, specifier);
      return SQLITE_PACKAGE.test(specifier) || Boolean(resolved && SQLITE_MODULE.test(resolved))
        ? [`${path} -> ${specifier}`]
        : [];
    }),
  );
}

function applicationGraph(root = ROOT, includeDynamic = false): Set<string> {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const { specifier, dynamic } of applicationImports(path)) {
      if (dynamic && !includeDynamic) continue;
      const resolved = resolveApplicationImport(path, specifier);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

describe('Layer 6 semantic worker package boundary', () => {
  it('composes the real PostgreSQL semantic worker without an eager SQLite import edge', () => {
    const graph = applicationGraph();

    expect(sqliteImportViolations(graph)).toEqual([]);
    expect(graph).toContain('src/db/postgres/semantic-index/repository.ts');
    expect(graph).toContain('src/db/postgres/semantic-index/source-port.ts');
    expect(graph).toContain('src/lib/semantic-index/service.ts');
    expect(graph).toContain('src/lib/semantic-index/worker.ts');
    expect(graph).toContain('src/lib/semantic-index/embedding-provider.ts');
    expect(graph).toContain('src/lib/search/embedding-transport.ts');
    expect(graph).toContain('src/lib/non-production-database-target.ts');
    expect(graph).not.toContain('src/lib/semantic-index/runtime.ts');
    expect(graph).not.toContain('src/lib/ai/config-resolver.ts');
  });

  it('makes the packaged provider default lazy while the harness injects its explicit route', () => {
    const completeGraph = applicationGraph(ROOT, true);
    expect(completeGraph).toContain('src/lib/search/embedding-request.ts');
    expect(completeGraph).not.toContain('src/lib/ai/config-resolver.ts');
    expect(completeGraph).toContain('src/lib/ai/provider-configuration-service.ts');
    expect(source('src/lib/semantic-index/embedding-provider.ts'))
      .toContain("await import('@/lib/search/embedding-request')");
    expect(source(ROOT)).toContain('getEmbeddingConfig: async');
  });

  it('detects forbidden SQLite dependencies reachable only through re-exports', () => {
    const root = 'src/db/schema/index.ts';
    const edges = applicationImports(root).filter((entry) => !entry.dynamic);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((entry) => entry.reexport)).toBe(true);

    const graph = applicationGraph(root);
    expect(graph.size).toBeGreaterThan(1);
    expect(sqliteImportViolations(graph).length).toBeGreaterThan(0);
  });

  it('keeps the harness inaccessible to normal and non-PostgreSQL execution', () => {
    const entry = source(ROOT);
    expect(entry).toContain("process.env.NODE_ENV !== 'test'");
    expect(entry).toContain("MC_SEMANTIC_PACKAGED_HARNESS !== HARNESS_TOKEN");
    expect(entry).toContain("process.env.MC_DATABASE_BACKEND !== 'postgres'");
    expect(entry).toContain('connectionString !== process.env.MC_TEST_POSTGRES_URL');
    expect(entry).toContain('embedding route must be loopback-only');
    expect(entry).toContain('MC_SEMANTIC_HARNESS_CRASH_AFTER_RUN_CHECKPOINT');

    const normalWorker = source('src/lib/runtime/packaged-sync-worker.ts');
    expect(normalWorker).toContain(
      "import('@/lib/semantic-index/packaged-worker-runtime')",
    );
    expect(normalWorker).toContain('createPackagedPostgresSemanticRuntime');
    expect(normalWorker).toContain("isParityActive('semantic-search')");
    expect(normalWorker).not.toContain('MC_SEMANTIC_PACKAGED_HARNESS');
    expect(source('src/lib/semantic-index/runtime.ts')).not.toContain('onRunCheckpointed');
    const normalWorkerGraph = applicationGraph('src/sync-worker.ts', true);
    expect(normalWorkerGraph.size).toBeGreaterThan(1);
    expect(normalWorkerGraph)
      .not.toContain('src/lib/non-production-database-target.ts');
  });
});
