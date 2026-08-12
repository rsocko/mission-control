import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from '@/app/api/mcp/route';
import { isAuthorizedMcpRequest } from '@/mcp/auth';

function request(method: string, headers: Record<string, string> = {}) {
  return new Request('https://mc.example/api/mcp', {
    method,
    headers,
    ...(method === 'POST'
      ? {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'auth-test', version: '1.0.0' },
            },
          }),
        }
      : {}),
  });
}

function rpcRequest(method: string, params?: Record<string, unknown>) {
  return new Request('https://mc.example/api/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

describe('MCP HTTP transport authorization', () => {
  afterEach(() => {
    delete process.env.MC_API_KEY;
  });

  it('rejects unauthenticated POST and GET requests when configured', async () => {
    process.env.MC_API_KEY = 'trusted-key';

    const postResponse = await POST(request('POST'));
    const getResponse = await GET(request('GET'));

    expect(postResponse.status).toBe(401);
    expect(getResponse.status).toBe(401);
    await expect(postResponse.json()).resolves.toMatchObject({
      error: { code: -32001, message: 'Unauthorized' },
    });
  });

  it('accepts X-MC-API-Key and bearer credentials', () => {
    process.env.MC_API_KEY = 'trusted-key';

    expect(isAuthorizedMcpRequest(request('POST', {
      'X-MC-API-Key': 'trusted-key',
    }))).toBe(true);
    expect(isAuthorizedMcpRequest(request('POST', {
      Authorization: 'Bearer trusted-key',
    }))).toBe(true);
  });

  it('rejects invalid credentials', () => {
    process.env.MC_API_KEY = 'trusted-key';

    expect(isAuthorizedMcpRequest(request('POST', {
      'X-MC-API-Key': 'wrong-key',
    }))).toBe(false);
  });

  it('preserves documented open local mode when no key is configured', () => {
    expect(isAuthorizedMcpRequest(request('POST'))).toBe(true);
  });

  it('serves MCP App resources from the deployed HTTP transport', async () => {
    const response = await POST(rpcRequest('resources/read', {
      uri: 'ui://mc/triage-summary',
    }));
    const body = await response.text();
    const dataLine = body.split('\n').find(line => line.startsWith('data: '));
    const payload = JSON.parse(dataLine?.slice(6) || '{}');

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      result: {
        contents: [{
          uri: 'ui://mc/triage-summary',
          mimeType: 'text/html;profile=mcp-app',
          text: expect.stringContaining('ui/initialize'),
        }],
      },
    });
  });
});
