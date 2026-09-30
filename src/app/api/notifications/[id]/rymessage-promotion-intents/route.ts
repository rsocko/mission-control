import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { createCompanionActionClient } from '@/lib/connectors/rymessage/companion-action-client';
import { submitDurableRyMessageV2Mutation } from '@/lib/connectors/rymessage/durable-v2-mutations';
import { normalizeTrustedOrigin } from '@/lib/connectors/rymessage/action-contract-v2';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = record(await request.json().catch(() => ({})));
  const items = Array.isArray(body.items) ? body.items.map(record) : [];
  if (items.length === 0 || items.length > 16) {
    return ApiErrors.badRequest('items must contain between 1 and 16 promotion intents');
  }

  const repositories = getCorePersistenceRepositories();
  const notification = await repositories.notifications.get(id);
  if (!notification || notification.connectorType !== 'rymessage') {
    return ApiErrors.notFound('RyMessage notification');
  }
  const metadata = record(notification.metadata);
  const actionId = typeof metadata.actionId === 'string' ? metadata.actionId : '';
  const expectedRevision = Number(metadata.revision);
  let currentRevision = expectedRevision;
  if (!UUID_RE.test(actionId)) {
    return ApiErrors.conflict('Notification is missing its canonical Companion action identity');
  }
  const connector = await repositories.connectors.get(notification.connectorInstanceId);
  if (!connector || connector.type !== 'rymessage' || !connector.enabled) {
    return ApiErrors.conflict('The RyMessage connector is unavailable');
  }
  const settings = record(connector.settings);
  const baseUrl = typeof settings.companionBaseUrl === 'string'
    ? settings.companionBaseUrl.trim()
    : '';
  const credentialEnv = typeof settings.credentialEnv === 'string'
    ? settings.credentialEnv
    : 'RYMESSAGE_COMPANION_ACTION_FEED_TOKEN';
  const credential = process.env[credentialEnv];
  const trustedMissionControlOrigin = normalizeTrustedOrigin(
    settings.trustedMissionControlOrigin,
  );
  if (!baseUrl || !credential || !trustedMissionControlOrigin) {
    return ApiErrors.conflict(
      `RyMessage Companion requires ${credentialEnv} in the Mission Control web runtime`,
    );
  }

  const client = createCompanionActionClient({
    baseUrl,
    credential,
    maxRetries: 0,
    trustedMissionControlOrigin,
  });
  const results = [];
  for (const item of items) {
    const intentId = typeof item.intentId === 'string' ? item.intentId : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const priority = item.priority !== undefined && item.priority !== 'none';
    if (
      !UUID_RE.test(intentId)
      || !title
      || Buffer.byteLength(title, 'utf8') > 512
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
    ) {
      results.push({ intentId, success: false, error: 'Invalid promotion intent' });
      continue;
    }
    try {
      const receipt = await submitDurableRyMessageV2Mutation(
        notification.connectorInstanceId,
        client,
        {
        contractVersion: '2.0',
        operationId: intentId,
        actionId,
        expectedRevision: currentRevision,
        mutation: {
          kind: 'creation-intent.register',
          intentId,
          draft: {
            title,
            ...(description ? { notes: description } : {}),
            ...(priority ? { priority } : {}),
          },
        },
        },
      );
      results.push({
        intentId,
        success: receipt.outcome !== 'conflict',
        ...(receipt.outcome === 'conflict'
          ? { error: 'Companion rejected the intent revision' }
          : {}),
      });
      currentRevision = receipt.revision;
    } catch (error) {
      results.push({
        intentId,
        success: false,
        error: error instanceof Error ? error.message : 'Companion intent registration failed',
      });
    }
  }

  return NextResponse.json({ actionId, results });
}
