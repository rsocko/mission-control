import { describe, expect, it } from 'vitest';
import {
  createNotificationBulkOutcome,
  MAX_NOTIFICATION_BULK_IDS,
  normalizeNotificationBulkIds,
} from '@/lib/notifications/bulk';
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from '@/lib/api/bounded-body';

describe('notification bulk request bounds', () => {
  it('deduplicates normalized IDs without duplicating work', () => {
    expect(normalizeNotificationBulkIds([' one ', 'two', 'one'])).toEqual(['one', 'two']);
  });

  it('rejects oversized and malformed ID lists before mutation', () => {
    expect(() => normalizeNotificationBulkIds(
      Array.from({ length: MAX_NOTIFICATION_BULK_IDS + 1 }, (_, index) => `n-${index}`),
    )).toThrow(/maximum/i);
    expect(() => normalizeNotificationBulkIds(['valid', ''])).toThrow(/non-empty/i);
  });

  it('reports stable accepted, no-op, failed, and queued outcome counts', () => {
    expect(createNotificationBulkOutcome({
      requestedCount: 6,
      acceptedCount: 3,
      failedCount: 1,
      queuedCount: 2,
    })).toEqual({
      acceptedCount: 3,
      noOpCount: 2,
      failedCount: 1,
      queuedCount: 2,
    });
  });
});

describe('bounded request body reads', () => {
  it('rejects an excessive declared content length without reading the body', async () => {
    const request = {
      headers: new Headers({ 'Content-Length': '11' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.close();
        },
      }),
    };
    await expect(readBoundedRequestBody(request, 10))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('rejects a streamed body that crosses the byte budget', async () => {
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readBoundedRequestBody(request, 10))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
