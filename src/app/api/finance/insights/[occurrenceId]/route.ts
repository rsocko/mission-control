import { NextResponse } from 'next/server';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { buildFinanceExternalTargetLink } from '@/lib/finance/external-links';
import {
  resolveTyrionFinanceInsightConfig,
  TyrionFinanceInsightClient,
  TyrionFinanceInsightError,
} from '@/lib/finance-insights/client';
import {
  FINANCE_INSIGHT_ERROR_MESSAGES,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  occurrenceIdSchema,
} from '@/lib/finance-insights/contract';
import logger from '@/lib/logger';

function errorResponse(
  code: 'invalid_request' | 'insight_forbidden' | 'occurrence_not_found' | 'insight_source_unavailable',
  status: number,
) {
  return NextResponse.json({
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    error: { code, message: FINANCE_INSIGHT_ERROR_MESSAGES[code] },
  }, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ occurrenceId: string }> },
) {
  if (!isTrustedFinanceReadRequest(request)) {
    return errorResponse('insight_forbidden', 403);
  }
  const occurrenceId = occurrenceIdSchema.safeParse((await params).occurrenceId);
  if (!occurrenceId.success) return errorResponse('invalid_request', 400);

  let connectorId: string | null = null;
  try {
    const config = await getPersistedFinanceConnectorConfig();
    connectorId = config.id;
    const client = new TyrionFinanceInsightClient(resolveTyrionFinanceInsightConfig(config));
    const detail = await client.getOccurrence(occurrenceId.data, config.id, request.signal);
    const externalLinks = detail.targets.flatMap((target) => {
      const resolved = buildFinanceExternalTargetLink(target);
      return resolved ? [resolved] : [];
    });
    return NextResponse.json({
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      detail,
      externalLinks,
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    const notFound = error instanceof TyrionFinanceInsightError
      && error.code === 'occurrence_not_found';
    logger.warn(
      {
        code: 'finance_insight_detail_proxy_failed',
        connectorId,
        sourceCode: error instanceof TyrionFinanceInsightError ? error.code : 'unknown',
      },
      'Finance insight detail proxy failed',
    );
    return errorResponse(
      notFound ? 'occurrence_not_found' : 'insight_source_unavailable',
      notFound ? 404 : 503,
    );
  }
}
