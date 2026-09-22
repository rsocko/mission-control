import logger from '@/lib/logger';
import { getScoutStatusChangeRepository } from './status-change-runtime';

const DEFAULT_LIMIT = 500;
const MAXIMUM_LIMIT = 1000;

export interface ScoutStatusChange {
  readonly mcTaskId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly title: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly suppressRepush: boolean;
}

export interface ScoutStatusChangesResponse {
  readonly changes: ScoutStatusChange[];
  readonly count: number;
  readonly hasMore: boolean;
  readonly since: string | null;
  readonly cursorSource: 'explicit' | 'write_back_cursor' | 'none';
  readonly queriedAt: string;
}

export interface ScoutStatusAcknowledgementResponse {
  readonly success: true;
  readonly cursor: string;
  readonly updatedAt: string;
}

export class InvalidScoutStatusTimestampError extends Error {}

export function hasValidScoutApiKey(request: Request): boolean {
  const expected = process.env.MC_API_KEY;
  if (!expected) return true;
  if (request.headers.get('x-mc-api-key') === expected) return true;
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim() === expected
    : false;
}

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new InvalidScoutStatusTimestampError(`${label} must be a valid ISO timestamp`);
  }
}

function normalizeTimestamp(value: string, label: string): string {
  assertTimestamp(value, label);
  return new Date(value).toISOString();
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Math.min(Math.max(parsed || DEFAULT_LIMIT, 1), MAXIMUM_LIMIT);
}

function parseSourceTypes(value: string | null): string[] | null {
  return value === null
    ? null
    : value.split(',').map((sourceType) => sourceType.trim()).filter(Boolean);
}

export async function listScoutStatusChanges(
  searchParams: URLSearchParams,
  now = new Date(),
): Promise<ScoutStatusChangesResponse> {
  const repository = getScoutStatusChangeRepository();
  const explicitSince = searchParams.get('since');
  const normalizedExplicitSince = explicitSince
    ? normalizeTimestamp(explicitSince, 'Invalid "since" parameter —')
    : null;

  const acknowledgedCursor = normalizedExplicitSince
    ? null
    : await repository.getAcknowledgedCursor();
  const since = normalizedExplicitSince ?? acknowledgedCursor;
  const queriedAt = now.toISOString();
  const page = await repository.listChanges({
    since,
    through: queriedAt,
    sourceTypes: parseSourceTypes(searchParams.get('sourceTypes')),
    limit: parseLimit(searchParams.get('limit')),
  });

  const changes = page.changes.map((change): ScoutStatusChange => ({
    ...change,
    suppressRepush:
      change.status === 'done'
      || change.status === 'cancelled'
      || (change.snoozedUntil !== null && new Date(change.snoozedUntil) > now),
  }));

  logger.info(
    {
      count: changes.length,
      hasMore: page.hasMore,
      cursorSource:
        normalizedExplicitSince ? 'explicit' : acknowledgedCursor ? 'write_back_cursor' : 'none',
    },
    '[scout-status-changes] Listed status changes',
  );

  return {
    changes,
    count: changes.length,
    hasMore: page.hasMore,
    since,
    cursorSource:
      normalizedExplicitSince ? 'explicit' : acknowledgedCursor ? 'write_back_cursor' : 'none',
    queriedAt,
  };
}

export async function acknowledgeScoutStatusChanges(
  acknowledgedAt: string,
  now = new Date(),
): Promise<ScoutStatusAcknowledgementResponse> {
  const result = await getScoutStatusChangeRepository().acknowledge({
    acknowledgedAt: normalizeTimestamp(acknowledgedAt, 'acknowledgedAt'),
    updatedAt: now.toISOString(),
  });
  logger.info(
    { advanced: result.advanced },
    '[scout-status-ack] Processed write-back acknowledgement',
  );
  return {
    success: true,
    cursor: result.cursor,
    updatedAt: result.updatedAt,
  };
}
