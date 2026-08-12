import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  GraphAuthorizationError,
  GraphNodeNotFoundError,
  getNodeNeighbors,
  parseNodeNeighborSearchParams,
} from '@/lib/graph/neighbors-service';
import { GraphQueryValidationError } from '@/lib/graph/query';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  try {
    const { nodeId } = await params;
    const graph = await getNodeNeighbors(parseNodeNeighborSearchParams(
      nodeId,
      new URL(request.url).searchParams,
    ));
    return NextResponse.json({ graph });
  } catch (error) {
    if (error instanceof GraphQueryValidationError) {
      return ApiErrors.badRequest(error.message);
    }
    if (error instanceof GraphNodeNotFoundError) {
      return ApiErrors.notFound('Graph node');
    }
    if (error instanceof GraphAuthorizationError) {
      return ApiErrors.forbidden(error.message);
    }
    return ApiErrors.internal('Failed to fetch graph neighbors', error);
  }
}
