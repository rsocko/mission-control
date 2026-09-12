import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorNotificationTypeDefinition } from '@/lib/notifications/push-policy/catalog';

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getPreferences: vi.fn(),
  getPushDeliveryEnabled: vi.fn(),
  listWebPushSubscriptions: vi.fn(),
  listOverrides: vi.fn(),
  saveRule: vi.fn(),
  resetRule: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: async () => ({
    getOverview: mocks.getOverview,
  }),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    notificationDelivery: {
      push: {
        getPreferences: mocks.getPreferences,
        getPushDeliveryEnabled: mocks.getPushDeliveryEnabled,
      },
      listWebPushSubscriptions: mocks.listWebPushSubscriptions,
      pushRules: {
        listOverrides: mocks.listOverrides,
        save: mocks.saveRule,
        reset: mocks.resetRule,
      },
    },
  }),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getNotificationTypeCatalog: mocks.getCatalog,
  },
}));

vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
  runWithConnectorOperationLease: async (
    _connectorId: string,
    _operationType: string,
    operation: () => Promise<unknown>,
  ) => operation(),
}));

import { DELETE, GET, PUT } from '@/app/api/push/rules/route';

const reviewRequested = {
  key: 'pr_review_requested',
  label: 'Review requested',
  description: 'A pull request needs your review.',
  defaultLevel: 'action_needed',
  pushEligible: true,
  pushRecommendation: 'off',
  sensitivity: 'sensitive',
  defaultPreview: 'title_only',
} as const satisfies ConnectorNotificationTypeDefinition;

const connector = {
  id: 'github-work',
  type: 'github-issues',
  name: 'GitHub Work',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
  lastTestStatus: null,
  lastTestError: null,
  lastTestAt: null,
};

function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/push/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VAPID_PUBLIC_KEY', 'public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'private');
  mocks.getOverview.mockResolvedValue({
    connectors: [connector],
    sourceLists: [],
    openTaskCounts: [],
    syncOutcomes: [],
  });
  mocks.getPreferences.mockResolvedValue({
    doNotDisturb: false,
    quietStart: 22,
    quietEnd: 7,
  });
  mocks.getPushDeliveryEnabled.mockResolvedValue(true);
  mocks.listWebPushSubscriptions.mockResolvedValue([{ id: 'subscription-1' }]);
  mocks.listOverrides.mockResolvedValue([]);
  mocks.getCatalog.mockReturnValue([reviewRequested]);
  mocks.saveRule.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'rule-1',
    ...input,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }));
  mocks.resetRule.mockResolvedValue(undefined);
});

describe('connector push rules route', () => {
  it('returns redacted channel status, eligible catalogs, and resolved recommendations', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      global: {
        pushDeliveryEnabled: true,
        doNotDisturb: false,
        quietStart: 22,
        quietEnd: 7,
        channelConfigured: true,
        subscriptionCount: 1,
      },
      connectors: [{
        connectorInstanceId: 'github-work',
        connectorType: 'github-issues',
        connectorName: 'GitHub Work',
        enabled: true,
        deletedAt: null,
        wildcardOverride: null,
        notificationTypes: [{
          definition: reviewRequested,
          override: null,
          effective: {
            enabled: false,
            minLevel: 'action_needed',
            preview: 'title_only',
            maxPerHour: null,
            source: 'connector',
            sourceDetail: 'recommended',
          },
        }],
      }],
    });
    expect(JSON.stringify(body)).not.toContain('endpoint');
  });

  it('saves a validated rule for an active connector and declared type', async () => {
    const response = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'action_needed',
      preview: 'title_only',
      maxPerHour: 5,
    }));

    expect(response.status).toBe(200);
    expect(mocks.saveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorInstanceId: 'github-work',
        templateKey: 'pr_review_requested',
        maxPerHour: 5,
      }),
      reviewRequested,
    );
  });

  it('rejects undeclared types and unsafe wildcard previews server-side', async () => {
    const undeclared = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: 'payload_claimed_safe',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
    }));
    const wildcard = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: '*',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_and_body',
      maxPerHour: null,
    }));

    expect(undeclared.status).toBe(400);
    expect(wildcard.status).toBe(400);
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it('rejects missing and unknown request fields instead of clearing limits', async () => {
    const missingLimit = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
    }));
    const misspelledLimit = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerhour: 5,
      maxPerHour: null,
    }));

    expect(missingLimit.status).toBe(400);
    expect(misspelledLimit.status).toBe(400);
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it('rejects updates to soft-deleted connector instances', async () => {
    mocks.getOverview.mockResolvedValue({
      connectors: [{ ...connector, deletedAt: '2026-09-12T01:00:00.000Z' }],
      sourceLists: [],
      openTaskCounts: [],
      syncOutcomes: [],
    });

    const response = await PUT(putRequest({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
    }));

    expect(response.status).toBe(404);
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it('resets an override only for a declared connector rule', async () => {
    const response = await DELETE(new Request(
      'http://localhost/api/push/rules?connectorInstanceId=github-work&templateKey=pr_review_requested',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(mocks.resetRule).toHaveBeenCalledWith(
      'github-work',
      'pr_review_requested',
    );
  });
});
