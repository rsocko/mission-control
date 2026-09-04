import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Poisoned-SQLite PostgreSQL proof: verifies that notification web routes
 * and their service can be imported without evaluating `@/db` (the
 * SQLite-backed Drizzle handle).
 */

const ROUTES = [
  'src/app/api/notifications/[id]/snooze/route.ts',
  'src/app/api/notifications/bulk/route.ts',
  'src/app/api/notifications/route.ts',
  'src/app/api/notifications/views/[id]/route.ts',
  'src/app/api/notifications/views/route.ts',
  'src/app/api/notifications/writebacks/route.ts',
  'src/app/api/push/subscribe/route.ts',
];

const PERSISTENCE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;
const DB_HANDLE_SPECIFIER = /^@\/db$/;
const SQLITE_DRIVER = /^(better-sqlite3|drizzle-orm\/better-sqlite3)/;

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(PERSISTENCE_IMPORT)) {
    const clause = source
      .slice(match.index ?? 0, (match.index ?? 0) + match[0].length)
      .replace(/from\s*['"][^'"]+['"]$/, '');
    const typeOnly = /\bimport\s+type\b|\bexport\s+type\b/.test(clause)
      || (() => {
        const bindings = clause.match(/\{([\s\S]*)\}/);
        if (!bindings) return false;
        const inner = bindings[1].split(',').map(s => s.trim()).filter(Boolean);
        return inner.length > 0 && inner.every(part => /^type\s/.test(part));
      })();
    if (!typeOnly) specifiers.push(match[1]);
  }
  return specifiers;
}

describe('notification web PostgreSQL import safety', () => {
  it.each(ROUTES)('%s does not statically import @/db or a SQLite driver', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    const forbidden = valueImportSpecifiers(source)
      .filter(spec => DB_HANDLE_SPECIFIER.test(spec) || SQLITE_DRIVER.test(spec));
    expect(forbidden).toEqual([]);
  });

  it('notification-web-service.ts does not import @/db or a SQLite driver', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/notifications/notification-web-service.ts'),
      'utf8',
    );
    const forbidden = valueImportSpecifiers(source)
      .filter(spec => DB_HANDLE_SPECIFIER.test(spec) || SQLITE_DRIVER.test(spec));
    expect(forbidden).toEqual([]);
  });

  it('notification-writeback.ts does not statically import @/db or a SQLite driver', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/notifications/notification-writeback.ts'),
      'utf8',
    );
    const forbidden = valueImportSpecifiers(source)
      .filter(spec => DB_HANDLE_SPECIFIER.test(spec) || SQLITE_DRIVER.test(spec));
    expect(forbidden).toEqual([]);
  });
});
