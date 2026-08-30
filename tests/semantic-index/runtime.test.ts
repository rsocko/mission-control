import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Startup safety: the index worker shares a process with the sync worker, so a
 * disabled feature, an unconfigured provider, or a broken backend must never
 * throw into its host or start a loop that does work.
 */

const mocks = vi.hoisted(() => ({
  resolved: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    semanticSearchEnabled: false,
    houstonMemoryEnabled: false,
    baseUrl: undefined as string | undefined,
    apiKey: '',
    configured: false,
  },
  getSemanticIndexRepository: vi.fn(),
  getSemanticSourcePort: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  semanticIndexLogger: mocks.logger,
  aiLogger: mocks.logger,
  dbLogger: mocks.logger,
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => mocks.resolved,
  getAIRoutingPolicy: () => ({
    policies: {
      'local-only': { allowedRoutes: ['ollama'] },
      restricted: { allowedRoutes: ['ollama', 'azure-private'] },
      standard: { allowedRoutes: ['bifrost-copilot', 'ollama', 'azure-private', 'openai'] },
    },
    featureDefaults: {},
    sourceDefaults: {},
  }),
}));

vi.mock('@/lib/semantic-index/repository-facade', () => ({
  getSemanticIndexRepository: mocks.getSemanticIndexRepository,
  resetSemanticIndexRepositoryForTests: vi.fn(),
}));

vi.mock('@/lib/semantic-index/source/facade', () => ({
  getSemanticSourcePort: mocks.getSemanticSourcePort,
  resetSemanticSourcePortForTests: vi.fn(),
}));

const ORIGINAL_DISABLED = process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.resolved.semanticSearchEnabled = false;
  mocks.resolved.houstonMemoryEnabled = false;
  delete process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED;
  mocks.getSemanticIndexRepository.mockResolvedValue({});
  mocks.getSemanticSourcePort.mockResolvedValue({});
});

afterEach(() => {
  if (ORIGINAL_DISABLED === undefined) delete process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED;
  else process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED = ORIGINAL_DISABLED;
});

describe('semantic index feature gate', () => {
  it('is off when semantic search enrichment is off', async () => {
    const { isSemanticIndexEnabled } = await import('@/lib/semantic-index/config');
    expect(isSemanticIndexEnabled()).toBe(false);
  });

  it('is on when semantic search enrichment is on', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    const { isSemanticIndexEnabled } = await import('@/lib/semantic-index/config');
    expect(isSemanticIndexEnabled()).toBe(true);
  });

  it('is on when only Houston memory is on and restricts maintenance to Houston summaries', async () => {
    mocks.resolved.houstonMemoryEnabled = true;
    const { getSemanticWorkerConfig, isSemanticIndexEnabled } = await import('@/lib/semantic-index/config');
    expect(isSemanticIndexEnabled()).toBe(true);
    expect(getSemanticWorkerConfig().entityTypes).toEqual(['houston-summary']);
  });

  it('honours an explicit worker kill switch even when the feature is on', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED = 'true';
    const { isSemanticIndexEnabled } = await import('@/lib/semantic-index/config');
    expect(isSemanticIndexEnabled()).toBe(false);
  });
});

describe('semantic index worker startup', () => {
  it('starts parked when the feature is disabled, doing no work', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');
    const worker = await runtime.startSemanticIndexWorker();

    expect(worker).not.toBeNull();
    expect(worker?.isRunning).toBe(true);
    expect(await worker!.runCycle()).toMatchObject({
      status: 'disabled',
      reason: 'semantic-search-disabled',
      intentsClaimed: 0,
      runsExecuted: 0,
    });

    await runtime.stopSemanticIndexWorker();
    expect(worker?.isRunning).toBe(false);
  });

  it('returns the same worker instead of starting a second loop', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');
    const first = await runtime.startSemanticIndexWorker();
    const second = await runtime.startSemanticIndexWorker();
    expect(second).toBe(first);
    await runtime.stopSemanticIndexWorker();
  });

  it('logs and returns null rather than throwing when the backend is unavailable', async () => {
    mocks.getSemanticIndexRepository.mockRejectedValue(new Error('no database'));
    const runtime = await import('@/lib/semantic-index/runtime');
    await expect(runtime.startSemanticIndexWorker()).resolves.toBeNull();
    expect(runtime.getSemanticIndexWorker()).toBeNull();
  });

  it('stops cleanly when no worker was ever started', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');
    await expect(runtime.stopSemanticIndexWorker()).resolves.toBeUndefined();
  });
});

describe('publish helpers', () => {
  it('skips silently when the feature is disabled, touching no backend', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');
    expect(await runtime.publishSemanticUpsert('task', 'task-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(await runtime.publishSemanticDelete('alert', 'alert-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(mocks.getSemanticIndexRepository).not.toHaveBeenCalled();
  });

  it('does not publish non-Houston entities when only Houston memory is enabled', async () => {
    mocks.resolved.houstonMemoryEnabled = true;
    const runtime = await import('@/lib/semantic-index/runtime');
    expect(await runtime.publishSemanticUpsert('task', 'task-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(mocks.getSemanticIndexRepository).not.toHaveBeenCalled();
  });

  it('never throws into an authoritative write path', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    mocks.getSemanticIndexRepository.mockRejectedValue(new Error('database exploded'));
    const runtime = await import('@/lib/semantic-index/runtime');
    expect(await runtime.publishSemanticUpsert('task', 'task-1')).toEqual({
      status: 'skipped', reason: 'publish-failed',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'semantic_publish_failed',
        kind: 'upsert',
        entityType: 'task',
        entityId: 'task-1',
      }),
      expect.any(String),
    );
  });

  it('records a skipped publication so the gap is observable', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    const runtime = await import('@/lib/semantic-index/runtime');
    runtime.setSemanticIndexRuntimeForTests({
      repository: {} as never,
      source: {} as never,
      embeddings: {} as never,
      service: {
        publish: async () => ({ status: 'skipped', reason: 'identity-not-created' }),
      } as never,
      config: {} as never,
    });

    expect(await runtime.publishSemanticDelete('alert', 'alert-9')).toMatchObject({
      status: 'skipped',
      reason: 'identity-not-created',
    });
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'semantic_publish_skipped',
        kind: 'delete',
        entityType: 'alert',
        entityId: 'alert-9',
      }),
      expect.any(String),
    );
    runtime.resetSemanticIndexRuntimeForTests();
  });

  it('reports no readiness while the feature is off', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');
    expect(await runtime.getSemanticIndexReadiness()).toBeNull();
    expect(mocks.getSemanticIndexRepository).not.toHaveBeenCalled();
  });
});

describe('identity lifecycle helpers', () => {
  it('refuse to touch storage while the feature is off', async () => {
    const runtime = await import('@/lib/semantic-index/runtime');

    expect(await runtime.activateSemanticIdentity('idx-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(await runtime.rollbackSemanticIdentity('idx-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(await runtime.retireSemanticIdentity('idx-1')).toEqual({
      status: 'skipped', reason: 'semantic-search-disabled',
    });
    expect(mocks.getSemanticIndexRepository).not.toHaveBeenCalled();
  });

  it('cut over, roll back, and retire through the repository', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    const repository = {
      activateIdentity: vi.fn().mockResolvedValue({
        status: 'activated', activatedId: 'idx-new', previousActiveId: 'idx-old',
      }),
      rollbackToIdentity: vi.fn().mockResolvedValue({
        status: 'rolled-back', activatedId: 'idx-old', previousActiveId: 'idx-new',
      }),
      retireIdentity: vi.fn().mockResolvedValue(true),
    };
    const runtime = await import('@/lib/semantic-index/runtime');
    runtime.setSemanticIndexRuntimeForTests({
      repository: repository as never,
      source: {} as never,
      embeddings: {} as never,
      service: {} as never,
      config: {} as never,
    });

    expect(await runtime.activateSemanticIdentity('idx-new')).toMatchObject({
      status: 'activated', previousActiveId: 'idx-old',
    });
    // The default gate is the same readiness bar the worker uses.
    expect(repository.activateIdentity.mock.calls[0][2]).toEqual({ minVectorCount: 1 });

    expect(await runtime.rollbackSemanticIdentity('idx-old')).toMatchObject({
      status: 'rolled-back', activatedId: 'idx-old',
    });
    expect(await runtime.retireSemanticIdentity('idx-1')).toEqual({ status: 'ok' });

    repository.retireIdentity.mockResolvedValue(false);
    expect(await runtime.retireSemanticIdentity('idx-1')).toEqual({
      status: 'skipped', reason: 'identity-not-retirable',
    });
    runtime.resetSemanticIndexRuntimeForTests();
  });

  it('report a skipped outcome instead of throwing when storage fails', async () => {
    mocks.resolved.semanticSearchEnabled = true;
    mocks.getSemanticIndexRepository.mockRejectedValue(new Error('database exploded'));
    const runtime = await import('@/lib/semantic-index/runtime');

    expect(await runtime.activateSemanticIdentity('idx-1')).toEqual({
      status: 'skipped', reason: 'activate-failed',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'semantic_identity_lifecycle_failed',
        operation: 'activate',
      }),
      expect.any(String),
    );
  });
});
