/**
 * Unit tests for the standardized API error helper (src/lib/api-error.ts)
 * Validates issue #82 — consistent { error, code } response shape.
 */
import { describe, it, expect, vi } from 'vitest';

const mockGetRequestContext = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requestContext: { getStore: mockGetRequestContext },
}));

import { apiError, ApiErrors } from '@/lib/api-error';

describe('apiError()', () => {
  it('returns a NextResponse with { error, code } body and correct status', async () => {
    const res = apiError('Something went wrong', 'CUSTOM_CODE', 418);
    expect(res.status).toBe(418);
    const body = await res.json();
    expect(body).toEqual({ error: 'Something went wrong', code: 'CUSTOM_CODE' });
  });

  it('defaults to status 500 when omitted', async () => {
    const res = apiError('Server error', 'ERR');
    expect(res.status).toBe(500);
  });
});

describe('ApiErrors helpers', () => {
  it('.notFound() returns 404 with NOT_FOUND code', async () => {
    const res = ApiErrors.notFound('Task');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Task not found', code: 'NOT_FOUND' });
  });

  it('.badRequest() returns 400 with BAD_REQUEST code', async () => {
    const res = ApiErrors.badRequest('Missing field');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Missing field', code: 'BAD_REQUEST' });
  });

  it('.validation() returns 422 with VALIDATION_ERROR code', async () => {
    const res = ApiErrors.validation('Invalid email');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid email', code: 'VALIDATION_ERROR' });
  });

  it('.internal() returns 500 with INTERNAL_ERROR code', async () => {
    const res = ApiErrors.internal('DB failure');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'DB failure', code: 'INTERNAL_ERROR' });
  });

  it('.internal() includes the request trace ID when available', async () => {
    mockGetRequestContext.mockReturnValueOnce({ traceId: 'a1b2c3d4' });

    const res = ApiErrors.internal('DB failure');

    expect(await res.json()).toEqual({
      error: 'DB failure',
      code: 'INTERNAL_ERROR',
      traceId: 'a1b2c3d4',
    });
  });

  it('.internal() omits an unsafe request trace ID', async () => {
    mockGetRequestContext.mockReturnValueOnce({ traceId: 'private task title\nsecret' });

    const res = ApiErrors.internal('DB failure');

    expect(await res.json()).toEqual({
      error: 'DB failure',
      code: 'INTERNAL_ERROR',
    });
  });

  it('.unauthorized() returns 401 with default message', async () => {
    const res = ApiErrors.unauthorized();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  });

  it('.forbidden() returns 403 with FORBIDDEN code', async () => {
    const res = ApiErrors.forbidden('Not allowed');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not allowed', code: 'FORBIDDEN' });
  });

  it('.conflict() returns 409 with CONFLICT code', async () => {
    const res = ApiErrors.conflict('Already exists');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'Already exists', code: 'CONFLICT' });
  });
});
