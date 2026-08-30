import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSemanticHarness, type SemanticHarness } from './harness';

const mocks = vi.hoisted(() => ({ semanticSearchEnabled: true }));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({
    provider: 'openai',
    configured: true,
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'test',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    semanticSearchEnabled: mocks.semanticSearchEnabled,
  }),
}));

describe('scheduleSemanticBackfill', () => {
  let harness: SemanticHarness;
  let runtime: typeof import('@/lib/semantic-index/runtime');

  beforeEach(async () => {
    vi.resetModules();
    mocks.semanticSearchEnabled = true;
    harness = createSemanticHarness();
    runtime = await import('@/lib/semantic-index/runtime');
    runtime.setSemanticIndexRuntimeForTests({
      repository: harness.repository,
      source: harness.source,
      embeddings: harness.embeddings,
      service: harness.service,
      config: harness.config,
    });
  });

  afterEach(() => {
    runtime.resetSemanticIndexRuntimeForTests();
    harness.close();
  });

  it('records a durable backfill run instead of rebuilding in-process', async () => {
    const identity = await harness.service.ensureIdentity({ create: true });
    if (identity.status !== 'ready') throw new Error('expected an identity');
    const embedCallsAfterProvisioning = harness.embeddings.calls.length;

    const scheduled = await runtime.scheduleSemanticBackfill();

    expect(scheduled).toMatchObject({
      status: 'scheduled',
      indexId: identity.identity.id,
      runStatus: 'queued',
    });
    const run = await harness.repository.getRun(scheduled.runId!);
    expect(run).toMatchObject({ kind: 'backfill', status: 'queued', checkpoint: null });
    // Scheduling embeds nothing: the worker owns corpus work.
    expect(harness.embeddings.calls).toHaveLength(embedCallsAfterProvisioning);
  });

  it('is idempotent within a maintenance window', async () => {
    await harness.service.ensureIdentity({ create: true });

    const first = await runtime.scheduleSemanticBackfill();
    const second = await runtime.scheduleSemanticBackfill();

    expect(first.status).toBe('scheduled');
    expect(second).toMatchObject({ status: 'existing', runId: first.runId });
  });

  it('skips without provisioning an identity when none exists yet', async () => {
    const scheduled = await runtime.scheduleSemanticBackfill();

    expect(scheduled).toEqual({ status: 'skipped', reason: 'identity-not-created' });
    expect(await harness.repository.listIdentities()).toEqual([]);
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('skips when semantic search is switched off', async () => {
    mocks.semanticSearchEnabled = false;

    await expect(runtime.scheduleSemanticBackfill()).resolves.toEqual({
      status: 'skipped',
      reason: 'semantic-search-disabled',
    });
  });
});
