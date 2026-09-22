import { afterEach, describe, expect, it } from 'vitest';
import type { InboundNotification } from '@/types';
import {
  clearNotificationProvidersForTests,
  executeNotificationProviderAction,
  getNotificationProvider,
  normalizeInternalNavigationTarget,
  normalizeNotificationUrl,
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  registerNotificationProvider,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import {
  financeInsightDetailTarget,
  financeInsightPeriodTarget,
} from '@/lib/finance-insights/navigation';
import { buildMonarchExternalTargetLink } from '@/lib/finance/external-targets';
import { connectorRegistry } from '@/lib/connectors';
import { financeNotificationCatalogKey } from '@/lib/notifications/push-policy/catalogs';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import { getAllTemplates } from '@/lib/notifications/templates';

function notification(overrides: Partial<InboundNotification> = {}): InboundNotification {
  return {
    id: 'provider-test',
    sourceId: 'source-1',
    connectorType: 'test-source',
    connectorInstanceId: 'test-instance',
    title: 'Raw title',
    body: 'Raw body',
    level: 'fyi',
    category: 'system',
    isRead: false,
    isActionable: true,
    receivedAt: '2026-07-31T12:00:00.000Z',
    hubProjectIds: [],
    tags: [],
    metadata: {},
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.MONARCH_WEB_URL;
  delete process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS;
  delete process.env.TYRION_OPERATIONS_URL;
  clearNotificationProvidersForTests();
  registerDefaultNotificationProviders();
});

describe('notification provider registry', () => {
  it('lets a source define signatures, presentation, and CTAs', () => {
    registerNotificationProvider({
      sourceType: 'test-source',
      displayName: 'Test Source',
      signatures: [{
        key: 'approval-request',
        matches: item => item.metadata.kind === 'approval',
        present: item => ({
          title: `Approve: ${item.title}`,
          templateKey: 'approval_request',
          presentation: {
            sourceName: 'Test Source',
            subtitle: 'Production',
            richContent: {
              stats: [{ label: 'Risk', value: 'Low', tone: 'success' }],
            },
          },
          actions: [{
            actionType: 'test_approve',
            label: 'Approve deployment',
            variant: 'primary',
            isPrimary: true,
            payload: { deploymentId: 'dep-1' },
            createdBy: 'connector',
          }],
        }),
      }],
    });

    const resolved = resolveNotificationProvider(notification({
      metadata: { kind: 'approval' },
    }));

    expect(resolved?.signature.key).toBe('approval-request');
    expect(resolved?.presentation.title).toBe('Approve: Raw title');
    expect(resolved?.presentation.presentation?.sourceName).toBe('Test Source');
    expect(resolved?.presentation.actions?.[0].label).toBe('Approve deployment');
  });

  it('delegates source-owned action execution to the provider', async () => {
    registerNotificationProvider({
      sourceType: 'test-source',
      displayName: 'Test Source',
      signatures: [{
        key: 'default',
        matches: () => true,
        present: item => ({ title: item.title }),
      }],
      executeAction: async context => {
        if (context.action.actionType !== 'test_acknowledge') return null;
        return {
          state: 'resolved',
          result: {
            type: 'test_acknowledge',
            acknowledgedId: context.payload.remoteId,
          },
        };
      },
    });

    const result = await executeNotificationProviderAction({
      notification: {
        id: 'n1',
        sourceId: 'source-1',
        connectorType: 'test-source',
        connectorInstanceId: 'test-instance',
        title: 'Test',
        body: null,
        category: 'system',
        navigationTarget: null,
        metadata: {},
        presentation: {},
      },
      action: {
        id: 'a1',
        notificationId: 'n1',
        actionType: 'test_acknowledge',
        payload: { remoteId: 'remote-7' },
      },
      payload: { remoteId: 'remote-7' },
      input: {},
    });

    expect(result).toEqual({
      state: 'resolved',
      result: {
        type: 'test_acknowledge',
        acknowledgedId: 'remote-7',
      },
    });
  });

  it('constructs and authorizes the Tyrion reconnect destination server-side', async () => {
    process.env.TYRION_OPERATIONS_URL = 'https://tyrion.socko.us';
    process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS = 'tyrion.socko.us';
    const resolved = resolveNotificationProvider(notification({
      connectorType: 'finance-manager',
      metadata: {
        notificationType: 'connectorAuthenticationExpired',
        returnUrl: 'https://attacker.example',
        session_id: 'must-not-propagate',
      },
    }));
    const action = resolved?.presentation.actions?.[0];

    expect(action).toMatchObject({
      actionType: 'reconnect_monarch',
      label: 'Reconnect Monarch',
      payload: {},
    });
    expect(JSON.stringify(action)).not.toMatch(/returnUrl|session_id|csrftoken|token/i);

    const result = await executeNotificationProviderAction({
      notification: {
        id: 'finance-recovery',
        sourceId: 'finance-source',
        connectorType: 'finance-manager',
        connectorInstanceId: 'finance-invented',
        title: 'Reconnect Monarch',
        body: null,
        category: 'finance',
        navigationTarget: null,
        metadata: { notificationType: 'connectorAuthenticationExpired' },
        presentation: {},
      },
      action: {
        id: 'finance-recovery-action',
        notificationId: 'finance-recovery',
        actionType: 'reconnect_monarch',
        payload: {},
      },
      payload: {
        url: 'https://attacker.example',
        returnUrl: 'https://attacker.example',
        session_id: 'must-not-propagate',
      },
      input: {},
    });

    expect(result).toEqual({
      state: 'read',
      result: {
        type: 'open_url',
        url: 'https://tyrion.socko.us/?source=mission-control',
      },
    });
  });

  it('rejects reconnect actions outside outage notifications or an approved origin', async () => {
    process.env.TYRION_OPERATIONS_URL = 'https://attacker.example';
    process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS = 'tyrion.socko.us';
    const base = {
      id: 'finance-recovery',
      sourceId: 'finance-source',
      connectorType: 'finance-manager',
      connectorInstanceId: 'finance-invented',
      title: 'Reconnect Monarch',
      body: null,
      category: 'finance',
      navigationTarget: null,
      presentation: {},
    };
    const action = {
      id: 'finance-recovery-action',
      notificationId: 'finance-recovery',
      actionType: 'reconnect_monarch',
      payload: {},
    };

    await expect(executeNotificationProviderAction({
      notification: { ...base, metadata: { notificationType: 'largeTransaction' } },
      action,
      payload: {},
      input: {},
    })).resolves.toMatchObject({ error: { status: 400 } });
    await expect(executeNotificationProviderAction({
      notification: {
        ...base,
        metadata: { notificationType: 'connectorDegraded' },
      },
      action,
      payload: {},
      input: {},
    })).resolves.toMatchObject({ error: { status: 503 } });
  });

  it('registers built-in providers with source-specific CTA labels', () => {
    registerDefaultNotificationProviders();
    const resolved = resolveNotificationProvider(notification({
      connectorType: 'github-issues',
      title: '[PullRequest] Fix auth middleware',
      actionUrl: 'https://github.com/acme/repo/pull/42',
      metadata: {
        reason: 'review_requested',
        subjectType: 'PullRequest',
        subjectUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
        repository: 'acme/repo',
      },
    }));

    expect(getNotificationProvider('github-issues')?.displayName).toBe('GitHub');
    expect(resolved?.presentation.category).toBe('development');
    expect(resolved?.presentation.actions?.[0].label).toBe('Review PR');
    expect(resolved?.presentation.actions?.[0].payload).toEqual({
      url: 'https://github.com/acme/repo/pull/42',
    });
  });

  it('presents bounded Homelab incident context and approved actions', () => {
    registerDefaultNotificationProviders();
    const resolved = resolveNotificationProvider(notification({
      connectorType: 'homelab',
      category: 'infrastructure',
      metadata: {
        schemaVersion: 1,
        fingerprint: 'abcdef',
        status: 'firing',
        type: 'homelab_service_unavailable',
        node: 'node-1',
        environment: 'production',
        metrics: [{ label: 'Unavailable', value: '5m', tone: 'danger' }],
        links: [
          { kind: 'dashboard', url: 'https://grafana.example/d/node' },
          { kind: 'logs', url: 'javascript:alert(1)' },
        ],
      },
    }));

    expect(getNotificationProvider('homelab')?.displayName).toBe('Homelab');
    expect(resolved?.presentation.presentation).toMatchObject({
      sourceName: 'Homelab',
      subtitle: 'node-1 - firing',
      richContent: {
        stats: [
          { label: 'Environment', value: 'production' },
          { label: 'Unavailable', value: '5m', tone: 'danger' },
        ],
        links: [{ label: 'Open dashboard', url: 'https://grafana.example/d/node' }],
      },
    });
    expect(resolved?.presentation.actions).toHaveLength(1);
  });

  it('keeps finance digests navigable without marking them actionable', () => {
    registerDefaultNotificationProviders();
    const resolved = resolveNotificationProvider(notification({
      connectorType: 'finance',
      level: 'digest',
      isActionable: false,
      metadata: { notificationType: 'weekly_summary' },
    }));

    expect(resolved?.presentation.isActionable).toBe(false);
    expect(resolved?.presentation.actions?.[0].label).toBe('View summary');
    expect(resolved?.presentation.actions?.[0].createdBy).toBe('connector');
    expect(financeNotificationCatalogKey('finance-insight-merchantVariance'))
      .toBe('finance_insight_merchant_variance');
    for (const alias of ['finance', 'finance-manager', 'monarch-money']) {
      expect(getNotificationProvider(alias)?.displayName).toBe('Tyrion');
      expect(resolveNotificationProvider(notification({
        connectorType: alias,
        metadata: { notificationType: 'largeTransaction' },
      }))?.provider.sourceType).toBe('finance-manager');
      const catalog = connectorRegistry.getNotificationTypeCatalog(alias, {
        id: `finance-${alias}`,
        type: alias,
        name: 'Invented Finance',
        enabled: true,
        syncMode: 'poll',
        capabilities: {
          read: true,
          write: true,
          delete: false,
          sync: true,
          subtasks: false,
          lists: false,
          tags: true,
          tagWriteBack: false,
          notificationOnly: true,
        },
        credentials: {},
        settings: {},
        syncedLists: [],
      });

      expect(catalog).toContainEqual(expect.objectContaining({
        key: 'finance_insight_merchant_variance',
        pushEligible: true,
        pushRecommendation: 'off',
      }));
    }
  });

  it('presents attribution review with a safe internal action for every finance alias', () => {
    registerDefaultNotificationProviders();

    for (const alias of ['finance', 'finance-manager', 'monarch-money']) {
      const resolved = resolveNotificationProvider(notification({
        connectorType: alias,
        category: 'finance',
        metadata: { notificationType: 'financeAttributionReview' },
      }));
      expect(resolved?.signature.key).toBe('finance-attribution-review');
      expect(resolved?.presentation.actions).toEqual([expect.objectContaining({
        actionType: 'navigate',
        isPrimary: true,
        payload: { target: '/finance/review' },
      })]);
      expect(JSON.stringify(resolved?.presentation.actions)).not.toContain('http');
    }
    expect(financeNotificationCatalogKey('finance-attribution-review'))
      .toBe('finance_attribution_review');
  });

  it('omits and rejects generic task actions for every Finance provider and template alias', async () => {
    registerNotificationProvider({
      sourceType: 'finance-manager',
      displayName: 'Policy probe',
      signatures: [{
        key: 'policy-probe',
        matches: () => true,
        present: item => item.metadata.taskOnly
          ? {
              isActionable: true,
              actions: [{
                actionType: 'create_task',
                label: 'Unsafe task',
                variant: 'primary',
              }],
            }
          : {
              isActionable: true,
              actions: [{
                actionType: 'create_task',
                label: 'Unsafe task',
                variant: 'primary',
              }, {
                actionType: 'navigate',
                label: 'Review Finance',
                variant: 'secondary',
                payload: { target: '/finance' },
              }],
            },
      }],
    }, { replace: true });

    for (const alias of FINANCE_PROVIDER_ALIASES) {
      const resolved = resolveNotificationProvider(notification({
        connectorType: alias,
        category: 'finance',
      }));
      expect(resolved?.presentation.actions?.map(action => action.actionType))
        .toEqual(['navigate']);

      const result = await executeNotificationProviderAction({
        notification: {
          id: `finance-${alias}`,
          sourceId: 'finance-source',
          connectorType: alias,
          connectorInstanceId: 'finance-instance',
          title: 'Invented Finance notice',
          body: null,
          category: 'finance',
          navigationTarget: null,
          metadata: {},
          presentation: {},
        },
        action: {
          id: `finance-${alias}-create-task`,
          notificationId: `finance-${alias}`,
          actionType: 'create_task',
          payload: {},
        },
        payload: {},
        input: {},
      });
      expect(result).toEqual({
        result: { type: 'finance_task_action_rejected' },
        error: {
          message: 'Finance notifications cannot create tasks',
          status: 400,
        },
      });
    }

    const taskOnly = resolveNotificationProvider(notification({
      connectorType: 'finance',
      category: 'finance',
      metadata: { taskOnly: true },
    }));
    expect(taskOnly?.presentation.actions).toEqual([]);
    expect(taskOnly?.presentation.isActionable).toBe(false);

    const financeTemplates = getAllTemplates().filter(template => template.category === 'finance');
    expect(financeTemplates.length).toBeGreaterThan(0);
    for (const template of financeTemplates) {
      expect(template.defaultActions.map(action => action.actionType))
        .not.toContain('create_task');
    }
  });

  it('builds bounded Finance insight cards and typed Monarch actions without task creation', async () => {
    registerDefaultNotificationProviders();
    const resolved = resolveNotificationProvider(notification({
      connectorType: 'monarch-money',
      title: 'Invented market purchase was unusually large',
      category: 'finance',
      metadata: {
        notificationType: 'largeTransaction',
        occurrenceId: 'occurrence-invented-one',
        confidence: 'high',
        entityDisplayName: 'Invented market',
        observationPeriod: { start: '2026-08-09', end: '2026-08-09' },
        observedAmountMinor: -184000,
        absoluteDeltaMinor: 94000,
        percentageDeltaBasisPoints: 20444,
        currency: 'USD',
        primaryTarget: {
          system: 'monarch',
          targetKind: 'transaction',
          sourceRef: 'transaction-invented-one',
        },
      },
    }));

    expect(resolved?.signature.key).toBe('finance-large-transaction');
    expect(resolved?.presentation.presentation?.richContent?.stats).toHaveLength(3);
    expect(resolved?.presentation.presentation?.richContent?.footerText)
      .toBe('This is a spending notice, not a fraud determination.');
    expect(resolved?.presentation.actions).toHaveLength(2);
    expect(resolved?.presentation.actions?.filter(action => action.isPrimary)).toHaveLength(1);
    expect(resolved?.presentation.actions?.[0]).toMatchObject({
      actionType: 'open_url',
      opensExternal: true,
      isPrimary: true,
      payload: {
        target: {
          system: 'monarch',
          targetKind: 'transaction',
          sourceRef: 'transaction-invented-one',
        },
      },
    });
    expect(JSON.stringify(resolved?.presentation.actions)).not.toContain('"url"');
    expect(resolved?.presentation.actions?.some(action => action.actionType === 'create_task'))
      .toBe(false);

    const typedResult = await executeNotificationProviderAction({
      notification: {
        id: 'finance-notification',
        sourceId: 'finance-source',
        connectorType: 'finance',
        connectorInstanceId: 'finance-invented',
        title: 'Invented finance notice',
        body: null,
        category: 'finance',
        navigationTarget: null,
        metadata: {},
        presentation: {},
      },
      action: {
        id: 'finance-action',
        notificationId: 'finance-notification',
        actionType: 'open_url',
        payload: {},
      },
      payload: resolved?.presentation.actions?.[0]?.payload ?? {},
      input: {},
    });
    expect(typedResult).toEqual({
      state: 'read',
      result: {
        type: 'open_url',
        url: 'https://app.monarchmoney.com/transactions',
      },
    });
    process.env.MONARCH_WEB_URL = 'https://finance.example';
    process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS = 'finance.example';
    const configuredOriginResult = await executeNotificationProviderAction({
      notification: {
        id: 'finance-notification',
        sourceId: 'finance-source',
        connectorType: 'finance-manager',
        connectorInstanceId: 'finance-invented',
        title: 'Invented finance notice',
        body: null,
        category: 'finance',
        navigationTarget: null,
        metadata: {},
        presentation: {},
      },
      action: {
        id: 'finance-action',
        notificationId: 'finance-notification',
        actionType: 'open_url',
        payload: {},
      },
      payload: resolved?.presentation.actions?.[0]?.payload ?? {},
      input: {},
    });
    expect(configuredOriginResult).toEqual({
      state: 'read',
      result: {
        type: 'open_url',
        url: 'https://finance.example/transactions',
      },
    });
    delete process.env.MONARCH_WEB_URL;
    delete process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS;

    const rawUrlResult = await executeNotificationProviderAction({
      notification: {
        id: 'finance-notification',
        sourceId: 'finance-source',
        connectorType: 'finance-manager',
        connectorInstanceId: 'finance-invented',
        title: 'Invented finance notice',
        body: null,
        category: 'finance',
        navigationTarget: null,
        metadata: {},
        presentation: {},
      },
      action: {
        id: 'finance-action',
        notificationId: 'finance-notification',
        actionType: 'open_url',
        payload: {},
      },
      payload: { url: 'https://attacker.example' },
      input: {},
    });
    expect(rawUrlResult).toEqual({
      result: { type: 'invalid_external_target' },
      error: {
        message: 'Finance action target is unavailable',
        status: 400,
      },
    });
    expect(buildMonarchExternalTargetLink({
      system: 'monarch',
      targetKind: 'safeRoot',
      root: 'toString',
    })).toBeNull();
  });

  it('uses canonical shared Finance detail targets', () => {
    expect(financeInsightDetailTarget('occurrence invented/one')).toBe(
      '/finance/insights/occurrence%20invented%2Fone',
    );
    expect(financeInsightPeriodTarget({
      start: '2026-07-01',
      end: '2026-07-31',
    })).toBe('/finance?insightPeriod=2026-07-01%3A2026-07-31');
  });

  it('rejects unsafe external URLs and cross-origin navigation targets', () => {
    expect(normalizeNotificationUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeNotificationUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(normalizeInternalNavigationTarget('/notifications')).toBe('/notifications');
    expect(normalizeInternalNavigationTarget('//evil.example')).toBeNull();
    expect(normalizeInternalNavigationTarget('/\\evil.example')).toBeNull();
    expect(normalizeInternalNavigationTarget('https://evil.example')).toBeNull();
  });

  it('rejects accidental duplicate provider registration', () => {
    const provider = {
      sourceType: 'test-source',
      displayName: 'Test Source',
      signatures: [{
        key: 'default',
        matches: () => true,
        present: (item: InboundNotification) => ({ title: item.title }),
      }],
    };
    registerNotificationProvider(provider);
    expect(() => registerNotificationProvider(provider)).toThrow(/already registered/);
  });

  it('materializes exactly one primary CTA', () => {
    let sequence = 0;
    const actions = materializeNotificationActions('n1', [
      { actionType: 'first', label: 'First', variant: 'secondary' },
      { actionType: 'second', label: 'Second', variant: 'primary', isPrimary: true },
      { actionType: 'third', label: 'Third', variant: 'primary', isPrimary: true },
    ], () => `a${++sequence}`);

    expect(actions.filter(action => action.isPrimary)).toHaveLength(1);
    expect(actions.find(action => action.isPrimary)?.actionType).toBe('second');
  });
});
