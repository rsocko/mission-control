import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Dedicated regression guard for `src/app/api/settings/mode/route.ts`
 * (Layer L02). The generic `web-persistence-baseline.test.ts` ratchet
 * already prevents this route from re-entering `tierARoutes`/`tierBRoutes`
 * once it is committed to the `cleanRoutes` floor set (any addition to
 * either ceiling set fails that test, and any regression out of the floor
 * set fails it too). This test names the specific route explicitly so a
 * reviewer -- or a future PR that reintroduces a static or dynamic import
 * from this route to `@/db`, `@/lib/seed-api`, or `@/lib/triage/lifecycle`
 * -- sees the exact guarantee being pinned, independent of the baseline
 * JSON's contents.
 */
describe('settings/mode route stays fully clean (Layer L02)', () => {
  const ROUTE = 'src/app/api/settings/mode/route.ts';

  it('is present in the API route inventory', () => {
    const { apiRoutes } = computeWebPersistenceGraph(process.cwd());
    expect(apiRoutes).toContain(ROUTE);
  });

  it('is neither Tier A (import-time taint) nor Tier B (deferred/call-time taint)', () => {
    const { tierARoutes, tierBRoutes, cleanRoutes } = computeWebPersistenceGraph(process.cwd());
    expect(tierARoutes).not.toContain(ROUTE);
    expect(tierBRoutes).not.toContain(ROUTE);
    expect(cleanRoutes).toContain(ROUTE);
  });
});
