/**
 * Tests for PR #308 — Stop exposing raw internal error details in API responses
 */
import { describe, it, expect, vi } from 'vitest';

// ─── Test the ApiErrors helper directly ─────────────────────────────────────

const mockGetRequestContext = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requestContext: { getStore: mockGetRequestContext },
}));

describe('ApiErrors helper — safe error responses (PR #308)', () => {
  it('internal() should return generic message, not the raw error', async () => {
    const { ApiErrors } = await import('@/lib/api-error');
    const sensitiveError = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed on users.email at /app/node_modules/better-sqlite3/lib/methods/run.js:12:14');

    const response = ApiErrors.internal('Operation failed', sensitiveError);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Operation failed');
    expect(data.code).toBe('INTERNAL_ERROR');
    // Must NOT contain the raw error details
    expect(data.error).not.toContain('SQLITE_CONSTRAINT');
    expect(data.error).not.toContain('node_modules');
    expect(JSON.stringify(data)).not.toContain('UNIQUE constraint');
  });

  it('internal() should not expose stack traces in the response body', async () => {
    const { ApiErrors } = await import('@/lib/api-error');
    const errorWithStack = new Error('Connection refused');
    errorWithStack.stack = 'Error: Connection refused\n    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)';

    const response = ApiErrors.internal('Service unavailable', errorWithStack);
    const body = await response.text();

    expect(body).not.toContain('TCPConnectWrap');
    expect(body).not.toContain('net.js');
  });

  it('notFound() should return 404 with clean message', async () => {
    const { ApiErrors } = await import('@/lib/api-error');
    const response = ApiErrors.notFound('Task');
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Task not found');
    expect(data.code).toBe('NOT_FOUND');
  });

  it('badRequest() should return 400 with provided message', async () => {
    const { ApiErrors } = await import('@/lib/api-error');
    const response = ApiErrors.badRequest('Missing required field: name');
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Missing required field: name');
    expect(data.code).toBe('BAD_REQUEST');
  });

  it('validation() should return 422', async () => {
    const { ApiErrors } = await import('@/lib/api-error');
    const response = ApiErrors.validation('Invalid email format');
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('all error responses should have consistent shape: { error, code }', async () => {
    const { ApiErrors } = await import('@/lib/api-error');

    const responses = [
      ApiErrors.notFound('Item'),
      ApiErrors.badRequest('Bad'),
      ApiErrors.validation('Invalid'),
      ApiErrors.internal('Oops', new Error('secret')),
      ApiErrors.unauthorized(),
      ApiErrors.forbidden('No access'),
      ApiErrors.conflict('Duplicate'),
    ];

    for (const response of responses) {
      const data = await response.json();
      expect(data).toHaveProperty('error');
      expect(data).toHaveProperty('code');
      expect(typeof data.error).toBe('string');
      expect(typeof data.code).toBe('string');
    }
  });
});
