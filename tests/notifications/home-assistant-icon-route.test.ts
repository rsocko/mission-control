import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchNotificationImage: vi.fn(),
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

import { GET } from '@/app/api/notifications/[id]/subject-icon/route';

function requestIcon(id = 'notification-1') {
  return GET(
    new Request(`http://localhost/api/notifications/${id}/subject-icon`),
    { params: Promise.resolve({ id }) },
  );
}

describe('Home Assistant notification subject icon route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findNotificationForAction.mockResolvedValue({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        entityPicture: '/api/brands/integration/bambu_lab/icon.png',
      },
    });
    mocks.getOrInitializeConnector.mockResolvedValue({
      type: 'home-assistant',
      fetchNotificationImage: mocks.fetchNotificationImage,
    });
    mocks.fetchNotificationImage.mockResolvedValue({
      body: new Uint8Array([137, 80, 78, 71]).buffer,
      contentType: 'image/png',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies a canonical brand image through the owning connector', async () => {
    const response = await requestIcon();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.getOrInitializeConnector).toHaveBeenCalledWith('ha-home');
    expect(mocks.fetchNotificationImage)
      .toHaveBeenCalledWith('/api/brands/integration/bambu_lab/icon.png');
    expect(Array.from(new Uint8Array(await response.arrayBuffer())))
      .toEqual([137, 80, 78, 71]);
  });

  it('fetches legacy HACS brand artwork directly from the trusted public host', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        entityPicture: 'https://brands.home-assistant.io/_/bambu_lab/icon.png',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([137, 80, 78, 71]),
      {
        status: 200,
        headers: {
          'Content-Length': '4',
          'Content-Type': 'image/png',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await requestIcon();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://brands.home-assistant.io/_/bambu_lab/icon.png',
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();
  });

  it('proxies authenticated Supervisor add-on artwork through Home Assistant', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        entityPicture: '/api/hassio/addons/core_matter_server/icon',
      },
    });

    const response = await requestIcon();

    expect(response.status).toBe(200);
    expect(mocks.getOrInitializeConnector).toHaveBeenCalledWith('ha-home');
    expect(mocks.fetchNotificationImage)
      .toHaveBeenCalledWith('/api/hassio/addons/core_matter_server/icon');
  });

  it('does not proxy arbitrary entity picture URLs', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        attributes: { entity_picture: 'http://169.254.169.254/latest/meta-data' },
      },
    });

    const response = await requestIcon();

    expect(response.status).toBe(404);
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();
  });

  it('does not proxy arbitrary authenticated Home Assistant API paths', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'home-assistant',
      connectorInstanceId: 'ha-home',
      metadata: {
        entityPicture: '/api/config',
      },
    });

    const response = await requestIcon();

    expect(response.status).toBe(404);
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();
  });

  it('does not expose icons for notifications owned by another source', async () => {
    mocks.findNotificationForAction.mockResolvedValueOnce({
      id: 'notification-1',
      connectorType: 'custom-rest',
      connectorInstanceId: 'rest-1',
      metadata: {
        entityPicture: '/api/brands/integration/bambu_lab/icon.png',
      },
    });

    const response = await requestIcon();

    expect(response.status).toBe(404);
    expect(mocks.getOrInitializeConnector).not.toHaveBeenCalled();
  });
});
