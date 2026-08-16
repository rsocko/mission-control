import { getSearchStatus, searchWithBranches } from '@/lib/search';
import { withRuntimeOperation } from '@/lib/telemetry/operations';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const requestedType = searchParams.get('type') || 'all';
  const requestedMode = searchParams.get('mode') || 'hybrid';
  const type = ['tasks', 'notifications', 'all'].includes(requestedType)
    ? requestedType as 'tasks' | 'notifications' | 'all'
    : null;
  const mode = ['keyword', 'semantic', 'hybrid'].includes(requestedMode)
    ? requestedMode as 'keyword' | 'semantic' | 'hybrid'
    : null;
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '20', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 50))
    : 20;
  const source = searchParams.get('source')?.trim() || undefined;
  const status = searchParams.get('status')?.trim() || undefined;
  const excludeDone = searchParams.get('excludeDone') === 'true';

  if (!query) {
    return Response.json({ error: 'q parameter is required' }, { status: 400 });
  }
  if (!type || !mode) {
    return Response.json({ error: 'type or mode parameter is invalid' }, { status: 400 });
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
      branches: {},
      results: [],
    });
  }

  const startMs = performance.now();

  const searchOptions = {
    type,
    mode,
    limit,
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(excludeDone ? { excludeDone: true } : {}),
  };
  const [execution, statusResult] = await withRuntimeOperation({
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
    branches: execution.branches,
    statusDurationMs: statusResult.durationMs,
    results: execution.results,
  });
}
