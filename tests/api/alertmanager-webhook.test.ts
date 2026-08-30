import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getControlMock,
  ingestMock,
  recordEventMock,
} = vi.hoisted(() => ({
  getControlMock: vi.fn(),
  ingestMock: vi.fn(),
  recordEventMock: vi.fn(),
}));

vi.mock('@/lib/alertmanager/service', () => ({
  ingestHomelabAlertEvents: ingestMock,
}));
vi.mock('@/lib/alertmanager/operations', () => ({
  getAlertmanagerControl: getControlMock,
  getAlertmanagerIntegrationId: () => 'homelab',
  recordAlertmanagerIntegrationEvent: recordEventMock,
}));
vi.mock('@/lib/logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function payload() {
  return {
    version: '4',
    groupKey: '{}:{alertname="NodeDown"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'mission-control',
    notification_reason: 'first notification',
    groupLabels: { alertname: 'NodeDown' },
    routeLabels: { action_required: 'true' },
    commonLabels: { severity: 'critical' },
    commonAnnotations: {},
    externalURL: 'https://alertmanager.example',
    alerts: [{
      status: 'firing',
      labels: {
        alertname: 'NodeDown',
        severity: 'critical',
        notification_type: 'homelab_service_unavailable',
        action_required: 'true',
      },
      annotations: { summary: 'Node is unavailable' },
      startsAt: '2026-08-22T20:00:00.000Z',
      endsAt: '2026-08-22T20:05:00.000Z',
      generatorURL: 'https://prometheus.example/graph',
      fingerprint: 'abcdef0123456789',
    }],
  };
}

function request(
  body: unknown = payload(),
  headers: Record<string, string> = {},
) {
  return new Request('https://mission-control.example/api/integrations/alertmanager/webhook', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('Alertmanager webhook API', () => {
  beforeEach(() => {
    process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN = 'test-token-with-at-least-32-characters';
    process.env.MC_ALERTMANAGER_INTEGRATION_ID = 'homelab';
    delete process.env.MC_TRUSTED_PROXY_HOPS;
    ingestMock.mockReset();
    getControlMock.mockReset();
    getControlMock.mockResolvedValue({ paused: false, updatedAt: null });
    recordEventMock.mockReset();
    recordEventMock.mockResolvedValue(undefined);
    ingestMock.mockReturnValue({
      accepted: 1,
      applied: 1,
      stale: 0,
      created: 1,
      updated: 0,
      duplicateReceipts: 0,
    });
  });

  it('returns the producer-facing success contract', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      accepted: 1,
      applied: 1,
      stale: 0,
      created: 1,
      updated: 0,
      duplicateReceipts: 0,
    });
    expect(ingestMock).toHaveBeenCalledWith(
      [expect.objectContaining({
        source: 'alertmanager',
        fingerprint: 'abcdef0123456789',
      })],
      { integration: 'homelab' },
    );
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'webhook_request',
      outcome: 'projected',
      authenticated: true,
      httpStatus: 200,
    }));
  });

  it('requires a correctly scoped bearer token', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request(payload(), { authorization: 'Bearer wrong-token' }));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(ingestMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'authentication_failed',
      httpStatus: 401,
    }));
  });

  it('fails closed when the server credential is missing or weak', async () => {
    process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN = 'too-short';
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('rejects malformed members without ingesting any part of the batch', async () => {
    const invalid = payload();
    invalid.alerts.push({
      ...invalid.alerts[0],
      fingerprint: '1234567890abcdef',
      labels: { ...invalid.alerts[0].labels, notification_type: 'unknown_type' },
    });
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request(invalid));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      error: 'Invalid Alertmanager webhook batch',
      maxAlerts: 100,
    });
    expect(body.issues[0]).toHaveProperty('path');
    expect(ingestMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'invalid_batch',
      authenticated: true,
    }));
  });

  it('returns a retryable 503 when storage fails', async () => {
    ingestMock.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    await expect(response.json()).resolves.toEqual({
      error: 'Alertmanager batch could not be persisted',
    });
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'storage_failed',
    }));
  });

  it('rejects unsafe content types and oversized bodies before parsing', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const wrongType = await POST(request(payload(), { 'content-type': 'text/plain' }));
    expect(wrongType.status).toBe(415);

    const oversized = await POST(request(payload(), { 'content-length': '262145' }));
    expect(oversized.status).toBe(413);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('acknowledges valid authenticated batches without projection while paused', async () => {
    getControlMock.mockResolvedValue({ paused: true, updatedAt: '2026-08-29T20:00:00.000Z' });
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      paused: true,
      accepted: 1,
      applied: 0,
    });
    expect(ingestMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'paused',
      authenticated: true,
      result: { accepted: 1, applied: 0 },
    }));
  });

  it('returns a retryable failure when a successful projection cannot be audited', async () => {
    recordEventMock.mockRejectedValue(new Error('audit storage failed'));
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(ingestMock).toHaveBeenCalledOnce();
  });

  it('does not let rejected credentials consume the authenticated delivery quota', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    for (let index = 0; index < 25; index++) {
      const rejected = await POST(request(payload(), { authorization: 'Bearer invalid-token' }));
      expect(rejected.status).toBe(401);
    }

    const accepted = await POST(request());
    expect(accepted.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
  });

  it('globally bounds rejected-auth audit writes across distributed sources', async () => {
    process.env.MC_TRUSTED_PROXY_HOPS = '1';
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    const auditWritesBefore = recordEventMock.mock.calls.length;

    for (let index = 0; index < 10_050; index++) {
      const rejected = await POST(request(payload(), {
        authorization: 'Bearer rejected-token',
        'x-forwarded-for': `192.0.2.${index + 1}, 198.51.100.1`,
      }));
      expect(rejected.status).toBe(401);
    }

    const auditWrites = recordEventMock.mock.calls.length - auditWritesBefore;
    expect(auditWrites).toBeGreaterThan(0);
    expect(auditWrites).toBeLessThanOrEqual(30);

    const accepted = await POST(request());
    expect(accepted.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
  });
});
