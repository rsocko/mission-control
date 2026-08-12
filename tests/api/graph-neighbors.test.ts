import { beforeEach, describe, expect, it, vi } from 'vitest';

const getNodeNeighbors = vi.fn();

class MockValidationError extends Error {}
class MockNotFoundError extends Error {}
class MockAuthorizationError extends Error {}

vi.mock('@/lib/graph/neighbors-service', () => ({
  getNodeNeighbors,
  parseNodeNeighborSearchParams: (
    nodeId: string,
    searchParams: URLSearchParams,
  ) => {
    const maxNodes = searchParams.get('maxNodes');
    if (maxNodes === 'bad') throw new MockValidationError('maxNodes must be a finite number');
    return {
      nodeId,
      include: searchParams.get('include')?.split(','),
      maxNodes: maxNodes ? Number(maxNodes) : undefined,
    };
  },
  GraphNodeNotFoundError: MockNotFoundError,
  GraphAuthorizationError: MockAuthorizationError,
}));
vi.mock('@/lib/graph/query', () => ({
  GraphQueryValidationError: MockValidationError,
}));

describe('GET /api/graph/nodes/[nodeId]/neighbors', () => {
  beforeEach(() => getNodeNeighbors.mockReset());

  it('passes a decoded node ID and narrow options to the service', async () => {
    getNodeNeighbors.mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const { GET } = await import('@/app/api/graph/nodes/[nodeId]/neighbors/route');
    const response = await GET(new Request(
      'http://localhost/api/graph/nodes/task%3Atask-1/neighbors?include=explicit,semantic&maxNodes=40',
    ), {
      params: Promise.resolve({ nodeId: 'task:task-1' }),
    });
    expect(response.status).toBe(200);
    expect(getNodeNeighbors).toHaveBeenCalledWith({
      nodeId: 'task:task-1',
      include: ['explicit', 'semantic'],
      maxNodes: 40,
    });
  });

  it('returns an explicit validation error for malformed bounds', async () => {
    const { GET } = await import('@/app/api/graph/nodes/[nodeId]/neighbors/route');
    const response = await GET(new Request(
      'http://localhost/api/graph/nodes/task%3Atask-1/neighbors?maxNodes=bad',
    ), {
      params: Promise.resolve({ nodeId: 'task:task-1' }),
    });
    expect(response.status).toBe(400);
    expect(getNodeNeighbors).not.toHaveBeenCalled();
  });

  it('maps missing and unauthorized nodes without exposing data', async () => {
    const { GET } = await import('@/app/api/graph/nodes/[nodeId]/neighbors/route');
    getNodeNeighbors.mockRejectedValueOnce(new MockNotFoundError('missing'));
    const missing = await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ nodeId: 'task:missing' }),
    });
    expect(missing.status).toBe(404);

    getNodeNeighbors.mockRejectedValueOnce(new MockAuthorizationError('forbidden'));
    const forbidden = await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ nodeId: 'task:private' }),
    });
    expect(forbidden.status).toBe(403);
  });
});
