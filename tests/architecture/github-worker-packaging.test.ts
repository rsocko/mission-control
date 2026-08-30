import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layer 3A packaging reachability guard.
 *
 * The packaged sync worker is a single bundle that must run against either
 * backend. These checks assert, statically, that the PostgreSQL half of the
 * GitHub worker composition never pulls a SQLite adapter, a raw `sqlite`
 * handle, or `better-sqlite3` into its module graph, and that the SQLite half
 * never pulls `pg` in. `@/lib/persistence/worker-runtime` is the only place
 * allowed to reach a SQLite adapter, and it does so behind a dynamic import so
 * a PostgreSQL worker never evaluates it.
 */

const POSTGRES_GITHUB_ADAPTERS = [
  'src/db/postgres/repositories/github-identity-repositories.ts',
  'src/db/postgres/repositories/github-dependency-repositories.ts',
  'src/db/postgres/repositories/github-hierarchy-repositories.ts',
  'src/db/postgres/repositories/github-project-repositories.ts',
  'src/db/postgres/repositories/connector-execution-repositories.ts',
  'src/db/postgres/repositories/index.ts',
];

const SQLITE_GITHUB_ADAPTERS = [
  'src/db/persistence/sqlite-github-identity-repositories.ts',
  'src/db/persistence/sqlite-github-dependency-repositories.ts',
  'src/db/persistence/sqlite-github-hierarchy-repositories.ts',
  'src/db/persistence/sqlite-github-project-repositories.ts',
];

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('sync worker persistence packaging reachability', () => {
  it('keeps SQLite out of every PostgreSQL GitHub adapter module graph', () => {
    const violations = POSTGRES_GITHUB_ADAPTERS.flatMap((path) => {
      const source = read(path);
      return /from\s+['"]better-sqlite3['"]/.test(source)
        || /from\s+['"][^'"]*sqlite-[^'"]*['"]/.test(source)
        || /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"]@\/db(?:['"]|\/index['"])/.test(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the pg driver out of every SQLite GitHub adapter', () => {
    const violations = SQLITE_GITHUB_ADAPTERS.flatMap((path) => (
      /from\s+['"]pg['"]/.test(read(path)) ? [path] : []
    ));

    expect(violations).toEqual([]);
  });

  it('only reaches SQLite adapters through the lazy worker runtime composition', () => {
    const sourceFiles = listTypeScriptFiles(join(process.cwd(), 'src'));
    const offenders = sourceFiles.flatMap((absolute) => {
      const path = relative(process.cwd(), absolute).split(sep).join('/');
      if (path.startsWith('src/db/')) return [];
      if (path === 'src/lib/persistence/worker-runtime.ts') return [];
      const source = readFileSync(absolute, 'utf8');
      return /(?:^|\n)import\s+[^;]*?from\s+['"]@\/db\/persistence\/sqlite-github-[^'"]+['"]/
        .test(source)
        ? [path]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it('loads the SQLite GitHub adapters through dynamic imports only', () => {
    const runtime = read('src/lib/persistence/worker-runtime.ts');
    for (const adapter of [
      'sqlite-github-identity-repositories',
      'sqlite-github-dependency-repositories',
      'sqlite-github-hierarchy-repositories',
      'sqlite-github-project-repositories',
    ]) {
      expect(runtime).toContain(`import('@/db/persistence/${adapter}')`);
      expect(runtime).not.toMatch(
        new RegExp(String.raw`(?:^|\n)import\s+[^;]*?from\s+['"]@/db/persistence/${adapter}['"]`),
      );
    }
  });

  it('registers the GitHub worker composition atomically for PostgreSQL', () => {
    const index = read('src/db/postgres/repositories/index.ts');
    expect(index).toContain('export function createPostgresGitHubWorkerRepositories');
    expect(index).toContain('github: createPostgresGitHubWorkerRepositories(pool)');

    const worker = read('src/sync-worker.ts');
    expect(worker).toContain('githubWorkerCompositionPresent');
    expect(worker).toMatch(/startDependencyReconciliationResume\(\)/);
  });
});
