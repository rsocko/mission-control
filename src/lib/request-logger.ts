import { headers } from 'next/headers';
import logger, { requestContext, type RequestContext } from './logger';
import type { NextRequest } from 'next/server';
import { normalizeRouteFamily, withRuntimeOperation } from './telemetry/operations';

/**
 * Creates a child logger bound to the current request's trace ID.
 * Use in API route handlers for automatic correlation.
 *
 * Usage:
 *   const log = await getRequestLogger();
 *   log.info({ userId }, 'User authenticated');
 */
export async function getRequestLogger() {
  const hdrs = await headers();
  const traceId = hdrs.get('x-trace-id') || 'unknown';
  return logger.child({ traceId });
}

/**
 * Wraps an API route handler to run within request context.
 * Enables automatic trace ID injection in all logs via AsyncLocalStorage.
 */
export function withRequestContext<T>(
  request: NextRequest,
  fn: () => T | Promise<T>
): Promise<T> {
  const traceId = request.headers.get('x-trace-id') || 'unknown';
  const ctx: RequestContext = {
    traceId,
    method: request.method,
    path: new URL(request.url).pathname,
  };
  return requestContext.run(ctx, () => withRuntimeOperation({
    kind: 'request',
    name: `${request.method} ${normalizeRouteFamily(ctx.path ?? '/')}`,
    traceId,
    routeFamily: ctx.path,
  }, async () => {
      logger.info({ traceId, method: ctx.method, path: ctx.path }, 'request started');
      try {
        const result = await fn();
        logger.info({ traceId }, 'request completed');
        return result;
      } catch (err) {
        logger.error({ traceId, err }, 'request failed');
        throw err;
      }
    }));
}
