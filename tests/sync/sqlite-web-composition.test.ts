import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalNextRuntime = process.env.NEXT_RUNTIME;

vi.mock('@/lib/runtime/lifecycle', () => ({
  configureRuntimeLifecycle: vi.fn(),
  markRuntimeReady: vi.fn(),
}));
vi.mock('@/lib/runtime/startup', () => ({
  terminateFailedStartup: (error: unknown) => {
    throw error;
  },
}));
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => true,
}));
vi.mock('@/lib/public-demo-runtime', () => ({
  initializePublicDemoData: vi.fn(async () => undefined),
}));
vi.mock('@/lib/telemetry/runtime', () => ({
  startRuntimeTelemetry: vi.fn(async () => undefined),
}));

describe('SQLite web sync service composition', () => {
  beforeAll(async () => {
    process.env.MC_DATABASE_BACKEND = 'sqlite';
    process.env.NEXT_RUNTIME = 'nodejs';
    const { register } = await import('@/instrumentation');
    await register();
    await register();
  });

  afterAll(() => {
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalNextRuntime;
  });

  it('registers the narrow connector, persistence, search, and enrichment services', async () => {
    const [
      { getConnectorRegistry },
      { getCorePersistenceRepositories },
      { getWorkerPersistenceRepositories },
      { getKeywordSearchRepository },
      { getLegacySearchIndexingService },
      { enrichWithAI },
      { publishSemanticEntityUpsert },
    ] = await Promise.all([
      import('@/lib/connectors/registry-runtime'),
      import('@/lib/persistence/runtime'),
      import('@/lib/persistence/worker-runtime'),
      import('@/lib/search/keyword-runtime'),
      import('@/lib/search/indexing-service'),
      import('@/lib/notifications/enrichment/ai-enrichment-service'),
      import('@/lib/semantic-index/publication-service'),
    ]);

    expect(getConnectorRegistry().getAllConnectors()).toEqual([]);
    await expect(
      getCorePersistenceRepositories().settings.get('l03-composition-missing'),
    ).resolves.toBeNull();
    await expect(
      getWorkerPersistenceRepositories(),
    ).resolves.toHaveProperty('execution');
    await expect(getKeywordSearchRepository().warmUp()).resolves.toBeUndefined();
    await expect(
      getLegacySearchIndexingService().warmUp(),
    ).resolves.toBeUndefined();
    await expect(enrichWithAI({
      notificationId: 'l03-no-ai',
      title: 'No enrichment needed',
      connectorType: 'test',
      category: 'informational',
      metadata: {},
      presentation: {},
    })).resolves.toBeNull();
    await expect(
      publishSemanticEntityUpsert('task', 'l03-missing-task'),
    ).resolves.toBeUndefined();
  });
});
