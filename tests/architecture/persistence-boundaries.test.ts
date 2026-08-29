import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const LEGACY_DRIVER_IMPORTS = new Set([
  'src/lib/ai/agents/maintenance.ts',
  'src/lib/connectors/github-issues/repoint-service.ts',
  'src/lib/seed-api.ts',
]);

const LEGACY_RAW_SQLITE_IMPORTS = new Set([
  'src/app/api/inbound-webhooks/[id]/receive/route.ts',
  'src/app/api/notifications/writebacks/route.ts',
  'src/lib/ai/agents/maintenance.ts',
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/durable-runs/store.ts',
  'src/lib/ai/finance-approval-store.ts',
  'src/lib/connectors/github-issues/bulk-transfer-service.ts',
  'src/lib/connectors/github-issues/repoint-service.ts',
  'src/lib/connectors/monarch-money/attribution-service.ts',
  'src/lib/connectors/monarch-money/dataset-sync.ts',
  'src/lib/connectors/monarch-money/finance-insight-history-sync.ts',
  'src/lib/connectors/monarch-money/identity.ts',
  'src/lib/connectors/monarch-money/snapshot-sync.ts',
  'src/lib/connectors/monarch-money/transaction-backfill.ts',
  'src/lib/connectors/shared/connector-config-store.ts',
  'src/lib/external-agents/service.ts',
  'src/lib/external-identities/github-backfill.ts',
  'src/lib/external-identities/github-write-fence.ts',
  'src/lib/external-identities/identity-status.ts',
  'src/lib/external-identities/linked-source-identity.ts',
  'src/lib/external-identities/stable-identity-runtime.ts',
  'src/lib/external-identities/stable-lookup.ts',
  'src/lib/external-identities/write-cycle-reconciliation.ts',
  'src/lib/external-identities/write-outcome-resolution.ts',
  'src/lib/finance-insights/cutover-operator.ts',
  'src/lib/finance-insights/cutover.ts',
  'src/lib/finance-insights/notification-ingestion.ts',
  'src/lib/finance-insights/occurrence-cache.ts',
  'src/lib/finance-insights/orchestrator.ts',
  'src/lib/finance-insights/publication.ts',
  'src/lib/finance/attention-repair.ts',
  'src/lib/finance/attention-routing.ts',
  'src/lib/finance/houston-tools.ts',
  'src/lib/finance/operations.ts',
  'src/lib/notifications/notification-writeback.ts',
  'src/lib/public-demo-runtime.ts',
  'src/lib/push/dispatcher.ts',
  'src/lib/search/semantic.ts',
  'src/lib/sync/control-state.ts',
  'src/lib/sync/deletion-detector.ts',
  'src/lib/sync/github-hierarchy-reconciliation.ts',
  'src/lib/sync/maintenance-lock.ts',
  'src/lib/sync/operator-control.ts',
  'src/lib/telemetry/runtime.ts',
]);

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx'))
      ? [path]
      : [];
  });
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/');
}

function isSqliteAdapter(path: string): boolean {
  return path.startsWith('src/db/')
    || path.includes('/sqlite-')
    || path === 'src/lib/persistence/runtime.ts'
    || path === 'src/lib/telemetry/database-health-runtime.ts';
}

function importsRawSqliteHandle(source: string): boolean {
  const databaseImport = /import\s+([^'"]+?)\s+from\s+['"](?:@\/db(?:\/index)?|(?:\.\.?\/)+db(?:\/index)?)['"]/g;
  return Array.from(source.matchAll(databaseImport), (match) => match[1])
    .some((bindings) => {
      if (/\bsqlite\b/.test(bindings)) return true;
      const namespace = bindings.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (namespace) {
        return new RegExp(`\\b${namespace[1]}\\s*\\.\\s*sqlite\\b`).test(source);
      }
      const defaultImport = bindings.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      return defaultImport
        ? new RegExp(`\\b${defaultImport[1]}\\s*\\.\\s*sqlite\\b`).test(source)
        : false;
    });
}

describe('portable persistence dependency ratchet', () => {
  const sourceFiles = listTypeScriptFiles(join(process.cwd(), 'src'));

  it('detects named, aliased, namespace, and default raw-handle imports', () => {
    expect(importsRawSqliteHandle("import { sqlite } from '@/db';")).toBe(true);
    expect(importsRawSqliteHandle("import { sqlite as database } from '@/db';")).toBe(true);
    expect(importsRawSqliteHandle(
      "import * as database from '@/db'; database.sqlite.prepare('SELECT 1');",
    )).toBe(true);
    expect(importsRawSqliteHandle(
      "import database from '../db'; database.sqlite.prepare('SELECT 1');",
    )).toBe(true);
    expect(importsRawSqliteHandle(
      "import * as database from '@/db'; database.db.query.tasks.findMany();",
    )).toBe(false);
  });

  it('keeps direct better-sqlite3 imports inside adapters or documented exceptions', () => {
    const unexpected = sourceFiles.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const name = repoPath(path);
      return source.match(/from\s+['"]better-sqlite3['"]/)
        && !isSqliteAdapter(name)
        && !LEGACY_DRIVER_IMPORTS.has(name)
        ? [name]
        : [];
    });

    expect(unexpected).toEqual([]);
  });

  it('keeps new raw sqlite handle imports inside adapters', () => {
    const unexpected = sourceFiles.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const name = repoPath(path);
      return importsRawSqliteHandle(source)
        && !isSqliteAdapter(name)
        && !LEGACY_RAW_SQLITE_IMPORTS.has(name)
        ? [name]
        : [];
    });

    expect(unexpected).toEqual([]);
  });
});
