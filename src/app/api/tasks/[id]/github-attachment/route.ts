import { NextResponse } from 'next/server';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getGitHubConnectorToken } from '@/lib/connectors/github-issues/credentials';
import { isGitHubUserAttachmentUrl } from '@/lib/github-user-attachments';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PRIVATE_IMAGE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: PRIVATE_IMAGE_HEADERS },
  );
}

function isAllowedRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const allowedHost = url.hostname.endsWith('.githubusercontent.com')
      || url.hostname === 'github-production-user-asset-6210df.s3.amazonaws.com';
    return url.protocol === 'https:'
      && allowedHost
      && url.port === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

async function fetchGitHubAttachment(
  attachmentUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = attachmentUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(currentUrl, {
      headers: {
        Accept: 'image/*',
        ...(redirectCount === 0 ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': 'Mission-Control-GitHub-Attachment-Proxy',
      },
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (
      redirectCount === MAX_REDIRECTS
      || !location
      || !isAllowedRedirectUrl(location)
    ) {
      await response.body?.cancel();
      throw new Error('GitHub attachment returned an unsafe redirect');
    }

    await response.body?.cancel();
    currentUrl = location;
  }

  throw new Error('GitHub attachment exceeded the redirect limit');
}

function boundedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let receivedBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }

      receivedBytes += result.value.byteLength;
      if (receivedBytes > MAX_ATTACHMENT_BYTES) {
        await reader.cancel('GitHub attachment exceeded the response size limit');
        controller.error(new Error('GitHub attachment exceeded the response size limit'));
        return;
      }

      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return errorResponse('GitHub attachment proxy requires a same-origin request', 403);
  }

  const attachmentUrl = new URL(request.url).searchParams.get('url');
  if (!attachmentUrl || !isGitHubUserAttachmentUrl(attachmentUrl)) {
    return errorResponse('Unsupported GitHub attachment URL', 400);
  }

  const { id: taskId } = await params;
  const task = await (await getTaskCorePersistence()).ancillary.getTask(taskId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }
  if (task.connectorType !== 'github-issues') {
    return errorResponse('Task is not linked to a GitHub Issues connector', 400);
  }

  const connector = await (
    await getConnectorManagementPersistence()
  ).getConnector(task.connectorInstanceId);
  if (!connector) {
    return errorResponse('GitHub connector not found', 404);
  }
  if (connector.type !== 'github-issues') {
    return errorResponse('Task connector is not a GitHub Issues connector', 400);
  }
  if (!connector.enabled || connector.deletedAt !== null) {
    return errorResponse('GitHub connector is not active', 403);
  }

  const token = getGitHubConnectorToken(connector.credentials, connector.settings);
  if (!token) {
    return errorResponse('GitHub connector credentials are missing', 401);
  }

  let upstream: Response;
  try {
    upstream = await fetchGitHubAttachment(
      attachmentUrl,
      token,
      AbortSignal.any([
        request.signal,
        AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ]),
    );
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return errorResponse(
      timedOut
        ? 'GitHub attachment request timed out'
        : 'GitHub attachment request failed',
      timedOut ? 504 : 502,
    );
  }

  if (upstream.status === 404) {
    return errorResponse('GitHub attachment was not found or is not accessible', 404);
  }
  if (!upstream.ok) {
    return errorResponse('GitHub attachment request failed', 502);
  }

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!contentType?.startsWith('image/')) {
    await upstream.body?.cancel();
    return errorResponse('GitHub attachment response was not an image', 415);
  }

  const contentLength = upstream.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      await upstream.body?.cancel();
      return errorResponse('GitHub attachment response had an invalid size', 502);
    }
    if (parsedLength > MAX_ATTACHMENT_BYTES) {
      await upstream.body?.cancel();
      return errorResponse('GitHub attachment exceeds the 10 MB size limit', 413);
    }
  }

  if (!upstream.body) {
    return errorResponse('GitHub attachment response was empty', 502);
  }

  const headers = new Headers(PRIVATE_IMAGE_HEADERS);
  headers.set('Content-Type', contentType);
  if (contentLength !== null) headers.set('Content-Length', contentLength);

  return new Response(boundedBody(upstream.body), { status: 200, headers });
}
