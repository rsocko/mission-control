import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_LIBRARIES = [
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/provider-factory.ts',
  'src/lib/ai/index.ts',
  'src/lib/houston-memory/retrieval.ts',
  'src/lib/semantic-index/config.ts',
  'src/lib/semantic-index/index.ts',
  'src/lib/semantic-index/runtime.ts',
  'src/lib/semantic-index/sensitivity.ts',
] as const;

const COMPATIBILITY_CONSUMERS = [
  'src/lib/stats/observations.ts',
  'src/lib/triage/actions/multi-action-extract.ts',
  'src/lib/triage/actions/knowledge-base.ts',
  'src/lib/notifications/enrichment/ai-enrichment.ts',
] as const;

const ROUTES = [
  'src/app/api/insights/observations/route.ts',
  'src/app/api/triage/[id]/extract-actions/route.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('residual AI boundary parity taint decrement', () => {
  it('pins the exact 12-file production slice', () => {
    expect([...OWNED_LIBRARIES, ...COMPATIBILITY_CONSUMERS]).toHaveLength(12);
    for (const path of [...OWNED_LIBRARIES, ...COMPATIBILITY_CONSUMERS, ...ROUTES]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(OWNED_LIBRARIES)('%s is no longer import-time SQLite-tainted', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    expect(source(path)).not.toMatch(
      /better-sqlite3|@\/db(?:['"]|\/schema)|drizzle-orm/,
    );
  });

  it('uses only the async provider runtime at the four compatible AI call sites', () => {
    for (const path of COMPATIBILITY_CONSUMERS) {
      expect(source(path), path).toContain('getAsyncAIModel');
      expect(source(path), path).not.toMatch(/provider-factory|config-resolver/);
    }
  });

  it('moves both owned route outcomes to clean without owning exact-current counts', () => {
    for (const route of ROUTES) {
      expect(current.cleanRoutes).toContain(route);
      expect(current.tierARoutes).not.toContain(route);
      expect(current.tierBRoutes).not.toContain(route);
    }
  });
});
