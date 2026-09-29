import { NextResponse } from 'next/server';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  COMPANION_ACTION_MAX_WRITE_BYTES,
  isCompanionActionQueueRequest,
} from '@/lib/connectors/rymessage/action-contract';
import { queueCompanionActionMutation } from '@/lib/connectors/rymessage/companion-action-service';
import { RyMessageActionPersistenceError } from '@/db/persistence/rymessage-actions';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

function persistenceError(error: unknown): NextResponse {
  if (!(error instanceof RyMessageActionPersistenceError)) throw error;
  const status = error.code === 'CONNECTOR_NOT_FOUND' || error.code === 'ACTION_NOT_FOUND'
    ? 404
    : error.code === 'IDEMPOTENCY_CONFLICT'
        || error.code === 'EVENT_IDENTITY_CONFLICT'
        || error.code === 'FIELD_REVISION_CONFLICT'
      ? 409
      : error.code.endsWith('QUOTA_EXCEEDED')
        ? 429
        : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

async function companionConnector(connectorId: string): Promise<boolean> {
  const connector = await getCorePersistenceRepositories().connectors.get(connectorId);
  return connector?.type === 'rymessage'
    && connector.enabled
    && connector.settings?.mode === 'companion';
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!await companionConnector(id)) {
    return NextResponse.json({ error: 'Companion connector not found' }, { status: 404 });
  }
  try {
    const repository = (await getWorkerPersistenceRepositories())
      .connectorState.rymessageActions;
    return NextResponse.json(await repository.readStatus(id));
  } catch (error) {
    return persistenceError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > COMPANION_ACTION_MAX_WRITE_BYTES) {
    return NextResponse.json({ error: 'Mutation request is too large' }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > COMPANION_ACTION_MAX_WRITE_BYTES) {
    return NextResponse.json({ error: 'Mutation request is too large' }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Mutation request must be valid JSON' }, { status: 400 });
  }
  if (!isCompanionActionQueueRequest(body)) {
    return NextResponse.json(
      { error: 'Mutation request is outside the allowed Companion authority' },
      { status: 400 },
    );
  }
  const { id } = await params;
  if (!await companionConnector(id)) {
    return NextResponse.json({ error: 'Companion connector not found' }, { status: 404 });
  }
  try {
    return NextResponse.json(
      await queueCompanionActionMutation(id, body),
      { status: 202 },
    );
  } catch (error) {
    return persistenceError(error);
  }
}
