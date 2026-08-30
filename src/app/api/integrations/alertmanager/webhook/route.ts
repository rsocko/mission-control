import { z } from 'zod';
import {
  MAX_ALERTMANAGER_BATCH_ALERTS,
  normalizeAlertmanagerWebhook,
} from '@/lib/alertmanager/contracts';
import { ingestHomelabAlertEvents } from '@/lib/alertmanager/service';
import {
  getRateLimitClientKey,
  InMemoryRateLimiter,
  rateLimitHeaders,
  type RateLimitPolicy,
} from '@/lib/api/rate-limit';
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from '@/lib/api/bounded-body';
import { safeEqual } from '@/lib/api/trusted-request';
import {
  getAlertmanagerControl,
  getAlertmanagerIntegrationId,
  recordAlertmanagerIntegrationEvent,
  type AlertmanagerIntegrationEventInput,
} from '@/lib/alertmanager/operations';
import logger from '@/lib/logger';

const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_MIN_LENGTH = 32;
const RATE_POLICY: RateLimitPolicy = {
  name: 'alertmanager-webhook',
  limit: 60,
  windowMs: 60_000,
};
const SOURCE_RATE_POLICY: RateLimitPolicy = {
  name: 'alertmanager-webhook-source',
  limit: 20,
  windowMs: 10_000,
};
const AUTH_FAILURE_AUDIT_POLICY: RateLimitPolicy = {
  name: 'alertmanager-auth-failure-audit',
  limit: 5,
  windowMs: 60_000,
};
const AUTH_FAILURE_GLOBAL_AUDIT_POLICY: RateLimitPolicy = {
  name: 'alertmanager-auth-failure-audit-global',
  limit: 30,
  windowMs: 60_000,
};
const rateLimiter = new InMemoryRateLimiter();
const authFailureAuditLimiter = new InMemoryRateLimiter();
const authFailureGlobalAuditLimiter = new InMemoryRateLimiter();

function configuredToken(): string | null {
  const token = process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN?.trim();
  return token && token.length >= TOKEN_MIN_LENGTH ? token : null;
}

function isAuthorized(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length).trim();
  return Boolean(supplied) && safeEqual(supplied, expected);
}

function validationIssues(error: z.ZodError) {
  return error.issues.slice(0, 20).map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

async function respondWithAudit(
  response: Response,
  event: AlertmanagerIntegrationEventInput,
  auditRequired = false,
): Promise<Response> {
  try {
    await recordAlertmanagerIntegrationEvent(event);
    return response;
  } catch (error) {
    logger.error(
      { err: error, integration: event.integration, outcome: event.outcome },
      'Failed to record Alertmanager request outcome',
    );
    if (!auditRequired) return response;
    return Response.json(
      { error: 'Alertmanager batch was processed but its operational receipt could not be persisted' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
}

function shouldAuditAuthenticationFailure(sourceKey: string): boolean {
  const source = authFailureAuditLimiter.check(sourceKey, AUTH_FAILURE_AUDIT_POLICY);
  if (!source.allowed) return false;
  return authFailureGlobalAuditLimiter.check('global', AUTH_FAILURE_GLOBAL_AUDIT_POLICY).allowed;
}

export async function POST(request: Request) {
  const integration = getAlertmanagerIntegrationId();
  const sourceKey = getRateLimitClientKey(request);
  const expectedToken = configuredToken();
  if (!expectedToken) {
    logger.error('Alertmanager webhook token is missing or shorter than 32 characters');
    const response = Response.json(
      { error: 'Alertmanager intake is not configured' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
    if (!shouldAuditAuthenticationFailure(sourceKey)) return response;
    return respondWithAudit(response, {
      integration,
      kind: 'webhook_request',
      outcome: 'not_configured',
      httpStatus: 503,
    });
  }
  if (!isAuthorized(request, expectedToken)) {
    const response = Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
    if (!shouldAuditAuthenticationFailure(sourceKey)) return response;
    return respondWithAudit(response, {
      integration,
      kind: 'webhook_request',
      outcome: 'authentication_failed',
      httpStatus: 401,
    });
  }

  for (const [key, policy] of [
    ['alertmanager', RATE_POLICY],
    [`alertmanager:${sourceKey}`, SOURCE_RATE_POLICY],
  ] as const) {
    const rate = rateLimiter.check(key, policy);
    if (!rate.allowed) {
      logger.warn({ integration, sourceKey }, 'Alertmanager webhook request rate limited');
      return Response.json(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        {
          status: 429,
          headers: {
            ...rateLimitHeaders(rate),
            'Retry-After': String(rate.retryAfterSeconds),
          },
        },
      );
    }
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    return respondWithAudit(
      Response.json({ error: 'Content-Type must be application/json' }, { status: 415 }),
      {
        integration,
        kind: 'webhook_request',
        outcome: 'invalid_content_type',
        authenticated: true,
        httpStatus: 415,
      },
    );
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return respondWithAudit(Response.json(
        { error: 'Alertmanager payload is too large', maxBytes: error.maxBytes },
        { status: 413 },
      ), {
        integration,
        kind: 'webhook_request',
        outcome: 'payload_too_large',
        authenticated: true,
        httpStatus: 413,
      });
    }
    return respondWithAudit(
      Response.json({ error: 'Failed to read request body' }, { status: 400 }),
      {
        integration,
        kind: 'webhook_request',
        outcome: 'body_read_failed',
        authenticated: true,
        httpStatus: 400,
      },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return respondWithAudit(
      Response.json({ error: 'Invalid JSON payload' }, { status: 400 }),
      {
        integration,
        kind: 'webhook_request',
        outcome: 'invalid_json',
        authenticated: true,
        httpStatus: 400,
      },
    );
  }

  let events;
  try {
    events = normalizeAlertmanagerWebhook(payload, integration);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = validationIssues(error);
      return respondWithAudit(Response.json({
        error: 'Invalid Alertmanager webhook batch',
        maxAlerts: MAX_ALERTMANAGER_BATCH_ALERTS,
        issues,
      }, { status: 422 }), {
        integration,
        kind: 'webhook_request',
        outcome: 'invalid_batch',
        authenticated: true,
        httpStatus: 422,
        detail: issues[0] ? `${issues[0].path}: ${issues[0].message}` : undefined,
      });
    }
    throw error;
  }

  try {
    if ((await getAlertmanagerControl()).paused) {
      return respondWithAudit(Response.json({
        success: true,
        paused: true,
        accepted: events.length,
        applied: 0,
      }, { status: 202 }), {
        integration,
        kind: 'webhook_request',
        outcome: 'paused',
        authenticated: true,
        httpStatus: 202,
        result: { accepted: events.length, applied: 0 },
        detail: 'Authenticated batch intentionally dropped while intake was paused',
      }, true);
    }
    const result = ingestHomelabAlertEvents(events, { integration });
    return respondWithAudit(Response.json({ success: true, ...result }), {
      integration,
      kind: 'webhook_request',
      outcome: 'projected',
      authenticated: true,
      httpStatus: 200,
      result,
    }, true);
  } catch (error) {
    logger.error({ err: error, integration }, 'Alertmanager webhook storage failed');
    return respondWithAudit(Response.json(
      { error: 'Alertmanager batch could not be persisted' },
      { status: 503, headers: { 'Retry-After': '5' } },
    ), {
      integration,
      kind: 'webhook_request',
      outcome: 'storage_failed',
      authenticated: true,
      httpStatus: 503,
      detail: 'Batch persistence failed',
    });
  }
}
