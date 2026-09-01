import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = 'src/sync-worker.ts';
const POSTGRES_GATED_ENTRY_IMPORTS = new Set([
  '@/lib/ai/durable-runs',
  '@/lib/semantic-index/runtime',
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

function postgresStartupGraph(): Set<string> {
  const roots = dynamicImports(ROOT)
    .filter((specifier) => !POSTGRES_GATED_ENTRY_IMPORTS.has(specifier))
    .map((specifier) => resolveApplicationImport(ROOT, specifier))
    .filter((path): path is string => path !== null);
  const visited = new Set<string>([ROOT]);
  const pending = roots;
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of staticImports(path)) {
      const resolved = resolveApplicationImport(path, specifier);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

describe('Layer 8 final PostgreSQL worker persistence boundary', () => {
  it('keeps the real PostgreSQL startup graph free of SQLite evaluation', () => {
    const graph = postgresStartupGraph();
    const violations = [...graph].flatMap((path) => {
      return staticImports(path).filter((specifier) => {
        const resolved = resolveApplicationImport(path, specifier);
        return SQLITE_PACKAGE.test(specifier) || Boolean(resolved && SQLITE_MODULE.test(resolved));
      })
        .map((specifier) => `${path} -> ${specifier}`);
    });

    const configImporters = [...graph].filter((path) =>
      source(path).includes('config-resolver')
    );
    expect(violations, `AI config importers: ${configImporters.join(', ')}`).toEqual([]);
    expect(graph).toContain('src/lib/connectors/monarch-money/recovery-scheduler.ts');
    expect(graph).toContain('src/lib/telemetry/health-snapshot.ts');
    expect(graph).toContain('src/lib/triage/scheduler.ts');
  });

  it('gates only the two known SQLite-only worker features at the entry', () => {
    const entry = source(ROOT);
    const gated = dynamicImports(ROOT)
      .filter((specifier) => POSTGRES_GATED_ENTRY_IMPORTS.has(specifier));
    expect(new Set(gated)).toEqual(POSTGRES_GATED_ENTRY_IMPORTS);
    expect(entry).toContain("allowsLegacyWorkflow('semantic-search')");
    expect(entry).toContain('legacy durable AI run worker is disabled on PostgreSQL');
  });

  it('requires every inherited repository in the atomic composition', () => {
    const entry = source(ROOT);
    for (const member of [
      'connectors',
      'syncRuns',
      'execution',
      'github',
      'connectorState',
      'notificationDelivery',
      'reminders',
      'triage',
      'finance',
      'finance.recovery',
    ]) {
      expect(entry).toContain(`workerPersistence.${member}`);
    }
    expect(entry).toContain("throw new Error('Selected worker persistence composition is incomplete')");
  });
});
