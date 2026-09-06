import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DurableAiRunRepository } from '@/lib/ai/durable-runs/repository';
import {
  createPackagedDurableAiRuntime,
  isCopilotDurableExecutionEnabled,
} from '@/lib/ai/durable-runs/packaged-worker';
import { COPILOT_EXECUTION_ROUTE } from '@/lib/ai/durable-runs/route-contract';

function repository(): DurableAiRunRepository {
  return {
    createRun: vi.fn(),
    getRun: vi.fn(),
    getInternalRun: vi.fn(),
    listInternalRunsByRoute: vi.fn(),
    listRuns: vi.fn(),
    getEventsAfter: vi.fn(),
    getEventIdempotencyKeys: vi.fn(),
    appendEvent: vi.fn(),
    appendEventForClaim: vi.fn(),
    appendEventForExecutionOwner: vi.fn(),
    claimNextRun: vi.fn().mockResolvedValue(null),
    renewLease: vi.fn(),
    isCancellationRequested: vi.fn(),
    requestCancellation: vi.fn(),
    retryRun: vi.fn(),
    completeRun: vi.fn(),
    cancelRun: vi.fn(),
    timeOutRun: vi.fn(),
    failRun: vi.fn(),
    expireTimedOutQueuedRuns: vi.fn().mockResolvedValue(0),
    recoverExpiredRuns: vi.fn().mockResolvedValue(0),
    setProviderSession: vi.fn(),
    setProviderSessionForClaim: vi.fn(),
    getProviderSession: vi.fn(),
    getProviderSessionForClaim: vi.fn(),
    revokeProviderSession: vi.fn(),
    revokeProviderSessionForClaim: vi.fn(),
    claimCleanup: vi.fn().mockResolvedValue(null),
    renewCleanupLease: vi.fn(),
    finishCleanup: vi.fn(),
    initializeExecutionState: vi.fn(),
    compareAndSetExecutionState: vi.fn(),
    pruneExpired: vi.fn().mockResolvedValue({
      runs: 0,
      events: 0,
      providerSessions: 0,
    }),
  } as unknown as DurableAiRunRepository;
}

const logger = {
  error: vi.fn(),
} as unknown as Logger;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('packaged durable AI runtime capability gate', () => {
  it('defaults direct Copilot execution to disabled', () => {
    expect(isCopilotDurableExecutionEnabled({})).toBe(false);
    expect(isCopilotDurableExecutionEnabled({
      MC_COPILOT_DURABLE_EXECUTION_ENABLED: 'false',
    })).toBe(false);
    expect(isCopilotDurableExecutionEnabled({
      MC_COPILOT_DURABLE_EXECUTION_ENABLED: ' TRUE ',
    })).toBe(true);
  });

  it('starts without a provider-session key and owns no route when disabled', async () => {
    vi.stubEnv('MC_COPILOT_DURABLE_EXECUTION_ENABLED', 'false');
    vi.stubEnv('MC_AI_PROVIDER_SESSION_KEY', '');
    const durableRuns = repository();
    const createCopilotClient = vi.fn();

    const runtime = createPackagedDurableAiRuntime(
      durableRuns,
      logger,
      () => true,
      { createCopilotClient },
    );

    expect(runtime.executionEnabled).toBe(false);
    expect(runtime.executorRoutes).toEqual([]);
    expect(createCopilotClient).not.toHaveBeenCalled();
    await expect(runtime.worker.runOnce()).resolves.toBe(false);
    expect(durableRuns.recoverExpiredRuns).toHaveBeenCalledWith(
      expect.any(Date),
      [],
    );
    expect(durableRuns.claimCleanup).toHaveBeenCalledWith(
      runtime.worker.ownerId,
      [],
      expect.any(Number),
    );
    expect(durableRuns.claimNextRun).toHaveBeenCalledWith(
      runtime.worker.ownerId,
      [],
      expect.any(Number),
    );
    expect(durableRuns.getProviderSession).not.toHaveBeenCalled();
    expect(durableRuns.getProviderSessionForClaim).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('keeps execution disabled when a legacy deployment only supplies the key', () => {
    vi.stubEnv('MC_AI_PROVIDER_SESSION_KEY', Buffer.alloc(32, 7).toString('base64'));

    const runtime = createPackagedDurableAiRuntime(
      repository(),
      logger,
      () => true,
    );

    expect(runtime.executionEnabled).toBe(false);
    expect(runtime.executorRoutes).toEqual([]);
  });

  it('fails fast when direct Copilot execution is enabled without a key', () => {
    vi.stubEnv('MC_COPILOT_DURABLE_EXECUTION_ENABLED', 'true');
    vi.stubEnv('MC_AI_PROVIDER_SESSION_KEY', '');

    expect(() => createPackagedDurableAiRuntime(
      repository(),
      logger,
      () => true,
    )).toThrow('MC_AI_PROVIDER_SESSION_KEY is required');
  });

  it('fails fast when direct Copilot execution uses malformed key material', () => {
    vi.stubEnv('MC_COPILOT_DURABLE_EXECUTION_ENABLED', 'true');
    vi.stubEnv('MC_AI_PROVIDER_SESSION_KEY', 'not-a-dedicated-32-byte-key');

    expect(() => createPackagedDurableAiRuntime(
      repository(),
      logger,
      () => true,
    )).toThrow(
      'MC_AI_PROVIDER_SESSION_KEY must be a 32-byte base64 or 64-character hex key',
    );
  });

  it('advertises the existing route when enabled with a valid dedicated key', async () => {
    vi.stubEnv('MC_COPILOT_DURABLE_EXECUTION_ENABLED', 'true');
    vi.stubEnv(
      'MC_AI_PROVIDER_SESSION_KEY',
      Buffer.alloc(32, 11).toString('base64'),
    );
    const createCopilotClient = vi.fn();

    const runtime = createPackagedDurableAiRuntime(
      repository(),
      logger,
      () => true,
      { createCopilotClient },
    );

    expect(runtime.executionEnabled).toBe(true);
    expect(runtime.executorRoutes).toEqual([COPILOT_EXECUTION_ROUTE]);
    expect(createCopilotClient).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
