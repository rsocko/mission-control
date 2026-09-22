import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryMocks = vi.hoisted(() => ({
  probeAllFinanceConnections: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/connection-recovery', () => ({
  probeAllFinanceConnections: recoveryMocks.probeAllFinanceConnections,
}));

describe('finance connection recovery scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for an active recovery probe when stopped', async () => {
    let finishProbe: (() => void) | undefined;
    recoveryMocks.probeAllFinanceConnections.mockImplementation(() => new Promise<void>((resolve) => {
      finishProbe = resolve;
    }));
    const { FinanceConnectionRecoveryScheduler } = await import(
      '@/lib/connectors/monarch-money/recovery-scheduler'
    );
    const scheduler = new FinanceConnectionRecoveryScheduler();
    const startup = scheduler.start();
    await vi.waitFor(() => {
      expect(recoveryMocks.probeAllFinanceConnections).toHaveBeenCalledOnce();
    });

    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishProbe?.();
    await Promise.all([startup, stop]);
    expect(stopped).toBe(true);
  });
});
