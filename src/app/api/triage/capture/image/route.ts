import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  CAPTURE_IMAGE_MIME_TYPES,
  detectCaptureImageMimeType,
  getCaptureImageMaxBytes,
  isCaptureImageMimeType,
} from '@/lib/capture-image';
import {
  createTriageImageCapture,
  findTriageImageCaptureByImageUrl,
  findTriageImageCaptureByRequestId,
} from '@/lib/triage/capture';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { getCaptureImageStorage } from '@/lib/triage/capture-image-storage';
import { isSameOriginRequest } from '@/lib/api/trusted-request';
import logger from '@/lib/logger';
import { startRuntimeOperation } from '@/lib/runtime/lifecycle';

export const runtime = 'nodejs';

const MULTIPART_OVERHEAD_ALLOWANCE = 1024 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function GET() {
  return NextResponse.json({
    maxBytes: getCaptureImageMaxBytes(),
    mimeTypes: CAPTURE_IMAGE_MIME_TYPES,
  });
}

function textField(form: FormData, name: string, maxLength: number): string | undefined {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeOriginalName(name: string): string | undefined {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
  return normalized || undefined;
}

export async function POST(request: Request) {
  const hasConfiguredCaptureKey = Boolean(process.env.MC_TRIAGE_CAPTURE_KEY);
  const hasCaptureKey = hasConfiguredCaptureKey && hasValidTriageCaptureKey(request);
  if (!hasCaptureKey && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized capture request' }, { status: 401 });
  }

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json({ error: 'Content-Type must be multipart/form-data' }, { status: 415 });
  }

  const runtimeOperation = startRuntimeOperation('image-capture');
  if (!runtimeOperation.accepted) {
    return NextResponse.json(
      { error: 'Service is draining' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }
  try {
    return await captureImage(request, runtimeOperation.signal);
  } finally {
    runtimeOperation.finish();
  }
}

async function captureImage(request: Request, shutdownSignal: AbortSignal) {
  const maxBytes = getCaptureImageMaxBytes();
  const maxRequestBytes = maxBytes + MULTIPART_OVERHEAD_ALLOWANCE;
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return NextResponse.json(
      { error: `Image is too large. Maximum size is ${maxBytes} bytes.` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      return NextResponse.json({ error: 'The image file is required' }, { status: 400 });
    }
    const cancelReader = () => {
      void reader.cancel(shutdownSignal.reason);
    };
    shutdownSignal.addEventListener('abort', cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        shutdownSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxRequestBytes) {
          await reader.cancel();
          return NextResponse.json(
            { error: `Image is too large. Maximum size is ${maxBytes} bytes.` },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
      shutdownSignal.throwIfAborted();
    } finally {
      shutdownSignal.removeEventListener('abort', cancelReader);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    form = await new Request(request.url, {
      method: 'POST',
      headers,
      body: body.buffer,
    }).formData();
  } catch (error) {
    if (shutdownSignal.aborted) {
      return NextResponse.json(
        { error: 'Service is draining' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
    logger.warn({ err: error }, 'Invalid image capture multipart body');
    return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  const image = form.get('image');
  if (!(image instanceof File)) {
    return NextResponse.json({ error: 'The image file is required' }, { status: 400 });
  }
  if (image.size === 0) {
    return NextResponse.json({ error: 'The image file is empty' }, { status: 400 });
  }
  if (image.size > maxBytes) {
    return NextResponse.json(
      { error: `Image is too large. Maximum size is ${maxBytes} bytes.` },
      { status: 413 },
    );
  }

  const declaredMime = image.type.toLowerCase();
  if (!isCaptureImageMimeType(declaredMime)) {
    return NextResponse.json(
      { error: 'Unsupported image type. Use JPEG, PNG, WebP, or HEIC.' },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await image.arrayBuffer());
  const detectedMime = detectCaptureImageMimeType(buffer);
  if (detectedMime !== declaredMime) {
    return NextResponse.json(
      { error: 'Image content does not match its declared MIME type.' },
      { status: 415 },
    );
  }

  const idempotencyKey = request.headers.get('x-idempotency-key')?.trim();
  if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json({ error: 'Invalid X-Idempotency-Key' }, { status: 400 });
  }
  if (idempotencyKey) {
    const existing = await findTriageImageCaptureByRequestId(idempotencyKey);
    if (existing) {
      return NextResponse.json({ item: existing, imageUrl: existing.sourceUrl });
    }
  }

  const storageId = randomUUID();
  const storage = getCaptureImageStorage();
  let stored = false;
  let imageUrl: string | null = null;

  try {
    shutdownSignal.throwIfAborted();
    imageUrl = await storage.save(storageId, buffer, detectedMime);
    stored = true;
    shutdownSignal.throwIfAborted();
    const item = await createTriageImageCapture({
      storageId,
      imageUrl,
      mime: detectedMime,
      size: image.size,
      title: textField(form, 'title', 500),
      description: textField(form, 'description', 10_000),
      client: textField(form, 'client', 50),
      originalName: safeOriginalName(image.name),
      requestId: idempotencyKey,
    });

    return NextResponse.json({ item, imageUrl }, { status: 201 });
  } catch (error) {
    let persistedItem: Awaited<ReturnType<typeof findTriageImageCaptureByImageUrl>> = null;
    try {
      persistedItem = imageUrl
        ? await findTriageImageCaptureByImageUrl(imageUrl)
        : null;
    } catch (lookupError) {
      logger.error(
        { err: lookupError, storageId },
        'Could not verify image persistence after capture failure',
      );
      return NextResponse.json({ error: 'Failed to capture image' }, { status: 500 });
    }
    if (persistedItem) {
      return NextResponse.json({ item: persistedItem, imageUrl: persistedItem.sourceUrl });
    }

    let idempotentItem: Awaited<ReturnType<typeof findTriageImageCaptureByRequestId>> = null;
    if (idempotencyKey) {
      idempotentItem = await findTriageImageCaptureByRequestId(idempotencyKey);
    }

    if (stored) {
      try {
        await storage.delete(storageId);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, storageId }, 'Failed to clean up capture image');
      }
    }
    if (idempotentItem) {
      return NextResponse.json({ item: idempotentItem, imageUrl: idempotentItem.sourceUrl });
    }
    if (shutdownSignal.aborted) {
      return NextResponse.json(
        { error: 'Service is draining' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
    logger.error({ err: error, storageId }, 'Failed to capture image');
    return NextResponse.json({ error: 'Failed to capture image' }, { status: 500 });
  }
}
