import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  controlMock,
  recordMock,
  statusMock,
  syntheticMock,
} = vi.hoisted(() => ({
  controlMock: vi.fn(),
  recordMock: vi.fn(),
  statusMock: vi.fn(),
  syntheticMock: vi.fn(),
}));

vi.mock('@/lib/alertmanager/operations', () => ({
  getAlertmanagerControl: controlMock,
  getAlertmanagerIntegrationId: () => 'homelab',
  getAlertmanagerIntegrationStatus: statusMock,
  isAlertmanagerConfigured: () => true,
  recordAlertmanagerIntegrationEvent: recordMock,
  runSyntheticAlertmanagerLifecycle: syntheticMock,
  setAlertmanagerPaused: vi.fn(async (_integration, paused) => ({
    paused,
    updatedAt: '2026-08-29T20:00:00.000Z',
  })),
}));

function sameOriginRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://mc.example${path}`, {
    ...init,
    headers: {
      origin: 'https://mc.example',
      host: 'mc.example',
      'sec-fetch-site': 'same-origin',
      ...init.headers,
    },
  });
}

describe('Alertmanager operations API', () => {
  beforeEach(() => {
    controlMock.mockReset();
    controlMock.mockResolvedValue({ paused: false, updatedAt: null });
    recordMock.mockReset();
    recordMock.mockResolvedValue(undefined);
    statusMock.mockReset();
    statusMock.mockResolvedValue({ id: 'homelab', configured: true, connected: false });
    syntheticMock.mockReset();
    syntheticMock.mockResolvedValue({ success: true, projectionCount: 1 });
  });

  it('returns bounded system-managed status', async () => {
    const { GET } = await import('@/app/api/integrations/alertmanager/route');
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 'homelab',
      configured: true,
      connected: false,
    });
  });

  it('requires a trusted request before pausing intake', async () => {
    const { PATCH } = await import('@/app/api/integrations/alertmanager/route');
    const rejected = await PATCH(new Request('https://mc.example/api/integrations/alertmanager', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ paused: true }),
    }));
    expect(rejected.status).toBe(401);

    const accepted = await PATCH(sameOriginRequest('/api/integrations/alertmanager', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ success: true, paused: true });
  });

  it('runs the fixed synthetic lifecycle and records its result', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/test/route');
    const response = await POST(sameOriginRequest('/api/integrations/alertmanager/test', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    expect(syntheticMock).toHaveBeenCalledWith('homelab');
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'synthetic_test',
      outcome: 'passed',
    }));
  });

  it('blocks synthetic testing while intake is paused', async () => {
    controlMock.mockResolvedValue({ paused: true, updatedAt: null });
    const { POST } = await import('@/app/api/integrations/alertmanager/test/route');
    const response = await POST(sameOriginRequest('/api/integrations/alertmanager/test', {
      method: 'POST',
    }));
    expect(response.status).toBe(409);
    expect(syntheticMock).not.toHaveBeenCalled();
  });
});
