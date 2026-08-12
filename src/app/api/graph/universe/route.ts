import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  getFilteredSubgraph,
  parseFilteredSubgraphSearchParams,
} from '@/lib/graph/filtered-subgraph';
import { GraphQueryValidationError } from '@/lib/graph/query';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const graph = await getFilteredSubgraph(
      parseFilteredSubgraphSearchParams(searchParams),
    );

    return NextResponse.json({ graph });
  } catch (error) {
    if (error instanceof GraphQueryValidationError) {
      return ApiErrors.badRequest(error.message);
    }
    return ApiErrors.internal('Failed to fetch Universe graph', error);
  }
}
