import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchNotificationReleaseNotes: vi.fn(),
  findNotificationForAction: vi.fn(),
  getOrInitializeConnector: vi.fn(),
}));

vi.mock('@/lib/notifications/notification-web-service', () => ({
  getNotificationWebPersistence: vi.fn(async () => ({
    findNotificationForAction: mocks.findNotificationForAction,
  })),
}));

vi.mock('@/lib/connectors/runtime', () => ({
  getOrInitializeConnector: mocks.getOrInitializeConnector,
}));

import { GET } from '@/app/api/notifications/[id]/release-notes/route';

function requestReleaseNotes(id = 'notification-1') {
  return GET(
    new Request(`http://localhost/api/notifications/${id}/release-notes`),
    { params: Promise.resolve({ id }) },
  );
}

describe('Home Assistant release notes route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findNotificationForAction.mockResolvedValue({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        haSource: 'updates',
        entityId: 'update.battery_notes',
        supportsReleaseNotes: true,
      },
    });
    mocks.getOrInitializeConnector.mockResolvedValue({
      type: 'home-assistant',
      fetchNotificationReleaseNotes: mocks.fetchNotificationReleaseNotes,
    });
    mocks.fetchNotificationReleaseNotes.mockResolvedValue(
      '## Bug fixes\n\n- Fixed discovery.',
    );
  });

  it('returns release notes through the notification owning connector', async () => {
    const response = await requestReleaseNotes();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    await expect(response.json()).resolves.toEqual({
      releaseNotes: '## Bug fixes\n\n- Fixed discovery.',
    });
    expect(mocks.getOrInitializeConnector).toHaveBeenCalledWith('ha-home');
    expect(mocks.fetchNotificationReleaseNotes)
      .toHaveBeenCalledWith('update.battery_notes');
  });

  it('does not query Home Assistant for unsupported or unrelated notifications', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        haSource: 'updates',
        entityId: 'update.battery_notes',
        supportsReleaseNotes: false,
      },
    });

    expect((await requestReleaseNotes()).status).toBe(404);
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();

    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'custom-rest',
      connectorInstanceId: 'rest-home',
      metadata: {
        entityId: 'update.battery_notes',
        supportsReleaseNotes: true,
      },
    });

    expect((await requestReleaseNotes()).status).toBe(404);
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();
  });

  it('returns a recoverable error when Home Assistant is unavailable', async () => {
    mocks.fetchNotificationReleaseNotes.mockRejectedValueOnce(new Error('offline'));

    const response = await requestReleaseNotes();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Release notes are temporarily unavailable',
    });
  });
});
