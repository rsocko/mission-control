import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

afterEach(() => {
  resetProcessRuntimeRegistries();
  vi.resetModules();
});

describe('durable AI run persistence runtime', () => {
  it('returns one explicitly registered repository to concurrent callers', async () => {
    const repository = { marker: 'selected' };
    const {
      getDurableAiRunRepository,
      registerDurableAiRunRepository,
    } = await import(
      '@/lib/ai/durable-runs/runtime'
    );

    registerDurableAiRunRepository(repository as never);
    const [first, second] = await Promise.all([
      getDurableAiRunRepository(),
      getDurableAiRunRepository(),
    ]);

    expect(first).toBe(repository);
    expect(second).toBe(repository);
  });

  it('fails closed when startup has not registered a repository', async () => {
    const { getDurableAiRunRepository } = await import(
      '@/lib/ai/durable-runs/runtime'
    );

    await expect(getDurableAiRunRepository()).rejects.toThrow(
      'Durable AI run repository has not been registered',
    );
  });

  it('rejects replacement until the selected repository is cleared', async () => {
    const first = { marker: 'first' };
    const second = { marker: 'second' };
    const {
      clearDurableAiRunRepository,
      getDurableAiRunRepository,
      registerDurableAiRunRepository,
    } = await import('@/lib/ai/durable-runs/runtime');

    registerDurableAiRunRepository(first as never);
    expect(() => registerDurableAiRunRepository(second as never)).toThrow(
      'Durable AI run repository is already registered',
    );
    clearDurableAiRunRepository(second as never);
    await expect(getDurableAiRunRepository()).resolves.toBe(first);
    clearDurableAiRunRepository(first as never);
    registerDurableAiRunRepository(second as never);
    await expect(getDurableAiRunRepository()).resolves.toBe(second);
  });

  it('keeps API routes fail-closed until startup registration completes', async () => {
    const { GET } = await import('@/app/api/ai/runs/route');

    const response = await GET(new Request('http://localhost/api/ai/runs'));

    expect(response.status).toBe(500);
  });
});
