import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = {
  save: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};
const createTriageImageCapture = vi.fn();
const findTriageImageCaptureByRequestId = vi.fn();
const findTriageImageCaptureByImageUrl = vi.fn();

vi.mock('@/lib/triage/capture-image-storage', () => ({
  getCaptureImageStorage: () => storage,
}));
vi.mock('@/lib/triage/capture', () => ({
  createTriageImageCapture,
  findTriageImageCaptureByImageUrl,
  findTriageImageCaptureByRequestId,
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function uploadRequest(file: File, headers?: HeadersInit, authenticated = true): Request {
  const form = new FormData();
  form.set('image', file);
  form.set('title', 'Whiteboard');
  const requestHeaders = new Headers(headers);
  if (authenticated && !requestHeaders.has('x-capture-key')) {
    requestHeaders.set('x-capture-key', 'secret');
  }
  return new Request('http://localhost/api/triage/capture/image', {
    method: 'POST',
    headers: requestHeaders,
    body: form,
  });
}

describe('POST /api/triage/capture/image', () => {
  const originalKey = process.env.MC_TRIAGE_CAPTURE_KEY;
  const originalMaxBytes = process.env.CAPTURE_IMAGE_MAX_BYTES;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MC_TRIAGE_CAPTURE_KEY = 'secret';
    delete process.env.CAPTURE_IMAGE_MAX_BYTES;
    storage.save.mockImplementation(async (id: string) => `/api/triage/capture/image/${id}`);
    createTriageImageCapture.mockResolvedValue({ id: 'triage-1', contentType: 'image' });
    findTriageImageCaptureByImageUrl.mockResolvedValue(null);
    findTriageImageCaptureByRequestId.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MC_TRIAGE_CAPTURE_KEY;
    else process.env.MC_TRIAGE_CAPTURE_KEY = originalKey;
    if (originalMaxBytes === undefined) delete process.env.CAPTURE_IMAGE_MAX_BYTES;
    else process.env.CAPTURE_IMAGE_MAX_BYTES = originalMaxBytes;
  });

  it('stores a validated image and creates a triage item', async () => {
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.not-really-trusted.png', { type: 'image/png' }),
    ));

    expect(response.status).toBe(201);
    expect(storage.save).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.any(Buffer),
      'image/png',
    );
    expect(createTriageImageCapture).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Whiteboard',
      mime: 'image/png',
      originalName: 'board.not-really-trusted.png',
    }));
    expect(await response.json()).toEqual(expect.objectContaining({
      item: { id: 'triage-1', contentType: 'image' },
      imageUrl: expect.stringContaining('/api/triage/capture/image/'),
    }));
  });

  it('reports the effective configured upload limit', async () => {
    process.env.CAPTURE_IMAGE_MAX_BYTES = '12345';
    const { GET } = await import('@/app/api/triage/capture/image/route');
    const response = GET();

    expect(await response.json()).toEqual(expect.objectContaining({
      maxBytes: 12345,
      mimeTypes: expect.arrayContaining(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
    }));
  });

  it('rejects an image over the configured limit', async () => {
    process.env.CAPTURE_IMAGE_MAX_BYTES = '8';
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File([PNG_BYTES], 'large.png', { type: 'image/png' }),
    ));

    expect(response.status).toBe(413);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('rejects a declared MIME type that does not match the bytes', async () => {
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File(['not an image'], 'fake.png', { type: 'image/png' }),
    ));

    expect(response.status).toBe(415);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('requires the configured capture key and accepts the compatibility header', async () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'secret';
    const { POST } = await import('@/app/api/triage/capture/image/route');

    const unauthorized = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.png', { type: 'image/png' }),
      undefined,
      false,
    ));
    const authorized = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.png', { type: 'image/png' }),
      { 'x-capture-key': 'secret' },
      false,
    ));

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(201);
  });

  it('requires either same-origin browser context or a configured capture key', async () => {
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.png', { type: 'image/png' }),
      undefined,
      false,
    ));

    expect(response.status).toBe(401);
  });

  it('returns an existing capture for a repeated idempotency key', async () => {
    findTriageImageCaptureByRequestId.mockResolvedValue({
      id: 'existing',
      sourceUrl: '/api/triage/capture/image/existing',
    });
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.png', { type: 'image/png' }),
      { 'x-idempotency-key': 'capture-existing' },
    ));

    expect(response.status).toBe(200);
    expect(storage.save).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      item: {
        id: 'existing',
        sourceUrl: '/api/triage/capture/image/existing',
      },
      imageUrl: '/api/triage/capture/image/existing',
    });
  });

  it('does not delete storage when persistence succeeded before a readback failure', async () => {
    createTriageImageCapture.mockRejectedValue(new Error('readback failed'));
    findTriageImageCaptureByImageUrl.mockResolvedValue({
      id: 'persisted',
      sourceUrl: '/api/triage/capture/image/persisted',
    });
    const { POST } = await import('@/app/api/triage/capture/image/route');
    const response = await POST(uploadRequest(
      new File([PNG_BYTES], 'board.png', { type: 'image/png' }),
    ));

    expect(response.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/triage/capture/image/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findTriageImageCaptureByImageUrl.mockResolvedValue({
      id: 'triage-1',
      sourceUrl: '/api/triage/capture/image/2f1dfac6-69dc-4ca0-8514-7f441dc253cb',
    });
  });

  it('serves only adapter-backed UUID images with safe immutable headers', async () => {
    storage.get.mockResolvedValue({
      buffer: Buffer.from(PNG_BYTES),
      mime: 'image/png',
    });
    const { GET } = await import('@/app/api/triage/capture/image/[id]/route');
    const response = await GET(
      new Request('http://localhost/api/triage/capture/image/1'),
      { params: Promise.resolve({ id: '2f1dfac6-69dc-4ca0-8514-7f441dc253cb' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not pass path-like IDs to storage', async () => {
    const { GET } = await import('@/app/api/triage/capture/image/[id]/route');
    const response = await GET(
      new Request('http://localhost/api/triage/capture/image/..%2Fsecret'),
      { params: Promise.resolve({ id: '../secret' }) },
    );

    expect(response.status).toBe(404);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('does not serve orphaned files after the triage item is deleted', async () => {
    findTriageImageCaptureByImageUrl.mockResolvedValue(null);
    const { GET } = await import('@/app/api/triage/capture/image/[id]/route');
    const response = await GET(
      new Request('http://localhost/api/triage/capture/image/1'),
      { params: Promise.resolve({ id: '2f1dfac6-69dc-4ca0-8514-7f441dc253cb' }) },
    );

    expect(response.status).toBe(404);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
