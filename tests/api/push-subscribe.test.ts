import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockWeb = {
  findSubscriptionByEndpoint: vi.fn(),
  registerSubscription: vi.fn(),
  removeSubscription: vi.fn(),
};

vi.mock('@/lib/notifications/notification-web-service', () => ({
  getNotificationWebPersistence: vi.fn(() => Promise.resolve(mockWeb)),
}));

describe('push subscribe API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects missing keys', async () => {
    const { POST } = await import('@/app/api/push/subscribe/route');
    const response = await POST(new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/test' }),
    }));
    expect(response.status).toBe(400);
  });

  it('rejects non-HTTPS endpoints (SSRF)', async () => {
    const { POST } = await import('@/app/api/push/subscribe/route');
    const response = await POST(new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'http://internal.corp/malicious',
        keys: { p256dh: 'key', auth: 'auth' },
      }),
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid push endpoint');
  });

  it('rejects endpoints to unknown domains (SSRF)', async () => {
    const { POST } = await import('@/app/api/push/subscribe/route');
    const response = await POST(new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'https://evil.example.com/steal',
        keys: { p256dh: 'key', auth: 'auth' },
      }),
    }));
    expect(response.status).toBe(400);
  });

  it('returns already_registered for duplicate endpoint', async () => {
    mockWeb.findSubscriptionByEndpoint.mockResolvedValueOnce({ id: 'existing-id' });
    const { POST } = await import('@/app/api/push/subscribe/route');
    const response = await POST(new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      headers: { 'user-agent': 'Test/1.0' },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'key', auth: 'auth' },
      }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe('already_registered');
    expect(body.id).toBe('existing-id');
  });

  it('registers new subscription with 201', async () => {
    mockWeb.findSubscriptionByEndpoint.mockResolvedValueOnce(null);
    mockWeb.registerSubscription.mockResolvedValueOnce('new-id');
    const { POST } = await import('@/app/api/push/subscribe/route');
    const response = await POST(new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      headers: { 'user-agent': 'Test/1.0' },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'key', auth: 'auth' },
      }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe('new-id');
    expect(body.status).toBe('subscribed');
  });

  it('DELETE removes subscription idempotently', async () => {
    mockWeb.removeSubscription.mockResolvedValueOnce(undefined);
    const { DELETE } = await import('@/app/api/push/subscribe/route');
    const response = await DELETE(new Request('http://localhost/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/test' }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('unsubscribed');
  });
});
