import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_PUSH_PREFERENCES } from '@/db/persistence/notification-push';

const mocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  getPushDeliveryEnabled: vi.fn(),
  savePreferences: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('@/lib/push/notification-push-service', () => ({
  getNotificationPushPersistence: async () => ({
    getPreferences: mocks.getPreferences,
    getPushDeliveryEnabled: mocks.getPushDeliveryEnabled,
    savePreferences: mocks.savePreferences,
  }),
}));
vi.mock('@/lib/push/scheduler', () => ({
  pushNotificationScheduler: {
    restart: mocks.restart,
  },
}));

import { GET, PUT } from '@/app/api/push/preferences/route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/push/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPreferences.mockResolvedValue({ ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES });
  mocks.getPushDeliveryEnabled.mockResolvedValue(true);
  mocks.savePreferences.mockResolvedValue(undefined);
  mocks.restart.mockResolvedValue(undefined);
});

describe('push preferences route', () => {
  it('returns preferences and the delivery master switch', async () => {
    mocks.getPushDeliveryEnabled.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
      pushDeliveryEnabled: false,
    });
  });

  it('saves validated values atomically and preserves an omitted master switch', async () => {
    const response = await PUT(request({
      morningEnabled: false,
      morningHour: 9,
      quietStart: 22,
      quietEnd: 7,
    }));

    expect(response.status).toBe(200);
    expect(mocks.savePreferences).toHaveBeenCalledWith({
      preferences: {
        ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
        morningEnabled: false,
        morningHour: 9,
        quietStart: 22,
        quietEnd: 7,
      },
      pushDeliveryEnabled: undefined,
      updatedAt: expect.any(String),
    });
    expect(mocks.restart).toHaveBeenCalledOnce();
  });

  it('refreshes scheduler state only after persistence succeeds', async () => {
    const response = await PUT(request({ carryForwardHour: 20 }));
    expect(response.status).toBe(200);
    expect(mocks.savePreferences.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.restart.mock.invocationCallOrder[0]);
  });

  it.each([
    [{ morningHour: 24 }, 'morningHour must be 0-23'],
    [{ carryForwardHour: -1 }, 'carryForwardHour must be 0-23'],
    [{ triageNudgeThreshold: 0 }, 'triageNudgeThreshold must be a positive integer'],
    [{ quietStart: 24 }, 'quietStart must be 0-23'],
    [{ quietEnd: 1.5 }, 'quietEnd must be 0-23'],
    [{ pushDeliveryEnabled: 'false' }, 'pushDeliveryEnabled must be a boolean'],
    [{ morningEnabled: 'false' }, 'morningEnabled must be a boolean'],
    [{ triageNudgeEnabled: 1 }, 'triageNudgeEnabled must be a boolean'],
    [{ carryForwardEnabled: null }, 'carryForwardEnabled must be a boolean'],
    [{ doNotDisturb: 'true' }, 'doNotDisturb must be a boolean'],
  ])('rejects invalid input %#', async (body, error) => {
    const response = await PUT(request(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.savePreferences).not.toHaveBeenCalled();
  });

  it('redacts persistence failures and does not restart', async () => {
    mocks.savePreferences.mockRejectedValue(new Error('postgres://secret@example'));
    const response = await PUT(request({ morningHour: 9 }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to save preferences' });
    expect(mocks.restart).not.toHaveBeenCalled();
  });
});
