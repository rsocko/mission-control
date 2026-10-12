import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createListGroup: vi.fn(),
  getConnector: vi.fn(),
  reorderListGroups: vi.fn(),
}));

vi.mock('@/lib/list-groups/service', () => ({
  createListGroup: mocks.createListGroup,
  getListOrganizationSnapshot: vi.fn(),
  reorderListGroups: mocks.reorderListGroups,
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => ({
    getConnector: mocks.getConnector,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createListGroup.mockResolvedValue(undefined);
  mocks.reorderListGroups.mockResolvedValue(undefined);
});

describe('source-scoped list group routes', () => {
  it('requires a source when creating a group', async () => {
    const { POST } = await import('@/app/api/list-groups/route');
    const response = await POST(new Request('http://localhost/api/list-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'Planning' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.createListGroup).not.toHaveBeenCalled();
  });

  it('persists the selected source on a new group', async () => {
    mocks.getConnector.mockResolvedValue({ id: 'connector-a' });
    const { POST } = await import('@/app/api/list-groups/route');
    const response = await POST(new Request('http://localhost/api/list-groups', {
      method: 'POST',
      body: JSON.stringify({
        connectorInstanceId: 'connector-a',
        name: 'Planning',
      }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.createListGroup).toHaveBeenCalledWith(expect.objectContaining({
      connectorInstanceId: 'connector-a',
      name: 'Planning',
    }));
  });

  it('scopes group reordering to one source', async () => {
    const { PUT } = await import('@/app/api/list-groups/reorder/route');
    const response = await PUT(new Request('http://localhost/api/list-groups/reorder', {
      method: 'PUT',
      body: JSON.stringify({
        connectorInstanceId: 'connector-a',
        orderedIds: ['group-2', 'group-1'],
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.reorderListGroups).toHaveBeenCalledWith(
      'connector-a',
      ['group-2', 'group-1'],
    );
  });
});
