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
const rateLimiter = new InMemoryRateLimiter();

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

export async function POST(request: Request) {
  const expectedToken = configuredToken();
  if (!expectedToken) {
    logger.error('Alertmanager webhook token is missing or shorter than 32 characters');
    return Response.json(
      { error: 'Alertmanager intake is not configured' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }
  if (!isAuthorized(request, expectedToken)) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const sourceKey = getRateLimitClientKey(request);
  for (const [key, policy] of [
    ['alertmanager', RATE_POLICY],
    [`alertmanager:${sourceKey}`, SOURCE_RATE_POLICY],
  ] as const) {
    const rate = rateLimiter.check(key, policy);
    if (!rate.allowed) {
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

  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: 'Alertmanager payload is too large', maxBytes: error.maxBytes },
        { status: 413 },
      );
    }
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const integration = process.env.MC_ALERTMANAGER_INTEGRATION_ID?.trim() || 'homelab';
  let events;
  try {
    events = normalizeAlertmanagerWebhook(payload, integration);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({
        error: 'Invalid Alertmanager webhook batch',
        maxAlerts: MAX_ALERTMANAGER_BATCH_ALERTS,
        issues: validationIssues(error),
      }, { status: 422 });
    }
    throw error;
  }

  try {
    const result = ingestHomelabAlertEvents(events, { integration });
    return Response.json({ success: true, ...result });
  } catch (error) {
    logger.error({ err: error, integration }, 'Alertmanager webhook storage failed');
    return Response.json(
      { error: 'Alertmanager batch could not be persisted' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
}
