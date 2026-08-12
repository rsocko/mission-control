import { safeEqual } from '@/lib/api/trusted-request';

/**
 * MCP is intentionally open when MC_API_KEY is unset (local/homelab mode).
 * Configured deployments require the key at the transport boundary.
 */
export function isAuthorizedMcpRequest(request: Request) {
  const expectedApiKey = process.env.MC_API_KEY;
  if (!expectedApiKey) {
    return true;
  }

  const apiKey = request.headers.get('x-mc-api-key');
  if (apiKey && safeEqual(apiKey, expectedApiKey)) {
    return true;
  }

  const authorization = request.headers.get('authorization');
  return Boolean(
    authorization?.startsWith('Bearer ')
    && safeEqual(authorization.slice('Bearer '.length).trim(), expectedApiKey),
  );
}

export function unauthorizedMcpResponse() {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
