import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import {
  generateIdeationExpansion,
  ideationExpansionRequestSchema,
  InvalidIdeationExpansionError,
} from '@/lib/ai/ideation-expand';
import logger from '@/lib/logger';

const MAX_REQUEST_BYTES = 16_384;
const GENERATION_TIMEOUT_MS = 20_000;

class RequestTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError('Missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function safeEqual(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return valueBytes.length === expectedBytes.length && timingSafeEqual(valueBytes, expectedBytes);
}

export function isAuthorizedIdeationExpansionRequest(request: Request): boolean {
  const expectedKey = process.env.MC_API_KEY;
  const headerKey = request.headers.get('x-mc-api-key');
  const authorization = request.headers.get('authorization');
  const bearerKey = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null;

  if (expectedKey) {
    return Boolean(
      (headerKey && safeEqual(headerKey, expectedKey))
      || (bearerKey && safeEqual(bearerKey, expectedKey)),
    );
  }

  return request.headers.get('sec-fetch-site') === 'same-origin'
    && request.headers.get('origin') === new URL(request.url).origin;
}

export async function POST(request: Request) {
  if (!isAuthorizedIdeationExpansionRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request is too large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return NextResponse.json({ error: 'Request is too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ideationExpansionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid ideation expansion request' }, { status: 400 });
  }
  if (!getResolvedAIConfig().configured) {
    return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new DOMException('AI generation timed out', 'TimeoutError'));
  }, GENERATION_TIMEOUT_MS);

  try {
    const signal = AbortSignal.any([request.signal, timeoutController.signal]);
    const proposals = await generateIdeationExpansion(parsed.data, signal);
    return NextResponse.json({
      proposals,
      contextVersion: parsed.data.contextVersion,
      selectedNodeId: parsed.data.selectedNode.id,
    });
  } catch (error) {
    if (timeoutController.signal.aborted && !request.signal.aborted) {
      return NextResponse.json({ error: 'AI expansion timed out. Please retry.' }, { status: 504 });
    }
    if (error instanceof InvalidIdeationExpansionError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return NextResponse.json({ error: 'Expansion cancelled' }, { status: 499 });
    }
    logger.error({ err: error }, 'Ideation AI expansion failed');
    return NextResponse.json({ error: 'Failed to expand ideation node' }, { status: 500 });
  } finally {
    clearTimeout(timeout);
  }
}
