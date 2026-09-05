import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const LEGACY_DRIVER_IMPORTS = new Set([
  'src/lib/ai/agents/maintenance.ts',
  // Documented edge helper: SQLite backup file verification, not persistence.
  // It produces the bounded, backend-neutral backup attestation the Layer 3B
  // recovery services consume, and nothing in the ports imports it.
  'src/lib/connectors/github-issues/backup-verifier.ts',
  'src/lib/seed-api.ts',
]);

const LEGACY_RAW_SQLITE_IMPORTS = new Set([
  'src/app/api/notifications/writebacks/route.ts',
  'src/lib/ai/agents/maintenance.ts',
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/durable-runs/sqlite-adapter.ts',
  'src/lib/ai/finance-approval-store.ts',
  'src/lib/connectors/monarch-money/identity-sqlite.ts',
  'src/lib/connectors/monarch-money/snapshot-sync.ts',
  'src/lib/external-agents/service.ts',
  'src/lib/finance/houston-tools.ts',
  'src/lib/finance/operations.ts',
  'src/lib/notifications/notification-writeback.ts',
  'src/lib/public-demo-runtime.ts',
  'src/lib/push/dispatcher.ts',
  'src/lib/search/semantic.ts',
  'src/lib/sync/control-state.ts',
  'src/lib/sync/maintenance-lock.ts',
  'src/lib/sync/operator-control.ts',
  'src/lib/telemetry/runtime.ts',
]);

const MIGRATED_CONNECTOR_EXECUTION_MODULES = [
  'src/lib/sync/conflict-resolution.ts',
  'src/lib/sync/deletion-detector.ts',
  'src/lib/sync/deletion-recovery.ts',
  'src/lib/sync/execution-pipeline.ts',
  'src/lib/sync/list-manager.ts',
  'src/lib/sync/pull-manager.ts',
  'src/lib/sync/push-lease.ts',
  'src/lib/sync/push-manager.ts',
  'src/lib/sync/retention-resolution.ts',
  'src/lib/sync/search-indexer.ts',
  'src/lib/sync/write-through-log.ts',
] as const;

/**
 * Layer 3A: the normal GitHub queue-execution modules. They may only reach the
 * database through `GitHubWorkerRepositories` (identity, write fence,
 * dependencies, hierarchy, projects), so a PostgreSQL sync worker never loads a
 * SQLite runtime or schema. Type-only `import type` from `@/db/schema` stays
 * allowed because it is erased at build time.
 */
const MIGRATED_GITHUB_WORKER_MODULES = [
  'src/lib/external-identities/github-write-fence.ts',
  'src/lib/external-identities/linked-source-identity.ts',
  'src/lib/external-identities/primary-identity.ts',
  'src/lib/external-identities/stable-identity-runtime.ts',
  'src/lib/external-identities/stable-lookup.ts',
  'src/lib/external-identities/worker-persistence.ts',
  'src/lib/sync/github-hierarchy-reconciliation.ts',
  'src/lib/sync/github-identity-context.ts',
  'src/lib/sync/github-project-association-identity.ts',
  'src/lib/sync/github-worker-persistence.ts',
  'src/lib/sync/task-dependency-manager.ts',
  // Layer 3B: GitHub operator recovery orchestration.
  'src/lib/connectors/github-issues/bulk-transfer-service.ts',
  'src/lib/connectors/github-issues/repoint-service.ts',
] as const;

/**
 * Surfaces Layer 3A deliberately leaves on SQLite-only legacy persistence.
 * They must fail closed under PostgreSQL before any remote effect, and the
 * migrated modules above must not import them at runtime.
 */
const LEGACY_GITHUB_OPERATOR_MODULES = [
  'src/lib/external-identities/github-backfill.ts',
  'src/lib/external-identities/identity-status.ts',
  'src/lib/external-identities/task-transfer-reconciliation.ts',
  'src/lib/external-identities/write-cycle-reconciliation.ts',
  'src/lib/external-identities/write-outcome-resolution.ts',
] as const;

/**
 * Layer 4: the non-finance connector-state modules. The whole Work To Do bridge
 * plus Microsoft To Do's hidden-list discovery and authenticated-user settings
 * write must reach the database only through the worker persistence
 * composition, so a PostgreSQL runtime never loads a SQLite adapter or schema.
 */
const MIGRATED_CONNECTOR_STATE_MODULES = [
  'src/lib/connectors/work-todo/service.ts',
  'src/lib/connectors/work-todo/index.ts',
  'src/lib/connectors/microsoft-todo/index.ts',
  'src/lib/connectors/rymessage/index.ts',
  'src/lib/connectors/document-intelligence/index.ts',
] as const;

/**
 * Layer 18: the webhook configuration/delivery/log surface. Every inbound and
 * outbound webhook route, both n8n routes, the RyMessage receiver, and the
 * per-connector receiver must reach the database only through the
 * `webhookIntegrations` worker persistence slot, so PostgreSQL selection never
 * imports, evaluates, or falls back to SQLite. `src/lib/integrations/n8n.ts` is
 * listed because it is the one shared library those routes still import.
 */
const MIGRATED_WEBHOOK_MODULES = [
  'src/app/api/inbound-webhooks/route.ts',
  'src/app/api/inbound-webhooks/[id]/route.ts',
  'src/app/api/inbound-webhooks/[id]/log/route.ts',
  'src/app/api/inbound-webhooks/[id]/receive/route.ts',
  'src/app/api/integrations/n8n/route.ts',
  'src/app/api/integrations/n8n/webhook/route.ts',
  'src/app/api/integrations/rymessage/route.ts',
  'src/app/api/integrations/webhooks/route.ts',
  'src/app/api/integrations/webhooks/[id]/route.ts',
  'src/app/api/integrations/webhooks/[id]/test/route.ts',
  'src/app/api/webhooks/[connectorId]/route.ts',
  'src/lib/integrations/n8n.ts',
] as const;

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

/**
 * True when `source` has a runtime (non-`import type`) import from
 * `better-sqlite3`. A leading `import type` clause is excluded because
 * TypeScript erases it entirely at build time and additionally rejects, at
 * compile time, any attempt to use a type-only binding in a value/runtime
 * expression (`new Database(...)`, `.prepare(...)`, etc.) — so this exclusion
 * cannot be used to smuggle in a live driver reference under a "type" label.
 * It is *not* excluded for a per-specifier inline `type` modifier mixed with
 * a real value binding in the same clause (e.g. `import Database, { type
 * Options } from 'better-sqlite3'`) or for a plain default/named import:
 * those clauses still bind a real, callable runtime value, so they must
 * still count as a driver import regardless of any `type` token elsewhere in
 * the same statement. See the "cannot be evaded by mixed type/value syntax"
 * test below.
 */
function importsRuntimeBetterSqlite3Driver(source: string): boolean {
  return /(?<!import type )(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]better-sqlite3['"]/.test(source);
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

  it('flags runtime better-sqlite3 imports but not a leading import type, and cannot be evaded by mixed type/value syntax', () => {
    // Genuine runtime imports: must be flagged regardless of default/named form.
    expect(importsRuntimeBetterSqlite3Driver("import Database from 'better-sqlite3';")).toBe(true);
    expect(importsRuntimeBetterSqlite3Driver("import { Database } from 'better-sqlite3';")).toBe(true);
    // A leading `import type` is erased at build time and cannot be used as a
    // value (a real construction under this alias is a compile error), so it
    // is correctly excluded.
    expect(importsRuntimeBetterSqlite3Driver("import type Database from 'better-sqlite3';")).toBe(false);
    expect(importsRuntimeBetterSqlite3Driver("import type { Database } from 'better-sqlite3';")).toBe(false);
    // Mixed clauses that still carry a real value binding alongside an inline
    // per-specifier `type` modifier must still be flagged: the `type`
    // modifier only erases that one named binding, not the whole statement,
    // so the default import remains a live, callable driver reference.
    expect(importsRuntimeBetterSqlite3Driver(
      "import Database, { type Options } from 'better-sqlite3';",
    )).toBe(true);
    expect(importsRuntimeBetterSqlite3Driver(
      "import { type Options, Database } from 'better-sqlite3';",
    )).toBe(true);
  });

  it('keeps direct better-sqlite3 imports inside adapters or documented exceptions', () => {
    // Group-2 SQLite-adapter-internal sync helpers use a leading `import
    // type` to type a transaction handle parameter without making the
    // module itself a runtime `better-sqlite3` importer; see
    // `importsRuntimeBetterSqlite3Driver` above for why this cannot be
    // gamed by mixed type/value syntax.
    const unexpected = sourceFiles.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const name = repoPath(path);
      return importsRuntimeBetterSqlite3Driver(source)
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

  it('keeps migrated connector execution modules behind persistence ports', () => {
    const violations = MIGRATED_CONNECTOR_EXECUTION_MODULES.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      return /from\s+['"]@\/db(?:['"]|\/(?:index|schema)(?:['"/]))/.test(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps migrated GitHub worker modules behind the GitHub persistence ports', () => {
    const violations = MIGRATED_GITHUB_WORKER_MODULES.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const runtimeDatabaseImport = new RegExp(
        String.raw`(?<!import type )(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@/db(?:['"]|/(?:index|schema)['"])`,
      );
      return runtimeDatabaseImport.test(source)
        || /from\s+['"]better-sqlite3['"]/.test(source)
        || /from\s+['"]pg['"]/.test(source)
        || importsRawSqliteHandle(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps GitHub operator surfaces out of the migrated worker modules', () => {
    const legacySpecifiers = LEGACY_GITHUB_OPERATOR_MODULES.map((path) =>
      path.replace(/^src\//, '@/').replace(/\.ts$/, ''));
    const violations = MIGRATED_GITHUB_WORKER_MODULES.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const offenders = legacySpecifiers.filter((specifier) => {
        const bare = specifier.replace(/^@\/lib\/(?:external-identities|connectors\/github-issues)\//, '');
        const runtimeImport = new RegExp(
          String.raw`(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"](?:${
            specifier.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
          }|\./${bare})['"]`,
        );
        return runtimeImport.test(source);
      });
      return offenders.length > 0 ? [`${path} -> ${offenders.join(', ')}`] : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps every GitHub worker persistence port free of driver imports', () => {
    const ports = [
      'src/db/persistence/github-worker.ts',
      'src/db/persistence/github-worker-errors.ts',
      'src/db/persistence/github-identity.ts',
      'src/db/persistence/github-dependencies.ts',
      'src/db/persistence/github-hierarchy.ts',
      'src/db/persistence/github-projects.ts',
      'src/db/persistence/github-recovery.ts',
      'src/db/persistence/github-recovery-values.ts',
      'src/db/persistence/github-transfer-succession.ts',
    ];
    const violations = ports.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      return /from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*)['"]/.test(source)
        || /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@\/db(?:['"]|\/index['"])/.test(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps migrated connector-state modules behind the persistence ports', () => {
    const violations = MIGRATED_CONNECTOR_STATE_MODULES.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const runtimeDatabaseImport = new RegExp(
        String.raw`(?<!import type )(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@/db(?:['"]|/(?:index|schema)['"])`,
      );
      const dynamicDatabaseImport = /import\(\s*['"]@\/db(?:\/(?:index|schema))?['"]\s*\)/;
      return runtimeDatabaseImport.test(source)
        || dynamicDatabaseImport.test(source)
        || /from\s+['"]pg['"]/.test(source)
        || importsRawSqliteHandle(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the Layer 4 connector-state ports free of driver imports', () => {
    const ports = [
      'src/db/persistence/work-todo.ts',
      'src/db/persistence/work-todo-values.ts',
      'src/db/persistence/task-deletion.ts',
    ];
    const violations = ports.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      return /from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*)['"]/.test(source)
        || /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@\/db(?:['"]|\/(?:index|schema)['"])/.test(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the migrated webhook routes behind the webhook persistence port', () => {
    const violations = MIGRATED_WEBHOOK_MODULES.flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const runtimeDatabaseImport = new RegExp(
        String.raw`(?<!import type )(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@/db(?:['"]|/(?:index|schema)['"])`,
      );
      const dynamicDatabaseImport = /import\(\s*['"]@\/db(?:\/(?:index|schema))?['"]\s*\)/;
      return runtimeDatabaseImport.test(source)
        || dynamicDatabaseImport.test(source)
        || /from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*)['"]/.test(source)
        || importsRawSqliteHandle(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the Layer 18 webhook port free of driver imports', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/db/persistence/webhook-integrations.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*)['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"]|\/)/);
    expect(importsRawSqliteHandle(source)).toBe(false);
  });

  it('keeps the PostgreSQL webhook adapter off every SQLite module', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/db/postgres/repositories/webhook-integrations-repository.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"](?:better-sqlite3|drizzle-orm\/better-sqlite3)['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"]|\/(?:index|schema)['"])/);
    expect(importsRawSqliteHandle(source)).toBe(false);
  });

  /**
   * Task deletion has one canonical cleanup per backend. The core task
   * repository, connector execution, and the Work To Do bridge must all reuse
   * it, otherwise a deleted task leaves planning, audit, provenance, or
   * notification references behind on whichever path drifted.
   */
  describe('canonical task deletion cleanup', () => {
    const SQLITE_DELETION_CONSUMERS = [
      'src/db/persistence/sqlite-core-repositories.ts',
      'src/db/persistence/sqlite-connector-execution-repositories.ts',
      'src/db/persistence/sqlite-work-todo-repositories.ts',
    ] as const;

    const POSTGRES_DELETION_CONSUMERS = [
      'src/db/postgres/repositories/task-repository.ts',
      'src/db/postgres/repositories/connector-execution-repositories.ts',
      'src/db/postgres/repositories/work-todo-repositories.ts',
    ] as const;

    /**
     * Tables that only ever appear in deletion cleanup — a `DELETE ... WHERE
     * task_id` for one of these outside the shared helpers is a drifting copy.
     */
    const DELETION_ONLY_TABLES = [
      'my_day_items',
      'my_day_exclusions',
      'focus_items',
      'weekly_one_thing',
      'priority_sync_log',
      'task_triage_log',
      'quick_sort_operations',
      'task_linked_sources',
      'task_attachments',
      'project_phase_items',
      'sync_deletion_candidates',
    ] as const;

    it('covers every canonical association in the shared table list', () => {
      const shared = readFileSync(
        join(process.cwd(), 'src/db/persistence/task-deletion.ts'),
        'utf8',
      );
      for (const table of [...DELETION_ONLY_TABLES, 'task_tags', 'task_projects',
        'task_schedules', 'task_field_states', 'project_auto_include_exclusions']) {
        expect(shared).toContain(`'${table}'`);
      }
    });

    it('routes both backends through the shared cleanup helpers', () => {
      for (const path of SQLITE_DELETION_CONSUMERS) {
        const source = readFileSync(join(process.cwd(), path), 'utf8');
        expect(source).toMatch(/from\s+['"]\.\/sqlite-task-deletion['"]/);
      }
      for (const path of POSTGRES_DELETION_CONSUMERS) {
        const source = readFileSync(join(process.cwd(), path), 'utf8');
        expect(source).toMatch(/from\s+['"]\.\/task-deletion['"]/);
      }
    });

    it('keeps duplicated per-table deletion lists out of the consumers', () => {
      const violations = [...SQLITE_DELETION_CONSUMERS, ...POSTGRES_DELETION_CONSUMERS]
        .flatMap((path) => {
          const source = readFileSync(join(process.cwd(), path), 'utf8');
          return DELETION_ONLY_TABLES
            .filter((table) => new RegExp(
              String.raw`DELETE FROM ${table}\s+WHERE task_id`,
            ).test(source))
            .map((table) => `${path} -> ${table}`);
        });

      expect(violations).toEqual([]);
    });
  });

  /**
   * The optional Rymessage source-side SQLite reader is an *external* connector
   * transport (it opens RyMessage's own database file); it is never Mission
   * Control persistence, and nothing in the ports may import it.
   */
  it('keeps the external Rymessage SQLite transport out of Mission Control persistence', () => {
    const client = readFileSync(
      join(process.cwd(), 'src/lib/connectors/rymessage/rymessage-client.ts'),
      'utf8',
    );
    expect(client).toMatch(/import\(\s*'better-sqlite3'\s*\)/);
    expect(importsRawSqliteHandle(client)).toBe(false);
    expect(client).not.toMatch(/from\s+['"]@\/db(?:['"]|\/)/);

    const importers = sourceFiles.filter((path) => {
      const name = repoPath(path);
      if (name === 'src/lib/connectors/rymessage/rymessage-client.ts') return false;
      return /from\s+['"][^'"]*rymessage-client['"]/
        .test(readFileSync(path, 'utf8'));
    }).map(repoPath);
    expect(importers).toEqual(['src/lib/connectors/rymessage/index.ts']);
  });
});
