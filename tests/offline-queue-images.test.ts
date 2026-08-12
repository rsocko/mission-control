import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OfflineImageQueueLimitError,
  getPendingCaptures,
  queueCapture,
  syncPendingCaptures,
} from '@/lib/offline-queue';
import { OFFLINE_IMAGE_MAX_COUNT } from '@/lib/capture-image';

describe('offline image capture queue', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('File', NodeFile);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('round-trips an image blob through IndexedDB and multipart sync', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await queueCapture('Receipt', 'Lunch', {
      blob: new Blob([bytes], { type: 'image/png' }),
      name: 'receipt.png',
      type: 'image/png',
      size: bytes.byteLength,
    });

    const [queued] = await getPendingCaptures();
    expect(queued.title).toBe('Receipt');
    expect(queued.image).toEqual(expect.objectContaining({
      name: 'receipt.png',
      type: 'image/png',
      size: bytes.byteLength,
    }));
    expect(new Uint8Array(await queued.image!.blob.arrayBuffer())).toEqual(bytes);

    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 201 }));
    expect(await syncPendingCaptures()).toEqual({ synced: 1, failed: 0 });
    expect(await getPendingCaptures()).toEqual([]);

    const request = vi.mocked(fetch).mock.calls[0];
    expect(request[0]).toBe('/api/triage/capture/image');
    expect(request[1]?.body).toBeInstanceOf(FormData);
    expect((request[1]?.body as FormData).has('image')).toBe(true);
  });

  it('replays text captures to their pinned destination', async () => {
    await queueCapture('Remote task', 'Details', undefined, undefined, {
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceListId: 'work-list',
      sourceListName: 'Work',
    });
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 201 }));

    expect(await syncPendingCaptures()).toEqual({ synced: 1, failed: 0 });

    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request?.body))).toEqual({
      title: 'Remote task',
      description: 'Details',
      status: 'todo',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceListId: 'work-list',
      sourceListName: 'Work',
    });
  });

  it('bounds the number of image blobs retained offline', async () => {
    for (let index = 0; index < OFFLINE_IMAGE_MAX_COUNT; index++) {
      await queueCapture(`Image ${index}`, undefined, {
        blob: new Blob([String(index)], { type: 'image/png' }),
        name: `${index}.png`,
        type: 'image/png',
        size: 1,
      });
    }

    await expect(queueCapture('One too many', undefined, {
      blob: new Blob(['x'], { type: 'image/png' }),
      name: 'overflow.png',
      type: 'image/png',
      size: 1,
    })).rejects.toBeInstanceOf(OfflineImageQueueLimitError);
    expect(await getPendingCaptures()).toHaveLength(OFFLINE_IMAGE_MAX_COUNT);
  });

  it('retains retryable failures instead of silently deleting the image', async () => {
    await queueCapture('Retry me', undefined, {
      blob: new Blob(['image'], { type: 'image/png' }),
      name: 'retry.png',
      type: 'image/png',
      size: 5,
    });
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));

    expect(await syncPendingCaptures()).toEqual({ synced: 0, failed: 1 });
    const [queued] = await getPendingCaptures();
    expect(queued.attempts).toBe(1);
    expect(queued.lastError).toBe('HTTP 503');
  });

  it('retains configured-limit rejections for user review', async () => {
    await queueCapture('Too large for server config', undefined, {
      blob: new Blob(['image'], { type: 'image/png' }),
      name: 'large.png',
      type: 'image/png',
      size: 5,
    });
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 413 }));

    expect(await syncPendingCaptures()).toEqual({ synced: 0, failed: 1 });
    const [queued] = await getPendingCaptures();
    expect(queued.lastError).toBe('HTTP 413');
  });
});
