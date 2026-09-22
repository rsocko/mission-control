import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeWebPersistenceGraph, normalizeRepoPath } from '../tests/architecture/web-persistence-graph.ts';

export const POSTGRES_ROUTE_BASELINE_PATH =
  'tests/architecture/web-persistence-baseline.json';

const PATH_ARRAY_FIELDS = [
  'staticSources',
  'dynamicSources',
  'apiRoutes',
  'tierARoutes',
  'tierBRoutes',
  'cleanRoutes',
  'directTaintSourceRoutes',
  'transitiveOnlyTaintSourceRoutes',
  'directDbNamespaceRoutes',
  'taintedLibA',
  'taintedApiHelpers',
];

const COUNT_FIELDS = [
  'apiRoutes',
  'tierARoutes',
  'tierBRoutes',
  'cleanRoutes',
  'directTaintSourceRoutes',
  'transitiveOnlyTaintSourceRoutes',
  'directDbNamespaceRoutes',
  'taintedLibA',
  'taintedApiHelpers',
];

function duplicateEntries(entries) {
  return [...new Set(entries.filter((entry, index) => entries.indexOf(entry) !== index))];
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((entry) => !rightSet.has(entry));
}

function formatPaths(paths) {
  return paths.map((entry) => `  - ${entry}`).join('\n');
}

export function countsForGraph(graph) {
  return {
    ...Object.fromEntries(COUNT_FIELDS.map((field) => [field, graph[field].length])),
    totalMigrationUnits: graph.totalMigrationUnits,
  };
}

export function createPostgresRouteBaseline(graph) {
  return {
    schema: 'mission-control/tests/architecture/web-persistence-baseline@1',
    counts: countsForGraph(graph),
    ...Object.fromEntries(PATH_ARRAY_FIELDS.map((field) => [field, [...graph[field]]])),
  };
}

export function evaluatePostgresRouteSentinel(baseline, current) {
  const violations = [];

  if (baseline?.schema !== 'mission-control/tests/architecture/web-persistence-baseline@1') {
    violations.push(`unsupported baseline schema: ${String(baseline?.schema)}`);
  }

  for (const field of PATH_ARRAY_FIELDS) {
    const baselinePaths = baseline?.[field];
    const currentPaths = current?.[field];
    if (!Array.isArray(baselinePaths)) {
      violations.push(`baseline.${field} must be a path array`);
      continue;
    }
    if (!Array.isArray(currentPaths)) {
      violations.push(`current.${field} must be a path array`);
      continue;
    }

    const malformed = baselinePaths.filter((entry) =>
      typeof entry !== 'string' ||
      entry !== normalizeRepoPath(entry) ||
      path.posix.isAbsolute(entry) ||
      /^[A-Za-z]:\//u.test(entry)
    );
    if (malformed.length > 0) {
      violations.push(`baseline.${field} contains non-canonical paths:\n${formatPaths(malformed)}`);
    }

    const duplicates = duplicateEntries(baselinePaths);
    if (duplicates.length > 0) {
      violations.push(`baseline.${field} contains duplicate paths:\n${formatPaths(duplicates)}`);
    }

    const sorted = [...baselinePaths].sort();
    if (!baselinePaths.every((entry, index) => entry === sorted[index])) {
      violations.push(`baseline.${field} must be sorted`);
    }
  }

  if (Array.isArray(baseline?.cleanRoutes)) {
    const newlyTaintedCleanRoutes = baseline.cleanRoutes.filter((route) =>
      current.tierARoutes.includes(route) || current.tierBRoutes.includes(route)
    );
    if (newlyTaintedCleanRoutes.length > 0) {
      violations.push(
        `routes previously clean under MC_DATABASE_BACKEND=postgres now reach SQLite:\n${
          formatPaths(newlyTaintedCleanRoutes)
        }`,
      );
    }
  }

  for (const tier of ['tierARoutes', 'tierBRoutes']) {
    if (!Array.isArray(baseline?.[tier])) continue;
    const additions = difference(current[tier], baseline[tier]);
    if (additions.length > 0) {
      violations.push(`new ${tier} entries are not in the exact-current allowlist:\n${formatPaths(additions)}`);
    }
  }

  for (const field of PATH_ARRAY_FIELDS) {
    if (!Array.isArray(baseline?.[field]) || !Array.isArray(current?.[field])) continue;
    try {
      assert.deepEqual(current[field], baseline[field]);
    } catch {
      const added = difference(current[field], baseline[field]);
      const removed = difference(baseline[field], current[field]);
      const details = [
        added.length > 0 ? `added:\n${formatPaths(added)}` : '',
        removed.length > 0 ? `removed:\n${formatPaths(removed)}` : '',
      ].filter(Boolean).join('\n');
      violations.push(`current.${field} must exactly match the canonical baseline${details ? `:\n${details}` : ''}`);
    }
  }

  const baselineCounts = baseline?.counts;
  const currentCounts = countsForGraph(current);
  if (!baselineCounts || typeof baselineCounts !== 'object' || Array.isArray(baselineCounts)) {
    violations.push('baseline.counts must be an object');
  } else {
    try {
      assert.deepEqual(currentCounts, baselineCounts);
    } catch {
      violations.push(
        `baseline counts do not match the current graph:\n` +
        `  expected ${JSON.stringify(baselineCounts)}\n` +
        `  current  ${JSON.stringify(currentCounts)}`,
      );
    }
  }

  const tierPartitions = [
    ...current.tierARoutes,
    ...current.tierBRoutes,
    ...current.cleanRoutes,
  ].sort();
  if (
    duplicateEntries(tierPartitions).length > 0 ||
    tierPartitions.length !== current.apiRoutes.length ||
    tierPartitions.some((entry, index) => entry !== current.apiRoutes[index])
  ) {
    violations.push('current Tier A, Tier B, and clean route arrays must exactly partition apiRoutes');
  }

  if (
    current.directTaintSourceRoutes.length +
      current.transitiveOnlyTaintSourceRoutes.length !==
    current.tierARoutes.length
  ) {
    violations.push('current direct/transitive Tier A arrays must exactly partition tierARoutes');
  }

  if (
    current.tierARoutes.length +
      current.taintedLibA.length +
      current.taintedApiHelpers.length !==
    current.totalMigrationUnits
  ) {
    violations.push('current totalMigrationUnits must equal Tier A routes plus tainted libraries and API helpers');
  }

  return violations;
}

export function assertPostgresRouteSentinel(baseline, current) {
  const violations = evaluatePostgresRouteSentinel(baseline, current);
  assert.equal(
    violations.length,
    0,
    `PostgreSQL route sentinel failed:\n\n${violations.map((violation) => `- ${violation}`).join('\n')}`,
  );
}

export async function runPostgresRouteSentinel(root = process.cwd()) {
  const baselinePath = path.join(root, POSTGRES_ROUTE_BASELINE_PATH);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const current = computeWebPersistenceGraph(root);
  assertPostgresRouteSentinel(baseline, current);
  return current;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  if (process.env.MC_DATABASE_BACKEND && process.env.MC_DATABASE_BACKEND !== 'postgres') {
    throw new Error('PostgreSQL route sentinel requires MC_DATABASE_BACKEND=postgres');
  }
  process.env.MC_DATABASE_BACKEND = 'postgres';
  const current = await runPostgresRouteSentinel();
  console.log(
    `PostgreSQL route sentinel passed: ${current.apiRoutes.length} routes ` +
    `(${current.cleanRoutes.length} clean, ${current.tierARoutes.length} Tier A allowed, ` +
    `${current.tierBRoutes.length} Tier B allowed).`,
  );
}
