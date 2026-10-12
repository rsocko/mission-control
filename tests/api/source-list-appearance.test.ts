import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConnectorManagementPersistence, patchSourceList } = vi.hoisted(() => ({
  getConnectorManagementPersistence: vi.fn(),
  patchSourceList: vi.fn(),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence,
}));

beforeEach(() => {
  vi.clearAllMocks();
  patchSourceList.mockResolvedValue(undefined);
  getConnectorManagementPersistence.mockResolvedValue({
    getSourceList: vi.fn().mockResolvedValue({
      id: 'list-1',
      connectorInstanceId: 'connector-a',
    }),
    getListGroupOwner: vi.fn().mockResolvedValue('connector-a'),
    patchSourceList,
  });
});

async function patch(body: unknown) {
  const { PATCH } = await import('@/app/api/source-lists/[id]/route');
  return PATCH(
    new Request('http://localhost/api/source-lists/list-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'list-1' }) },
  );
}

describe('source list appearance route', () => {
  it('rejects assigning a list to a group from another source', async () => {
    getConnectorManagementPersistence.mockResolvedValue({
      getSourceList: vi.fn().mockResolvedValue({
        id: 'list-1',
        connectorInstanceId: 'connector-a',
      }),
      getListGroupOwner: vi.fn().mockResolvedValue('connector-b'),
      patchSourceList,
    });

    const response = await patch({ groupId: 'group-b' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Lists can only be assigned to groups from the same source',
    });
    expect(patchSourceList).not.toHaveBeenCalled();
  });

  it('persists a validated appearance override', async () => {
    const appearance = {
      strength: 'canvas',
      backdrop: 'nebula',
      accentColor: '#14b8a6',
    };

    const response = await patch({ appearance });

    expect(response.status).toBe(200);
    expect(patchSourceList).toHaveBeenCalledWith({
      sourceListId: 'list-1',
      groupId: undefined,
      hidden: undefined,
      appearance,
    });
  });

  it('allows clearing an override to restore inheritance', async () => {
    const response = await patch({ appearance: null });

    expect(response.status).toBe(200);
    expect(patchSourceList).toHaveBeenCalledWith(expect.objectContaining({
      appearance: null,
    }));
  });

  it('rejects malformed appearance values', async () => {
    const response = await patch({
      appearance: { strength: 'maximum', backdrop: 'nebula' },
    });

    expect(response.status).toBe(400);
    expect(patchSourceList).not.toHaveBeenCalled();
  });
});
