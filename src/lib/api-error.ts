import { NextResponse } from 'next/server';
import logger, { requestContext } from '@/lib/logger';
import { normalizeTraceId } from '@/lib/trace-id';
import { getAIOverloadDetails } from '@/lib/ai/admission-controller';

/**
 * Standardized API error response.
 * All API routes should use this helper for consistent error shapes.
 */
export interface ApiErrorBody {
  error: string;
  code: string;
  traceId?: string;
}

/**
 * Create a standardized JSON error response.
 *
 * @param message  Human-readable error description
 * @param code     Machine-readable error code (e.g. 'NOT_FOUND', 'VALIDATION_ERROR')
 * @param status   HTTP status code (default 500)
 */
export function apiError(
  message: string,
  code: string,
  status = 500,
  traceId?: string,
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: message, code };
  const safeTraceId = normalizeTraceId(traceId);
  if (safeTraceId) body.traceId = safeTraceId;
  return NextResponse.json(body, { status });
}

/** Convenience helpers for common error types */
export const ApiErrors = {
  notFound: (resource: string) =>
    apiError(`${resource} not found`, 'NOT_FOUND', 404),

  badRequest: (message: string) =>
    apiError(message, 'BAD_REQUEST', 400),

  validation: (message: string) =>
    apiError(message, 'VALIDATION_ERROR', 422),

  internal: (message: string, cause?: unknown, traceId?: string) => {
    const resolvedTraceId = normalizeTraceId(traceId ?? requestContext.getStore()?.traceId);
    const overload = getAIOverloadDetails(cause);
    if (overload) {
      logger.warn({ code: overload.code, traceId: resolvedTraceId }, 'Retryable AI capacity error');
      return NextResponse.json(
        { error: overload.message, code: overload.code, traceId: resolvedTraceId },
        {
          status: overload.status,
          headers: { 'Retry-After': String(overload.retryAfter) },
        },
      );
    }
    logger.error({ err: cause, errorMessage: message, traceId: resolvedTraceId }, 'Internal API error');
    return apiError(message, 'INTERNAL_ERROR', 500, resolvedTraceId);
  },

  unauthorized: (message = 'Unauthorized') =>
    apiError(message, 'UNAUTHORIZED', 401),

  forbidden: (message: string) =>
    apiError(message, 'FORBIDDEN', 403),

  conflict: (message: string) =>
    apiError(message, 'CONFLICT', 409),
} as const;
