import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AtomicSettingsRepository,
  SettingsRepository,
} from '@/db/persistence/core-repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteCompatibilityAccess = vi.hoisted(() => vi.fn());

vi.mock('@/db', () => {
  sqliteCompatibilityAccess();
  throw new Error('SQLite compatibility persistence was reached');
});

vi.mock('@/lib/semantic-index/packaged-worker-runtime', () => ({
  resumePackagedPostgresSemanticRuntime: vi.fn(),
  stopPackagedPostgresSemanticWorker: vi.fn(async () => undefined),
}));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

function requireAtomicSettings(repository: SettingsRepository): AtomicSettingsRepository {
  if (
    typeof repository.getMany !== 'function'
    || typeof repository.setMany !== 'function'
    || typeof repository.getActiveEmbeddingIdentity !== 'function'
  ) {
    throw new Error('PostgreSQL composition did not register atomic settings operations');
  }
  return repository;
}

describePostgres('PostgreSQL AI provider routes', () => {
  const ownedKeys = [
    'ai_provider_config',
    'ai_routing_policy',
  ] as const;
  let runtime: typeof import('@/db/runtime');

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    vi.stubEnv('MC_DATABASE_BACKEND', 'postgres');
    vi.stubEnv('MC_POSTGRES_URL', connectionString!);
    vi.stubEnv('MC_POSTGRES_APPLICATION_NAME', 'mission-control-ai-provider-route-test');
    vi.stubEnv('BIFROST_BASE_URL', 'https://bifrost.test/v1');
    runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    const settings = requireAtomicSettings((await import('@/lib/persistence/runtime'))
      .getCorePersistenceRepositories().settings);
    for (const key of ownedKeys) await settings.delete(key);
  }, 120_000);

  afterAll(async () => {
    const settings = requireAtomicSettings((await import('@/lib/persistence/runtime'))
      .getCorePersistenceRepositories().settings);
    for (const key of ownedKeys) await settings.delete(key);
    await runtime.shutdownRuntimeDatabase();
    vi.unstubAllEnvs();
  });

  it('imports and persists an untorn configuration pair without evaluating SQLite', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: `llama-${randomUUID()}`,
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        embeddingProvider: 'ollama',
        embeddingModel: 'nomic-embed-text',
        embeddingBaseUrl: 'http://localhost:11434/v1',
        embeddingApiKey: '',
        semanticSearchEnabled: false,
        houstonMemoryEnabled: false,
        houstonMemoryRetentionDays: 90,
        routingPolicy: {
          policies: {
            'local-only': { allowedRoutes: ['ollama'] },
            restricted: { allowedRoutes: ['ollama'] },
            standard: { allowedRoutes: ['ollama'] },
          },
          featureDefaults: {},
          sourceDefaults: {},
        },
      }),
    }));

    expect(response.status).toBe(200);
    const settings = requireAtomicSettings((await import('@/lib/persistence/runtime'))
      .getCorePersistenceRepositories().settings);
    const pair = await settings.getMany(ownedKeys);
    expect(pair.ai_provider_config).toMatchObject({
      provider: 'ollama',
      embeddingProvider: 'ollama',
    });
    expect(pair.ai_routing_policy).toMatchObject({
      policies: {
        'local-only': { allowedRoutes: ['ollama'] },
        restricted: { allowedRoutes: ['ollama'] },
        standard: { allowedRoutes: ['ollama'] },
      },
    });
    expect(sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('loads model configuration before provider network I/O', async () => {
    const settings = requireAtomicSettings((await import('@/lib/persistence/runtime'))
      .getCorePersistenceRepositories().settings);
    await settings.setMany([
      ['ai_provider_config', {
        provider: 'bifrost',
        model: 'azure/gpt-4o-mini',
        baseUrl: 'https://bifrost.test/v1',
        apiKey: 'integration-secret',
      }],
      ['ai_routing_policy', {
        policies: {
          'local-only': { allowedRoutes: ['ollama'] },
          restricted: { allowedRoutes: ['ollama', 'azure-private'] },
          standard: { allowedRoutes: ['bifrost-copilot', 'ollama'] },
        },
        featureDefaults: {},
        sourceDefaults: {},
      }],
    ]);
    const service = await import('@/lib/ai/provider-configuration-service');
    service.invalidateAIProviderConfigurationCache();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'azure/gpt-4o-mini' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/ai/models/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/models?provider=bifrost',
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [{ name: 'azure/gpt-4o-mini' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bifrost.test/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer integration-secret' },
      }),
    );
    expect(sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });
});
