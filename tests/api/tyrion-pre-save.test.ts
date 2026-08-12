import { afterEach, describe, expect, it, vi } from 'vitest';

function healthResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    status: 'ok',
    mode: 'live',
    reachable: true,
    authenticated: true,
    authState: 'connected',
    ...overrides,
  }), {
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Tyrion pre-save setup', () => {
  it.each([
    'finance',
    'finance-manager',
    'monarch-money',
  ])('accepts the %s alias with a composed connected gateway health response', async (type) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse()));
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        credentials: { serviceToken: 'invented-setup-token' },
        settings: { bridgeUrl: 'https://tyrion.example/api/connector/v1' },
      }),
    }));

    expect(await response.json()).toMatchObject({
      success: true,
      details: 'Tyrion bridge reachable and authenticated with Monarch',
    });
  });

  it.each([
    ['unauthenticated', 'unauthenticated', 'ok'],
    ['expired', 'expired', 'degraded'],
    ['degraded', 'degraded', 'degraded'],
  ])('rejects a composed %s gateway health response', async (_case, authState, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse({
      status,
      authenticated: false,
      authState,
    })));
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'finance-manager',
        credentials: { serviceToken: 'invented-setup-token' },
        settings: { bridgeUrl: 'https://tyrion.example/api/connector/v1' },
      }),
    }));

    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Tyrion is reachable, but its Monarch session is not authenticated',
    });
  });

  it('uses the canonical setup token with the configured private bridge base path', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FINANCE_MANAGER_API_TOKEN', 'invented-server-token');
    const fetchMock = vi.fn().mockResolvedValue(healthResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'finance-manager',
        credentials: {
          serviceToken: 'browser-setup-token',
          bridgeToken: 'alias-must-be-ignored',
        },
        settings: { bridgeUrl: 'http://custom-tyrion-bridge:8100/bridge/v1/' },
      }),
    }));

    expect(await response.json()).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://custom-tyrion-bridge:8100/bridge/v1/health',
      expect.any(Object),
    );
    const authorization = new Headers(fetchMock.mock.calls[0][1].headers).get('authorization');
    expect(authorization?.endsWith('browser-setup-token')).toBe(true);
    expect(authorization).not.toContain('invented-server-token');
    expect(authorization).not.toContain('alias-must-be-ignored');
  });

  it('rejects the public operations UI before sending the setup token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'finance-manager',
        credentials: { serviceToken: 'invented-setup-token' },
        settings: { bridgeUrl: 'https://tyrion.example' },
      }),
    }));

    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Use https://tyrion.example/api/connector/v1 for the protected Tyrion Bridge API',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a custom HTTPS bridge base path without environment configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(healthResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'finance-manager',
        credentials: { serviceToken: 'invented-setup-token' },
        settings: { bridgeUrl: 'https://bridge.example.test/custom/v1/' },
      }),
    }));

    expect(await response.json()).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bridge.example.test/custom/v1/health',
      expect.any(Object),
    );
  });

  it('returns a sanitized error without making a request when the token is absent', async () => {
    vi.stubEnv('FINANCE_MANAGER_API_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connectors/test-pre-save/route');

    const response = await POST(new Request('http://localhost/api/connectors/test-pre-save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'finance-manager',
        settings: { bridgeUrl: 'http://localhost:8100' },
      }),
    }));

    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Tyrion service token is not configured. Enter it in connector setup or set FINANCE_MANAGER_API_TOKEN on the server.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
