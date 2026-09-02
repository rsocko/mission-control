export type NotificationEnrichmentJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'superseded'
  | 'dead_letter';

export interface NotificationEnrichmentPayload {
  notificationId: string;
  title: string;
  body: string | null;
  connectorType: string;
  category: string;
  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;
}

export interface ClaimedNotificationEnrichmentJob {
  id: string;
  notificationId: string;
  sourceId: string;
  sourceRevision: string;
  sourceGeneration: number;
  payload: NotificationEnrichmentPayload;
  attemptCount: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface NotificationEnrichmentRepository {
  claimNext(input: {
    now: Date;
    leaseMs: number;
    owner: string;
  }): Promise<ClaimedNotificationEnrichmentJob | null>;
  heartbeat(
    claim: ClaimedNotificationEnrichmentJob,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  complete(
    claim: ClaimedNotificationEnrichmentJob,
    input: {
      metadata: Record<string, unknown>;
      completedAt: string;
    },
  ): Promise<'completed' | 'superseded' | 'fenced'>;
  scheduleRetry(
    claim: ClaimedNotificationEnrichmentJob,
    input: { nextAttemptAt: string; lastError: string },
  ): Promise<boolean>;
  deadLetter(
    claim: ClaimedNotificationEnrichmentJob,
    input: { lastError: string; completedAt: string },
  ): Promise<boolean>;
  recoverStaleLeases(input: { now: Date }): Promise<number>;
  getNextWakeAt(): Promise<string | null>;
}

const NOTIFICATION_ENRICHMENT_METADATA_KEYS = [
  'aiSummary',
  'aiSuggestedAction',
  'aiSuggestedActionReason',
  'aiContextTags',
  'aiUrgencyBoost',
  'aiEnrichedAt',
  'aiEnrichmentSkipped',
] as const;

export function reconcileNotificationEnrichmentMetadata(
  existingMetadata: unknown,
  incomingMetadata: Record<string, unknown>,
  existingRevision: string | null,
  incomingRevision: string | null | undefined,
): Record<string, unknown> {
  if (incomingRevision === undefined) return incomingMetadata;

  const reconciled = { ...incomingMetadata };
  for (const key of NOTIFICATION_ENRICHMENT_METADATA_KEYS) {
    delete reconciled[key];
  }
  if (
    incomingRevision === null
    || incomingRevision !== existingRevision
    || !existingMetadata
    || typeof existingMetadata !== 'object'
    || Array.isArray(existingMetadata)
  ) {
    return reconciled;
  }
  const existing = existingMetadata as Record<string, unknown>;
  for (const key of NOTIFICATION_ENRICHMENT_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      reconciled[key] = existing[key];
    }
  }
  return reconciled;
}

export function parseNotificationEnrichmentPayload(
  value: unknown,
): NotificationEnrichmentPayload {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('Stored notification enrichment payload is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored notification enrichment payload must be an object');
  }
  const payload = parsed as Partial<NotificationEnrichmentPayload>;
  if (
    typeof payload.notificationId !== 'string'
    || typeof payload.title !== 'string'
    || (payload.body !== null && typeof payload.body !== 'string')
    || typeof payload.connectorType !== 'string'
    || typeof payload.category !== 'string'
    || !payload.metadata
    || typeof payload.metadata !== 'object'
    || Array.isArray(payload.metadata)
    || !payload.presentation
    || typeof payload.presentation !== 'object'
    || Array.isArray(payload.presentation)
  ) {
    throw new Error('Stored notification enrichment payload has an invalid shape');
  }
  return payload as NotificationEnrichmentPayload;
}
