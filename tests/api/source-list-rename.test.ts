/**
 * Tests for the body-based source list rename endpoint.
 *
 * The key scenario: IDs containing slashes (GitHub repo IDs like
 * `github-xxx:repo:octo-org/mission-control`) must survive round-trip
 * because the ID is in the JSON body, not the URL path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSourceList = vi.fn();
const mockApplyLocalSourceListRename = vi.fn();
const mockConfirmRemoteSourceListRename = vi.fn();
type MockConnector = {
  renameList: (sourceId: string, name: string) => Promise<void>;
} | null;
const mockGetConnector = vi.fn<(id: string) => MockConnector>(() => null);

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => ({
    getSourceList: mockGetSourceList,
    applyLocalSourceListRename: mockApplyLocalSourceListRename,
    confirmRemoteSourceListRename: mockConfirmRemoteSourceListRename,
  })),
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

vi.mock('@/lib/connectors/registry-runtime', () => ({
  getConnectorRegistry: () => ({
    getConnector: mockGetConnector,
  }),
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
  mockGetSourceList.mockResolvedValue(sourceList);
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

    expect(mockApplyLocalSourceListRename).toHaveBeenCalledWith({
      sourceListId: DEFAULT_SOURCE_LIST.id,
      name: 'My Renamed Repo',
      icon: undefined,
      iconColor: undefined,
    });
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

    expect(mockApplyLocalSourceListRename).toHaveBeenCalledWith({
      sourceListId: DEFAULT_SOURCE_LIST.id,
      name: 'With Icon',
      icon: '🚀',
      iconColor: '#ff0000',
    });
  });

  it('should not include icon fields when not provided', async () => {
    setupDbMocks(DEFAULT_SOURCE_LIST);
    const { PUT } = await import('@/app/api/source-lists/rename/route');

    await PUT(makeRequest({
      id: 'github-abc123:repo:octo-org/mission-control',
      name: 'No Icon',
    }));

    expect(mockApplyLocalSourceListRename).toHaveBeenCalledWith({
      sourceListId: DEFAULT_SOURCE_LIST.id,
      name: 'No Icon',
      icon: undefined,
      iconColor: undefined,
    });
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
    expect(mockApplyLocalSourceListRename).toHaveBeenCalledWith({
      sourceListId: DEFAULT_SOURCE_LIST.id,
      name: 'Worker-safe name',
      icon: undefined,
      iconColor: undefined,
    });

    finishRemoteRename?.();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(mockConfirmRemoteSourceListRename).toHaveBeenCalledWith(
      DEFAULT_SOURCE_LIST.id,
      'Worker-safe name',
    );
  });
});
