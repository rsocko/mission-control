import { getSearchStatus, searchWithBranches } from '@/lib/search/semantic';
import { searchFTSFacets } from '@/lib/search/fts';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { withRuntimeOperation } from '@/lib/telemetry/operations';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const requestedType = searchParams.get('type') || 'all';
  const requestedMode = searchParams.get('mode') || 'hybrid';
  const requestedDate = searchParams.get('date') || 'all';
  const requestedNotificationKind = searchParams.get('notificationKind');
  const type = ['tasks', 'notifications', 'all'].includes(requestedType)
    ? requestedType as 'tasks' | 'notifications' | 'all'
    : null;
  const mode = ['keyword', 'semantic', 'hybrid'].includes(requestedMode)
    ? requestedMode as 'keyword' | 'semantic' | 'hybrid'
    : null;
  const date = ['all', '7d', '30d', 'overdue'].includes(requestedDate)
    ? requestedDate as 'all' | '7d' | '30d' | 'overdue'
    : null;
  const notificationKind = requestedNotificationKind === null
    ? undefined
    : ['triage', 'notes'].includes(requestedNotificationKind)
      ? requestedNotificationKind as 'triage' | 'notes'
      : null;
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '20', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 50))
    : 20;
  const source = searchParams.get('source')?.trim() || undefined;
  const status = searchParams.get('status')?.trim() || undefined;
  const excludeDone = searchParams.get('excludeDone') === 'true';
  const universeEligible = searchParams.get('universeEligible') === 'true';

  if (!query) {
    return Response.json({ error: 'q parameter is required' }, { status: 400 });
  }
  if (
    !type
    || !mode
    || !date
    || notificationKind === null
    || (notificationKind !== undefined && type !== 'notifications')
  ) {
    return Response.json(
      { error: 'type, mode, date, or notificationKind parameter is invalid' },
      { status: 400 },
    );
  }

  // Status-only check for the client to discover capabilities without searching
  if (query === '__status_check__') {
    const status = await getSearchStatus(mode);
    return Response.json({
      query: '',
      type,
      mode,
      total: 0,
      durationMs: 0,
      note: status.note,
      semanticEnabled: status.enabled,
      semanticAvailable: status.available,
      semanticState: status.state,
      semanticMetrics: status.semanticMetrics,
      semanticIndex: status.semanticMetrics?.index ?? null,
      branches: {},
      facets: { sources: [], statuses: [] },
      results: [],
    });
  }

  const startMs = performance.now();
  const now = new Date();
  const dateFrom = date === '7d' || date === '30d'
    ? new Date(now.getTime() - Number.parseInt(date, 10) * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const dueBefore = date === 'overdue' ? now.toISOString() : undefined;
  let excludedConnectorInstanceIds: string[] = [];
  if (universeEligible) {
    const connectorRepository = getCorePersistenceRepositories().connectors;
    if (typeof connectorRepository.listDeletedIds !== 'function') {
      throw new Error(
        'Connector deleted-ID persistence is not registered. Initialize the selected persistence backend before searching private data.',
      );
    }
    excludedConnectorInstanceIds = await connectorRepository.listDeletedIds();
  }

  const searchOptions = {
    type,
    mode,
    limit,
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(notificationKind ? { notificationKind } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dueBefore ? { dueBefore } : {}),
    ...(excludeDone ? { excludeDone: true } : {}),
    ...(universeEligible ? {
      universeEligible: true,
      excludeConnectorInstanceIds: excludedConnectorInstanceIds,
    } : {}),
  };
  const [execution, statusResult, facets] = await withRuntimeOperation({
    kind: 'semantic-search',
    name: mode,
    traceId: request.headers.get('x-trace-id') ?? undefined,
    routeFamily: '/api/ai/search',
  }, () => Promise.all([
      searchWithBranches(query, searchOptions),
      (async () => {
        const statusStartedAt = performance.now();
        const status = await getSearchStatus(mode);
        return {
          status,
          durationMs: Math.round(performance.now() - statusStartedAt),
        };
      })(),
      mode === 'semantic'
        ? Promise.resolve({ sources: [], statuses: [] })
        : searchFTSFacets(query, searchOptions),
    ]));

  const durationMs = Math.round(performance.now() - startMs);

  return Response.json({
    query,
    type,
    mode,
    total: execution.results.length,
    durationMs,
    note: statusResult.status.note,
    semanticEnabled: statusResult.status.enabled,
    semanticAvailable: statusResult.status.available,
    semanticState: statusResult.status.state,
    semanticMetrics: statusResult.status.semanticMetrics,
    semanticIndex: statusResult.status.semanticMetrics?.index ?? null,
    branches: execution.branches,
    facets,
    statusDurationMs: statusResult.durationMs,
    results: execution.results,
  });
}
