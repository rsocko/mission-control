import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Dedicated regression guard for `src/app/api/settings/mode/route.ts`
 * (Layer L02). The PostgreSQL route sentinel already prevents this route from
 * re-entering `tierARoutes`/`tierBRoutes` once it is committed to the
 * `cleanRoutes` allowlist. This test names the specific route explicitly so a
 * reviewer -- or a future PR that reintroduces a static or dynamic import
 * from this route to `@/db`, `@/lib/seed-api`, or `@/lib/triage/lifecycle`
 * -- sees the exact guarantee being pinned, independent of the baseline
 * JSON's contents.
 */
describe('settings/mode route stays fully clean (Layer L02)', () => {
  const ROUTE = 'src/app/api/settings/mode/route.ts';
  const graph = computeWebPersistenceGraph(process.cwd());

  it('is present in the API route inventory', () => {
    expect(graph.apiRoutes).toContain(ROUTE);
  });

  it('is neither Tier A (import-time taint) nor Tier B (deferred/call-time taint)', () => {
    expect(graph.tierARoutes).not.toContain(ROUTE);
    expect(graph.tierBRoutes).not.toContain(ROUTE);
    expect(graph.cleanRoutes).toContain(ROUTE);
  });
});
