import { NextResponse } from 'next/server';
import logger, { aiLogger, requestContext } from '@/lib/logger';
import { normalizeTraceId } from '@/lib/trace-id';
import { getAIOverloadDetails } from '@/lib/ai/admission-controller';
import {
  getAIProviderErrorDetails,
  sanitizeAITelemetryLabel,
} from '@/lib/ai/provider-errors';

/**
 * Standardized API error response.
 * All API routes should use this helper for consistent error shapes.
 */
export interface ApiErrorBody {
  error: string;
  code: string;
  traceId?: string;
  retryAfterSeconds?: number;
}

interface AIErrorContext {
  featureId?: string;
  correlationId?: string;
  allowedRoutes?: string[];
  provider?: string;
  model?: string;
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

  internal: (
    message: string,
    cause?: unknown,
    traceId?: string,
    aiContext?: AIErrorContext,
  ) => {
    const resolvedTraceId = normalizeTraceId(traceId ?? requestContext.getStore()?.traceId);
    const overload = getAIOverloadDetails(cause);
    if (overload) {
      logger.warn({ code: overload.code, traceId: resolvedTraceId }, 'Retryable AI capacity error');
      return NextResponse.json(
        {
          error: overload.message,
          code: overload.code,
          traceId: resolvedTraceId,
          retryAfterSeconds: overload.retryAfter,
        },
        {
          status: overload.status,
          headers: { 'Retry-After': String(overload.retryAfter) },
        },
      );
    }
    const providerError = aiContext ? getAIProviderErrorDetails(cause) : null;
    if (providerError) {
      const correlationId = normalizeTraceId(aiContext?.correlationId) ?? resolvedTraceId;
      aiLogger.warn({
        event: 'ai_provider_request_failed',
        featureId: sanitizeAITelemetryLabel(aiContext?.featureId, 80),
        correlationId,
        allowedRoutes: aiContext?.allowedRoutes
          ?.map((route) => sanitizeAITelemetryLabel(route, 80))
          .filter((route): route is string => Boolean(route)),
        provider: sanitizeAITelemetryLabel(aiContext?.provider, 80),
        model: sanitizeAITelemetryLabel(aiContext?.model),
        errorCategory: providerError.category,
        upstreamStatus: providerError.upstreamStatus,
        responseStatus: providerError.status,
        retryAfterSeconds: providerError.retryAfter,
      }, 'Retryable AI provider error');
      return NextResponse.json(
        {
          error: providerError.message,
          code: providerError.code,
          traceId: correlationId,
          retryAfterSeconds: providerError.retryAfter,
        },
        {
          status: providerError.status,
          headers: {
            'Retry-After': String(providerError.retryAfter),
            'Cache-Control': 'no-store',
          },
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
