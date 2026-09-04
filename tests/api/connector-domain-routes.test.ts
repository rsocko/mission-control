import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConnector: vi.fn(async () => true),
  getConnector: vi.fn(),
  getConnectorListSnapshot: vi.fn(),
  getGitHubRepositorySnapshot: vi.fn(),
  listActiveConnectorsByType: vi.fn(),
  getAuthUrl: vi.fn(() => 'https://login.microsoft.test/authorize'),
  resolveClientCredentials: vi.fn(() => ({ clientId: 'client-id', clientSecret: 'secret' })),
  probePermissions: vi.fn(async () => ({ granted: ['Tasks.ReadWrite'] })),
  probeGitHubScopes: vi.fn(async () => ({ scopes: ['repo'] })),
  scanForNonCanonicalLabels: vi.fn(async () => [{
    oldName: 'Priority: High',
    newName: 'priority:high',
    issueCount: 2,
  }]),
  normalizeLabels: vi.fn(async () => ({ succeeded: 2, failed: 0, errors: [] })),
  createGitHubClient: vi.fn(() => ({ marker: 'github-client' })),
  runWithConnectorOperationLease: vi.fn(
    async (_id: string, _type: string, work: () => Promise<unknown>) => work(),
  ),
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => mocks),
}));
vi.mock('@/lib/auth', () => ({
  getAuthUrl: mocks.getAuthUrl,
  resolveClientCredentials: mocks.resolveClientCredentials,
  probePermissions: mocks.probePermissions,
}));
vi.mock('@/lib/connectors/github-issues/github-client', () => ({
  createGitHubClient: mocks.createGitHubClient,
}));
vi.mock('@/lib/connectors/github-issues/scope-probe', () => ({
  probeGitHubScopes: mocks.probeGitHubScopes,
}));
vi.mock('@/lib/connectors/github-issues/label-handler', () => ({
  scanForNonCanonicalLabels: mocks.scanForNonCanonicalLabels,
  normalizeLabels: mocks.normalizeLabels,
}));
vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: mocks.ConnectorOperationBusyError,
  runWithConnectorOperationLease: mocks.runWithConnectorOperationLease,
}));
vi.mock('@/lib/mode', () => ({
  getTimezone: vi.fn(() => 'America/New_York'),
  ianaToWindowsTimezone: vi.fn(() => 'Eastern Standard Time'),
}));
vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-09-04'),
}));

const baseConnector = {
  id: 'connector-1',
  type: 'github-issues',
  name: 'Connector',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: { read: true, write: true },
  credentials: { token: 'top-secret' },
  settings: { repos: ['octo/fallback'] },
  syncedLists: [],
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  deletedAt: null,
  lastTestStatus: null,
  lastTestError: null,
  lastTestAt: null,
};

describe('connector-domain API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnector.mockResolvedValue(baseConnector);
    mocks.getConnectorListSnapshot.mockResolvedValue({
      connector: {
        id: 'connector-1',
        type: 'github-issues',
        settings: { repos: ['octo/repo'] },
        syncedLists: [],
      },
      sourceLists: [{
        id: 'list-1',
        connectorInstanceId: 'connector-1',
        sourceId: 'octo/repo',
        name: 'Repo',
        type: 'repo',
        taskCount: 0,
        lastSyncedAt: null,
        wellKnownListName: null,
        groupId: 'group-1',
        sortOrder: 0,
        hidden: false,
        lastKnownRemoteName: null,
        userDisplayName: 'Display repo',
        icon: null,
        iconColor: null,
      }],
      openTaskCounts: [{ sourceListId: 'octo/repo', count: 3 }],
      groups: [{ id: 'group-1', name: 'Projects', sortOrder: 0 }],
    });
    mocks.getGitHubRepositorySnapshot.mockResolvedValue({
      connectors: [{
        id: 'connector-1',
        name: 'GitHub',
        settings: { repos: ['octo/fallback'] },
      }],
      sourceLists: [{
        connectorInstanceId: 'connector-1',
        sourceId: 'octo/repo',
        name: 'Repo',
      }],
    });
    mocks.listActiveConnectorsByType.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a Microsoft connector before redirecting without exposing credentials', async () => {
    mocks.getConnector.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/auth/microsoft/connect/route');
    const response = await GET(new Request(
      'http://localhost/api/auth/microsoft/connect?instanceId=ms-1&connectorType=outlook-calendar&accountType=work',
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://login.microsoft.test/authorize');
    expect(mocks.createConnector).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ms-1',
      type: 'outlook-calendar',
      credentials: {},
      settings: { accountType: 'work', tenantId: undefined },
    }));
    expect(JSON.stringify(mocks.createConnector.mock.calls)).not.toContain('secret');
  });

  it('returns connector lists and counts from one normalized snapshot', async () => {
    const { GET } = await import('@/app/api/connectors/[id]/lists/route');
    const response = await GET(
      new Request('http://localhost/api/connectors/connector-1/lists'),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sourceLists: [expect.objectContaining({
        id: 'list-1',
        name: 'Display repo',
        taskCount: 3,
        selectedForSync: true,
      })],
      groups: [{ id: 'group-1', name: 'Projects', sortOrder: 0 }],
    });
  });

  it('merges discovered and configured GitHub repositories deterministically', async () => {
    const { GET } = await import('@/app/api/connectors/github-repos/route');
    const response = await GET();

    expect(await response.json()).toEqual({
      repos: [
        {
          connectorId: 'connector-1',
          connectorName: 'GitHub',
          repo: 'octo/repo',
          displayName: 'Repo',
        },
        {
          connectorId: 'connector-1',
          connectorName: 'GitHub',
          repo: 'octo/fallback',
          displayName: 'fallback',
        },
      ],
    });
  });

  it('keeps GitHub credentials server-side for permission and repository probes', async () => {
    const permissions = await import('@/app/api/connectors/[id]/permissions/route');
    const permissionResponse = await permissions.GET(
      new Request('http://localhost/api/connectors/connector-1/permissions'),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );
    expect(await permissionResponse.json()).toEqual({ scopes: ['repo'] });
    expect(mocks.probeGitHubScopes).toHaveBeenCalledWith('top-secret');

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      full_name: 'octo/repo',
      open_issues_count: 4,
    }), { status: 200 }));
    const validation = await import('@/app/api/connectors/[id]/validate-repo/route');
    const validationResponse = await validation.POST(
      new Request('http://localhost/api/connectors/connector-1/validate-repo', {
        method: 'POST',
        body: JSON.stringify({ repo: 'octo/repo' }),
      }),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );
    const validationBody = await validationResponse.json();
    expect(validationBody).toEqual({
      valid: true,
      fullName: 'octo/repo',
      openIssues: 4,
    });
    expect(JSON.stringify(validationBody)).not.toContain('top-secret');
  });

  it('scans and normalizes labels with the connector operation lease', async () => {
    const scan = await import('@/app/api/connectors/[id]/label-scan/route');
    const scanResponse = await scan.GET(
      new Request('http://localhost/api/connectors/connector-1/label-scan'),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );
    expect(await scanResponse.json()).toMatchObject({
      reposScanned: 1,
      totalLabelsToNormalize: 1,
      totalIssuesAffected: 2,
    });

    const normalize = await import('@/app/api/connectors/[id]/label-normalize/route');
    const normalizeResponse = await normalize.POST(
      new Request('http://localhost/api/connectors/connector-1/label-normalize', {
        method: 'POST',
        body: JSON.stringify({
          normalizations: [{
            repo: 'octo/repo',
            oldName: 'Priority: High',
            newName: 'priority:high',
            issueCount: 2,
          }],
        }),
      }),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );
    expect(await normalizeResponse.json()).toEqual({
      succeeded: 2,
      failed: 0,
      errors: [],
    });
    expect(mocks.runWithConnectorOperationLease).toHaveBeenCalledWith(
      'connector-1',
      'transfer',
      expect.any(Function),
    );
  });

  it('returns the established conflict response when label normalization lease is busy', async () => {
    mocks.runWithConnectorOperationLease.mockRejectedValueOnce(
      new mocks.ConnectorOperationBusyError('busy'),
    );
    const { POST } = await import('@/app/api/connectors/[id]/label-normalize/route');
    const response = await POST(
      new Request('http://localhost/api/connectors/connector-1/label-normalize', {
        method: 'POST',
        body: JSON.stringify({
          normalizations: [{
            repo: 'octo/repo',
            oldName: 'Priority: High',
            newName: 'priority:high',
            issueCount: 2,
          }],
        }),
      }),
      { params: Promise.resolve({ id: 'connector-1' }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Connector has an active operation',
      code: 'CONFLICT',
    });
    expect(mocks.normalizeLabels).not.toHaveBeenCalled();
  });

  it('fetches and sorts Outlook events after the connector snapshot closes', async () => {
    mocks.listActiveConnectorsByType.mockResolvedValueOnce([{
      ...baseConnector,
      id: 'calendar-1',
      type: 'outlook-calendar',
      credentials: { accessToken: 'calendar-secret' },
    }]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      value: [
        {
          id: 'late',
          subject: 'Late',
          start: { dateTime: '2026-09-04T14:00:00' },
          end: { dateTime: '2026-09-04T15:00:00' },
          location: {},
          isAllDay: false,
          isCancelled: false,
        },
        {
          id: 'early',
          subject: 'Early',
          start: { dateTime: '2026-09-04T09:00:00' },
          end: { dateTime: '2026-09-04T09:30:00' },
          location: { displayName: 'Room' },
          isAllDay: false,
          isCancelled: false,
        },
      ],
    }), { status: 200 }));

    const { GET } = await import('@/app/api/calendar-events/route');
    const response = await GET(new Request(
      'http://localhost/api/calendar-events?date=2026-09-04',
    ));
    const body = await response.json();
    expect(body.events.map((event: { id: string }) => event.id)).toEqual(['early', 'late']);
    expect(JSON.stringify(body)).not.toContain('calendar-secret');
  });
});
