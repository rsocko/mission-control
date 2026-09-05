import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertPostgresRouteSentinel,
  createPostgresRouteBaseline,
  evaluatePostgresRouteSentinel,
  POSTGRES_ROUTE_BASELINE_PATH,
  runPostgresRouteSentinel,
} from './postgres-route-sentinel.mjs';
import {
  computeWebPersistenceGraph,
  normalizeRepoPath,
} from '../tests/architecture/web-persistence-graph.ts';

const fixtureRoots = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'postgres-route-sentinel-'));
  fixtureRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, 'utf8');
  }
  return root;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}

test('the current repository exactly matches the canonical PostgreSQL route baseline', async () => {
  await runPostgresRouteSentinel();
});

test('historical layer tests stay decoupled from later exact-current decrements', async () => {
  const sourceFiles = (await Promise.all(
    ['tests', 'scripts'].map((directory) => listFiles(path.join(process.cwd(), directory))),
  )).flat().filter((file) => /\.(?:ts|tsx|mjs)$/u.test(file));
  const exactCurrentOwners = new Set([
    'scripts/postgres-route-sentinel.mjs',
    'scripts/postgres-route-sentinel.test.mjs',
  ]);
  const countFields = [
    'apiRoutes',
    'tierARoutes',
    'tierBRoutes',
    'cleanRoutes',
    'directTaintSourceRoutes',
    'transitiveOnlyTaintSourceRoutes',
    'directDbNamespaceRoutes',
    'taintedLibA',
    'taintedApiHelpers',
    'totalMigrationUnits',
  ];
  const baselineReaders = [];
  const fullTupleOwners = [];

  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    const relative = normalizeRepoPath(path.relative(process.cwd(), file));
    if (exactCurrentOwners.has(relative)) continue;
    if (
      source.includes(POSTGRES_ROUTE_BASELINE_PATH) ||
      source.includes('POSTGRES_ROUTE_BASELINE_PATH')
    ) {
      baselineReaders.push(relative);
    }
    const copiedCountFields = countFields.filter((field) =>
      new RegExp(`\\b${field}:\\s*[^,\\n}]+\\.length\\b`, 'u').test(source)
    );
    if (copiedCountFields.length >= 5) {
      fullTupleOwners.push(relative);
    }
  }

  assert.deepEqual(baselineReaders, []);
  assert.deepEqual(fullTupleOwners, []);
});

test('declared count drift fails even when every path allowlist still matches', () => {
  const graph = computeWebPersistenceGraph(process.cwd());
  const baseline = createPostgresRouteBaseline(graph);
  baseline.counts = {
    ...baseline.counts,
    totalMigrationUnits: baseline.counts.totalMigrationUnits + 1,
  };

  const violations = evaluatePostgresRouteSentinel(baseline, graph);

  assert.ok(violations.some((violation) =>
    violation.includes('baseline counts do not match the current graph')
  ));
});

test('a synthetic SQLite edge added to a previously clean route fails the sentinel', async () => {
  const root = await createFixture({
    'src/db/index.ts': 'export const sqlite = {};\n',
    'src/lib/safe.ts': 'export const value = 1;\n',
    'src/app/api/example/route.ts':
      "import { value } from '@/lib/safe';\nexport function GET() { return value; }\n",
  });
  const baseline = createPostgresRouteBaseline(computeWebPersistenceGraph(root));

  await writeFile(
    path.join(root, 'src', 'lib', 'safe.ts'),
    "export const before = 1; import { sqlite /* ; from '@/safe' */ } " +
      "from /* sentinel bypass probe */ '@/db';\n" +
      'export const value = sqlite;\n',
    'utf8',
  );
  const violated = computeWebPersistenceGraph(root);
  const violations = evaluatePostgresRouteSentinel(baseline, violated);

  assert.ok(violations.some((violation) =>
    violation.includes('routes previously clean under MC_DATABASE_BACKEND=postgres now reach SQLite') &&
    violation.includes('src/app/api/example/route.ts')
  ));
  assert.throws(
    () => assertPostgresRouteSentinel(baseline, violated),
    /PostgreSQL route sentinel failed/,
  );
});

test('the exact-current Tier A and Tier B allowlists cannot hide same-count swaps', async () => {
  const root = await createFixture({
    'src/db/index.ts': 'export const sqlite = {};\n',
    'src/lib/static-a.ts': "import '@/db';\n",
    'src/lib/static-b.ts': "import '@/db';\n",
    'src/app/api/a/route.ts': "import '@/lib/static-a';\n",
    'src/app/api/b/route.ts': "import '@/lib/static-b';\n",
  });
  const baseline = createPostgresRouteBaseline(computeWebPersistenceGraph(root));

  await rm(path.join(root, 'src', 'app', 'api', 'a', 'route.ts'));
  await mkdir(path.join(root, 'src', 'app', 'api', 'c'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app', 'api', 'c', 'route.ts'), "import '@/lib/static-a';\n");

  const violations = evaluatePostgresRouteSentinel(
    baseline,
    computeWebPersistenceGraph(root),
  );

  assert.ok(violations.some((violation) =>
    violation.includes('new tierARoutes entries are not in the exact-current allowlist') &&
    violation.includes('src/app/api/c/route.ts')
  ));
});

test('the exact-current tainted-library allowlist cannot hide a same-count swap', async () => {
  const root = await createFixture({
    'src/db/index.ts': 'export const sqlite = {};\n',
    'src/lib/original.ts': "import '@/db';\n",
    'src/app/api/example/route.ts': "import '@/lib/original';\n",
  });
  const graph = computeWebPersistenceGraph(root);
  const baseline = createPostgresRouteBaseline(graph);
  const swapped = structuredClone(graph);
  swapped.taintedLibA = ['src/lib/replacement.ts'];

  const violations = evaluatePostgresRouteSentinel(baseline, swapped);

  assert.ok(violations.some((violation) =>
    violation.includes('current.taintedLibA must exactly match the canonical baseline') &&
    violation.includes('src/lib/replacement.ts') &&
    violation.includes('src/lib/original.ts')
  ));
});

test('a synthetic deferred SQLite edge added to a clean route fails the Tier B allowlist', async () => {
  const root = await createFixture({
    'src/db/index.ts': 'export const sqlite = {};\n',
    'src/lib/safe.ts': 'export const value = 1;\n',
    'src/app/api/example/route.ts': "import '@/lib/safe';\n",
  });
  const baseline = createPostgresRouteBaseline(computeWebPersistenceGraph(root));

  await writeFile(
    path.join(root, 'src', 'lib', 'safe.ts'),
    "export async function load() { return import /* sentinel bypass probe */ " +
      "(/* specifier */ '@/db', { with: { type: 'json' } }); }\n",
  );
  const violations = evaluatePostgresRouteSentinel(baseline, computeWebPersistenceGraph(root));

  assert.ok(violations.some((violation) =>
    violation.includes('new tierBRoutes entries are not in the exact-current allowlist') &&
    violation.includes('src/app/api/example/route.ts')
  ));
});

test('repository paths normalize deterministically on Windows and Linux', () => {
  assert.equal(normalizeRepoPath('src\\app\\api\\tasks\\route.ts'), 'src/app/api/tasks/route.ts');
  assert.equal(normalizeRepoPath('src/app/api/tasks/route.ts'), 'src/app/api/tasks/route.ts');

  const root = process.cwd();
  const graph = computeWebPersistenceGraph(root);
  const baseline = createPostgresRouteBaseline(graph);
  baseline.apiRoutes[0] = baseline.apiRoutes[0].replaceAll('/', '\\');
  const violations = evaluatePostgresRouteSentinel(baseline, graph);
  assert.ok(violations.some((violation) => violation.includes('contains non-canonical paths')));
});
