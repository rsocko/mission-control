import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  load: vi.fn(),
  createContext: vi.fn(),
  createProvider: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: mocks.load,
}));
vi.mock('@/lib/ai/provider-routing-core', () => ({
  createConfiguredAIRequestContext: mocks.createContext,
}));
vi.mock('@/lib/ai/provider-client', () => ({
  createConfiguredAIProvider: mocks.createProvider,
}));

describe('async AI provider runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.load.mockImplementation(async () => {
      mocks.calls.push('load-configuration');
      return {
        resolved: { provider: 'openai', model: 'configured-model' },
        routingPolicy: { policies: {}, featureDefaults: {}, sourceDefaults: {} },
      };
    });
    mocks.createContext.mockImplementation(() => {
      mocks.calls.push('create-context');
      return { featureId: 'document-intake' };
    });
    mocks.selectModel.mockImplementation((model: string) => {
      mocks.calls.push(`select-model:${model}`);
      return { model };
    });
    mocks.createProvider.mockImplementation(() => {
      mocks.calls.push('create-provider');
      return mocks.selectModel;
    });
  });

  it('loads persisted configuration before constructing and selecting the model', async () => {
    const { getAsyncAIModel } = await import('@/lib/ai/provider-runtime');

    await expect(getAsyncAIModel('document-intake', {
      sources: ['document-intelligence'],
      correlationId: 'correlation-id',
    })).resolves.toEqual({
      model: { model: 'configured-model' },
      context: { featureId: 'document-intake' },
    });
    expect(mocks.calls).toEqual([
      'load-configuration',
      'create-context',
      'create-provider',
      'select-model:configured-model',
    ]);
    expect(mocks.createContext).toHaveBeenCalledWith(
      { policies: {}, featureDefaults: {}, sourceDefaults: {} },
      'document-intake',
      {
        sources: ['document-intelligence'],
        correlationId: 'correlation-id',
      },
    );
  });

  it('propagates configuration failures without constructing a provider', async () => {
    mocks.load.mockRejectedValueOnce(new Error('configuration unavailable'));
    const { getAsyncAIModel } = await import('@/lib/ai/provider-runtime');

    await expect(getAsyncAIModel('houston-chat')).rejects.toThrow(
      'configuration unavailable',
    );
    expect(mocks.createContext).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });
});
