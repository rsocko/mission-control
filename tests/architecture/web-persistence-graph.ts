import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Backend-neutral static import-graph census over `src/**\/*.{ts,tsx}`,
 * ported from the approved planning session's `tiers.mjs` (the script that
 * produced the committed baseline numbers in the migration plan). This is a
 * pure, dependency-free module (only `node:fs`/`node:path`) so it can run
 * both inside `vitest` (for the recomputation ratchet test) and directly
 * under plain `node` (for regenerating the committed baseline JSON when a
 * later layer legitimately shrinks the taint footprint).
 *
 * Taint propagates backward, by static import, from every module that
 * evaluates `@/db` (`src/db/index.ts`) or a SQLite driver package at import
 * time (Tier A) or only via a dynamic `import()`/`require()` (Tier B, which
 * fails at *call* time instead of *import* time). Type-only `import type`
 * clauses are excluded, matching the source semantics: they are erased
 * entirely at build time and never evaluate anything at runtime.
 */

export interface ImportEdge {
  target: string;
  dynamic: boolean;
  spec: string;
}

export interface WebPersistenceGraphResult {
  /** Files that evaluate `@/db` or a SQLite driver at static-import time. */
  staticSources: string[];
  /** Files that reach a SQLite driver only through a dynamic `import()`. */
  dynamicSources: string[];
  /** Every `src/app/api/**\/route.ts(x)` file. */
  apiRoutes: string[];
  /** API routes that transitively fail at *import* time under PostgreSQL. */
  tierARoutes: string[];
  /** API routes tainted only through a deferred/dynamic edge (call-time). */
  tierBRoutes: string[];
  /** API routes reachable from neither Tier A nor Tier B taint sources. */
  cleanRoutes: string[];
  /**
   * Tier A routes whose own file has a resolved, static edge whose target is
   * literally one of `staticSources` (i.e. reach a confirmed Tier A taint
   * source in exactly one hop). This is an exact partition of `tierARoutes`
   * (`directTaintSourceRoutes.length + transitiveOnlyTaintSourceRoutes.length
   * === tierARoutes.length` always holds, by construction).
   *
   * This is a *different, newly-derived* metric from the plan's committed
   * "144 direct / 79 transitive-only" figures (which come from the planning
   * session's separate `reach2.mjs` script and its own `directDb` namespace
   * check - see `directDbNamespaceRoutes` below). Do not conflate the two:
   * see `docs/architecture/persistence-boundaries.md` for the full
   * reconciliation of why they differ and by exactly which files.
   */
  directTaintSourceRoutes: string[];
  /** Tier A routes not in `directTaintSourceRoutes` (tainted only transitively). */
  transitiveOnlyTaintSourceRoutes: string[];
  /**
   * Every API route (any tier) whose own file has a resolved, *static*
   * import edge whose original specifier text matches `/^@\/db(\/|$)/`
   * (i.e. imports directly from the `@/db` namespace, regardless of
   * whether that specific submodule itself reaches a taint source). This
   * is a faithful port of the planning session's archived `reach2.mjs`
   * `directDb` check and reproduces its committed baseline value (144)
   * exactly. It is a structural/namespace metric, not a Tier A membership
   * test: it is not guaranteed to be a subset of `tierARoutes` (one
   * route reaches this count via a `@/db/persistence/*` submodule that
   * does not itself reach any taint source, while the route's *only* real
   * taint path is a Tier B dynamic edge - see
   * `docs/architecture/persistence-boundaries.md`).
   */
  directDbNamespaceRoutes: string[];
  /** Tainted (Tier A) `src/lib/**` modules. */
  taintedLibA: string[];
  /** Tainted (Tier A) `src/app/api/**` files that are not routes themselves. */
  taintedApiHelpers: string[];
  /**
   * `tierARoutes.length + taintedLibA.length + taintedApiHelpers.length` -
   * the same "definitely broken at import time" unit count the plan commits
   * as the total migration-unit budget. Tier B routes are tracked as their
   * own separate, independently-ratcheted count rather than folded into
   * this total, matching the approved plan's own accounting.
   */
  totalMigrationUnits: number;
}

export function normalizeRepoPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

// The clause is deliberately `[^;]*?` rather than `[\s\S]*?`: a lazy
// dot-all clause can span past an unrelated statement (e.g.
// `export type Foo = string;\nexport { Bar } from './bar';`) to reach a
// *later* `from` clause that belongs to a different statement, merging the
// two into one match and causing `clauseIsTypeOnly` to misjudge a real
// value-level import/export as type-only. No import/export...from clause
// in this codebase's style contains a bare `;` before its own `from`
// keyword (multi-line named-binding lists never do), so this bound cannot
// clip a legitimate clause while it prevents the clause from ever
// swallowing an intervening statement's terminator.
const IMPORT_COMMENT_TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const IMPORT_STATEMENT_RE = new RegExp(
  String.raw`(?:^|[;\n])[ \t]*(?:import|export)\b([^;]*?)from${IMPORT_COMMENT_TRIVIA}['"]([^'"]+)['"]`,
  'g',
);
const BARE_IMPORT_RE = new RegExp(
  String.raw`(?:^|[;\n])[ \t]*import${IMPORT_COMMENT_TRIVIA}['"]([^'"]+)['"]`,
  'g',
);
const DYNAMIC_IMPORT_RE = new RegExp(
  String.raw`import${IMPORT_COMMENT_TRIVIA}\(${IMPORT_COMMENT_TRIVIA}['"]([^'"]+)['"]`,
  'g',
);
const REQUIRE_RE = new RegExp(
  String.raw`require${IMPORT_COMMENT_TRIVIA}\(${IMPORT_COMMENT_TRIVIA}['"]([^'"]+)['"]`,
  'g',
);

function maskComments(source: string): string {
  const masked = [...source];
  let quote: "'" | '"' | '`' | null = null;

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    const next = masked[index + 1];

    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 2;
      while (index < masked.length && masked[index] !== '\n' && masked[index] !== '\r') {
        masked[index] = ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (char === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 2;
      while (index < masked.length) {
        if (masked[index] === '*' && masked[index + 1] === '/') {
          masked[index] = ' ';
          masked[index + 1] = ' ';
          index += 1;
          break;
        }
        if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
        index += 1;
      }
    }
  }

  return masked.join('');
}

function clauseIsTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  if (braced) {
    const inner = braced[1].split(',').map((s) => s.trim()).filter(Boolean);
    return inner.length > 0 && inner.every((binding) => /^type\s/.test(binding));
  }
  return false;
}

function isSqliteDriverSpecifier(specifier: string): boolean {
  return specifier === 'better-sqlite3' || specifier.startsWith('drizzle-orm/better-sqlite3');
}

// Faithful port of the planning session's archived reach2.mjs `directDb` check.
const DB_NAMESPACE_SPECIFIER_RE = /^@\/db(\/|$)/;

/**
 * Runs the full census against `root` (a repository root containing `src/`).
 * Every returned path array is repo-relative with `/` separators and sorted,
 * so the result is byte-for-byte deterministic across platforms and runs.
 */
export function computeWebPersistenceGraph(root: string): WebPersistenceGraphResult {
  const toRepoRelative = (path: string): string => normalizeRepoPath(relative(root, path));
  const files = listTypeScriptFiles(join(root, 'src')).map(toRepoRelative);
  const fileSet = new Set(files);

  function resolveSpecifier(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) {
      base = `src/${spec.slice(2)}`;
    } else if (spec.startsWith('.')) {
      base = normalizeRepoPath(relative(root, resolve(dirname(join(root, fromFile)), spec)));
    } else {
      return null;
    }
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
  }

  const edges = new Map<string, ImportEdge[]>();
  const externalStatic = new Map<string, Set<string>>();
  const externalDynamic = new Map<string, Set<string>>();

  for (const name of files) {
    const source = readFileSync(join(root, name), 'utf8');
    const syntaxSource = maskComments(source);
    const out: ImportEdge[] = [];
    const extStatic = new Set<string>();
    const extDynamic = new Set<string>();

    for (const match of syntaxSource.matchAll(IMPORT_STATEMENT_RE)) {
      if (clauseIsTypeOnly(match[1])) continue;
      const target = resolveSpecifier(name, match[2]);
      if (target) out.push({ target, dynamic: false, spec: match[2] });
      else extStatic.add(match[2]);
    }
    for (const match of syntaxSource.matchAll(BARE_IMPORT_RE)) {
      const target = resolveSpecifier(name, match[1]);
      if (target) out.push({ target, dynamic: false, spec: match[1] });
      else extStatic.add(match[1]);
    }
    for (const re of [DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
      for (const match of syntaxSource.matchAll(re)) {
        const target = resolveSpecifier(name, match[1]);
        if (target) out.push({ target, dynamic: true, spec: match[1] });
        else extDynamic.add(match[1]);
      }
    }

    edges.set(name, out);
    externalStatic.set(name, extStatic);
    externalDynamic.set(name, extDynamic);
  }

  const staticSources = files.filter((f) =>
    f === 'src/db/index.ts' || [...(externalStatic.get(f) ?? [])].some(isSqliteDriverSpecifier));
  const dynamicSources = files.filter((f) =>
    !staticSources.includes(f) && [...(externalDynamic.get(f) ?? [])].some(isSqliteDriverSpecifier));

  function propagate(seeds: string[], followDynamicEdges: boolean): Set<string> {
    const reverse = new Map<string, string[]>();
    for (const [from, outs] of edges) {
      for (const edge of outs) {
        if (edge.dynamic && !followDynamicEdges) continue;
        if (!reverse.has(edge.target)) reverse.set(edge.target, []);
        reverse.get(edge.target)!.push(from);
      }
    }
    const seen = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const current = queue.shift()!;
      for (const parent of reverse.get(current) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  }

  const apiRoutes = files.filter((p) => /^src\/app\/api\/.*\/route\.tsx?$/.test(p));

  // Tier A: pure module-eval taint (static edges, static seeds only) - fails at import time.
  const tierA = propagate(staticSources, false);
  // Tier B: adds deferred paths (dynamic edges and dynamic driver seeds) - fails at call time.
  const tierB = propagate([...staticSources, ...dynamicSources], true);

  const tierARoutes = apiRoutes.filter((r) => tierA.has(r)).sort();
  const tierBRoutes = apiRoutes.filter((r) => !tierA.has(r) && tierB.has(r)).sort();
  const cleanRoutes = apiRoutes.filter((r) => !tierB.has(r)).sort();

  const staticSourceSet = new Set(staticSources);
  const directTaintSourceRoutes = tierARoutes.filter((r) =>
    (edges.get(r) ?? []).some((edge) => !edge.dynamic && staticSourceSet.has(edge.target))).sort();
  const directTaintSourceRouteSet = new Set(directTaintSourceRoutes);
  const transitiveOnlyTaintSourceRoutes = tierARoutes.filter((r) => !directTaintSourceRouteSet.has(r)).sort();

  const directDbNamespaceRoutes = apiRoutes.filter((r) =>
    (edges.get(r) ?? []).some((edge) => !edge.dynamic && DB_NAMESPACE_SPECIFIER_RE.test(edge.spec))).sort();

  const taintedLibA = [...tierA].filter((f) => f.startsWith('src/lib/')).sort();
  // Scoped to src/app/api/** (not all of src/app/**) to match this field's
  // documented contract: a tainted src/app/**/page.tsx or layout.tsx is
  // neither an API route nor a "shared API helper" and must not be silently
  // folded into this bucket.
  const taintedApiHelpers = [...tierA]
    .filter((f) => f.startsWith('src/app/api/') && !/route\.tsx?$/.test(f))
    .sort();

  return {
    staticSources: [...staticSources].sort(),
    dynamicSources: [...dynamicSources].sort(),
    apiRoutes: [...apiRoutes].sort(),
    tierARoutes,
    tierBRoutes,
    cleanRoutes,
    directTaintSourceRoutes,
    transitiveOnlyTaintSourceRoutes,
    directDbNamespaceRoutes,
    taintedLibA,
    taintedApiHelpers,
    totalMigrationUnits: tierARoutes.length + taintedLibA.length + taintedApiHelpers.length,
  };
}
