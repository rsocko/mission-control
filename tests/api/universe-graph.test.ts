import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUniverseSubgraph = vi.fn();

vi.mock('@/lib/graph/universe-service', () => ({ getUniverseSubgraph }));

describe('GET /api/graph/universe', () => {
  beforeEach(() => getUniverseSubgraph.mockReset());

  it('passes validated dimensions, filters, and budgets to the shared service', async () => {
    getUniverseSubgraph.mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const { GET } = await import('@/app/api/graph/universe/route');
    const response = await GET(new Request(
      'http://localhost/api/graph/universe?dimensions=priority,tags&filterQuery=assignee%3Agraph&priorities=high&statuses=todo&sources=local&listIds=local%3Ainbox&seedTaskIds=task-a,task-b,task-a&maxNodes=250&maxEdges=400',
    ));

    expect(response.status).toBe(200);
    expect(getUniverseSubgraph).toHaveBeenCalledWith(expect.objectContaining({
      dimensions: ['priority', 'tags'],
      maxNodes: 250,
      maxEdges: 400,
      seedTaskIds: ['task-a', 'task-b'],
    }));
    const filters = getUniverseSubgraph.mock.calls[0][0];
    expect(filters.taskQuery.toString()).toBe(
      'parentOnly=true&filterQuery=assignee%3Agraph&priorities=high&statuses=todo&sources=local&listIds=local%3Ainbox',
    );
  });

  it('rejects requests without a valid dimension', async () => {
    const { GET } = await import('@/app/api/graph/universe/route');
    const response = await GET(new Request(
      'http://localhost/api/graph/universe?dimensions=invalid',
    ));

    expect(response.status).toBe(400);
    expect(getUniverseSubgraph).not.toHaveBeenCalled();
  });

  it('rejects malformed numeric budgets', async () => {
    const { GET } = await import('@/app/api/graph/universe/route');
    const response = await GET(new Request(
      'http://localhost/api/graph/universe?maxNodes=not-a-number',
    ));

    expect(response.status).toBe(400);
    expect(getUniverseSubgraph).not.toHaveBeenCalled();
  });
});
