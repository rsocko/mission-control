import { NextResponse } from 'next/server';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import {
  resolveTyrionFinanceInsightConfig,
  TyrionFinanceInsightClient,
  TyrionFinanceInsightError,
} from '@/lib/finance-insights/client';
import {
  FINANCE_INSIGHT_ERROR_MESSAGES,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  defaultOccurrenceListQueryV1,
  occurrenceListQuerySchema,
  type OccurrenceListQueryV1,
} from '@/lib/finance-insights/contract';
import logger from '@/lib/logger';

const MAX_REQUEST_URL_LENGTH = 4_096;
const ARRAY_PARAMETERS = [
  'kind',
  'sourceLifecycle',
  'analysisState',
  'severity',
  'baselineSufficiency',
] as const;
const SINGLETON_PARAMETERS = [
  'connectorRef',
  'updatedAfter',
  'limit',
  'cursor',
] as const;
const ALLOWED_PARAMETERS = new Set<string>([
  ...ARRAY_PARAMETERS,
  ...SINGLETON_PARAMETERS,
]);

type FinanceInsightErrorCode = keyof typeof FINANCE_INSIGHT_ERROR_MESSAGES;

function errorResponse(code: FinanceInsightErrorCode, status: number) {
  return NextResponse.json({
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    error: {
      code,
      message: FINANCE_INSIGHT_ERROR_MESSAGES[code],
    },
  }, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export function parseFinanceInsightOccurrenceQuery(
  searchParams: URLSearchParams,
): OccurrenceListQueryV1 | null {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) return null;
  }
  for (const key of SINGLETON_PARAMETERS) {
    if (searchParams.getAll(key).length > 1) return null;
  }
  for (const key of ALLOWED_PARAMETERS) {
    if (searchParams.getAll(key).some((value) => value.length === 0)) return null;
  }

  const defaults = defaultOccurrenceListQueryV1();
  const limitValue = searchParams.get('limit');
  if (limitValue !== null && !/^(?:[1-9]|[1-9]\d|100)$/.test(limitValue)) {
    return null;
  }
  const candidate = {
    ...defaults,
    ...Object.fromEntries(
      ARRAY_PARAMETERS.map((key) => [
        key,
        searchParams.has(key) ? searchParams.getAll(key) : defaults[key],
      ]),
    ),
    connectorRef: searchParams.get('connectorRef'),
    updatedAfter: searchParams.get('updatedAfter'),
    limit: limitValue === null ? defaults.limit : Number(limitValue),
    cursor: searchParams.get('cursor'),
  };
  const parsed = occurrenceListQuerySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function GET(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return errorResponse('insight_forbidden', 403);
  }
  if (request.url.length > MAX_REQUEST_URL_LENGTH) {
    return errorResponse('invalid_filter', 400);
  }

  let query: OccurrenceListQueryV1 | null;
  try {
    query = parseFinanceInsightOccurrenceQuery(new URL(request.url).searchParams);
  } catch {
    query = null;
  }
  if (!query) return errorResponse('invalid_filter', 400);

  let connectorId: string | null = null;
  try {
    const config = await getPersistedFinanceConnectorConfig();
    connectorId = config.id;
    if (query.connectorRef !== null && query.connectorRef !== config.id) {
      return errorResponse('invalid_filter', 400);
    }
    const client = new TyrionFinanceInsightClient(
      resolveTyrionFinanceInsightConfig(config),
    );
    const result = await client.listOccurrences({
      ...query,
      connectorRef: config.id,
    }, request.signal);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    const code = error instanceof TyrionFinanceInsightError
      ? error.code
      : 'insight_source_unavailable';
    logger.warn(
      {
        code: 'finance_insight_read_proxy_failed',
        connectorId,
        sourceCode: code,
      },
      'Finance insight read proxy failed',
    );
    return errorResponse('insight_source_unavailable', 503);
  }
}
