import type { NotificationSourceProvider } from './types';
import { buildMonarchExternalTargetLink } from '@/lib/finance/external-targets';
import { resolveTyrionReconnectUrl } from '@/lib/finance/tyrion-reconnect';
import {
  financeInsightDetailTarget,
  financeInsightPeriodTarget,
} from '@/lib/finance-insights/navigation';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function money(amountMinor: unknown, currencyValue: unknown): string | null {
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return null;
  const currency = text(currencyValue);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Math.abs(amountMinor) / 100);
}

function signedMoney(amountMinor: unknown, currencyValue: unknown): string | null {
  const formatted = money(amountMinor, currencyValue);
  if (!formatted || typeof amountMinor !== 'number') return formatted;
  return `${amountMinor > 0 ? '+' : amountMinor < 0 ? '-' : ''}${formatted}`;
}

function percentage(basisPoints: unknown): string | null {
  if (typeof basisPoints !== 'number' || !Number.isSafeInteger(basisPoints)) return null;
  const value = basisPoints / 100;
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

function detailTarget(metadata: Record<string, unknown>): string | null {
  const occurrenceId = text(metadata.occurrenceId);
  if (occurrenceId) return financeInsightDetailTarget(occurrenceId);
  const period = record(metadata.observationPeriod);
  const start = text(period.start);
  const end = text(period.end);
  return start && end ? financeInsightPeriodTarget({ start, end }) : null;
}

function financeActions(metadata: Record<string, unknown>) {
  const externalTarget = metadata.primaryTarget;
  const external = buildMonarchExternalTargetLink(externalTarget);
  const internal = detailTarget(metadata);
  return [
    ...(external ? [{
      actionType: 'open_url',
      label: external.label,
      icon: 'external-link',
      variant: 'primary' as const,
      isPrimary: true,
      payload: { target: externalTarget },
      opensExternal: true,
      createdBy: 'connector' as const,
    }] : []),
    ...(internal ? [{
      actionType: 'navigate',
      label: 'View insight details',
      icon: 'search',
      variant: 'secondary' as const,
      payload: { target: internal },
      createdBy: 'connector' as const,
    }] : []),
  ].slice(0, 2);
}

function commonPresentation(
  notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0],
  signature: string,
  richContent: Record<string, unknown>,
) {
  const metadata = notification.metadata;
  const confidence = text(metadata.confidence);
  const period = record(metadata.observationPeriod);
  const start = text(period.start);
  const end = text(period.end);
  const actions = financeActions(metadata);
  return {
    title: notification.title,
    body: notification.body ?? null,
    category: 'finance',
    templateKey: notification.metadata.notificationType as string,
    isActionable: actions.length > 0,
    metadata,
    presentation: {
      sourceName: 'Tyrion',
      providerSignature: signature,
      metadataChips: [
        ...(confidence ? [{ label: 'Confidence', value: confidence }] : []),
        ...(start && end ? [{ label: 'Period', value: start === end ? start : `${start} – ${end}` }] : []),
      ].slice(0, 4),
      richContent,
    },
    actions,
  };
}

function recurringPresentation(
  notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0],
) {
  const metadata = notification.metadata;
  return commonPresentation(notification, 'finance-recurring-amount-change', {
    primaryText: text(metadata.entityDisplayName) ?? undefined,
    secondaryText: 'Recurring charge increased',
    stats: [
      { label: 'New amount', value: money(metadata.observedAmountMinor, metadata.currency) },
      { label: 'Change', value: signedMoney(metadata.absoluteDeltaMinor, metadata.currency), tone: 'warning' },
      { label: 'Change', value: percentage(metadata.percentageDeltaBasisPoints), tone: 'warning' },
    ].filter((stat): stat is { label: string; value: string; tone?: 'warning' } => Boolean(stat.value)).slice(0, 3),
  });
}

function largeTransactionPresentation(
  notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0],
) {
  const metadata = notification.metadata;
  return commonPresentation(notification, 'finance-large-transaction', {
    primaryText: text(metadata.entityDisplayName) ?? undefined,
    secondaryText: 'Unusually large transaction',
    stats: [
      { label: 'Amount', value: money(metadata.observedAmountMinor, metadata.currency), tone: 'warning' },
      { label: 'Above expected', value: signedMoney(metadata.absoluteDeltaMinor, metadata.currency) },
      { label: 'Variance', value: percentage(metadata.percentageDeltaBasisPoints) },
    ].filter((stat): stat is { label: string; value: string; tone?: 'warning' } => Boolean(stat.value)).slice(0, 3),
    footerText: 'This is a spending notice, not a fraud determination.',
  });
}

function merchantVariancePresentation(
  notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0],
) {
  const metadata = notification.metadata;
  return commonPresentation(notification, 'finance-merchant-variance', {
    primaryText: text(metadata.entityDisplayName) ?? undefined,
    secondaryText: 'Merchant spending changed',
    stats: [
      { label: 'Change', value: signedMoney(metadata.absoluteDeltaMinor, metadata.currency), tone: 'info' },
      { label: 'Variance', value: percentage(metadata.percentageDeltaBasisPoints), tone: 'info' },
    ].filter((stat): stat is { label: string; value: string; tone: 'info' } => Boolean(stat.value)),
  });
}

function digestPresentation(
  notification: Parameters<NotificationSourceProvider['signatures'][number]['present']>[0],
) {
  const metadata = notification.metadata;
  const movers = Array.isArray(metadata.movers)
    ? metadata.movers.slice(0, 10).map(record)
    : [];
  const moverCount = typeof metadata.moverCount === 'number'
    && Number.isSafeInteger(metadata.moverCount)
    && metadata.moverCount >= 0
    ? metadata.moverCount
    : movers.length;
  const common = commonPresentation(notification, 'finance-monthly-movers-digest', {
    primaryText: `${moverCount} high-confidence spending ${moverCount === 1 ? 'mover' : 'movers'}`,
    secondaryText: 'Category and merchant changes, ranked by impact',
    stats: movers.map((mover, index) => ({
      label: `#${index + 1} ${text(mover.name) ?? 'Spending mover'}`,
      value: signedMoney(mover.absoluteDeltaMinor, metadata.currency)
        ?? percentage(mover.percentageDeltaBasisPoints)
        ?? 'Changed',
      tone: 'info' as const,
    })),
    footerText: moverCount > movers.length
      ? `Showing the top ${movers.length} of ${moverCount} movers.`
      : 'High-confidence movers only.',
  });
  const chips = common.presentation.metadataChips as Array<{ label: string; value: string }>;
  return {
    ...common,
    level: 'digest' as const,
    presentation: {
      ...common.presentation,
      metadataChips: [
        ...chips,
        { label: 'Movers', value: String(moverCount) },
      ].slice(0, 4),
    },
  };
}

export const financeNotificationProvider: NotificationSourceProvider = {
  sourceType: 'finance-manager',
  displayName: 'Tyrion',
  signatures: [
    {
      key: 'finance-connector-authentication-expired',
      matches: notification => (
        notification.metadata.notificationType === 'connectorAuthenticationExpired'
      ),
      present(notification) {
        return {
          title: notification.title,
          body: notification.body ?? null,
          level: 'urgent',
          category: 'finance',
          templateKey: 'connectorAuthenticationExpired',
          isActionable: true,
          metadata: notification.metadata,
          presentation: {
            sourceName: 'Tyrion',
            providerSignature: 'finance-connector-authentication-expired',
            richContent: {
              primaryText: 'Monarch authentication expired',
              secondaryText: 'Finance data is stale and synchronization is blocked.',
              footerText: 'Reconnect in Tyrion, then verify recovery in Mission Control.',
            },
          },
          actions: [
            {
              actionType: 'reconnect_monarch',
              label: 'Reconnect Monarch',
              icon: 'external-link',
              variant: 'primary',
              isPrimary: true,
              payload: {},
              opensExternal: true,
              createdBy: 'connector',
            },
            {
              actionType: 'navigate',
              label: 'Open Finance settings',
              icon: 'settings',
              variant: 'secondary',
              payload: { target: '/settings/connectors' },
              createdBy: 'connector',
            },
          ],
        };
      },
    },
    {
      key: 'finance-connector-degraded',
      matches: notification => notification.metadata.notificationType === 'connectorDegraded',
      present(notification) {
        return {
          title: notification.title,
          body: notification.body ?? null,
          level: 'action_needed',
          category: 'finance',
          templateKey: 'connectorDegraded',
          isActionable: true,
          metadata: notification.metadata,
          presentation: {
            sourceName: 'Tyrion',
            providerSignature: 'finance-connector-degraded',
            richContent: {
              primaryText: 'Monarch connection degraded',
              secondaryText: 'Finance data is stale while synchronization is unavailable.',
              footerText: 'Reconnect in Tyrion, then verify recovery in Mission Control.',
            },
          },
          actions: [
            {
              actionType: 'reconnect_monarch',
              label: 'Reconnect Monarch',
              icon: 'external-link',
              variant: 'primary',
              isPrimary: true,
              payload: {},
              opensExternal: true,
              createdBy: 'connector',
            },
            {
              actionType: 'navigate',
              label: 'Open Finance settings',
              icon: 'settings',
              variant: 'secondary',
              payload: { target: '/settings/connectors' },
              createdBy: 'connector',
            },
          ],
        };
      },
    },
    {
      key: 'finance-recurring-amount-change',
      matches: notification => notification.metadata.notificationType === 'recurringAmountChange',
      present: recurringPresentation,
    },
    {
      key: 'finance-large-transaction',
      matches: notification => notification.metadata.notificationType === 'largeTransaction',
      present: largeTransactionPresentation,
    },
    {
      key: 'finance-merchant-variance',
      matches: notification => notification.metadata.notificationType === 'merchantVariance',
      present: merchantVariancePresentation,
    },
    {
      key: 'finance-monthly-movers-digest',
      matches: notification => notification.metadata.notificationType === 'monthlyMoversDigest',
      present: digestPresentation,
    },
    {
      key: 'finance-attribution-review',
      matches: notification => notification.metadata.notificationType === 'financeAttributionReview',
      present(notification) {
        return {
          title: notification.title,
          body: notification.body ?? null,
          category: 'finance',
          templateKey: 'finance-attribution-review',
          isActionable: true,
          metadata: notification.metadata,
          presentation: {
            sourceName: 'Tyrion',
            providerSignature: 'finance-attribution-review',
            richContent: {
              primaryText: 'Attribution decision required',
              secondaryText: 'Review the exception in Finance.',
            },
          },
          actions: [{
            actionType: 'navigate',
            label: 'Review finance exception',
            icon: 'search',
            variant: 'primary',
            isPrimary: true,
            payload: { target: '/finance/review' },
            createdBy: 'connector',
          }],
        };
      },
    },
    {
      key: 'finance-alert',
      matches: () => true,
      present(notification) {
        const notificationType = text(notification.metadata.notificationType) ?? 'finance_alert';
        const isSummary = notificationType === 'weekly_summary';
        return {
          title: notification.title,
          body: notification.body ?? null,
          category: 'finance',
          templateKey: notificationType,
          isActionable: !isSummary,
          metadata: notification.metadata,
          presentation: {
            sourceName: 'Tyrion',
            providerSignature: 'finance-alert',
          },
          actions: [{
            actionType: 'navigate',
            label: isSummary ? 'View summary' : 'Review spending',
            icon: isSummary ? 'bar-chart-3' : 'search',
            variant: 'primary',
            isPrimary: true,
            payload: { target: '/finance' },
            createdBy: 'connector',
          }],
        };
      },
    },
  ],
  async executeAction(context) {
    if (context.action.actionType === 'reconnect_monarch') {
      const notificationType = text(record(context.notification.metadata).notificationType);
      if (
        notificationType !== 'connectorDegraded'
        && notificationType !== 'connectorAuthenticationExpired'
      ) {
        return {
          result: { type: 'finance_reconnect_action_rejected' },
          error: {
            message: 'Reconnect is not authorized for this finance notification',
            status: 400,
          },
        };
      }
      try {
        return {
          state: 'read',
          result: { type: 'open_url', url: resolveTyrionReconnectUrl() },
        };
      } catch {
        return {
          result: { type: 'finance_reconnect_unavailable' },
          error: {
            message: 'Tyrion reconnect is not configured safely',
            status: 503,
          },
        };
      }
    }
    if (context.action.actionType !== 'open_url') return null;
    const link = buildMonarchExternalTargetLink(context.payload.target);
    if (!link) {
      return {
        result: { type: 'invalid_external_target' },
        error: {
          message: 'Finance action target is unavailable',
          status: 400,
        },
      };
    }
    return {
      state: 'read',
      result: { type: 'open_url', url: link.url },
    };
  },
};
