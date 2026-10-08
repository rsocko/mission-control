import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_SEARCH_DEBOUNCE_MS,
  MOBILE_SEARCH_DEBOUNCE_MS,
} from '@/lib/hooks/useDebouncedSearchQuery';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

const DATASET_SIZE = 2_500;
const SAMPLE_COUNT = 40;
const WARMUP_COUNT = 5;
const KEYWORD_API_P95_BUDGET_MS = 100;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function describeDistribution(values: number[]) {
  return {
    min: Number(Math.min(...values).toFixed(2)),
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
    max: Number(Math.max(...values).toFixed(2)),
  };
}

describe('keyword search performance gate', () => {
  let searchRequest: (query: string) => Promise<Response>;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [database, schema, fts] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/search/fts'),
    ]);
    const timestamp = '2030-01-01T00:00:00.000Z';

    for (let offset = 0; offset < DATASET_SIZE; offset += 250) {
      await database.default.insert(schema.tasks).values(
        Array.from({ length: Math.min(250, DATASET_SIZE - offset) }, (_, index) => {
          const ordinal = offset + index;
          return {
            id: `search-perf-${ordinal}`,
            sourceId: `search-perf-source-${ordinal}`,
            connectorType: 'synthetic-benchmark',
            connectorInstanceId: 'synthetic-benchmark',
            title: `Synthetic topic ${ordinal % 50} task ${ordinal}`,
            description: `Representative synthetic keyword corpus item ${ordinal}`,
            status: 'todo',
            priority: 'none',
            sourceListName: `Synthetic project ${ordinal % 20}`,
            metadata: {},
            syncStatus: 'synced' as const,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastSyncedAt: timestamp,
          };
        }),
      );
    }

    await fts.rebuildSearchIndex();
    await fts.warmUpFTS();

    const { GET } = await import('@/app/api/ai/search/route');
    searchRequest = (query: string) => GET(new Request(
      `http://localhost/api/ai/search?q=${encodeURIComponent(query)}&mode=keyword&type=tasks&limit=20`,
    ));

    for (let iteration = 0; iteration < WARMUP_COUNT; iteration++) {
      const response = await searchRequest(`synthetic topic ${iteration}`);
      await response.json();
    }
  }, 30_000);

  it('keeps warmed keyword API p95 at or below 100 ms', async () => {
    const durations: number[] = [];

    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
      const startedAt = performance.now();
      const response = await searchRequest(`synthetic topic ${iteration % 20}`);
      const payload = await response.json() as { total: number };
      durations.push(performance.now() - startedAt);
      expect(response.status).toBe(200);
      expect(payload.total).toBeGreaterThan(0);
    }

    const distributionMs = describeDistribution(durations);
    const failureDetails = {
      breachedBudget: `warm keyword API p95 <= ${KEYWORD_API_P95_BUDGET_MS} ms`,
      observedDistributionMs: distributionMs,
      datasetSize: DATASET_SIZE,
      sampleCount: SAMPLE_COUNT,
      configuredDebounceMs: {
        desktop: DESKTOP_SEARCH_DEBOUNCE_MS,
        mobile: MOBILE_SEARCH_DEBOUNCE_MS,
      },
    };

    expect(
      distributionMs.p95,
      `Keyword search latency gate failed: ${JSON.stringify(failureDetails)}`,
    ).toBeLessThanOrEqual(KEYWORD_API_P95_BUDGET_MS);
  });
});
