import { getSearchStatus, search } from '@/lib/search';
import { withRuntimeOperation } from '@/lib/telemetry/operations';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const type = (searchParams.get('type') || 'all') as 'tasks' | 'notifications' | 'all';
  const mode = (searchParams.get('mode') || 'hybrid') as 'keyword' | 'semantic' | 'hybrid';
  const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '20', 10), 50));

  if (!query) {
    return Response.json({ error: 'q parameter is required' }, { status: 400 });
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
      semanticAvailable: status.available,
      semanticMetrics: status.semanticMetrics,
      results: [],
    });
  }

  const startMs = performance.now();

  const [results, status] = await withRuntimeOperation({
    kind: 'semantic-search',
    name: mode,
    traceId: request.headers.get('x-trace-id') ?? undefined,
    routeFamily: '/api/ai/search',
  }, () => Promise.all([
      search(query, { type, mode, limit }),
      getSearchStatus(mode),
    ]));

  const durationMs = Math.round(performance.now() - startMs);

  return Response.json({
    query,
    type,
    mode,
    total: results.length,
    durationMs,
    note: status.note,
    semanticAvailable: status.available,
    semanticMetrics: status.semanticMetrics,
    results,
  });
}
