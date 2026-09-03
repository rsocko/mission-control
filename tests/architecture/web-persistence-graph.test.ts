import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Fixture-level unit tests for the `computeWebPersistenceGraph` parser
 * itself, independent of the real repository's current state - the real
 * repo's `web-persistence-baseline.test.ts` ratchet only proves the parser
 * agrees with the committed baseline for whatever patterns exist *today*; it
 * cannot demonstrate a parser bug whose triggering pattern doesn't currently
 * occur anywhere under `src/`. Both cases below were found by independent
 * review and are regression-locked here against synthetic fixtures.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'web-persistence-graph-fixture-'));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents, 'utf8');
  }
  return root;
}

describe('computeWebPersistenceGraph parser', () => {
  it('does not let a type-only declaration merge with a later value re-export\'s from clause', () => {
    // Regression test: the import-statement regex's clause used to be
    // lazily `[\s\S]*?`, which could span across an unrelated, semicolon
    // terminated statement (here `export type Foo = string;`) to reach the
    // *next* line's `from` clause, merging both into one match. Since the
    // merged clause text started with `type`, `clauseIsTypeOnly` wrongly
    // classified the real `export * from '@/db'` edge as type-only and
    // dropped it entirely - silently un-tainting a route that genuinely
    // imports `@/db` at module-eval time.
    const root = createFixture({
      'src/db/index.ts': 'export const db = 1;\n',
      'src/lib/victim.ts': 'export type Foo = string;\nexport * from \'@/db\';\n',
      'src/app/api/victim/route.ts':
        'import \'@/lib/victim\';\nexport async function GET() { return new Response(\'ok\'); }\n',
    });

    const result = computeWebPersistenceGraph(root);

    expect(result.taintedLibA).toContain('src/lib/victim.ts');
    expect(result.tierARoutes).toContain('src/app/api/victim/route.ts');
    expect(result.cleanRoutes).not.toContain('src/app/api/victim/route.ts');
  });

  it('still recognizes an ordinary multi-line named import clause as a static edge', () => {
    // Guards against over-correcting the fix above: a legitimate multi-line
    // named-binding import clause contains no semicolon before its own
    // `from`, so restricting the clause to `[^;]*?` must not break it.
    const root = createFixture({
      'src/db/index.ts': 'export const db = 1;\nexport const other = 2;\n',
      'src/lib/consumer.ts': 'import {\n  db,\n  other,\n} from \'@/db\';\n',
      'src/app/api/consumer/route.ts':
        'import \'@/lib/consumer\';\nexport async function GET() { return new Response(\'ok\'); }\n',
    });

    const result = computeWebPersistenceGraph(root);

    expect(result.taintedLibA).toContain('src/lib/consumer.ts');
    expect(result.tierARoutes).toContain('src/app/api/consumer/route.ts');
  });

  it('scopes taintedApiHelpers to src/app/api/**, excluding a tainted non-API app file', () => {
    // Regression test: taintedApiHelpers used to match any Tier A file
    // under src/app/ (not just src/app/api/), so a tainted page.tsx or
    // layout.tsx would have been silently folded into a field documented
    // as "shared API helpers".
    const root = createFixture({
      'src/db/index.ts': 'export const db = 1;\n',
      'src/app/page.tsx': 'import \'@/db\';\nexport default function Page() { return null; }\n',
      'src/app/api/helper.ts': 'import \'@/db\';\nexport function helper() { return 1; }\n',
      'src/app/api/uses-helper/route.ts':
        'import \'@/app/api/helper\';\nexport async function GET() { return new Response(\'ok\'); }\n',
    });

    const result = computeWebPersistenceGraph(root);

    expect(result.taintedApiHelpers).toEqual(['src/app/api/helper.ts']);
    expect(result.taintedApiHelpers).not.toContain('src/app/page.tsx');
    // The tainted page is still counted somewhere honest (Tier A overall),
    // it is simply not mislabeled as an "API helper".
    expect(result.tierARoutes.concat(result.taintedLibA, result.taintedApiHelpers))
      .not.toContain('src/app/page.tsx');
  });
});
