import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn<() => Promise<number>>(),
  error: vi.fn(),
}));

vi.mock('@/lib/push/dispatcher', () => ({
  dispatchNotificationDeliveries: mocks.dispatch,
}));

vi.mock('@/lib/logger', () => ({
  default: {
    error: mocks.error,
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  mocks.dispatch.mockReset();
  mocks.error.mockReset();
});

describe('notification delivery dispatcher wake', () => {
  it('coalesces concurrent wake requests into one microtask', async () => {
    vi.useFakeTimers();
    mocks.dispatch.mockResolvedValue(0);
    const { wakeNotificationDeliveryDispatcher } = await import(
      '@/lib/notifications/dispatcher-wake'
    );

    wakeNotificationDeliveryDispatcher();
    wakeNotificationDeliveryDispatcher();
    await vi.runAllTimersAsync();

    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('retries a failed startup wake without keeping the process alive', async () => {
    vi.useFakeTimers();
    mocks.dispatch.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(0);
    const { wakeNotificationDeliveryDispatcher } = await import(
      '@/lib/notifications/dispatcher-wake'
    );

    wakeNotificationDeliveryDispatcher();
    await vi.runAllTimersAsync();

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
