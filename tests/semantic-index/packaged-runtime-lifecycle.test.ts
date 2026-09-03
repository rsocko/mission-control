import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    settingsGate: null as Promise<void> | null,
    publishGate: null as Promise<void> | null,
    publishStarted: null as (() => void) | null,
    backendDisposed: false,
    semanticEnabled: false,
    settingsGet: vi.fn<() => Promise<null>>(),
    publish: vi.fn(async () => {
      mocks.publishStarted?.();
      if (mocks.publishGate) await mocks.publishGate;
      if (mocks.backendDisposed) throw new Error('used disposed backend');
      return { status: 'published' as const };
    }),
    workerStart: vi.fn(),
    workerStop: vi.fn(async () => undefined),
    workerConstructed: vi.fn(),
  };
  state.settingsGet.mockImplementation(async () => {
    if (state.settingsGate) await state.settingsGate;
    return null;
  });
  return state;
});

vi.mock('@/lib/logger', () => ({
  semanticIndexLogger: { warn: vi.fn() },
}));
vi.mock('@/lib/ai/config-values', () => ({
  parseSavedAIProviderConfig: () => ({}),
  resolveAIConfig: () => ({
    houstonMemoryEnabled: false,
    semanticSearchEnabled: mocks.semanticEnabled,
  }),
}));
vi.mock('@/lib/ai/sensitivity-policy', () => ({
  DEFAULT_AI_ROUTING_POLICY: {},
  resolveSensitivity: () => 'internal',
  validateAIRoutingPolicy: (value: unknown) => value,
}));
vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    settings: { get: mocks.settingsGet },
  }),
}));
vi.mock('@/lib/search/embedding-config', () => ({
  buildEmbeddingConfig: () => (mocks.semanticEnabled ? {} : null),
}));
vi.mock('@/db/runtime', () => ({
  getPostgresSemanticIndexRepository: () => new Proxy({}, {
    get: () => vi.fn(),
  }),
  getPostgresSemanticSourcePort: () => new Proxy({}, {
    get: () => vi.fn(),
  }),
}));
vi.mock('@/lib/semantic-index/embedding-provider', () => ({
  AIEmbeddingProvider: class {},
}));
vi.mock('@/lib/semantic-index/service', () => ({
  SemanticIndexService: class {
    publish = mocks.publish;
  },
}));
vi.mock('@/lib/semantic-index/worker', () => ({
  SemanticIndexWorker: class {
    start = mocks.workerStart;
    stop = mocks.workerStop;

    constructor() {
      mocks.workerConstructed();
    }
  },
}));
vi.mock('@/lib/semantic-index/worker-config', () => ({
  resolveSemanticWorkerConfig: (entityTypes: string[]) => ({
    embeddingTimeoutMs: 1,
    entityTypes,
  }),
}));
vi.mock('@/lib/semantic-index/source/contracts', () => ({
  SEMANTIC_SOURCE_ENTITY_TYPES: ['task'],
}));

describe('packaged PostgreSQL semantic runtime lifecycle', () => {
  beforeEach(() => {
    mocks.settingsGate = null;
    mocks.publishGate = null;
    mocks.publishStarted = null;
    mocks.backendDisposed = false;
    mocks.semanticEnabled = false;
    vi.clearAllMocks();
  });

  it('invalidates in-flight composition before shutdown and rebuilds without leaks', async () => {
    let releaseSettings!: () => void;
    mocks.settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const runtime = await import('@/lib/semantic-index/packaged-worker-runtime');
    const composition = runtime.createPackagedPostgresSemanticRuntime();
    const publication = runtime.publishPackagedPostgresSemanticEntity(
      'upsert',
      'task',
      'task-before-shutdown',
    );
    const compositionResult = expect(composition).rejects.toThrow('was invalidated');
    const publicationResult = expect(publication).rejects.toThrow('was invalidated');

    const shutdown = runtime.stopPackagedPostgresSemanticWorker();
    let shutdownComplete = false;
    void shutdown.then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseSettings();
    await shutdown;
    await compositionResult;
    await publicationResult;
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.workerConstructed).toHaveBeenCalledTimes(1);
    expect(mocks.workerStop).toHaveBeenCalledTimes(1);
    mocks.backendDisposed = true;

    await runtime.stopPackagedPostgresSemanticWorker();
    expect(mocks.workerStop).toHaveBeenCalledTimes(1);
    await expect(
      runtime.publishPackagedPostgresSemanticEntity(
        'upsert',
        'task',
        'task-while-suspended',
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'runtime-shutdown' });
    expect(mocks.workerConstructed).toHaveBeenCalledTimes(1);

    mocks.settingsGate = null;
    mocks.semanticEnabled = true;
    mocks.backendDisposed = false;
    runtime.resumePackagedPostgresSemanticRuntime();
    const rebuilt = await runtime.createPackagedPostgresSemanticRuntime();
    let releasePublication!: () => void;
    mocks.publishGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let markPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      markPublicationStarted = resolve;
    });
    mocks.publishStarted = markPublicationStarted;
    const activePublication = runtime.publishPackagedPostgresSemanticEntity(
      'upsert',
      'task',
      'task-after-reinitialize',
    );
    await publicationStarted;

    const finalShutdown = runtime.stopPackagedPostgresSemanticWorker();
    let finalShutdownComplete = false;
    void finalShutdown.then(() => {
      finalShutdownComplete = true;
    });
    await Promise.resolve();
    expect(finalShutdownComplete).toBe(false);
    await expect(
      runtime.publishPackagedPostgresSemanticEntity(
        'upsert',
        'task',
        'task-during-shutdown',
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'runtime-shutdown' });
    expect(mocks.workerConstructed).toHaveBeenCalledTimes(2);

    releasePublication();
    await expect(activePublication).resolves.toEqual({ status: 'published' });
    await finalShutdown;
    mocks.backendDisposed = true;
    expect(rebuilt).toBeDefined();
    expect(mocks.workerConstructed).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();

    await runtime.stopPackagedPostgresSemanticWorker();
    expect(mocks.workerStop).toHaveBeenCalledTimes(2);
    await expect(
      runtime.publishPackagedPostgresSemanticEntity(
        'upsert',
        'task',
        'task-after-shutdown',
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'runtime-shutdown' });
    expect(mocks.workerConstructed).toHaveBeenCalledTimes(2);
  });
});
