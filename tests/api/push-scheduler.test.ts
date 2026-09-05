import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_PUSH_PREFERENCES } from '@/db/persistence/notification-push';

const mocks = vi.hoisted(() => {
  let running = true;
  return {
    running: () => running,
    reset: () => { running = true; },
    getStatus: vi.fn(() => []),
    restart: vi.fn(async () => { running = true; }),
    startAndPersist: vi.fn(async () => { running = true; }),
    stopAndPersist: vi.fn(async () => { running = false; }),
    restartAndPersist: vi.fn(async () => { running = true; }),
    getScheduledSummariesEnabled: vi.fn(),
  };
});

vi.mock('@/lib/push/notification-push-service', () => ({
  getNotificationPushPersistence: async () => ({
    getScheduledSummariesEnabled: mocks.getScheduledSummariesEnabled,
  }),
}));
vi.mock('@/lib/push/scheduler', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/push/scheduler')>();
  return {
    ...original,
    scheduledSummariesEnabled: mocks.getScheduledSummariesEnabled,
    pushNotificationScheduler: {
      getStatus: mocks.getStatus,
      isRunning: mocks.running,
      restart: mocks.restart,
      startAndPersist: mocks.startAndPersist,
      stopAndPersist: mocks.stopAndPersist,
      restartAndPersist: mocks.restartAndPersist,
    },
  };
});

import { GET, POST } from '@/app/api/push/scheduler/route';

function request(action: string): Request {
  return new Request('http://localhost/api/push/scheduler', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reset();
  mocks.getScheduledSummariesEnabled.mockResolvedValue(true);
});

describe('push scheduler route', () => {
  it('reports persisted and runtime state', async () => {
    mocks.getScheduledSummariesEnabled.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      jobs: [],
      running: true,
    });
  });

  it.each([
    ['start', 'startAndPersist', 'running'],
    ['stop', 'stopAndPersist', 'stopped'],
    ['restart', 'restartAndPersist', 'running'],
  ] as const)('serializes %s through the scheduler lifecycle', async (action, method, status) => {
    const response = await POST(request(action));
    expect(response.status).toBe(200);
    expect(mocks[method]).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ status });
  });

  it('rejects unsupported actions without mutating scheduler state', async () => {
    const response = await POST(request('pause'));
    expect(response.status).toBe(400);
    expect(mocks.startAndPersist).not.toHaveBeenCalled();
    expect(mocks.stopAndPersist).not.toHaveBeenCalled();
    expect(mocks.restartAndPersist).not.toHaveBeenCalled();
  });

  it('redacts persistence and scheduler errors', async () => {
    mocks.startAndPersist.mockRejectedValueOnce(new Error('postgres://secret@example'));
    const response = await POST(request('start'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to control scheduler' });
  });
});

describe('PushNotificationScheduler lifecycle', () => {
  it('fails closed before handlers are registered and recovers after an error', async () => {
    vi.resetModules();
    const scheduledCallbacks: Array<() => Promise<void>> = [];
    const cronTask = { start: vi.fn(), stop: vi.fn() };
    vi.doMock('node-cron', () => ({
      default: {
        schedule: vi.fn((_schedule: string, callback: () => Promise<void>) => {
          scheduledCallbacks.push(callback);
          return cronTask;
        }),
      },
    }));
    vi.doMock('@/lib/mode', () => ({ getTimezone: () => 'America/New_York' }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    }));
    const persistence = {
      getPreferences: vi.fn(async () => ({ ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES })),
      getScheduledSummariesEnabled: vi.fn(async () => true),
      setScheduledSummariesEnabled: vi.fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValue(undefined),
    };
    vi.doMock('@/lib/push/notification-push-service', () => ({
      getNotificationPushPersistence: async () => persistence,
    }));
    const schedulerModule = await import('@/lib/push/scheduler');
    await schedulerModule._resetPushNotificationSchedulerForTests();
    const scheduler = new schedulerModule.PushNotificationScheduler();

    await expect(scheduler.start()).rejects.toThrow(
      'Push notification scheduler handlers have not been registered',
    );
    const handlers = {
      triggerMorningNotification: vi.fn(async () => true),
      triggerTriageNudge: vi.fn(async () => true),
      triggerCarryForwardReminder: vi.fn(async () => true),
    };
    schedulerModule.registerScheduledPushHandlers(handlers);
    expect(() => schedulerModule.registerScheduledPushHandlers({
      triggerMorningNotification: vi.fn(async () => false),
      triggerTriageNudge: vi.fn(async () => false),
      triggerCarryForwardReminder: vi.fn(async () => false),
    })).not.toThrow();
    await expect(scheduler.startAndPersist()).rejects.toThrow('temporary failure');
    expect(scheduler.isRunning()).toBe(false);
    expect(persistence.setScheduledSummariesEnabled).toHaveBeenNthCalledWith(
      2,
      false,
      expect.any(String),
    );
    await expect(scheduler.startAndPersist()).resolves.toBeUndefined();
    expect(scheduler.isRunning()).toBe(true);
    expect(cronTask.start).toHaveBeenCalledTimes(6);
    handlers.triggerMorningNotification.mockRejectedValueOnce(
      new Error('secret-token-must-not-leak'),
    );
    await scheduledCallbacks[3]();
    expect(scheduler.getStatus()[0]).toMatchObject({
      lastError: 'Push notification job failed',
      lastResult: 'error',
    });
    expect(JSON.stringify(scheduler.getStatus())).not.toContain('secret-token-must-not-leak');

    const stop = scheduler.stopAndPersist();
    const stalePreferencesRestart = scheduler.restart();
    await Promise.all([stop, stalePreferencesRestart]);
    expect(scheduler.isRunning()).toBe(false);
    expect(persistence.setScheduledSummariesEnabled).toHaveBeenLastCalledWith(
      false,
      expect.any(String),
    );
    expect(cronTask.start).toHaveBeenCalledTimes(6);
  });
});
