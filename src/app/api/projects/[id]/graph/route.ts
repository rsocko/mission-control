import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getProjectSubgraph } from '@/lib/graph/service';
import {
  GraphQueryValidationError,
  normalizeGraphBudgets,
} from '@/lib/graph/query';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const searchParams = new URL(request.url).searchParams;
    const rawLimit = searchParams.get('limit');
    const rawEdgeLimit = searchParams.get('edgeLimit');
    const limit = rawLimit === null ? 500 : Number(rawLimit);
    const edgeLimit = rawEdgeLimit === null ? undefined : Number(rawEdgeLimit);
    const budgets = normalizeGraphBudgets({ maxNodes: limit, maxEdges: edgeLimit });
    const graph = rawEdgeLimit === null
      ? await getProjectSubgraph(id, budgets.maxNodes)
      : await getProjectSubgraph(id, budgets.maxNodes, budgets.maxEdges);

    if (!graph) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    return NextResponse.json({ graph });
  } catch (error) {
    if (error instanceof GraphQueryValidationError) {
      return ApiErrors.badRequest(error.message);
    }
    return ApiErrors.internal('Failed to fetch project graph', error);
  }
}
