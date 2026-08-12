/**
 * Tests for the body-based source list rename endpoint.
 *
 * The key scenario: IDs containing slashes (GitHub repo IDs like
 * `github-xxx:repo:octo-org/mission-control`) must survive round-trip
 * because the ID is in the JSON body, not the URL path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ──────────────────────────────────────────────────────────
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockFrom = vi.fn();
type MockConnector = {
  renameList: (sourceId: string, name: string) => Promise<void>;
} | null;
const mockGetConnector = vi.fn<(id: string) => MockConnector>(() => null);

vi.mock('@/db', () => ({
  default: {
    select: () => ({ from: mockFrom }),
    update: mockUpdate,
  },
}));

vi.mock('@/db/schema', () => ({
  sourceLists: { id: 'id', userDisplayName: 'user_display_name', name: 'name', lastKnownRemoteName: 'last_known_remote_name', icon: 'icon', iconColor: 'icon_color' },
  tasks: { sourceListId: 'source_list_id', connectorInstanceId: 'connector_instance_id', sourceListName: 'source_list_name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => ({ write: true })),
  isConnectorEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/validation/emoji-safety', () => ({
  validateNameForGraphApi: vi.fn(() => null),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: mockGetConnector,
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────
function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/source-lists/rename', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupDbMocks(sourceList: Record<string, unknown> | null) {
  // select().from().where().limit() chain
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue(sourceList ? [sourceList] : []);

  // update().set().where() chain
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
}

const DEFAULT_SOURCE_LIST = {
  id: 'github-abc123:repo:octo-org/mission-control',
  name: 'mission-control',
  userDisplayName: null,
  connectorInstanceId: 'github-abc123',
  sourceId: 'octo-org/mission-control',
  icon: null,
  iconColor: null,
};

// ── Tests ────────────────────────────────────────────────────────────
describe('PUT /api/source-lists/rename (body-based)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnector.mockReturnValue(null);
  });

  it('should rename a source list with a slash-containing ID', async () => {
    setupDbMocks(DEFAULT_SOURCE_LIST);
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    const response = await PUT(makeRequest({
      id: 'github-abc123:repo:octo-org/mission-control',
      name: 'My Renamed Repo',
    }));

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.name).toBe('My Renamed Repo');

    // Verify DB update was called with userDisplayName
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ userDisplayName: 'My Renamed Repo' }),
    );
  });

  it('should reject missing id', async () => {
    const { PUT } = await import('@/app/api/source-lists/rename/route');
    const response = await PUT(makeRequest({ name: 'New Name' }));
    expect(response.status).toBe(400);
  });

  it('should reject missing name', async () => {
    const { PUT } = await import('@/app/api/source-lists/rename/route');
    const response = await PUT(makeRequest({ id: 'some-id' }));
    expect(response.status).toBe(400);
  });

  it('should reject empty/whitespace name', async () => {
    const { PUT } = await import('@/app/api/source-lists/rename/route');
    const response = await PUT(makeRequest({ id: 'some-id', name: '   ' }));
    expect(response.status).toBe(400);
  });

  it('should return 404 for non-existent source list', async () => {
    setupDbMocks(null);
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    const response = await PUT(makeRequest({
      id: 'does-not-exist',
      name: 'Test',
    }));

    expect(response.status).toBe(404);
  });

  it('should include icon and iconColor in update when provided', async () => {
    setupDbMocks(DEFAULT_SOURCE_LIST);
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    await PUT(makeRequest({
      id: 'github-abc123:repo:octo-org/mission-control',
      name: 'With Icon',
      icon: '🚀',
      iconColor: '#ff0000',
    }));

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        userDisplayName: 'With Icon',
        icon: '🚀',
        iconColor: '#ff0000',
      }),
    );
  });

  it('should not include icon fields when not provided', async () => {
    setupDbMocks(DEFAULT_SOURCE_LIST);
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    await PUT(makeRequest({
      id: 'github-abc123:repo:octo-org/mission-control',
      name: 'No Icon',
    }));

    const setArg = mockSet.mock.calls[0][0];
    expect(setArg).toEqual({ userDisplayName: 'No Icon' });
    expect(setArg).not.toHaveProperty('icon');
    expect(setArg).not.toHaveProperty('iconColor');
  });

  it('persists the local name before waiting for remote write-back', async () => {
    setupDbMocks(DEFAULT_SOURCE_LIST);
    let finishRemoteRename: (() => void) | undefined;
    const renameList = vi.fn(() => new Promise<void>((resolve) => {
      finishRemoteRename = resolve;
    }));
    mockGetConnector.mockReturnValue({ renameList });
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    const responsePromise = PUT(makeRequest({
      id: DEFAULT_SOURCE_LIST.id,
      name: 'Worker-safe name',
    }));

    await vi.waitFor(() => expect(renameList).toHaveBeenCalledOnce());
    expect(mockSet.mock.calls[0][0]).toEqual({
      userDisplayName: 'Worker-safe name',
    });

    finishRemoteRename?.();
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});
