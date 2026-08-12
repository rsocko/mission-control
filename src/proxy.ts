import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getPublicDemoRestriction, isPublicDemoMode } from '@/lib/public-demo';
import {
  getPublicRateLimitPolicy,
  getRateLimitClientKey,
  InMemoryRateLimiter,
  rateLimitHeaders,
} from '@/lib/api/rate-limit';

const rateLimiter = new InMemoryRateLimiter();

/**
 * Adds a unique trace ID to every request for correlation in structured logs.
 * The ID is propagated via the x-trace-id header and picked up by the logger.
 *
 * Also sets permissive frame/CORS headers for MCP Apps widget paths.
 */
export function proxy(request: NextRequest) {
  const traceId = request.headers.get('x-trace-id') || crypto.randomUUID().slice(0, 8);
  const policy = getPublicRateLimitPolicy(request.nextUrl.pathname, request.method);
  if (policy) {
    const result = rateLimiter.check(
      getRateLimitClientKey(request),
      policy,
    );
    if (!result.allowed) {
      console.warn('Public API request rate limited', {
        route: policy.name,
        method: request.method,
        traceId,
      });
      return NextResponse.json(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        {
          status: 429,
          headers: {
            ...rateLimitHeaders(result),
            'Retry-After': String(result.retryAfterSeconds),
            'Cache-Control': 'no-store',
            'x-trace-id': traceId,
          },
        },
      );
    }
  }

  if (isPublicDemoMode()) {
    const restriction = getPublicDemoRestriction(request.nextUrl.pathname, request.method);
    if (restriction) {
      return NextResponse.json(
        { error: restriction, code: 'PUBLIC_DEMO_RESTRICTED' },
        {
          status: 403,
          headers: {
            'Cache-Control': 'no-store',
            'x-trace-id': traceId,
            'x-mc-demo-mode': 'public',
          },
        },
      );
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-trace-id', traceId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('x-trace-id', traceId);
  if (isPublicDemoMode()) {
    response.headers.set('x-mc-demo-mode', 'public');
  }

  // MCP Apps widgets must be embeddable in sandboxed iframes
  if (request.nextUrl.pathname.startsWith('/mcp-widgets/')) {
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https:; connect-src *; frame-ancestors *;"
    );
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.delete('X-Frame-Options');
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/mcp-widgets/:path*'],
};
