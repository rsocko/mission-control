import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const CLEANED_TIER_A_ROUTES = [
  'src/app/api/triage/backfill-embeds/route.ts',
  'src/app/api/triage/backfill-thumbnails/route.ts',
  'src/app/api/triage/capture/image/[id]/route.ts',
  'src/app/api/triage/capture/image/route.ts',
  'src/app/api/triage/capture/route.ts',
  'src/app/api/triage/content-types/route.ts',
  'src/app/api/triage/digest/route.ts',
  'src/app/api/triage/digest/send/route.ts',
  'src/app/api/triage/extension-config/route.ts',
  'src/app/api/triage/health/route.ts',
  'src/app/api/triage/import/bulk/route.ts',
  'src/app/api/triage/maintenance/route.ts',
  'src/app/api/triage/reclassify/route.ts',
  'src/app/api/triage/route.ts',
  'src/app/api/triage/storage/route.ts',
  'src/app/api/native/logout/route.ts',
  'src/app/api/native/push/registrations/[registrationId]/route.ts',
  'src/app/api/native/push/registrations/route.ts',
] as const;

const CLEANED_TIER_B_ROUTES = [
  'src/app/api/triage/auto-sync/route.ts',
  'src/app/api/triage/cron/route.ts',
  'src/app/api/triage/import/document-intelligence/route.ts',
  'src/app/api/triage/import/github-stars/route.ts',
  'src/app/api/triage/import/reddit-saved/route.ts',
  'src/app/api/triage/import/twitter-archive/route.ts',
  'src/app/api/triage/import/youtube/route.ts',
  'src/app/api/triage/sync-status/route.ts',
] as const;

const PORTABLE_LIBRARIES = [
  'src/lib/triage/capture.ts',
  'src/lib/triage/classification.ts',
  'src/lib/triage/content-type-registry.ts',
  'src/lib/triage/digest.ts',
  'src/lib/triage/lifecycle.ts',
  'src/lib/triage/shared.ts',
  'src/lib/triage/staleness.ts',
  'src/lib/native/apns-registration-service.ts',
  'src/lib/native/installation-auth.ts',
  'src/lib/native/share-capture-auth.ts',
  'src/lib/native/share-capture-service.ts',
] as const;

const CLEANED_DIRECT_DB_ROUTES = [
  'src/app/api/triage/backfill-embeds/route.ts',
  'src/app/api/triage/backfill-thumbnails/route.ts',
  'src/app/api/triage/extension-config/route.ts',
  'src/app/api/triage/maintenance/route.ts',
  'src/app/api/triage/storage/route.ts',
] as const;

const EXCLUDED_TIER_A_ROUTES = [
  'src/app/api/notifications/triage/route.ts',
  'src/app/api/triage/[id]/extract-actions/route.ts',
  'src/app/api/triage/[id]/route.ts',
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Layer L08b triage native persistence boundary', () => {
  const graph = computeWebPersistenceGraph(process.cwd());

  it('pins the approved graph delta without adding deferred taint', () => {
    expect({
      apiRoutes: graph.apiRoutes.length,
      tierARoutes: graph.tierARoutes.length,
      tierBRoutes: graph.tierBRoutes.length,
      cleanRoutes: graph.cleanRoutes.length,
      directTaintSourceRoutes: graph.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: graph.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: graph.directDbNamespaceRoutes.length,
      taintedLibA: graph.taintedLibA.length,
      taintedApiHelpers: graph.taintedApiHelpers.length,
      totalMigrationUnits: graph.totalMigrationUnits,
    }).toEqual({
      apiRoutes: 266,
      tierARoutes: 121,
      tierBRoutes: 19,
      cleanRoutes: 126,
      directTaintSourceRoutes: 91,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 92,
      taintedLibA: 61,
      taintedApiHelpers: 0,
      totalMigrationUnits: 182,
    });
  });

  it('removes exactly the approved triage and native routes from static and deferred taint', () => {
    for (const route of [...CLEANED_TIER_A_ROUTES, ...CLEANED_TIER_B_ROUTES]) {
      expect(graph.tierARoutes, route).not.toContain(route);
      expect(graph.tierBRoutes, route).not.toContain(route);
      expect(graph.cleanRoutes, route).toContain(route);
    }
  });

  it('keeps the AI-linked and notification routes explicitly out of scope', () => {
    for (const route of EXCLUDED_TIER_A_ROUTES) {
      expect(graph.tierARoutes, route).toContain(route);
      expect(graph.tierBRoutes, route).not.toContain(route);
    }
  });

  it('keeps portable triage services free of database drivers', () => {
    for (const path of PORTABLE_LIBRARIES) {
      expect(graph.taintedLibA, path).not.toContain(path);
      expect(source(path), path).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:['"]|\/(?:index|schema|sqlite)))/,
      );
    }
  });

  it('removes direct database namespace ownership from the five approved routes', () => {
    for (const route of CLEANED_DIRECT_DB_ROUTES) {
      expect(graph.directDbNamespaceRoutes, route).not.toContain(route);
    }
  });
});
